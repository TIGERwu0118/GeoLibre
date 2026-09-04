/**
 * 矿山总览（50 矿权）panel for the mining deployment.
 *
 * Three one-click layers over the study area (WGS84 lon 111.1–113.56,
 * lat 33.75–35.05):
 *
 * - 矿权红线 — the 50 mining-rights polygons as a red-outlined GeoJSON layer
 *   served by the local CORS static server (:8767, mirror of the server's
 *   矿权4326/矿权_4326 shapefile, converted to EPSG:4326 GeoJSON).
 * - 外扩蓝线 — the 500 m buffered rights (矿权4326/外扩500m) in blue; this is
 *   the frame the ASF SLC download and JL1 imagery pulls are clipped to.
 * - 吉林一号影像 — JL1 nationwide mosaic tiles straight from
 *   api.jl1mall.com (CORS open). The service is TMS (y flipped), so the tile
 *   template uses plain {y} plus source scheme "tms".
 *
 * JL1 credentials (tk + per-year mk) are entered in the panel and persisted to
 * localStorage only — they never enter the repo. GeoJSON/tile endpoints are
 * editable fields with deployment-friendly defaults.
 */

import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import type { FeatureCollection } from "geojson";

export const MINING_PLUGIN_ID = "maplibre-mining";
const PANEL_ID = "mining-overview-panel";

export const DEFAULT_MINE_GEOJSON_URL = "http://127.0.0.1:8767/geolibre-mine/mine.geojson";
export const DEFAULT_BUFFER_GEOJSON_URL = "http://127.0.0.1:8767/geolibre-mine/buf500.geojson";
/** 50 矿批量 COG 的清单（batch_build_cogs.py 产出，8767 出口）。 */
export const DEFAULT_COG_MANIFEST_URL = "http://127.0.0.1:8767/geolibre-cogs/manifest.json";
/**
 * 默认影像源：服务器端 jilin1 矿区瓦片服务（tmux `mineserver`，127.0.0.1:9194，
 * Mac 经 SSH 隧道访问）。`/all/{z}/{x}/{y}.png` 是 50 个矿区金字塔的合并视图
 * （XYZ 北原点，缺瓦返回透明 PNG），无需 tk/mk 凭证。
 */
export const DEFAULT_LOCAL_IMAGERY_URL = "http://127.0.0.1:9194/all/{z}/{x}/{y}.png";
/** 矿区金字塔最深到 z19（gdal2tiles 在 z18 源上多出一级）。 */
export const LOCAL_IMAGERY_MAX_ZOOM = 19;
/** WGS84 bounds of the 50 mining rights (slightly padded for framing). */
export const MINE_AREA_BOUNDS: [number, number, number, number] = [111.1, 33.75, 113.56, 35.05];
/** JL1 在线一张图 API 的最深请求层级。 */
export const JL1_TILE_MAX_ZOOM = 18;

export type MiningTileYear = "2022" | "2023" | "2024";
export const MINING_TILE_YEARS: readonly MiningTileYear[] = ["2022", "2023", "2024"];
/** 影像来源：本地矿区瓦片服务（默认）或吉林一号在线 API。 */
export type MiningImageryMode = "local" | "api";

const JL1_TILE_ENDPOINT = "https://api.jl1mall.com/getMap";
const SETTINGS_STORAGE_KEY = "geolibre.mining.settings";

export const MINE_LAYER_NAME = "50矿权（红线）";
export const BUFFER_LAYER_NAME = "矿权外扩500m（蓝线）";
export const miningImageryLayerName = (year: MiningTileYear): string => `吉林一号${year}一张图`;
export const LOCAL_IMAGERY_LAYER_NAME = "吉林一号2024矿区影像（本地）";

/** Red outline + faint red fill for the mining-rights polygons. */
export const MINE_LAYER_STYLE = {
  strokeColor: "#e60000",
  strokeWidth: 2,
  fillColor: "#e60000",
  fillOpacity: 0.06,
} as const;

/** Blue outline + faint blue fill for the 500 m buffer frame. */
export const BUFFER_LAYER_STYLE = {
  strokeColor: "#2563eb",
  strokeWidth: 2,
  fillColor: "#2563eb",
  fillOpacity: 0.04,
} as const;

