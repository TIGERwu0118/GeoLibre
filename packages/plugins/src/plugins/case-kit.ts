/**
 * case-kit — 案例验证共享的纯函数、样式预设与类型（lib，不是插件）。
 *
 * maplibre-cases 的三个 section（违法监测/地灾/生态）共用：products.json
 * 解析、图层命名、样式预设、bbox 校验。刻意保持零宿主依赖，node:test 可直测。
 *
 * products.json 是 00-计划 M1 成果库的注册表（tools/products_store.py 维护），
 * 由 8767 静态服务出口；条目必带 source/method 溯源字段。
 */

/** 三个案例验证任务（任务书 2.3）；base 是数据底座，归矿山总览面板管。 */
export type CaseTaskId = "violation" | "hazard" | "eco";

export interface CaseTaskDescriptor {
  id: CaseTaskId;
  title: string;
  intro: string;
}

export const CASE_TASKS: readonly CaseTaskDescriptor[] = [
  {
    id: "violation",
    title: "矿山采场违法监测",
    intro: "开采面提取与越界/超量/超速判定（管线 P5 变化检测 + P3 越界差值；SAM3 恢复后升级提取）。",
  },
  {
    id: "hazard",
    title: "矿山地灾识别与风险评估",
    intro: "InSAR 形变斑提取与矿权叠加损失分析（P1 已就绪）；坡度/降雨风险叠加分级待 DEM 与因子数据（P2）。",
  },
  {
    id: "eco",
    title: "矿山生态修复评价",
    intro: "RSEI 生态指数与土地分类时序（P4/P6）——JL1 无近红外，待 Sentinel-2/Landsat 数据补齐。",
  },
];

/** products.json 里的一个产品条目（tools/products_store.make_entry 的 TS 视图）。 */
export interface CaseProduct {
  product_id: string;
  task: string;
  type: string;
  et_id?: string | null;
  mine_name?: string | null;
  year?: string | null;
  format: string;
  url: string;
  bbox?: number[] | null;
  style_preset?: string;
  metrics?: Record<string, unknown>;
  method?: string;
  source?: string[];
  status?: string;
  title?: string;
}

export interface ParsedCaseProduct {
  name: string;
  url: string;
  product: CaseProduct;
}

const TYPE_LABELS: Record<string, string> = {
  mine_boundary: "矿权边界",
  imagery_cog: "矿区影像",
  insar_velocity: "InSAR形变速率",
  insar_coherence: "InSAR时间相干性",
  insar_patch: "形变斑",
  loss_report: "损失报告",
  mining_footprint: "开采面",
  violation_zone: "越界图斑",
  excavation_indicator: "开采指标",
  risk_level: "风险分级",
  eco_index: "生态指数",
  landcover: "土地分类",
  eco_indicator: "生态指标",
  annotation_qa: "标注QA",
};

/** 框架级产品的 et_id 占位——不进图层名，避免 "ALL" 这类噪音。 */
const FRAME_ET_IDS = new Set(["ALL", "P113FULL", "BUF500"]);

export function productLayerName(p: CaseProduct): string {
  if (p.title) return p.title;
  const base = TYPE_LABELS[p.type] ?? p.type;
  const year = p.year ? ` ${p.year}` : "";
  const site = p.mine_name
    ? ` · ${p.mine_name}`
    : p.et_id && !FRAME_ET_IDS.has(p.et_id)
      ? ` · ${p.et_id}`
      : "";
  return `${base}${year}${site}`;
}

/** 解析并过滤一个任务的 products.json 数组；坏条目静默跳过，URL 相对清单地址解析。 */
export function parseProducts(
  manifest: unknown,
  manifestUrl: string,
  task: CaseTaskId,
): ParsedCaseProduct[] {
  if (!Array.isArray(manifest)) return [];
  const out: ParsedCaseProduct[] = [];
  for (const raw of manifest) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Partial<CaseProduct>;
    if (typeof p.product_id !== "string" || !p.product_id) continue;
    if (typeof p.type !== "string" || !p.type) continue;
    if (typeof p.format !== "string" || !p.format) continue;
    if (typeof p.url !== "string" || !p.url) continue;
    if (p.task !== task) continue;
    if (p.status && p.status !== "ok") continue;
    let url: string;
    try {
      url = new URL(p.url, manifestUrl).toString();
    } catch {
      continue;
    }
    out.push({ name: productLayerName(p as CaseProduct), url, product: p as CaseProduct });
  }
  return out;
}

export interface GeoJsonPreset {
  kind: "geojson";
  style: Record<string, unknown>;
}
export interface CogPreset {
  kind: "cog";
  options: Record<string, unknown>;
}
export type CaseStylePreset = GeoJsonPreset | CogPreset;

