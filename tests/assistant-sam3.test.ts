import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  DEFAULT_SAM3_URL,
  SAM3_CATEGORIES,
  createSam3Tools,
  rasterUploadUrl,
  sam3Endpoint,
} from "../apps/geolibre-desktop/src/lib/assistant/sam3";

type AnyTool = { name: string; invoke: (input: unknown) => Promise<unknown> };

function toolsByName(): Map<string, AnyTool> {
  const tools = createSam3Tools({ getMapController: () => null }) as unknown as AnyTool[];
  return new Map(tools.map((item) => [item.name, item]));
}

/** A raster layer whose bytes the tool can fetch from `url`. */
function cogLayer(overrides: Record<string, unknown> = {}): GeoLibreLayer {
  return {
    id: "cog-1",
    name: "mine imagery",
    type: "cog",
    source: { type: "raster", url: "http://127.0.0.1:8767/mine_fid0_cog.tif" },
    visible: true,
    opacity: 1,
    metadata: {},
    ...overrides,
  } as unknown as GeoLibreLayer;
}

/** Install layers and return a restore function (tests share the store). */
function setLayers(layers: GeoLibreLayer[]): () => void {
  const previous = useAppStore.getState().layers;
  useAppStore.setState({ layers });
  return () => useAppStore.setState({ layers: previous });
}

/** A WGS84-tagged FeatureCollection so no client reprojection is needed. */
function segmentResponse(features = 1): unknown {
  return {
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "EPSG:4326" } },
    features: Array.from({ length: features }, () => ({
      type: "Feature",
      properties: { score: 0.87, category: "露天采坑", value: 1 },
      geometry: { type: "Polygon", coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] },
    })),
    sam3: { job_id: "job-7", score: 0.874, category: "露天采坑", warnings: [] },
  };
}

describe("sam3Endpoint", () => {
  it("defaults to the ssh-tunnel local forward", () => {
    assert.equal(sam3Endpoint({}), DEFAULT_SAM3_URL);
    assert.equal(DEFAULT_SAM3_URL, "http://127.0.0.1:8766");
  });

  it("honours the GEOLIBRE_SAM3_URL runtime override", () => {
    assert.equal(sam3Endpoint({ GEOLIBRE_SAM3_URL: " http://elsewhere:9000 " }), "http://elsewhere:9000");
  });
});

describe("rasterUploadUrl", () => {
  it("uses the layer's original source url", () => {
    assert.equal(rasterUploadUrl(cogLayer()), "http://127.0.0.1:8767/mine_fid0_cog.tif");
  });

  it("prefers source.url over a re-encoded localBytesUrl copy", () => {
    const layer = cogLayer({ metadata: { localBytesUrl: "blob:original-bytes" } });
    assert.equal(rasterUploadUrl(layer), "http://127.0.0.1:8767/mine_fid0_cog.tif");
  });

  it("falls back to localBytesUrl when it is the only fetchable bytes", () => {
    const layer = cogLayer({
      source: { type: "raster" },
      metadata: { localBytesUrl: "blob:original-bytes" },
    });
    assert.equal(rasterUploadUrl(layer), "blob:original-bytes");
  });

  it("rejects non-raster layers and URLs that cannot be fetched", () => {
    assert.equal(rasterUploadUrl({ type: "geojson" } as unknown as GeoLibreLayer), null);
    assert.equal(
      rasterUploadUrl(cogLayer({ source: { type: "raster", url: "file:///tmp/x.tif" } })),
      null,
    );
  });
});

describe("sam3 tools", () => {
  it("registers exactly sam3_status and sam3_segment", () => {
    assert.deepEqual([...toolsByName().keys()].sort(), ["sam3_segment", "sam3_status"]);
  });

  it("exposes the mining taxonomy in the segment tool description", () => {
    const segment = toolsByName().get("sam3_segment")!;
    const spec = (segment as unknown as { toolSpec: { description: string } }).toolSpec;
    for (const category of SAM3_CATEGORIES) {
      assert.ok(spec.description.includes(category), `description must mention ${category}`);
    }
  });
});