/** Render state passed to addCogLayer for the imagery COG. The GPU renderer
 * auto-stretches each band to its 2–98% percentile once its background stats
 * sample lands, which destroys natural color on 8-bit imagery; pinning
 * rescale to the full Byte range keeps it the identity mapping. */
export const MINING_COG_LAYER_OPTIONS = {
  rescaleMin: 0,
  rescaleMax: 255,
} as const;

export interface MiningCogLayerRef {
  /** Display name: the mine's Chinese name, falling back to its ET_ID. */
  name: string;
  /** Absolute COG URL resolved against the manifest's own address. */
  url: string;
}

/**
 * Parse the batch-build manifest (`batch_build_cogs.py` output: an object
 * keyed by ET_ID, each holding `url`/`cog_file`, `mine_name`, …) into
 * addCogLayer-ready refs. Malformed entries are skipped; entry order is
 * preserved.
 */
export function cogLayersFromManifest(
  manifest: unknown,
  manifestUrl: string,
): MiningCogLayerRef[] {
  if (!manifest || typeof manifest !== "object") return [];
  const refs: MiningCogLayerRef[] = [];
  for (const [etId, value] of Object.entries(manifest as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const rawUrl =
      typeof entry.url === "string" && entry.url.trim()
        ? entry.url.trim()
        : typeof entry.cog_file === "string" && entry.cog_file.trim()
          ? entry.cog_file.trim()
          : "";
    if (!rawUrl) continue;
    let url: string;
    try {
      url = new URL(rawUrl, manifestUrl).toString();
    } catch {
      continue;
    }
    const name =
      typeof entry.mine_name === "string" && entry.mine_name.trim()
        ? entry.mine_name.trim()
        : etId;
    refs.push({ name, url });
  }
  return refs;
}

/** Panel state persisted to localStorage (credentials live here, not in git). */
export interface MiningPanelSettings {
  mineUrl: string;
  bufferUrl: string;
  /** 本地矿区瓦片服务的合并 XYZ 模板。 */
  imageryUrl: string;
  /** 影像来源：local（9194 合并瓦片，默认）或 api（jl1mall 在线）。 */
  imageryMode: MiningImageryMode;
  /** 可选：GeoTIFF/COG 直载地址（SAM3 分割的输入图层）。 */
  cogUrl: string;
  /** 50 矿批量 COG 清单地址（加载全部矿区 COG 按钮的数据源）。 */
  cogManifestUrl: string;
  year: MiningTileYear;
  tk: string;
  mkByYear: Record<MiningTileYear, string>;
}

export function defaultMiningSettings(): MiningPanelSettings {
  return {
    mineUrl: DEFAULT_MINE_GEOJSON_URL,
    bufferUrl: DEFAULT_BUFFER_GEOJSON_URL,
    imageryUrl: DEFAULT_LOCAL_IMAGERY_URL,
    imageryMode: "local",
    cogUrl: "",
    cogManifestUrl: DEFAULT_COG_MANIFEST_URL,
    year: "2024",
    tk: "",
    mkByYear: { "2022": "", "2023": "", "2024": "" },
  };
}

function isMiningTileYear(value: unknown): value is MiningTileYear {
  return value === "2022" || value === "2023" || value === "2024";
}

/** Merge a stored blob over the defaults, ignoring anything malformed. */
export function mergeMiningSettings(stored: unknown): MiningPanelSettings {
  const base = defaultMiningSettings();
  if (!stored || typeof stored !== "object") return base;
  const raw = stored as Partial<MiningPanelSettings> & { mkByYear?: Record<string, unknown> };
  if (typeof raw.mineUrl === "string" && raw.mineUrl.trim()) base.mineUrl = raw.mineUrl.trim();
  if (typeof raw.bufferUrl === "string" && raw.bufferUrl.trim()) base.bufferUrl = raw.bufferUrl.trim();
  if (typeof raw.imageryUrl === "string" && raw.imageryUrl.trim()) {
    base.imageryUrl = raw.imageryUrl.trim();
  }
  if (typeof raw.cogUrl === "string") base.cogUrl = raw.cogUrl.trim();
  if (typeof raw.cogManifestUrl === "string" && raw.cogManifestUrl.trim()) {
    base.cogManifestUrl = raw.cogManifestUrl.trim();
  }
  if (raw.imageryMode === "local" || raw.imageryMode === "api") base.imageryMode = raw.imageryMode;
  if (isMiningTileYear(raw.year)) base.year = raw.year;
  if (typeof raw.tk === "string") base.tk = raw.tk.trim();
  if (raw.mkByYear && typeof raw.mkByYear === "object") {
    for (const year of MINING_TILE_YEARS) {
      const mk = raw.mkByYear[year];
      if (typeof mk === "string") base.mkByYear[year] = mk.trim();
    }
  }
  return base;
}

export function loadMiningSettings(storage: Storage | null): MiningPanelSettings {
  if (!storage) return defaultMiningSettings();
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaultMiningSettings();
    return mergeMiningSettings(JSON.parse(raw));
  } catch {
    return defaultMiningSettings();
  }
}

