/**
 * InSAR ground-deformation product panel backed by the insar-viz sidecar.
 *
 * The sidecar (processing server behind an ssh local-forward tunnel, default
 * :8768) exposes a read-only registry of MintPy InSAR products plus cached
 * velocity / temporal-coherence COG snapshots. The panel lists the catalog,
 * shows each product's quality verdict, and adds a chosen snapshot as a
 * client-rendered COG layer. BLOCKED products stay visibly unusable rather
 * than being silently rendered.
 */

import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const INSAR_PLUGIN_ID = "maplibre-insar";
const PANEL_ID = "insar-products-panel";
export const DEFAULT_INSAR_API_URL = "http://127.0.0.1:8768";

/** One product row as the sidecar's `/products` summary reports it. */
export interface InsarProductRow {
  id: string;
  year: number | null;
  track: number | null;
  variant: string | null;
  quality_verdict?: string | null;
  n_dates?: number;
  date_range?: [string, string] | null;
  grid?: [number, number] | null;
  velocity_unit?: string | null;
  has?: {
    velocity_cog?: boolean;
    tempcoh_cog?: boolean;
    manifest?: boolean;
  };
  /** Full-record shape from GET /products (the agent summary uses `has`). */
  cache?: {
    velocity_cog?: boolean;
    tempcoh_cog?: boolean;
    manifest?: boolean;
  };
  /** Full-record shape: the raw date list (summary sends date_range). */
  dates?: string[];
}

/** Geolocation block of a product detail record (EPSG:4326 affine). */
export interface InsarGeo {
  crs?: string;
  x_first?: number;
  y_first?: number;
  x_step?: number;
  y_step?: number;
  length?: number;
  width?: number;
}

export type InsarRasterKind = "velocity" | "tempcoh";

/**
 * Host-translated strings, mirroring the SamGeo label pattern: the plugins
 * package has no i18n access, the desktop shell may override via
 * {@link setInsarLabels}. Defaults are Chinese for the mining deployment.
 */
export interface InsarLabels {
  panelTitle: string;
  intro: string;
  apiUrl: string;
  connect: string;
  refresh: string;
  checking: string;
  connected: (count: number) => string;
  unavailable: (error: string) => string;
  notChecked: string;
  productsHeading: string;
  emptyCatalog: string;
  blockedTitle: (verdict: string) => string;
  noSnapshot: string;
  loadVelocity: string;
  loadTempcoh: string;
  loading: (product: string, kind: string) => string;
  addedLayer: (name: string) => string;
  addFailed: (product: string, error: string) => string;
  hostMissingCogApi: string;
  dates: (count: number, range: string) => string;
  metaLine: (year: unknown, track: unknown, variant: unknown) => string;
  unknownVariant: string;
  loadTimeseries: string;
  browseHeading: string;
  tsLoaded: (product: string, count: number) => string;
  tsFailed: (product: string, error: string) => string;
  sliderDate: (date: string, index: number, count: number) => string;
  tsLayerMissing: string;
  pickPoint: string;
  pickActive: string;
  pickHeading: (product: string) => string;
  pickFailed: (error: string) => string;
}

