import assert from "node:assert/strict";
import { test } from "node:test";

import type { FeatureCollection } from "geojson";

import {
  decorateSamGeoResult,
  reprojectSamGeoResult,
  sanitizeSamGeoState,
} from "../packages/plugins/src/plugins/maplibre-samgeo";

test("sanitizeSamGeoState keeps only well-typed, in-range fields", () => {
  const next = sanitizeSamGeoState({
    apiUrl: "http://example.test",
    mode: "box",
    backend: "transformers",
    confidence: 5,
    pointsPerSide: 0,
    minSize: Number.NaN,
    modelId: 42,
    unknown: "ignored",
  });
  assert.deepEqual(next, {
    apiUrl: "http://example.test",
    mode: "box",
    backend: "transformers",
    confidence: 1,
    pointsPerSide: 1,
  });
});

test("sanitizeSamGeoState rejects unions outside Mode/backend and non-objects", () => {
  assert.deepEqual(sanitizeSamGeoState({ mode: "magic", backend: "other", apiUrl: 7 }), {});
  assert.deepEqual(sanitizeSamGeoState(null), {});
  assert.deepEqual(sanitizeSamGeoState(["apiUrl"]), {});
  assert.deepEqual(sanitizeSamGeoState("text"), {});
});

const square = (x: number, y: number): FeatureCollection => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [x, y],
            [x + 1, y],
            [x + 1, y + 1],
            [x, y + 1],
            [x, y],
          ],
        ],
      },
    },
  ],
});

test("reprojectSamGeoResult converts projected coordinates to WGS84", () => {
  const result = reprojectSamGeoResult(
    square(500_000, 0),
    "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs",
  );
  const [lng, lat] = (result.features[0]!.geometry as { coordinates: number[][][] })
    .coordinates[0]![0]!;
  assert.ok(Math.abs(lng - 15) < 1e-6, `lng ${lng}`);
  assert.ok(Math.abs(lat) < 1e-6, `lat ${lat}`);
});

test("reprojectSamGeoResult leaves WGS84 results alone regardless of source projection", () => {
  const fc = {
    ...square(10, 20),
    crs: {
      type: "name",
      properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" },
    },
  } as FeatureCollection;
  const result = reprojectSamGeoResult(fc, "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs");
  assert.deepEqual(result.features[0]!.geometry, fc.features[0]!.geometry);
  assert.deepEqual(
    reprojectSamGeoResult(
      {
        ...square(1, 2),
        crs: { type: "name", properties: { name: "EPSG::4326" } },
      } as FeatureCollection,
      null,
    ).features[0]!.geometry,
    square(1, 2).features[0]!.geometry,
  );
});

test("reprojectSamGeoResult refuses non-WGS84 results with no known projection", () => {
  assert.throws(() => reprojectSamGeoResult(square(500_000, 0), null), /WGS84/);
  // An empty result has nothing to misplace.
  assert.deepEqual(
    reprojectSamGeoResult({ type: "FeatureCollection", features: [] }, null).features,
    [],
  );
});

test("decorateSamGeoResult keeps server attributes and adds editable provenance", () => {
  const result = decorateSamGeoResult(square(10, 20), {
    prompt: "露天采坑",
    mode: "text",
    sourceLayer: "mine imagery",
    sourceUrl: "http://127.0.0.1:8767/mine.tif",
    metadata: { job_id: "job-1", score: 0.87, category: "露天采坑" },
  });
  const feature = result.features[0]!;
  assert.equal(feature.id, "sam3-job-1-1");
  assert.deepEqual(feature.properties, {
    sam3_prompt: "露天采坑",
    sam3_category: "露天采坑",
    sam3_mode: "text",
    sam3_score: 0.87,
    sam3_job_id: "job-1",
    sam3_source_layer: "mine imagery",
    sam3_source_url: "http://127.0.0.1:8767/mine.tif",
    sam3_review_status: "candidate",
    sam3_editable: true,
  });
});