export function saveMiningSettings(storage: Storage | null, settings: MiningPanelSettings): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* best-effort: private-mode storage quota errors must not break the panel */
  }
}

/**
 * JL1 tile URL template. The service is TMS (y origin flipped), expressed as a
 * plain {y} placeholder plus the raster source's scheme:"tms" — MapLibre then
 * substitutes the flipped row itself.
 */
export function jl1TileUrlTemplate(mk: string, tk: string): string {
  return `${JL1_TILE_ENDPOINT}/{z}/{x}/{y}?mk=${encodeURIComponent(mk)}&tk=${encodeURIComponent(tk)}&vf=0`;
}

/**
 * Host-translated strings, mirroring the InSAR/SamGeo label pattern: the
 * plugins package has no i18n access; the desktop shell may override via
 * {@link setMiningLabels}. Defaults are Chinese for the mining deployment.
 */
export interface MiningLabels {
  panelTitle: string;
  intro: string;
  loadMine: string;
  loadBuffer: string;
  loadImagery: string;
  yearLabel: string;
  modeLabel: string;
  modeLocal: string;
  modeApi: string;
  zoomArea: string;
  removeLayers: string;
  credsHeading: string;
  credsNote: string;
  tkLabel: string;
  mkLabel: string;
  mineUrlLabel: string;
  bufferUrlLabel: string;
  imageryUrlLabel: string;
  cogUrlLabel: string;
  loadCog: string;
  manifestUrlLabel: string;
  loadAllCogs: string;
  cogManifestFetching: string;
  cogManifestEmpty: string;
  cogProgress: (done: number, total: number) => string;
  cogSummary: (added: number, skipped: number, failed: number) => string;
  hostMissingCogApi: string;
  saved: string;
  statusIdle: string;
  added: (name: string) => string;
  exists: (name: string) => string;
  failed: (what: string, error: string) => string;
  missingKey: (year: MiningTileYear) => string;
  hostMissingTileApi: string;
  removed: (count: number) => string;
}

