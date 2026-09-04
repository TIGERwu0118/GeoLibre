import { getRuntimeEnvironment } from "@geolibre/core";
import type { InvokableTool, JSONValue } from "@strands-agents/sdk";
import { tool } from "@strands-agents/sdk";
import { z } from "zod";

/**
 * Remote InSAR product-catalog tools for the assistant.
 *
 * The insar-viz sidecar runs on the processing server behind an ssh
 * local-forward tunnel. It exposes a read-only registry of MintPy InSAR
 * time-series products (ground-deformation velocity, temporal coherence,
 * per-date stacks) through an MCP-style `/agent/call` envelope that never
 * 5xxes. The endpoint is fixed by the app (tunnel default or
 * `GEOLIBRE_INSAR_URL`), never chosen by the model — the model controls only
 * filter arguments, so there is no model-directed URL surface.
 */

/** Local forward of the processing server's insar-viz sidecar. */
export const DEFAULT_INSAR_URL = "http://127.0.0.1:8768";
const INSAR_URL_ENV = "GEOLIBRE_INSAR_URL";

/** Resolve the sidecar base URL: runtime env override, else the tunnel default. */
export function insarEndpoint(
  env: Record<string, string | undefined> = getRuntimeEnvironment(),
): string {
  return env[INSAR_URL_ENV]?.trim() || DEFAULT_INSAR_URL;
}

/** The sidecar's agent envelope (same unified shape as sam3_mcp). */
export interface InsarEnvelope {
  schema_version?: string;
  status?: "ok" | "blocked" | "failed";
  facts?: Record<string, unknown>;
  warnings?: string[];
  next_actions?: string[];
}

/** `/agent/call` failure: non-2xx (unknown tool) or unparseable envelope. */
interface InsarHttpError {
  httpError: string;
  knownTools?: string[];
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

const CALL_TIMEOUT_MS = 10_000;

/** POST one `/agent/call` dispatch and parse the envelope. */
async function agentCall(
  base: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<InsarEnvelope | InsarHttpError> {
  const response = await fetchWithTimeout(`${base}/agent/call`, CALL_TIMEOUT_MS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, arguments: args }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      detail?: { message?: string; known?: string[] };
    } | null;
    return {
      httpError: `HTTP ${response.status}: ${detail?.detail?.message ?? response.statusText}`,
      ...(Array.isArray(detail?.detail?.known) ? { knownTools: detail.detail.known } : {}),
    };
  }
  const envelope = (await response.json().catch(() => null)) as InsarEnvelope | null;
  return envelope ?? { httpError: "invalid envelope (not JSON)" };
}

const TUNNEL_HINT =
  "insar-viz sidecar unreachable — is the ssh tunnel (local forward 8768 to the processing server) running?";

/**
 * Build the InSAR tool set: a readiness probe plus catalog queries. All three
 * report structured state instead of crashing so the model can tell the user
 * what to fix (start the tunnel) rather than retrying a dead endpoint.
 */
export function createInsarTools(): InvokableTool<unknown, unknown>[] {
  const json = (value: unknown): JSONValue => value as JSONValue;

  /** Shape an envelope (or transport failure) into a model-friendly result. */
  const envelopeResult = async (
    tool: "insar_products" | "insar_product_detail" | "insar_point_timeseries",
    args: Record<string, unknown>,
  ): Promise<JSONValue> => {
    try {
      const envelope = await agentCall(insarEndpoint(), tool, args);
      if ("httpError" in envelope) {
        return json({
          error: envelope.httpError,
          ...(envelope.knownTools ? { knownTools: envelope.knownTools } : {}),
          hint: "Call insar_status to check the service.",
        });
      }
      if (envelope.status !== "ok") {
        return json({
          error: `${tool} returned ${envelope.status ?? "unknown status"}`,
          warnings: envelope.warnings ?? [],
          nextActions: envelope.next_actions ?? [],
        });
      }
      return json(envelope.facts ?? {});
    } catch (error) {
      return json({
        available: false,
        hint: TUNNEL_HINT,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const insarStatus = tool({
    name: "insar_status",
    description:
      "Check the remote InSAR product service (insar-viz sidecar over a local ssh tunnel): availability, product count, products root and cache dir. Call this before other insar tools. If unavailable, tell the user to start the tunnel/service instead of retrying.",
    inputSchema: z.object({}),
    callback: async () => {
      const base = insarEndpoint();
      try {
        const response = await fetchWithTimeout(`${base}/health`, 5_000);
        const health = (await response.json().catch(() => null)) as {
          status?: string;
          products_count?: number;
        } | null;
        if (!health || health.status !== "ok") {
          return json({ available: false, endpoint: base, health });
        }
        return json({ available: true, endpoint: base, ...health });
      } catch (error) {
        return json({
          available: false,
          endpoint: base,
          hint: TUNNEL_HINT,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  const insarProducts = tool({
    name: "insar_products",
    description:
      "List the InSAR ground-deformation products in the remote catalog: id, track (40/11/113), year, date range, grid size, quality verdict (BLOCKED products must not be used for analysis) and which render products are ready (velocity / temporal-coherence snapshots, per-date manifest).",
    inputSchema: z.object({
      year: z.number().int().optional().describe("Filter by product year, e.g. 2023."),
      track: z.number().int().optional().describe("Filter by track number: 40, 11 or 113."),
    }),
    callback: async (input) => {
      const args: Record<string, unknown> = {};
      if (input.year !== undefined) args.year = input.year;
      if (input.track !== undefined) args.track = input.track;
      return envelopeResult("insar_products", args);
    },
  });

  const insarProductDetail = tool({
    name: "insar_product_detail",
    description:
      "Full metadata of one InSAR product by id (from insar_products): dataset shapes and chunk layouts, the date list, EPSG:4326 geolocation, file roles, quality verdict and cache state.",
    inputSchema: z.object({
      product: z.string().describe("Product id, e.g. ts2023_p113_full."),
    }),
    callback: async (input) => envelopeResult("insar_product_detail", { product: input.product }),
  });

  const insarPointTimeseries = tool({
    name: "insar_point_timeseries",
    description:
      "Displacement time series (metres, cumulative since the reference date) at one point of an InSAR product's grid, read at the nearest pixel (~40 m). Use for a mine's deformation history at a coordinate. Points outside the grid are rejected with the grid bounds.",
    inputSchema: z.object({
      product: z.string().describe("Product id from insar_products."),
      lat: z.number().describe("WGS84 latitude in degrees."),
      lon: z.number().describe("WGS84 longitude in degrees."),
    }),
    callback: async (input) =>
      envelopeResult("insar_point_timeseries", {
        product: input.product,
        lat: input.lat,
        lon: input.lon,
      }),
  });

  return [insarStatus, insarProducts, insarProductDetail, insarPointTimeseries] as InvokableTool<
    unknown,
    unknown
  >[];
}
