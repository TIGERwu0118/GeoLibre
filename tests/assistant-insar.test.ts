import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  createInsarTools,
  DEFAULT_INSAR_URL,
  insarEndpoint,
} from "../apps/geolibre-desktop/src/lib/assistant/insar";

type AnyTool = { name: string; invoke: (input: unknown) => Promise<unknown> };

function toolsByName(): Map<string, AnyTool> {
  const tools = createInsarTools() as unknown as AnyTool[];
  return new Map(tools.map((item) => [item.name, item]));
}

/** A sidecar-style ok envelope. */
function okEnvelope(facts: Record<string, unknown>): unknown {
  return {
    schema_version: "insar-viz/agent-v1",
    status: "ok",
    facts,
    artifacts: [],
    warnings: [],
    next_actions: [],
    provenance: { server: "insar-viz" },
  };
}

/** A sidecar-style blocked envelope. */
function blockedEnvelope(warnings: string[], next_actions: string[]): unknown {
  return {
    schema_version: "insar-viz/agent-v1",
    status: "blocked",
    facts: {},
    artifacts: [],
    warnings,
    next_actions,
    provenance: { server: "insar-viz" },
  };
}

describe("insarEndpoint", () => {
  it("defaults to the ssh-tunnel local forward", () => {
    assert.equal(insarEndpoint({}), DEFAULT_INSAR_URL);
    assert.equal(DEFAULT_INSAR_URL, "http://127.0.0.1:8768");
  });

  it("honours the GEOLIBRE_INSAR_URL runtime override", () => {
    assert.equal(insarEndpoint({ GEOLIBRE_INSAR_URL: " http://elsewhere:9000 " }), "http://elsewhere:9000");
  });
});

describe("insar tools", () => {
  it("registers exactly the four catalog tools", () => {
    assert.deepEqual([...toolsByName().keys()].sort(), [
      "insar_point_timeseries",
      "insar_product_detail",
      "insar_products",
      "insar_status",
    ]);
  });
});