const DEFAULT_LABELS: MiningLabels = {
  panelTitle: "矿山总览（50 矿权）",
  intro:
    "一键加载 50 个矿权红线、外扩 500m 蓝线（ASF 下载 / 影像提取范围）与吉林一号矿区影像。" +
    "影像默认走服务器本地瓦片服务（9194，已下载的 2024 数据，无需凭证），可切换在线 API。",
  loadMine: "加载矿权（红线）",
  loadBuffer: "加载外扩 500m（蓝线）",
  loadImagery: "加载吉林一号影像",
  yearLabel: "影像年份",
  modeLabel: "影像来源",
  modeLocal: "本地瓦片服务（9194）",
  modeApi: "在线 API（需 tk/mk）",
  zoomArea: "缩放到矿区范围",
  removeLayers: "移除本面板图层",
  credsHeading: "凭证与数据地址",
  credsNote:
    "默认走本地矿区瓦片服务（9194，无需凭证）；只有切换到“在线 API”才需要吉林一号 tk / mk（只保存在本浏览器 localStorage，不进仓库）。",
  tkLabel: "吉林一号 tk",
  mkLabel: "mk（按年份）",
  mineUrlLabel: "矿权 GeoJSON 地址",
  bufferUrlLabel: "外扩 500m GeoJSON 地址",
  imageryUrlLabel: "本地瓦片服务 XYZ 模板",
  cogUrlLabel: "GeoTIFF（COG）地址",
  loadCog: "加载 GeoTIFF 图层",
  manifestUrlLabel: "50 矿 COG 清单地址（manifest.json）",
  loadAllCogs: "加载全部矿区 COG",
  cogManifestFetching: "正在读取 COG 清单…",
  cogManifestEmpty: "COG 清单为空或格式不对",
  cogProgress: (done, total) => `加载矿区 COG ${done}/${total}…`,
  cogSummary: (added, skipped, failed) =>
    `批量 COG 完成：新加 ${added}，已存在跳过 ${skipped}，失败 ${failed}`,
  hostMissingCogApi: "宿主未提供 addCogLayer 接口",
  saved: "已保存",
  statusIdle: "未加载图层",
  added: (name) => `已加载：${name}`,
  exists: (name) => `图层已存在，跳过：${name}`,
  failed: (what, error) => `加载失败（${what}）：${error}`,
  missingKey: (year) => `缺少 ${year} 的 tk 或 mk，请先在下方填写凭证`,
  hostMissingTileApi: "宿主未提供 addTileLayer 接口",
  removed: (count) => `已移除 ${count} 个图层`,
};

let labels: MiningLabels = DEFAULT_LABELS;

export function setMiningLabels(override: Partial<MiningLabels>): void {
  labels = { ...DEFAULT_LABELS, ...override };
}

let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;
/** Layer ids this panel added, so 移除 only touches its own layers. */
const trackedLayerIds = new Set<string>();

function layerByName(name: string): { id: string } | null {
  const layers = useAppStore.getState().layers;
  const found = layers.find((layer) => layer.name === name);
  return found ? { id: found.id } : null;
}

const INPUT_STYLE =
  "width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid rgba(128,128,128,0.5);border-radius:4px;background:transparent;color:inherit;";
const BUTTON_STYLE = "padding:4px 10px;";
const SECTION_STYLE =
  "display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(128,128,128,0.35);";

