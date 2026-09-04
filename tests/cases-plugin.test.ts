import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CASES_PLUGIN_ID,
  DEFAULT_PRODUCTS_MANIFEST_URL,
  maplibreCasesPlugin,
  mergeCasesSettings,
} from "../packages/plugins/src/plugins/maplibre-cases";
import {
  CASE_STYLE_PRESETS,
  CASE_TASKS,
} from "../packages/plugins/src/plugins/case-kit";
import {
  metricsSummary,
  parseProducts,
  presetFor,
  productBbox,
  productLayerName,
} from "../packages/plugins/src/plugins/case-kit";

test("cases plugin registers under its own id with the products manifest URL", () => {
  assert.equal(CASES_PLUGIN_ID, "maplibre-cases");
  assert.equal(typeof maplibreCasesPlugin.activate, "function");
  assert.equal(typeof maplibreCasesPlugin.deactivate, "function");
  assert.equal(DEFAULT_PRODUCTS_MANIFEST_URL, "http://127.0.0.1:8767/geolibre-products/products.json");
  assert.deepEqual(
    CASE_TASKS.map((task) => task.id),
    ["violation", "hazard", "eco"],
  );
});

test("mergeCasesSettings trims the URL and falls back to the default when blank", () => {
  assert.deepEqual(mergeCasesSettings(undefined), { productsUrl: DEFAULT_PRODUCTS_MANIFEST_URL });
  assert.deepEqual(mergeCasesSettings({ productsUrl: "   " }), { productsUrl: DEFAULT_PRODUCTS_MANIFEST_URL });
  assert.deepEqual(mergeCasesSettings({ productsUrl: " http://10.0.0.2:8767/geolibre-products/products.json " }), {
    productsUrl: "http://10.0.0.2:8767/geolibre-products/products.json",
  });
});

test("parseProducts filters by task, resolves relative URLs, and skips junk", () => {
  const manifestUrl = "http://127.0.0.1:8767/geolibre-products/products.json";
  const manifest = [
    {
      product_id: "hazard:insar_patch:P113FULL:2024",
      task: "hazard",
      type: "insar_patch",
      format: "geojson",
      url: "/geolibre-products/hazard/insar_patch/insar_patches_2024_p113full.geojson",
      status: "ok",
      year: "2024",
    },
    { task: "eco", type: "eco_index", format: "cog", url: "/x.tif", product_id: "eco:x" },
    { task: "hazard", type: "insar_patch", format: "geojson", url: "/y.geojson", status: "failed", product_id: "h:y" },
    { task: "hazard", type: "", format: "geojson", url: "/z.geojson", product_id: "h:z" },
    { task: "hazard", type: "loss_report", format: "md", url: 42, product_id: "h:r" },
    "junk",
  ];
  const hazard = parseProducts(manifest, manifestUrl, "hazard");
  assert.equal(hazard.length, 1);
  assert.equal(hazard[0].name, "形变斑 2024");
  assert.equal(
    hazard[0].url,
    "http://127.0.0.1:8767/geolibre-products/hazard/insar_patch/insar_patches_2024_p113full.geojson",
  );
  assert.equal(parseProducts(manifest, manifestUrl, "eco").length, 1);
  assert.equal(parseProducts("not an array", manifestUrl, "hazard").length, 0);
});

test("productLayerName labels by type and stays unique per mine", () => {
  assert.equal(productLayerName({ product_id: "a", task: "hazard", type: "insar_patch", format: "geojson", url: "u", year: "2024" }), "形变斑 2024");
  assert.equal(
    productLayerName({ product_id: "a", task: "eco", type: "eco_index", format: "cog", url: "u", year: "2024", et_id: "ET41" }),
    "生态指数 2024 · ET41",
  );
  assert.notEqual(
    productLayerName({ product_id: "a", task: "base", type: "imagery_cog", format: "cog", url: "u", year: "2024", et_id: "ET1", mine_name: "甲矿" }),
    productLayerName({ product_id: "b", task: "base", type: "imagery_cog", format: "cog", url: "u", year: "2024", et_id: "ET2", mine_name: "乙矿" }),
  );
});

test("style presets pin the byte range for imagery and window the velocity ramp", () => {
  assert.deepEqual(CASE_STYLE_PRESETS.imagery_cog, { kind: "cog", options: { rescaleMin: 0, rescaleMax: 255 } });
  assert.deepEqual(CASE_STYLE_PRESETS.insar_velocity, {
    kind: "cog",
    options: { bands: "1", colormap: "rdylgn", rescaleMin: -0.1, rescaleMax: 0.1, opacity: 0.9 },
  });
  assert.equal(CASE_STYLE_PRESETS.insar_patch.kind, "geojson");
  assert.equal((CASE_STYLE_PRESETS.violation_zone as { kind: string }).kind, "geojson");
  const fallback = presetFor("unknown-type");
  assert.equal(fallback.kind, "geojson");
});

test("productBbox validates wsen order and metricsSummary whitelists keys", () => {
  assert.deepEqual(
    productBbox({ product_id: "a", task: "hazard", type: "t", format: "geojson", url: "u", bbox: [111, 33, 112, 34] } as never),
    [111, 33, 112, 34],
  );
  assert.equal(productBbox({ product_id: "a", task: "hazard", type: "t", format: "geojson", url: "u", bbox: [112, 33, 111, 34] } as never), null);
  assert.equal(productBbox({ product_id: "a", task: "hazard", type: "t", format: "geojson", url: "u" } as never), null);
  const summary = metricsSummary({
    product_id: "a",
    task: "hazard",
    type: "insar_patch",
    format: "geojson",
    url: "u",
    metrics: { patch_count: 3, in_mine_area_m2: 184000, secret: 1 },
  });
  assert.ok(summary.includes("形变斑 3"));
  assert.ok(summary.includes("矿内面积m² 184000"));
  assert.ok(!summary.includes("secret"));
});