describe("sam3_status (mocked fetch)", () => {
  const originalFetch = globalThis.fetch;

  it("reports available with health and runtime facts", async () => {
    globalThis.fetch = (async (url: unknown) => {
      const target = String(url);
      if (target.endsWith("/health")) {
        return new Response(
          JSON.stringify({ status: "ok", gpu_index: 0, categories: ["露天采坑"] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.endsWith("/agent/call")) {
        return new Response(JSON.stringify({ status: "ok", facts: { ready_for_inference: true } }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    try {
      const result = (await toolsByName().get("sam3_status")!.invoke({})) as {
        available: boolean;
        runtime: { facts: { ready_for_inference: boolean } };
      };
      assert.equal(result.available, true);
      assert.equal(result.runtime.facts.ready_for_inference, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports unavailable with a tunnel hint when the service is down", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    try {
      const result = (await toolsByName().get("sam3_status")!.invoke({})) as {
        available: boolean;
        hint: string;
      };
      assert.equal(result.available, false);
      assert.match(result.hint, /tunnel/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("sam3_segment (mocked fetch)", () => {
  const originalFetch = globalThis.fetch;

  it("uploads the layer bytes and adds the polygons to the map", async () => {
    const restore = setLayers([cogLayer()]);
    const uploads: { url: string; prompt: string | null }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target === "http://127.0.0.1:8767/mine_fid0_cog.tif") {
        return new Response(new ArrayBuffer(8));
      }
      if (target.endsWith("/segment/text")) {
        const form = init?.body as FormData;
        uploads.push({
          url: target,
          prompt: form.get("prompt") as string | null,
        });
        return new Response(JSON.stringify(segmentResponse(2)), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    }) as typeof fetch;
    try {
      const result = (await toolsByName().get("sam3_segment")!.invoke({
        prompt: "采坑",
      })) as {
        featureCount: number;
        score: number;
        category: string;
        addedLayerId: string | null;
        endpoint: string;
      };
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].prompt, "采坑");
      assert.match(uploads[0].url, /\/segment\/text$/);
      assert.equal(result.featureCount, 2);
      assert.equal(result.score, 0.874);
      assert.equal(result.category, "露天采坑");
      assert.ok(result.addedLayerId);
      const added = useAppStore.getState().layers.find((layer) => layer.id === result.addedLayerId);
      assert.equal(added?.name, "SAM3 露天采坑");
      assert.equal(added?.geojson?.features.length, 2);
      assert.equal(added?.geojson?.features[0]?.properties?.score, 0.87);
      assert.equal(added?.geojson?.features[0]?.properties?.sam3_job_id, "job-7");
      assert.equal(added?.geojson?.features[0]?.properties?.sam3_source_layer, "mine imagery");
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  });

  it("surfaces the accepted categories on a 422 so the model can retry", async () => {
    const restore = setLayers([cogLayer()]);
    globalThis.fetch = (async (url: unknown) => {
      const target = String(url);
      if (target.endsWith(".tif")) return new Response(new ArrayBuffer(8));
      return new Response(
        JSON.stringify({
          detail: {
            message: "prompt is not one of the mining taxonomy categories",
            categories: [...SAM3_CATEGORIES],
          },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const result = (await toolsByName().get("sam3_segment")!.invoke({
        prompt: "nonsense",
        add_as_layer: false,
      })) as { error: string; categories: string[]; hint: string };
      assert.match(result.error, /422/);
      assert.deepEqual(result.categories, [...SAM3_CATEGORIES]);
      assert.match(result.hint, /categories/);
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  });

  it("throws a readable error when no raster layer is loaded", async () => {
    const restore = setLayers([]);
    try {
      await assert.rejects(
        toolsByName().get("sam3_segment")!.invoke({ prompt: "采坑" }),
        /No raster\/COG layer/,
      );
    } finally {
      restore();
    }
  });
});

/**
 * Live regression against the real GPU service (ssh tunnel on :8766 plus the
 * CORS/Range server on :8767 serving the mine COG). Skipped silently when
 * either is down, so the suite stays green on machines without the tunnel.
 */
describe("sam3 live (tunnel)", () => {
  let live = false;
  const originalFetch = globalThis.fetch;

  before(async () => {
    try {
      const response = await fetch(`${DEFAULT_SAM3_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const health = (await response.json()) as { status?: string };
      live = health.status === "ok";
    } catch {
      live = false;
    }
  });

  it("segments the mine COG regression baseline (8 features, score≈0.87)", async () => {
    if (!live) return; // node:test has no skip-after-start; treat as no-op
    const restore = setLayers([cogLayer()]);
    try {
      const result = (await toolsByName().get("sam3_segment")!.invoke({
        prompt: "采坑",
      })) as { featureCount: number; score: number; addedLayerId: string | null };
      assert.equal(result.featureCount, 8);
      assert.ok(result.score! > 0.8 && result.score! < 0.95, `unexpected score ${result.score}`);
      assert.ok(result.addedLayerId);
      const added = useAppStore.getState().layers.find((layer) => layer.id === result.addedLayerId);
      const first = added?.geojson?.features[0]?.geometry as
        | { coordinates: number[][][] }
        | undefined;
      const [lng, lat] = first?.coordinates?.[0]?.[0] ?? [];
      // WGS84 lon/lat for the mine site — catches a native-CRS leak.
      assert.ok(Number.isFinite(lng) && Number.isFinite(lat));
      assert.ok(lng! > -180 && lng! < 180 && lat! > -90 && lat! < 90);
    } finally {
      restore();
    }
  });
});