function buildPanel(container: HTMLElement): () => void {
  const storage = typeof localStorage !== "undefined" ? localStorage : null;
  let settings = loadMiningSettings(storage);

  const root = document.createElement("div");
  root.style.cssText =
    "display:flex;flex-direction:column;gap:8px;padding:4px 2px;font-size:13px;line-height:1.5;";

  const intro = document.createElement("p");
  intro.style.cssText = "margin:0 0 4px;opacity:0.85;";
  intro.textContent = labels.intro;

  const status = document.createElement("div");
  status.style.cssText = "min-height:1.4em;opacity:0.85;";
  status.textContent = labels.statusIdle;

  const buttonRow = document.createElement("div");
  buttonRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
  const loadMine = document.createElement("button");
  loadMine.type = "button";
  loadMine.textContent = labels.loadMine;
  loadMine.style.cssText = BUTTON_STYLE;
  const loadBuffer = document.createElement("button");
  loadBuffer.type = "button";
  loadBuffer.textContent = labels.loadBuffer;
  loadBuffer.style.cssText = BUTTON_STYLE;
  const zoomArea = document.createElement("button");
  zoomArea.type = "button";
  zoomArea.textContent = labels.zoomArea;
  zoomArea.style.cssText = BUTTON_STYLE;
  buttonRow.append(loadMine, loadBuffer, zoomArea);

  const imageryRow = document.createElement("div");
  imageryRow.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
  const modeLabel = document.createElement("span");
  modeLabel.style.cssText = "opacity:0.85;";
  modeLabel.textContent = labels.modeLabel;
  const modeSelect = document.createElement("select");
  modeSelect.setAttribute("aria-label", labels.modeLabel);
  modeSelect.style.cssText = "padding:4px 6px;border:1px solid rgba(128,128,128,0.5);border-radius:4px;background:transparent;color:inherit;";
  const modeLocal = document.createElement("option");
  modeLocal.value = "local";
  modeLocal.textContent = labels.modeLocal;
  modeLocal.selected = settings.imageryMode === "local";
  const modeApi = document.createElement("option");
  modeApi.value = "api";
  modeApi.textContent = labels.modeApi;
  modeApi.selected = settings.imageryMode === "api";
  modeSelect.append(modeLocal, modeApi);
  const yearLabel = document.createElement("span");
  yearLabel.style.cssText = "opacity:0.85;";
  yearLabel.textContent = labels.yearLabel;
  const yearSelect = document.createElement("select");
  yearSelect.setAttribute("aria-label", labels.yearLabel);
  yearSelect.style.cssText = "padding:4px 6px;border:1px solid rgba(128,128,128,0.5);border-radius:4px;background:transparent;color:inherit;";
  for (const year of MINING_TILE_YEARS) {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    option.selected = year === settings.year;
    yearSelect.append(option);
  }
  const loadImagery = document.createElement("button");
  loadImagery.type = "button";
  loadImagery.textContent = labels.loadImagery;
  loadImagery.style.cssText = BUTTON_STYLE;
  const removeLayers = document.createElement("button");
  removeLayers.type = "button";
  removeLayers.textContent = labels.removeLayers;
  removeLayers.style.cssText = BUTTON_STYLE;
  // 年份只对在线 API 有意义；本地服务的 2024 数据是固定的。
  const syncModeVisibility = () => {
    yearLabel.style.display = settings.imageryMode === "api" ? "" : "none";
    yearSelect.style.display = settings.imageryMode === "api" ? "" : "none";
  };
  syncModeVisibility();
  imageryRow.append(modeLabel, modeSelect, yearLabel, yearSelect, loadImagery, removeLayers);

  const creds = document.createElement("details");
  creds.style.cssText = SECTION_STYLE;
  const credsSummary = document.createElement("summary");
  credsSummary.textContent = labels.credsHeading;
  credsSummary.style.cssText = "cursor:pointer;opacity:0.9;";
  const credsNote = document.createElement("p");
  credsNote.style.cssText = "margin:6px 0 0;opacity:0.75;font-size:12px;";
  credsNote.textContent = labels.credsNote;
  const credsBody = document.createElement("div");
  credsBody.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:6px;";
  creds.append(credsSummary, credsNote, credsBody);

  const mkInputs = new Map<MiningTileYear, HTMLInputElement>();
  const addField = (labelText: string, value: string, onInput: (v: string) => void, secret = false): HTMLInputElement => {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;flex-direction:column;gap:2px;";
    const text = document.createElement("span");
    text.style.cssText = "opacity:0.8;";
    text.textContent = labelText;
    const input = document.createElement("input");
    input.type = secret ? "password" : "text";
    input.value = value;
    input.style.cssText = INPUT_STYLE;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.addEventListener("change", () => {
      onInput(input.value);
      saveMiningSettings(storage, settings);
      status.textContent = labels.saved;
    });
    label.append(text, input);
    credsBody.append(label);
    return input;
  };

  addField(labels.tkLabel, settings.tk, (v) => (settings.tk = v), true);
  for (const year of MINING_TILE_YEARS) {
    mkInputs.set(
      year,
      addField(`${labels.mkLabel} ${year}`, settings.mkByYear[year], (v) => (settings.mkByYear[year] = v), true),
    );
  }
  addField(labels.mineUrlLabel, settings.mineUrl, (v) => (settings.mineUrl = v));
  addField(labels.bufferUrlLabel, settings.bufferUrl, (v) => (settings.bufferUrl = v));
  addField(labels.imageryUrlLabel, settings.imageryUrl, (v) => (settings.imageryUrl = v));
  addField(labels.cogUrlLabel, settings.cogUrl, (v) => (settings.cogUrl = v));
  addField(labels.manifestUrlLabel, settings.cogManifestUrl, (v) => (settings.cogManifestUrl = v));
  const loadCog = document.createElement("button");
  loadCog.type = "button";
  loadCog.textContent = labels.loadCog;
  loadCog.style.cssText = BUTTON_STYLE;
  const loadAllCogs = document.createElement("button");
  loadAllCogs.type = "button";
  loadAllCogs.textContent = labels.loadAllCogs;
  loadAllCogs.style.cssText = BUTTON_STYLE;
  credsBody.append(loadCog, loadAllCogs);

  yearSelect.addEventListener("change", () => {
    const value = yearSelect.value;
    if (isMiningTileYear(value)) {
      settings.year = value;
      saveMiningSettings(storage, settings);
    }
  });
  modeSelect.addEventListener("change", () => {
    const value = modeSelect.value;
    if (value === "local" || value === "api") {
      settings.imageryMode = value;
      saveMiningSettings(storage, settings);
      syncModeVisibility();
    }
  });

  root.append(intro, buttonRow, imageryRow, status, creds);
  container.append(root);

  const addVectorLayer = async (name: string, url: string, style: Record<string, unknown>): Promise<void> => {
    const existing = layerByName(name);
    if (existing) {
      status.textContent = labels.exists(name);
      appRef?.fitBounds?.(MINE_AREA_BOUNDS);
      return;
    }
    status.textContent = `${labels.added(name)}…`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as FeatureCollection;
      if (!data || data.type !== "FeatureCollection") {
        throw new Error("not a GeoJSON FeatureCollection");
      }
      const id = appRef!.addGeoJsonLayer(name, data, url);
      useAppStore.getState().setLayerStyle(id, style);
      trackedLayerIds.add(id);
      status.textContent = labels.added(name);
      appRef?.fitBounds?.(MINE_AREA_BOUNDS);
    } catch (error) {
      status.textContent = labels.failed(name, error instanceof Error ? error.message : String(error));
    }
  };

  loadMine.addEventListener("click", () => {
    void addVectorLayer(MINE_LAYER_NAME, settings.mineUrl, { ...MINE_LAYER_STYLE });
  });
  loadBuffer.addEventListener("click", () => {
    void addVectorLayer(BUFFER_LAYER_NAME, settings.bufferUrl, { ...BUFFER_LAYER_STYLE });
  });

  loadImagery.addEventListener("click", () => {
    if (typeof appRef?.addTileLayer !== "function") {
      status.textContent = labels.hostMissingTileApi;
      return;
    }
    // 影像压在矿权矢量之下：找到任一矢量图层作为插入锚点。
    const anchor = layerByName(MINE_LAYER_NAME) ?? layerByName(BUFFER_LAYER_NAME);
    if (settings.imageryMode === "local") {
      const existing = layerByName(LOCAL_IMAGERY_LAYER_NAME);
      if (existing) {
        status.textContent = labels.exists(LOCAL_IMAGERY_LAYER_NAME);
        return;
      }
      const id = appRef.addTileLayer(LOCAL_IMAGERY_LAYER_NAME, settings.imageryUrl, {
        tileSize: 256,
        bounds: MINE_AREA_BOUNDS,
        maxzoom: LOCAL_IMAGERY_MAX_ZOOM,
        attribution: "吉林一号（本地矿区瓦片服务）",
        ...(anchor ? { beforeLayerId: anchor.id } : {}),
      });
      trackedLayerIds.add(id);
      status.textContent = labels.added(LOCAL_IMAGERY_LAYER_NAME);
      appRef?.fitBounds?.(MINE_AREA_BOUNDS);
      return;
    }
    const mk = settings.mkByYear[settings.year] ?? "";
    if (!settings.tk || !mk) {
      status.textContent = labels.missingKey(settings.year);
      creds.open = true;
      return;
    }
    const name = miningImageryLayerName(settings.year);
    // 年份切换重加同一图层名时，先移除旧影像再挂新模板。
    const existing = layerByName(name);
    if (existing) {
      useAppStore.getState().removeLayer(existing.id);
      trackedLayerIds.delete(existing.id);
    }
    const id = appRef.addTileLayer(name, jl1TileUrlTemplate(mk, settings.tk), {
      scheme: "tms",
      tileSize: 256,
      bounds: MINE_AREA_BOUNDS,
      maxzoom: JL1_TILE_MAX_ZOOM,
      attribution: "吉林一号",
      ...(anchor ? { beforeLayerId: anchor.id } : {}),
    });
    trackedLayerIds.add(id);
    status.textContent = labels.added(name);
  });

  loadCog.addEventListener("click", () => {
    const url = settings.cogUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      status.textContent = labels.failed(labels.loadCog, "需 http(s) GeoTIFF 地址");
      return;
    }
    if (typeof appRef?.addCogLayer !== "function") {
      status.textContent = labels.hostMissingCogApi;
      return;
    }
    status.textContent = `${labels.loadCog}…`;
    appRef
      .addCogLayer(
        url.split("/").pop()?.split("?")[0] || "GeoTIFF",
        url,
        { ...MINING_COG_LAYER_OPTIONS },
      )
      .then((id) => {
        trackedLayerIds.add(id);
        status.textContent = labels.added(url.split("/").pop()?.split("?")[0] || "GeoTIFF");
      })
      .catch((error: unknown) => {
        status.textContent = labels.failed(
          labels.loadCog,
          error instanceof Error ? error.message : String(error),
        );
      });
  });

  loadAllCogs.addEventListener("click", () => {
    const manifestUrl = settings.cogManifestUrl.trim();
    if (!/^https?:\/\//i.test(manifestUrl)) {
      status.textContent = labels.failed(labels.loadAllCogs, "需 http(s) 清单地址");
      return;
    }
    if (typeof appRef?.addCogLayer !== "function") {
      status.textContent = labels.hostMissingCogApi;
      return;
    }
    status.textContent = labels.cogManifestFetching;
    loadAllCogs.disabled = true;
    const finish = () => {
      loadAllCogs.disabled = false;
    };
    fetch(manifestUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(async (manifest: unknown) => {
        const items = cogLayersFromManifest(manifest, manifestUrl);
        if (!items.length) {
          status.textContent = labels.cogManifestEmpty;
          return;
        }
        let added = 0;
        let skipped = 0;
        let failed = 0;
        // Sequential on purpose: 50 concurrent COG adds would stampede the
        // renderer's per-layer stats sampling; one at a time keeps the map
        // responsive and the status line meaningful.
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          status.textContent = `${labels.cogProgress(i + 1, items.length)} ${item.name}`;
          if (layerByName(item.name)) {
            skipped++;
            continue;
          }
          try {
            const id = await appRef!.addCogLayer!(
              item.name,
              item.url,
              { ...MINING_COG_LAYER_OPTIONS },
            );
            trackedLayerIds.add(id);
            added++;
          } catch {
            failed++;
          }
        }
        status.textContent = labels.cogSummary(added, skipped, failed);
        if (added > 0) appRef?.fitBounds?.(MINE_AREA_BOUNDS);
      })
      .catch((error: unknown) => {
        status.textContent = labels.failed(
          labels.loadAllCogs,
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(finish);
  });

  zoomArea.addEventListener("click", () => {
    appRef?.fitBounds?.(MINE_AREA_BOUNDS);
  });

  removeLayers.addEventListener("click", () => {
    const store = useAppStore.getState();
    let count = 0;
    for (const id of [...trackedLayerIds]) {
      store.removeLayer(id);
      trackedLayerIds.delete(id);
      count += 1;
    }
    for (const name of [MINE_LAYER_NAME, BUFFER_LAYER_NAME, LOCAL_IMAGERY_LAYER_NAME]) {
      const layer = layerByName(name);
      if (layer) {
        store.removeLayer(layer.id);
        count += 1;
      }
    }
    for (const year of MINING_TILE_YEARS) {
      const layer = layerByName(miningImageryLayerName(year));
      if (layer) {
        store.removeLayer(layer.id);
        count += 1;
      }
    }
    status.textContent = labels.removed(count);
  });

  return () => {
    container.replaceChildren();
  };
}

export const maplibreMiningPlugin: GeoLibrePlugin = {
  id: MINING_PLUGIN_ID,
  name: "矿山总览",
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
    // Mirror InSAR/SamGeo: activating from the Plugins menu opens the panel
    // right away — a registered-but-never-opened panel has no other entry point.
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

export default maplibreMiningPlugin;
