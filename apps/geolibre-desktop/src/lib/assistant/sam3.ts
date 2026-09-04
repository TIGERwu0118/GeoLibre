import { getRuntimeEnvironment, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { rasterProjection, reprojectSamGeoResult } from "@geolibre/plugins/maplibre-samgeo";
import type { InvokableTool, JSONValue } from "@strands-agents/sdk";
import { tool } from "@strands-agents/sdk";
import type { FeatureCollection } from "geojson";
import { z } from "zod";

/**
 * Remote SAM3 mining-segmentation tools for the assistant.
 *
 * The heavy model runs on a GPU server behind an ssh local-forward tunnel;
 * the browser only uploads a loaded raster layer's GeoTIFF bytes to the
 * samgeo-compatible façade and maps the returned polygons. The endpoint is
 * fixed by the app (tunnel default or `GEOLIBRE_SAM3_URL`), never chosen by
 * the model — the model controls only the prompt and which loaded layer to
 * segment, so there is no model-directed URL surface.
 */

/** Local forward of the GPU server's SAM3 façade. */
export const DEFAULT_SAM3_URL = "http://127.0.0.1:8766";
const SAM3_URL_ENV = "GEOLIBRE_SAM3_URL";

/** The mining taxonomy the service accepts (mirrors the server contract). */
export const SAM3_CATEGORIES = [
  "露天采坑",
  "固体废弃物",
  "矿山道路",
  "裸露地表",
  "恢复治理",
  "工业广场",
  "疑似崩塌区",
  "疑似滑坡区",
] as const;

/** Resolve the façade base URL: runtime env override, else the tunnel default. */
export function sam3Endpoint(env: Record<string, string | undefined> = getRuntimeEnvironment()): string {
  return env[SAM3_URL_ENV]?.trim() || DEFAULT_SAM3_URL;
}

/**
 * The GeoTIFF URL the assistant can upload for a layer, or null. Prefers the
 * layer's original `source.url` over `metadata.localBytesUrl`: the latter may
 * be a cog-tiler-wasm re-encode, while the GPU service wants the original
 * bytes (and its georeference drives prompt reprojection).
 */
export function rasterUploadUrl(layer: GeoLibreLayer): string | null {
  if (layer.type !== "cog" && layer.type !== "raster") return null;
  const source = layer.source as Record<string, unknown>;
  const candidates = [source.url, layer.metadata?.localBytesUrl];
  return (
    candidates.find(
      (value): value is string => typeof value === "string" && /^(https?|blob|data):/i.test(value),
    ) ?? null
  );
}

/** Match a model-supplied reference (id, name, or substring) within a layer list. */
function matchLayer(reference: string, layers: GeoLibreLayer[]): GeoLibreLayer | null {
  const byId = layers.find((layer) => layer.id === reference);
  if (byId) return byId;
  const target = reference.trim().toLowerCase();
  const exact = layers.find((layer) => layer.name.toLowerCase() === target);
  if (exact) return exact;
  if (target.length < 3) return null;
  return layers.find((layer) => layer.name.toLowerCase().includes(target)) ?? null;
}

/** fetch with a timeout; throws on network failure (caller decides severity). */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The upload cap mirrors the façade's streaming limit (200 MiB). */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** First segmentation also loads the SAM3 checkpoint — allow for it. */
const SEGMENT_TIMEOUT_MS = 240_000;

type Sam3Meta = { job_id?: string; score?: number; category?: string; warnings?: string[] };

/**
 * Build the SAM3 tool set: a readiness probe and the layer-segmentation tool.
 * Both report structured state instead of crashing so the model can tell the
 * user what to fix (start the tunnel, load a raster, retry with a taxonomy
 * category).
 */
export function createSam3Tools(deps: {
  getMapController: () => MapController | null;
}): InvokableTool<unknown, unknown>[] {
  const json = (value: unknown): JSONValue => value as JSONValue;

  const sam3Status = tool({
    name: "sam3_status",
    description:
      "Check the remote SAM3 mining-segmentation service (GPU server over a local ssh tunnel) and list its mining categories. Call this before sam3_segment. If unavailable, tell the user to start the tunnel/service instead of retrying.",
    inputSchema: z.object({}),
    callback: async () => {
      const base = sam3Endpoint();
      try {
        const response = await fetchWithTimeout(`${base}/health`, 5_000);
        const health = (await response.json().catch(() => null)) as {
          status?: string;
        } | null;
        if (!health || health.status !== "ok") {
          return json({ available: false, endpoint: base, health });
        }
        // GPU/session facts come from the agent envelope; failure is non-fatal
        // — health already proved the service is up.
        let runtime: JSONValue = null;
        try {
          const call = await fetchWithTimeout(`${base}/agent/call`, 5_000, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tool: "sam3_runtime_status", arguments: {} }),
          });
          runtime = (await call.json().catch(() => null)) as JSONValue;
        } catch {
          /* keep runtime null */
        }
        return json({ available: true, endpoint: base, ...health, runtime });
      } catch (error) {
        return json({
          available: false,
          endpoint: base,
          hint: "SAM3 service unreachable — is the ssh tunnel (local forward to the GPU server) running?",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  const sam3Segment = tool({
    name: "sam3_segment",
    description: `Upload a loaded raster/COG layer to the remote SAM3 GPU service and segment it, adding the mask polygons as a vector layer. The prompt must be one of the mining categories (${SAM3_CATEGORIES.join(", ")}); Chinese or English synonyms such as "open pit mine" are mapped server-side.`,
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          `Mining category to extract, e.g. 露天采坑 or "open pit mine". Accepted: ${SAM3_CATEGORIES.join(", ")}.`,
        ),
      layer: z
        .string()
        .optional()
        .describe("Raster/COG layer name or id; defaults to the top-most raster layer."),
      add_as_layer: z.boolean().optional().describe("Add the polygons to the map (default true)."),
      min_score: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Withhold the mask when the model score is below this threshold."),
    }),
    callback: async (input) => {
      const rasterLayers = useAppStore
        .getState()
        .layers.filter((layer) => layer.type === "cog" || layer.type === "raster");
      if (rasterLayers.length === 0) {
        throw new Error("No raster/COG layer is loaded — SAM3 segments loaded imagery.");
      }
      // layers[0] is the bottom of the draw stack, so the last raster is the
      // top-most imagery the user sees.
      const layer = input.layer
        ? (matchLayer(input.layer, rasterLayers) ?? null)
        : rasterLayers[rasterLayers.length - 1];
      if (!layer) {
        throw new Error(
          `No raster layer matching "${input.layer}". Raster layers: ${rasterLayers
            .map((item) => item.name)
            .join(", ")}`,
        );
      }
      const url = rasterUploadUrl(layer);
      if (!url) {
        throw new Error(
          `Layer "${layer.name}" has no fetchable GeoTIFF URL; only http(s)/blob COG layers can be segmented.`,
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);
      try {
        const bytesResponse = await fetch(url, { signal: controller.signal });
        if (!bytesResponse.ok) {
          throw new Error(`Fetching the layer's GeoTIFF failed: HTTP ${bytesResponse.status}`);
        }
        const bytes = await bytesResponse.arrayBuffer();
        if (bytes.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(`Layer exceeds the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MiB upload cap.`);
        }

        const form = new FormData();
        const filename = /\.tiff?$/i.test(layer.name) ? layer.name : `${layer.name}.tif`;
        form.append("file", new File([bytes], filename, { type: "image/tiff" }), filename);
        form.append("prompt", input.prompt.trim());
        form.append("output_format", "geojson");
        if (input.min_score !== undefined) {
          form.append("confidence_threshold", String(input.min_score));
        }

        const base = sam3Endpoint();
        const response = await fetch(`${base}/segment/text`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as {
            detail?: { message?: string; categories?: string[] } | string;
          } | null;
          const detailObject = typeof detail?.detail === "object" ? detail.detail : null;
          const message = detailObject?.message ?? response.statusText;
          return json({
            error: `SAM3 rejected the request (${response.status}): ${message}`,
            ...(Array.isArray(detailObject?.categories)
              ? { categories: detailObject.categories }
              : {}),
            hint:
              response.status === 422
                ? "Retry with one of the listed mining categories."
                : "Call sam3_status to check the service.",
          });
        }
        const collection = (await response.json()) as FeatureCollection & { sam3?: Sam3Meta };
        if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
          throw new Error("SAM3 returned an unexpected response shape.");
        }
        const meta = collection.sam3 ?? {};
        // The polygons come back in the raster's native CRS; the projection is
        // read from the uploaded bytes (same path the SamGeo panel uses).
        const geojson = reprojectSamGeoResult(collection, await rasterProjection(bytes));

        let addedLayerId: string | null = null;
        if (input.add_as_layer !== false && geojson.features.length > 0) {
          addedLayerId = useAppStore.getState().addGeoJsonLayer(
            `SAM3 ${meta.category ?? input.prompt}`,
            geojson,
            `${sam3Endpoint()}/segment/text`,
          );
          const added = useAppStore.getState().layers.find((item) => item.id === addedLayerId);
          if (added) deps.getMapController()?.fitLayer(added);
        }
        return json({
          featureCount: geojson.features.length,
          score: meta.score ?? null,
          category: meta.category ?? null,
          jobId: meta.job_id ?? null,
          warnings: Array.isArray(meta.warnings) ? meta.warnings : [],
          addedLayerId,
          endpoint: base,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  });

  return [sam3Status, sam3Segment] as InvokableTool<unknown, unknown>[];
}
