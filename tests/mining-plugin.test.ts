import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUFFER_LAYER_STYLE,
  DEFAULT_BUFFER_GEOJSON_URL,
  DEFAULT_LOCAL_IMAGERY_URL,
  DEFAULT_MINE_GEOJSON_URL,
  jl1TileUrlTemplate,
  maplibreMiningPlugin,
  mergeMiningSettings,
  MINE_AREA_BOUNDS,
  MINING_PLUGIN_ID,
  MINE_LAYER_NAME,
  MINE_LAYER_STYLE,
  miningImageryLayerName,
} from "../packages/plugins/src/plugins/maplibre-mining";
import { __resetRightPanelRegistryForTests } from "../packages/plugins/src/right-panel-registry";

test("jl1TileUrlTemplate builds the TMS template with encoded credentials", () => {
  const url = jl1TileUrlTemplate("abc123", "tk/with+special");
  assert.equal(
    url,
    "https://api.jl1mall.com/getMap/{z}/{x}/{y}?mk=abc123&tk=tk%2Fwith%2Bspecial&vf=0",
  );
  // {y} stays a plain placeholder: the TMS flip is expressed via the raster
  // source's scheme:"tms", never via a {-y} token the host cannot resolve.
  assert.ok(url.includes("/{z}/{x}/{y}?"));
});

test("mining settings merge ignores junk and trims credentials", () => {
  const merged = mergeMiningSettings({
    mineUrl: " http://x/mine.geojson ",
    year: "2023",
    tk: " tk1 ",
    mkByYear: { "2024": " mk4 ", broken: true },
    bufferUrl: 42,
    imageryUrl: " http://127.0.0.1:9194/all/{z}/{x}/{y}.png ",
    imageryMode: "api",
  });
  assert.equal(merged.mineUrl, "http://x/mine.geojson");
  assert.equal(merged.year, "2023");
  assert.equal(merged.tk, "tk1");
  assert.equal(merged.mkByYear["2024"], "mk4");
  assert.equal(merged.bufferUrl, DEFAULT_BUFFER_GEOJSON_URL);
  assert.equal(merged.imageryUrl, "http://127.0.0.1:9194/all/{z}/{x}/{y}.png");
  assert.equal(merged.imageryMode, "api");
  // Defaults survive for anything absent or malformed.
  const empty = mergeMiningSettings(null);
  assert.equal(empty.mineUrl, DEFAULT_MINE_GEOJSON_URL);
  assert.equal(empty.imageryMode, "local");
  assert.equal(empty.imageryUrl, DEFAULT_LOCAL_IMAGERY_URL);
  assert.equal(empty.year, "2024");
  assert.deepEqual(empty.mkByYear, { "2022": "", "2023": "", "2024": "" });
  assert.equal(mergeMiningSettings({ year: "1999" }).year, "2024");
  assert.equal(mergeMiningSettings({ imageryMode: "weird" }).imageryMode, "local");
});

test("layer styles are visible outlines over faint fills", () => {
  for (const style of [MINE_LAYER_STYLE, BUFFER_LAYER_STYLE]) {
    assert.ok(/^#[0-9a-f]{6}$/i.test(style.strokeColor));
    assert.ok(style.strokeWidth >= 1.5);
    assert.ok(style.fillOpacity > 0 && style.fillOpacity <= 0.12);
    assert.equal(style.fillColor, style.strokeColor);
  }
  // The deployment contract: rights are red, the 500 m buffer is blue.
  assert.equal(MINE_LAYER_STYLE.strokeColor.toLowerCase(), "#e60000");
  assert.equal(BUFFER_LAYER_STYLE.strokeColor.toLowerCase(), "#2563eb");
  assert.notEqual(MINE_LAYER_STYLE.strokeColor, BUFFER_LAYER_STYLE.strokeColor);
});

test("mine-area bounds cover the rights extent and stay valid WGS84", () => {
  const [west, south, east, north] = MINE_AREA_BOUNDS;
  assert.ok(west < east && south < north);
  // Slightly padded around the converted shapefile extent
  // (lon 111.11–113.55, lat 33.76–35.04).
  assert.ok(west <= 111.11 && east >= 113.55);
  assert.ok(south <= 33.76 && north >= 35.04);
});

test("imagery layer name carries the mosaic year", () => {
  assert.equal(miningImageryLayerName("2024"), "吉林一号2024一张图");
  assert.notEqual(miningImageryLayerName("2023"), miningImageryLayerName("2024"));
  assert.ok(MINE_LAYER_NAME.includes("红线"));
});

test("plugin registers the right panel without touching the DOM until render", () => {
  __resetRightPanelRegistryForTests();
  let registration: { id: string; title: string | (() => string) } | null = null;
  const app = {
    registerRightPanel: (reg: { id: string; title: string | (() => string) }) => {
      registration = reg;
      return () => undefined;
    },
    openRightPanel: () => true,
    closeRightPanel: () => undefined,
  } as unknown as Parameters<typeof maplibreMiningPlugin.activate>[0];

  maplibreMiningPlugin.activate(app);
  try {
    assert.ok(registration, "panel was not registered");
    assert.equal(registration!.id, "mining-overview-panel");
    assert.equal(typeof registration!.title === "function" ? registration!.title() : registration!.title, "矿山总览（50 矿权）");
    assert.equal(maplibreMiningPlugin.id, MINING_PLUGIN_ID);
  } finally {
    maplibreMiningPlugin.deactivate(app);
    __resetRightPanelRegistryForTests();
  }
});