const DEFAULT_LABELS: InsarLabels = {
  panelTitle: "InSAR 形变产品",
  intro: "连接 insar-viz 服务（服务器隧道），浏览矿区 InSAR 时序产品并把速度场/相干性快照加载为 COG 图层。",
  apiUrl: "服务地址",
  connect: "连接",
  refresh: "刷新",
  checking: "连接中…",
  connected: (count) => `已连接 · ${count} 个产品`,
  unavailable: (error) => `不可用：${error}`,
  notChecked: "未检查",
  productsHeading: "产品目录",
  emptyCatalog: "目录为空",
  blockedTitle: (verdict) => `质量 verdict: ${verdict} — 已封锁，不用于分析`,
  noSnapshot: "无快照",
  loadVelocity: "速度场",
  loadTempcoh: "相干性",
  loading: (product, kind) => `加载 ${product} ${kind}…`,
  addedLayer: (name) => `已加载图层：${name}`,
  addFailed: (product, error) => `加载 ${product} 失败：${error}`,
  hostMissingCogApi: "宿主不支持 addCogLayer，无法加载 COG 图层。",
  dates: (count, range) => `${count} 期（${range}）`,
  metaLine: (year, track, variant) =>
    `${year ?? "?"} · 轨道 ${track ?? "?"}${variant ? ` · ${variant}` : ""}`,
  unknownVariant: "",
  loadTimeseries: "时序直读",
  browseHeading: "时序浏览（浏览器直读 H5）",
  tsLoaded: (product, count) => `已加载 ${product} 时序直读图层（${count} 期），拖动滑块切换日期`,
  tsFailed: (product, error) => `${product} 时序直读失败：${error}`,
  sliderDate: (date, index, count) => `${date}（第 ${index + 1}/${count} 期）`,
  tsLayerMissing: "时序图层已加载但未在图层列表中找到",
  pickPoint: "📍 点选时序",
  pickActive: "📍 点选中（点地图取点 / 再点关闭）",
  pickHeading: (product) => `点位时序 · ${product}`,
  pickFailed: (error) => `取点失败：${error}`,
};

let labels: InsarLabels = DEFAULT_LABELS;

/** Override the default (Chinese) panel strings. */
export function setInsarLabels(next: Partial<InsarLabels>): void {
  labels = { ...labels, ...next };
}

/** Absolute URL of one cached raster snapshot on the sidecar. */
export function insarRasterUrl(
  base: string,
  productId: string,
  kind: InsarRasterKind,
): string {
  return `${base.replace(/\/+$/, "")}/raster/${encodeURIComponent(productId)}/${kind}`;
}

/** Absolute URL of a product's kerchunk manifest (already /file-remapped). */
export function insarManifestUrl(base: string, productId: string): string {
  return `${base.replace(/\/+$/, "")}/manifest/${encodeURIComponent(productId)}`;
}

/** WGS84 bounds [w, s, e, n] of a product grid, or null when geo is missing. */
export function insarBoundsFromGeo(
  geo: InsarGeo | null | undefined,
): [number, number, number, number] | null {
  const { x_first, y_first, x_step, y_step, length, width } = geo ?? {};
  if (
    typeof x_first !== "number" ||
    typeof y_first !== "number" ||
    typeof x_step !== "number" ||
    typeof y_step !== "number" ||
    typeof length !== "number" ||
    typeof width !== "number"
  ) {
    return null;
  }
  const east = x_first + width * x_step;
  // MintPy grids are north-up with a negative y step, so south = first + length*step.
  const south = y_first + length * y_step;
  return [
    Math.min(x_first, east),
    Math.min(y_first, south),
    Math.max(x_first, east),
    Math.max(y_first, south),
  ];
}

/** Symbology per snapshot kind (mine deformation: ±8 cm/yr diverging ramp). */
const KIND_STYLE: Record<InsarRasterKind, { label: string; colormap: string; rescale: [number, number] }> = {
  velocity: { label: "速度场", colormap: "RdYlBu", rescale: [-0.08, 0.08] },
  tempcoh: { label: "相干性", colormap: "viridis", rescale: [0, 1] },
};

function formatRange(row: InsarProductRow): string {
  let first: string | null | undefined = row.date_range?.[0];
  let last: string | null | undefined = row.date_range?.[1];
  if (!first || !last) {
    first = row.dates?.[0];
    last = row.dates?.[row.dates.length - 1];
  }
  if (!first || !last) return "?";
  const pretty = (value: string) =>
    /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
  return `${pretty(first)} ~ ${pretty(last)}`;
}

let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;
const state = { apiBase: DEFAULT_INSAR_API_URL };