/** 各产品类型的渲染预设。8bit 影像必须显式 rescale 全量程——渲染器会自动做
 * 2–98% 百分位拉伸毁掉自然色（见 27d7ecc4）；float 形变场用发散色带开窗。 */
export const CASE_STYLE_PRESETS: Record<string, CaseStylePreset> = {
  insar_velocity: {
    kind: "cog",
    options: { bands: "1", colormap: "rdylgn", rescaleMin: -0.1, rescaleMax: 0.1, opacity: 0.9 },
  },
  insar_coherence: {
    kind: "cog",
    options: { bands: "1", colormap: "viridis", rescaleMin: 0.4, rescaleMax: 1, opacity: 0.9 },
  },
  insar_patch: {
    kind: "geojson",
    style: { strokeColor: "#7f2704", strokeWidth: 1, fillColor: "#e31a1c", fillOpacity: 0.45 },
  },
  mining_footprint: {
    kind: "geojson",
    style: { strokeColor: "#ff8c00", strokeWidth: 1.5, fillColor: "#ff8c00", fillOpacity: 0.35 },
  },
  violation_zone: {
    kind: "geojson",
    style: { strokeColor: "#e60000", strokeWidth: 2, fillColor: "#e60000", fillOpacity: 0.3 },
  },
  // P2 风险栅格尚未产出；0 低 → 2 高的调色方向等真实数据落地时定稿。
  risk_level: {
    kind: "cog",
    options: { bands: "1", colormap: "spectral", rescaleMin: 0, rescaleMax: 2, opacity: 0.75 },
  },
  eco_index: {
    kind: "cog",
    options: { bands: "1", colormap: "viridis", rescaleMin: 0, rescaleMax: 1, opacity: 0.85 },
  },
  landcover: { kind: "cog", options: { bands: "1", opacity: 0.85 } },
  imagery_cog: { kind: "cog", options: { rescaleMin: 0, rescaleMax: 255 } },
  // 标注 QA 六类分色（与 Label Studio build_labelstudio_masks.LABEL_COLORS 一致）
  annotation_露天采坑: {
    kind: "geojson",
    style: { strokeColor: "#ff4d4f", strokeWidth: 1, fillColor: "#ff4d4f", fillOpacity: 0.45 },
  },
  annotation_固体废弃物: {
    kind: "geojson",
    style: { strokeColor: "#faad14", strokeWidth: 1, fillColor: "#faad14", fillOpacity: 0.45 },
  },
  annotation_矿山道路: {
    kind: "geojson",
    style: { strokeColor: "#1677ff", strokeWidth: 1, fillColor: "#1677ff", fillOpacity: 0.45 },
  },
  annotation_裸露地表: {
    kind: "geojson",
    style: { strokeColor: "#8c8c8c", strokeWidth: 1, fillColor: "#8c8c8c", fillOpacity: 0.45 },
  },
  annotation_恢复治理: {
    kind: "geojson",
    style: { strokeColor: "#52c41a", strokeWidth: 1, fillColor: "#52c41a", fillOpacity: 0.45 },
  },
  annotation_工业广场: {
    kind: "geojson",
    style: { strokeColor: "#722ed1", strokeWidth: 1, fillColor: "#722ed1", fillOpacity: 0.45 },
  },
};

export const DEFAULT_PRESET: CaseStylePreset = {
  kind: "geojson",
  style: { strokeColor: "#555", strokeWidth: 1.5, fillColor: "#555", fillOpacity: 0.2 },
};

export function presetFor(typeOrPreset: string): CaseStylePreset {
  return CASE_STYLE_PRESETS[typeOrPreset] ?? DEFAULT_PRESET;
}

/** bbox 校验（[w, s, e, n]），坏值返回 null 而不是让 fitBounds 抛错。 */
export function productBbox(p: CaseProduct): [number, number, number, number] | null {
  const b = p.bbox;
  if (!Array.isArray(b) || b.length !== 4) return null;
  if (b.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  const [w, s, e, n] = b as [number, number, number, number];
  if (w >= e || s >= n) return null;
  return [w, s, e, n];
}

/** 成果列表行的指标摘要（白名单键 + 中文标签，缺失键跳过）。 */
const SUMMARY_KEYS: readonly [string, string][] = [
  ["patch_count", "形变斑"],
  ["in_mine_patch_count", "矿内"],
  ["in_mine_area_m2", "矿内面积m²"],
  ["mines_affected", "涉及矿权"],
  ["feature_count", "要素"],
  ["max_subsidence", "最大沉降m/yr"],
];

export function metricsSummary(p: CaseProduct): string {
  const parts: string[] = [];
  for (const [key, label] of SUMMARY_KEYS) {
    const value = p.metrics?.[key];
    if (typeof value === "number" && Number.isFinite(value)) parts.push(`${label} ${value}`);
    else if (typeof value === "string" && value) parts.push(`${label} ${value}`);
  }
  return parts.join(" · ");
}