describe("insar_status (mocked fetch)", () => {
  const originalFetch = globalThis.fetch;

  it("reports available with the health facts", async () => {
    globalThis.fetch = (async (url: unknown) => {
      assert.match(String(url), /\/health$/);
      return new Response(
        JSON.stringify({
          status: "ok",
          products_count: 17,
          products_root: "/home/wst/hdd",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const result = (await toolsByName().get("insar_status")!.invoke({})) as {
        available: boolean;
        products_count: number;
      };
      assert.equal(result.available, true);
      assert.equal(result.products_count, 17);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports unavailable when health is degraded", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "degraded", error: "scan failed" }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const result = (await toolsByName().get("insar_status")!.invoke({})) as {
        available: boolean;
      };
      assert.equal(result.available, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports unavailable with a tunnel hint when the sidecar is down", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    try {
      const result = (await toolsByName().get("insar_status")!.invoke({})) as {
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

describe("insar_products (mocked fetch)", () => {
  const originalFetch = globalThis.fetch;

  it("passes year/track filters in the /agent/call body and returns the facts", async () => {
    const bodies: { tool: string; arguments: unknown }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      assert.match(String(url), /\/agent\/call$/);
      const payload = JSON.parse(String(init?.body)) as {
        tool: string;
        arguments: unknown;
      };
      bodies.push(payload);
      return new Response(
        JSON.stringify(
          okEnvelope({
            count: 2,
            products: [
              { id: "ts2023_p113_full", year: 2023, track: 113, quality_verdict: "UNKNOWN" },
              { id: "ts2024_p113_full", year: 2024, track: 113, quality_verdict: "UNKNOWN" },
            ],
          }),
        ),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const result = (await toolsByName().get("insar_products")!.invoke({
        track: 113,
        year: 2023,
      })) as { count: number; products: { id: string }[] };
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].tool, "insar_products");
      assert.deepEqual(bodies[0].arguments, { track: 113, year: 2023 });
      assert.equal(result.count, 2);
      assert.equal(result.products[0].id, "ts2023_p113_full");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces blocked-envelope warnings and next actions", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(blockedEnvelope(["missing required argument"], ["call insar_products"])),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const result = (await toolsByName().get("insar_products")!.invoke({})) as {
        error: string;
        warnings: string[];
        nextActions: string[];
      };
      assert.match(result.error, /blocked/);
      assert.deepEqual(result.warnings, ["missing required argument"]);
      assert.deepEqual(result.nextActions, ["call insar_products"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces an unknown-tool 404 with the known tool list", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          detail: {
            message: "unknown tool",
            known: ["insar_status", "insar_products", "insar_product_detail"],
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const result = (await toolsByName().get("insar_products")!.invoke({})) as {
        error: string;
        knownTools: string[];
      };
      assert.match(result.error, /404/);
      assert.equal(result.knownTools.length, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports unavailable with a tunnel hint on transport failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    try {
      const result = (await toolsByName().get("insar_products")!.invoke({})) as {
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

describe("insar_product_detail (mocked fetch)", () => {
  const originalFetch = globalThis.fetch;

  it("returns the product facts untouched", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(
          okEnvelope({
            product: { id: "ts2022", n_dates: 9, geo: { crs: "EPSG:4326" } },
          }),
        ),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const result = (await toolsByName().get("insar_product_detail")!.invoke({
        product: "ts2022",
      })) as { product: { id: string; n_dates: number } };
      assert.equal(result.product.id, "ts2022");
      assert.equal(result.product.n_dates, 9);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a blocked envelope for an unknown product with known ids", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(
          blockedEnvelope(
            ["unknown product: nope"],
            ["call insar_products; known ids: ts2022, ts2023"],
          ),
        ),
        { headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const result = (await toolsByName().get("insar_product_detail")!.invoke({
        product: "nope",
      })) as { error: string; nextActions: string[] };
      assert.match(result.error, /blocked/);
      assert.match(result.nextActions[0], /insar_products/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Live regression against the real insar-viz sidecar (ssh tunnel on :8768).
 * Skipped silently when the sidecar is down, so the suite stays green on
 * machines without the tunnel.
 */
describe("insar live (tunnel)", () => {
  let live = false;

  before(async () => {
    try {
      const response = await fetch(`${DEFAULT_INSAR_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const health = (await response.json()) as { status?: string };
      live = health.status === "ok";
    } catch {
      live = false;
    }
  });

  it("status reports the deployed sidecar with 17 products", async () => {
    if (!live) return;
    const result = (await toolsByName().get("insar_status")!.invoke({})) as {
      available: boolean;
      products_count: number;
    };
    assert.equal(result.available, true);
    assert.ok(result.products_count! >= 15, `unexpected products_count ${result.products_count}`);
  });

  it("track-113 filter includes the BLOCKED 2022 product", async () => {
    if (!live) return;
    const result = (await toolsByName().get("insar_products")!.invoke({ track: 113 })) as {
      count: number;
      products: { id: string; quality_verdict: string; n_dates: number }[];
    };
    assert.ok(result.count! >= 5);
    const blocked = result.products.find((row) => row.id === "ts2022_p113_full");
    assert.equal(blocked?.quality_verdict, "BLOCKED");
    assert.equal(blocked?.n_dates, 30);
  });

  it("detail of ts2022 returns dates and cache readiness", async () => {
    if (!live) return;
    const result = (await toolsByName().get("insar_product_detail")!.invoke({
      product: "ts2022",
    })) as {
      product: {
        n_dates: number;
        dates: string[];
        cache: { velocity_cog: boolean; manifest: boolean };
        geo: { crs: string };
      };
    };
    assert.ok(result.product.n_dates >= 8);
    assert.match(result.product.dates[0], /^\d{8}$/);
    assert.equal(result.product.cache.velocity_cog, true);
    assert.equal(result.product.cache.manifest, true);
    assert.equal(result.product.geo.crs, "EPSG:4326");
  });

  it("point timeseries inside the grid returns the displacement series", async () => {
    if (!live) return;
    const result = (await toolsByName().get("insar_point_timeseries")!.invoke({
      product: "ts2022",
      lat: 34.55,
      lon: 113.95,
    })) as {
      product: string;
      dates: string[];
      values_m: (number | null)[];
      pixel_size_m: number;
    };
    assert.equal(result.product, "ts2022");
    assert.equal(result.dates.length >= 8, true);
    assert.equal(result.values_m.length, result.dates.length);
    assert.ok(result.pixel_size_m > 20 && result.pixel_size_m < 60);
    // The reference date is exactly zero displacement.
    assert.ok(Math.abs((result.values_m[0] ?? 1)) < 1e-6 || result.values_m[0] !== null);
  });
});