function buildPanel(container: HTMLElement): () => void {
  const root = document.createElement("div");
  root.style.cssText = "display:flex;flex-direction:column;gap:8px;padding:4px 2px;font-size:13px;line-height:1.5;";

  const intro = document.createElement("p");
  intro.style.cssText = "margin:0 0 4px;opacity:0.85;";
  intro.textContent = labels.intro;

  const api = document.createElement("input");
  api.type = "text";
  api.value = state.apiBase;
  api.style.cssText =
    "width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid rgba(128,128,128,0.5);border-radius:4px;background:transparent;color:inherit;";
  api.setAttribute("aria-label", labels.apiUrl);

  const connect = document.createElement("button");
  connect.type = "button";
  connect.textContent = labels.connect;
  connect.style.cssText = "padding:4px 10px;";

  const status = document.createElement("div");
  status.style.cssText = "min-height:1.4em;opacity:0.85;";
  status.textContent = labels.notChecked;

  const listHeading = document.createElement("h4");
  listHeading.style.cssText = "margin:6px 0 0;";
  listHeading.textContent = labels.productsHeading;

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:6px;";

  const apiRow = document.createElement("div");
  apiRow.style.cssText = "display:flex;gap:6px;align-items:center;";
  apiRow.append(api, connect);
  // 时序浏览区：加载时序直读图层后出现（滑块驱动 setZarrLayerSelector）。
  const tsSection = document.createElement("div");
  tsSection.style.cssText = "display:none;flex-direction:column;gap:6px;padding:8px;border:1px solid rgba(84,140,240,0.45);border-radius:6px;margin-top:6px;";
  root.append(intro, apiRow, status, listHeading, list, tsSection);
  container.append(root);

  let tsState: { layerId: string; dates: string[]; index: number; productId: string } | null = null;
  let tsSelectorTimer: ReturnType<typeof setTimeout> | null = null;
  let pickHandler: ((event: { lngLat: { lat: number; lng: number } }) => void) | null = null;

  const prettyDate = (value: string) =>
    /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;

  /** 简易折线图：x=日期序号，y=累计位移(m)。NaN(null)断开。 */
  const drawSeriesChart = (
    canvas: HTMLCanvasElement,
    dates: string[],
    values: (number | null)[],
  ): void => {
    const width = 330;
    const height = 150;
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = "100%";
    canvas.style.maxWidth = `${width}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
    if (finite.length < 2) return;
    let lo = Math.min(0, ...finite);
    let hi = Math.max(0, ...finite);
    if (hi - lo < 1e-6) {
      lo -= 0.01;
      hi += 0.01;
    }
    const pad = (hi - lo) * 0.1;
    lo -= pad;
    hi += pad;
    const left = 46;
    const right = width - 8;
    const top = 10;
    const bottom = height - 22;
    const x = (i: number) => left + ((right - left) * i) / Math.max(1, dates.length - 1);
    const y = (v: number) => top + ((hi - v) / (hi - lo)) * (bottom - top);
    // 轴
    ctx.strokeStyle = "rgba(128,128,128,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom);
    ctx.lineTo(right, bottom);
    ctx.stroke();
    // 零线（参考日期位移为 0）
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = "rgba(128,128,128,0.35)";
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(left, y(0));
      ctx.lineTo(right, y(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 折线（null 断开）
    ctx.strokeStyle = "#548cf0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    let drawing = false;
    values.forEach((value, i) => {
      if (value === null || !Number.isFinite(value)) {
        drawing = false;
        return;
      }
      if (!drawing) {
        ctx.moveTo(x(i), y(value));
        drawing = true;
      } else {
        ctx.lineTo(x(i), y(value));
      }
    });
    ctx.stroke();
    // y 轴刻度（mm 级显示）
    ctx.fillStyle = "rgba(128,128,128,0.95)";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    for (const v of [hi, (hi + lo) / 2, lo]) {
      const mm = v * 1000;
      ctx.fillText(`${mm.toFixed(mm > 100 || mm < -100 ? 0 : 1)} mm`, left - 4, y(v) + 3);
    }
    // x 轴首/中/尾日期
    ctx.textAlign = "center";
    const tickIdx = [0, Math.floor((dates.length - 1) / 2), dates.length - 1];
    for (const i of tickIdx) {
      ctx.fillText(prettyDate(dates[i] ?? "?").slice(2), x(i), bottom + 14);
    }
  };

  const renderPointChart = (
    productId: string,
    lat: number,
    lon: number,
    dates: string[],
    values: (number | null)[],
  ): void => {
    if (!tsState) return;
    const chart = document.createElement("canvas");
    drawSeriesChart(chart, dates, values);
    const head = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = labels.pickHeading(productId);
    const coords = document.createElement("span");
    coords.style.cssText = "opacity:0.75;font-size:11px;";
    coords.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    head.append(title, coords);
    const holder = document.createElement("div");
    holder.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    holder.append(head, chart);
    pointChartHost.replaceChildren(holder);
  };

  const onPointPicked = async (lat: number, lon: number): Promise<void> => {
    const current = tsState;
    if (!current) return;
    try {
      const response = await fetch(
        `${state.apiBase.replace(/\/+$/, "")}/timeseries/${encodeURIComponent(current.productId)}?lat=${lat}&lon=${lon}`,
        { signal: AbortSignal.timeout(20000) },
      );
      const data = (await response.json().catch(() => null)) as {
        dates?: string[];
        values_m?: (number | null)[];
        detail?: { message?: string };
      } | null;
      if (!response.ok || !data?.dates || !data.values_m) {
        throw new Error(data?.detail?.message ?? `HTTP ${response.status}`);
      }
      renderPointChart(current.productId, lat, lon, data.dates, data.values_m);
    } catch (error) {
      status.textContent = labels.pickFailed(error instanceof Error ? error.message : String(error));
    }
  };

  const togglePickMode = (): void => {
    const map = appRef?.getMap?.() as unknown as
      | {
          on(type: "click", handler: (event: { lngLat: { lat: number; lng: number } }) => void): unknown;
          off(type: "click", handler: (event: { lngLat: { lat: number; lng: number } }) => void): unknown;
        }
      | undefined;
    if (!map) return;
    if (pickHandler) {
      map.off("click", pickHandler);
      pickHandler = null;
      pickButton.textContent = labels.pickPoint;
    } else {
      pickHandler = (event) => void onPointPicked(event.lngLat.lat, event.lngLat.lng);
      map.on("click", pickHandler);
      pickButton.textContent = labels.pickActive;
    }
  };

  const pointChartHost = document.createElement("div");
  const pickButton = document.createElement("button");
  pickButton.type = "button";
  pickButton.textContent = labels.pickPoint;
  pickButton.style.cssText = "align-self:flex-start;padding:3px 10px;";
  pickButton.addEventListener("click", togglePickMode);

  const renderTsControls = (): void => {
    if (!tsState) {
      tsSection.style.display = "none";
      tsSection.replaceChildren();
      return;
    }
    const { layerId, dates, index } = tsState;
    tsSection.style.display = "flex";
    const head = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = labels.browseHeading;
    const dateLabel = document.createElement("span");
    dateLabel.style.cssText = "float:right;opacity:0.85;";
    dateLabel.textContent = labels.sliderDate(prettyDate(dates[index] ?? "?"), index, dates.length);
    head.append(title, dateLabel);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(Math.max(0, dates.length - 1));
    slider.value = String(index);
    slider.style.width = "100%";
    slider.addEventListener("input", () => {
      const next = Math.min(dates.length - 1, Math.max(0, Number(slider.value)));
      if (!tsState) return;
      tsState.index = next;
      dateLabel.textContent = labels.sliderDate(prettyDate(dates[next] ?? "?"), next, dates.length);
      if (tsSelectorTimer) clearTimeout(tsSelectorTimer);
      tsSelectorTimer = setTimeout(() => {
        try {
          appRef?.setZarrLayerSelector?.(layerId, { date: next });
        } catch (error) {
          status.textContent = labels.tsFailed(
            "",
            error instanceof Error ? error.message : String(error),
          );
        }
      }, 250);
    });
    tsSection.replaceChildren(head, slider, pickButton, pointChartHost);
  };

  const loadTimeseries = async (row: InsarProductRow, statusLine: HTMLElement): Promise<void> => {
    statusLine.textContent = labels.loading(row.id, labels.loadTimeseries);
    try {
      let bounds: [number, number, number, number] | null = null;
      let dates: string[] = row.dates ?? [];
      try {
        const detail = await fetch(
          `${state.apiBase.replace(/\/+$/, "")}/products/${encodeURIComponent(row.id)}`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (detail.ok) {
          const detailJson = (await detail.json()) as {
            product?: { geo?: InsarGeo; dates?: string[] };
          };
          bounds = insarBoundsFromGeo(detailJson.product?.geo);
          const detailDates = detailJson.product?.dates;
          if (Array.isArray(detailDates) && detailDates.length > 0) dates = detailDates;
        }
      } catch {
        /* bounds/dates are best-effort */
      }
      // 懒加载：共享 Zarr 渲染控件只在真正用时才进包。
      const { addCloudNetcdfLayer } = await import("./maplibre-components");
      const manifestUrl = insarManifestUrl(state.apiBase, row.id);
      await addCloudNetcdfLayer(appRef!, {
        url: manifestUrl,
        variable: "timeseries",
        clim: [-0.05, 0.05],
        colormap: "RdYlBu",
        ...(bounds ? { bounds } : {}),
      });
      // addCloudNetcdfLayer 不回传图层 id：按 manifest URL 在 store 里找刚加的图层。
      const layers = useAppStore.getState().layers;
      const manifestSuffix = `/manifest/${encodeURIComponent(row.id)}`;
      const added =
        [...layers]
          .reverse()
          .find((layer) => {
            const url = (layer.source as { url?: unknown } | undefined)?.url;
            return typeof url === "string" && url.includes(manifestSuffix);
          }) ?? [...layers].reverse().find((layer) => layer.type === "zarr") ?? null;
      if (!added) throw new Error(labels.tsLayerMissing);
      tsState = { layerId: added.id, dates, index: 0, productId: row.id };
      renderTsControls();
      if (bounds) appRef?.fitBounds?.(bounds);
      statusLine.textContent = labels.tsLoaded(row.id, dates.length);
    } catch (error) {
      statusLine.textContent = labels.tsFailed(row.id, error instanceof Error ? error.message : String(error));
    }
  };

  const refreshCatalog = async (): Promise<void> => {
    const base = api.value.trim() || DEFAULT_INSAR_API_URL;
    state.apiBase = base;
    connect.disabled = true;
    status.textContent = labels.checking;
    list.replaceChildren();
    try {
      const health = await fetch(`${base.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
      if (!health.ok) throw new Error(`HTTP ${health.status}`);
      const catalog = await fetch(`${base.replace(/\/+$/, "")}/products`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!catalog.ok) throw new Error(`HTTP ${catalog.status}`);
      const data = (await catalog.json()) as { products?: InsarProductRow[] };
      const rows = (data.products ?? []).filter((row) => row && row.id && !("error" in row));
      status.textContent = labels.connected(rows.length);
      if (rows.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "opacity:0.7;";
        empty.textContent = labels.emptyCatalog;
        list.append(empty);
        return;
      }
      for (const row of rows) {
        list.append(buildProductRow(row, base, status));
      }
    } catch (error) {
      status.textContent = labels.unavailable(error instanceof Error ? error.message : String(error));
    } finally {
      connect.disabled = false;
    }
  };

  const loadSnapshot = async (
    row: InsarProductRow,
    kind: InsarRasterKind,
    statusLine: HTMLElement,
  ): Promise<void> => {
    const style = KIND_STYLE[kind];
    statusLine.textContent = labels.loading(row.id, style.label);
    try {
      if (typeof appRef?.addCogLayer !== "function") {
        throw new Error(labels.hostMissingCogApi);
      }
      // Fetch the detail for geolocation so the view can fly to the product.
      let bounds: [number, number, number, number] | null = null;
      try {
        const detail = await fetch(`${state.apiBase.replace(/\/+$/, "")}/products/${encodeURIComponent(row.id)}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (detail.ok) {
          const detailJson = (await detail.json()) as { product?: { geo?: InsarGeo } };
          bounds = insarBoundsFromGeo(detailJson.product?.geo);
        }
      } catch {
        /* bounds are best-effort */
      }
      const name = `${row.id} · ${style.label}`;
      const layerId = await appRef.addCogLayer(name, insarRasterUrl(state.apiBase, row.id, kind), {
        colormap: style.colormap,
        rescaleMin: style.rescale[0],
        rescaleMax: style.rescale[1],
      });
      if (bounds) appRef.fitBounds?.(bounds);
      statusLine.textContent = labels.addedLayer(`${name}${layerId ? ` (${layerId})` : ""}`);
    } catch (error) {
      statusLine.textContent = labels.addFailed(row.id, error instanceof Error ? error.message : String(error));
    }
  };

  const buildProductRow = (
    row: InsarProductRow,
    base: string,
    statusLine: HTMLElement,
  ): HTMLElement => {
    const block = document.createElement("div");
    block.style.cssText =
      "display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid rgba(128,128,128,0.35);border-radius:6px;";

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;";
    const title = document.createElement("strong");
    title.textContent = row.id;
    head.append(title);
    if (row.quality_verdict === "BLOCKED") {
      const badge = document.createElement("span");
      badge.textContent = "⛔ BLOCKED";
      badge.title = labels.blockedTitle(String(row.quality_verdict));
      badge.style.cssText = "color:#e05252;font-size:12px;";
      head.append(badge);
    }
    const meta = document.createElement("span");
    meta.style.cssText = "opacity:0.75;font-size:12px;";
    meta.textContent = labels.metaLine(row.year, row.track, row.variant ?? null);
    head.append(meta);
    block.append(head);

    const dates = document.createElement("div");
    dates.style.cssText = "opacity:0.75;font-size:12px;";
    dates.textContent = labels.dates(row.n_dates ?? 0, formatRange(row));
    block.append(dates);

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:6px;";
    const blocked = row.quality_verdict === "BLOCKED";
    for (const kind of ["velocity", "tempcoh"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = KIND_STYLE[kind].label;
      button.style.cssText = "padding:3px 10px;";
      const ready = row.has?.[kind === "velocity" ? "velocity_cog" : "tempcoh_cog"]
        ?? row.cache?.[kind === "velocity" ? "velocity_cog" : "tempcoh_cog"];
      if (blocked) {
        button.disabled = true;
        button.title = labels.blockedTitle(String(row.quality_verdict));
      } else if (!ready) {
        button.disabled = true;
        button.title = labels.noSnapshot;
      }
      button.addEventListener("click", () => void loadSnapshot(row, kind, statusLine));
      buttons.append(button);
    }
    // 时序直读：浏览器经 kerchunk manifest + /file Range 代理按需读 H5。
    const tsButton = document.createElement("button");
    tsButton.type = "button";
    tsButton.textContent = labels.loadTimeseries;
    tsButton.style.cssText = "padding:3px 10px;";
    const manifestReady = row.has?.manifest ?? row.cache?.manifest;
    if (blocked) {
      tsButton.disabled = true;
      tsButton.title = labels.blockedTitle(String(row.quality_verdict));
    } else if (!manifestReady) {
      tsButton.disabled = true;
      tsButton.title = labels.noSnapshot;
    }
    tsButton.addEventListener("click", () => void loadTimeseries(row, statusLine));
    buttons.append(tsButton);
    block.append(buttons);
    return block;
  };

  connect.addEventListener("click", () => void refreshCatalog());

  return () => {
    if (tsSelectorTimer) clearTimeout(tsSelectorTimer);
    tsSelectorTimer = null;
    if (pickHandler) {
      togglePickMode(); // detach the map click handler
      pickHandler = null;
    }
    container.replaceChildren();
  };
}

export const maplibreInsarPlugin: GeoLibrePlugin = {
  id: INSAR_PLUGIN_ID,
  name: "InSAR",
  version: "0.1.0",
  activate(app) {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => labels.panelTitle,
        dock: "replace-style",
        defaultWidth: 390,
        render(container) {
          disposePanel?.();
          disposePanel = buildPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
          };
        },
      }) ?? null;
    // Mirror SamGeo: activating from the Plugins menu opens the panel right
    // away — a registered-but-never-opened panel has no other entry point.
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate(app) {
    disposePanel?.();
    disposePanel = null;
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    appRef = null;
  },
};

export default maplibreInsarPlugin;

