import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_INSAR_API_URL,
  INSAR_DOWNLOAD_ARM_SECONDS,
  INSAR_DOWNLOAD_CONFIRM_PHRASE,
  INSAR_PLUGIN_ID,
  insarBoundsFromGeo,
  insarManifestUrl,
  insarRasterUrl,
  maplibreInsarPlugin,
} from "../packages/plugins/src/plugins/maplibre-insar";
import { __resetRightPanelRegistryForTests } from "../packages/plugins/src/right-panel-registry";

test("insarRasterUrl joins base, product and kind with escaping", () => {
  assert.equal(
    insarRasterUrl("http://127.0.0.1:8768/", "ts2023_p113_full", "velocity"),
    "http://127.0.0.1:8768/raster/ts2023_p113_full/velocity",
  );
  assert.equal(
    insarRasterUrl("http://host:9000", "../escape", "tempcoh"),
    "http://host:9000/raster/..%2Fescape/tempcoh",
  );
});

test("insarBoundsFromGeo computes WGS84 bounds from the MintPy affine", () => {
  // North-up grid: y_first is the top, y_step negative.
  const bounds = insarBoundsFromGeo({
    x_first: 113.4,
    y_first: 34.9,
    x_step: 0.00045,
    y_step: -0.00035,
    length: 1924,
    width: 2415,
  });
  assert.ok(bounds);
  assert.ok(Math.abs(bounds[0] - 113.4) < 1e-9);
  assert.ok(Math.abs(bounds[1] - (34.9 - 1924 * 0.00035)) < 1e-9);
  assert.ok(Math.abs(bounds[2] - (113.4 + 2415 * 0.00045)) < 1e-9);
  assert.ok(Math.abs(bounds[3] - 34.9) < 1e-9);
  assert.ok(bounds[0] < bounds[2] && bounds[1] < bounds[3]);
  // Bounds stay in valid lon/lat territory for this AOI.
  assert.ok(bounds[1] > 33 && bounds[3] < 36 && bounds[0] > 111 && bounds[2] < 115);
});

test("insarBoundsFromGeo returns null on incomplete geo", () => {
  assert.equal(insarBoundsFromGeo(null), null);
  assert.equal(insarBoundsFromGeo({ x_first: 1, y_first: 2 }), null);
  assert.equal(
    insarBoundsFromGeo({ x_first: 1, y_first: 2, x_step: 0.1, y_step: -0.1, length: 10 }),
    null,
  );
});

test("plugin registers the right panel without touching the DOM until render", () => {
  __resetRightPanelRegistryForTests();
  let registration: { id: string; title: string | (() => string) } | null = null;
  const app = {
    registerRightPanel(panel: { id: string; title: string | (() => string) }) {
      registration = panel;
      return () => undefined;
    },
    openRightPanel: () => true,
    closeRightPanel: () => undefined,
  } as unknown as Parameters<typeof maplibreInsarPlugin.activate>[0];

  maplibreInsarPlugin.activate(app);
  try {
    assert.ok(registration, "panel was not registered");
    assert.equal(registration!.id, "insar-products-panel");
    const title = registration!.title;
    assert.ok(typeof title === "function" ? title() : title);
    assert.equal(maplibreInsarPlugin.id, INSAR_PLUGIN_ID);
    assert.equal(maplibreInsarPlugin.name, "InSAR");
  } finally {
    maplibreInsarPlugin.deactivate(app);
    __resetRightPanelRegistryForTests();
  }
});

test("insarManifestUrl joins base and product with escaping", () => {
  assert.equal(
    insarManifestUrl("http://127.0.0.1:8768/", "ts2023_p113_full"),
    "http://127.0.0.1:8768/manifest/ts2023_p113_full",
  );
});

test("default endpoint is the insar-viz tunnel local forward", () => {
  assert.equal(DEFAULT_INSAR_API_URL, "http://127.0.0.1:8768");
});

test("download-start contract: fixed phrase mirrors the sidecar, arming is short-lived", () => {
  // Must equal DOWNLOAD_CONFIRM_PHRASE in the sidecar's http_api.py — the
  // server refuses POST /download/start without the exact phrase.
  assert.equal(INSAR_DOWNLOAD_CONFIRM_PHRASE, "启动 SLC 下载");
  assert.ok(INSAR_DOWNLOAD_ARM_SECONDS >= 3 && INSAR_DOWNLOAD_ARM_SECONDS <= 10);
});
