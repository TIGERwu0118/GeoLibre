/**
 * 案例验证（任务书 2.3 三任务）panel。
 *
 * 从 products.json（00-计划 M1 成果库）按 task 读取产品并上图：
 * geojson → addGeoJsonLayer + 样式预设；cog → addCogLayer + 渲染预设。
 * 三个 section（违法监测/地灾/生态）共用同一机制——空任务显示引导文案，
 * 新管线（P2…P6）产出登记进 products.json 后无需改本文件即可上图。
 * 成果列表点击 = 加载图层 + fitBounds 到该产品 bbox。
 */

import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import type { FeatureCollection } from "geojson";
import {
  CASE_TASKS,
  metricsSummary,
  parseProducts,
  presetFor,
  productBbox,
  type CaseProduct,
  type CaseTaskId,
  type ParsedCaseProduct,
} from "./case-kit";

export const CASES_PLUGIN_ID = "maplibre-cases";
const PANEL_ID = "cases-validation-panel";

/** M1 成果库注册表（tools/products_store.py 维护，8767 出口）。 */
export const DEFAULT_PRODUCTS_MANIFEST_URL = "http://127.0.0.1:8767/geolibre-products/products.json";
const SETTINGS_STORAGE_KEY = "geolibre.cases.settings";

export interface CasesSettings {
  productsUrl: string;
}

export function defaultCasesSettings(): CasesSettings {
  return { productsUrl: DEFAULT_PRODUCTS_MANIFEST_URL };
}

export function mergeCasesSettings(stored: unknown): CasesSettings {
  const base = defaultCasesSettings();
  if (stored && typeof stored === "object") {
    const raw = stored as Partial<CasesSettings>;
    if (typeof raw.productsUrl === "string" && raw.productsUrl.trim()) {
      base.productsUrl = raw.productsUrl.trim();
    }
  }
  return base;
}

export function loadCasesSettings(storage: Storage | null): CasesSettings {
  if (!storage) return defaultCasesSettings();
  try {
    return mergeCasesSettings(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? ""));
  } catch {
    return defaultCasesSettings();
  }
}

export function saveCasesSettings(storage: Storage | null, settings: CasesSettings): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage 配额满等：设置仅本会话生效，不打断面板。
  }
}

interface CasesLabels {
  panelTitle: string;
  intro: string;
  productsUrlLabel: string;
  refresh: string;
  removeLayers: string;
  loading: string;
  emptyTask: string;
  loadYear: (year: string) => string;
  added: (name: string) => string;
  summary: (added: number, skipped: number, failed: number) => string;
  failed: (what: string, error: string) => string;
  hostMissingCogApi: string;
  statusIdle: string;
}

const labels: CasesLabels = {
  panelTitle: "案例验证（三任务）",
  intro:
    "任务书 2.3 三个案例验证的成果上图入口，数据来自成果库 products.json（每条带 source/method 溯源）。" +
    "空任务表示对应管线尚未产出——数据登记后本面板自动可用。",
  productsUrlLabel: "成果库清单地址（products.json）",
  refresh: "刷新成果清单",
  removeLayers: "移除本面板图层",
  loading: "加载中…",
  emptyTask: "该任务暂无已登记成果",
  loadYear: (year) => `加载 ${year} 图层`,
  added: (name) => `已加载：${name}`,
  summary: (added, skipped, failed) => `加载 ${added} 个，跳过 ${skipped} 个，失败 ${failed} 个`,
  failed: (what, error) => `加载失败（${what}）：${error}`,
  hostMissingCogApi: "宿主未提供 addCogLayer 接口",
  statusIdle: "未加载图层",
};

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
const SELECT_STYLE =
  "padding:4px 6px;border:1px solid rgba(128,128,128,0.5);border-radius:4px;background:transparent;color:inherit;";
const LIST_ITEM_STYLE =
  "text-align:left;padding:4px 6px;border:1px solid rgba(128,128,128,0.35);border-radius:4px;background:transparent;color:inherit;cursor:pointer;";

interface TaskSection {
  task: CaseTaskId;
  details: HTMLDetailsElement;
  yearSelect: HTMLSelectElement;
  loadButton: HTMLButtonElement;
  list: HTMLDivElement;
  products: ParsedCaseProduct[];
}

function selectedYear(section: TaskSection): string | null {
  return section.yearSelect.value || null;
}

function yearsOf(products: ParsedCaseProduct[]): string[] {
  const years = new Set<string>();
  for (const { product } of products) {
    if (product.year) years.add(product.year);
  }
  return [...years].sort().reverse();
}

function productsForYear(section: TaskSection, year: string | null): ParsedCaseProduct[] {
  return section.products.filter((item) => (year ? item.product.year === year : true));
}

function buildPanel(container: HTMLElement): () => void {
  const storage = typeof localStorage !== "undefined" ? localStorage : null;
  const settings = loadCasesSettings(storage);

  const root = document.createElement("div");
  root.style.cssText =
    "display:flex;flex-direction:column;gap:8px;padding:4px 2px;font-size:13px;line-height:1.5;";

  const intro = document.createElement("p");
  intro.style.cssText = "margin:0 0 4px;opacity:0.85;";
  intro.textContent = labels.intro;

  const status = document.createElement("div");
  status.style.cssText = "min-height:1.4em;opacity:0.85;";
  status.textContent = labels.statusIdle;

  const sections = new Map<CaseTaskId, TaskSection>();

  const renderList = (section: TaskSection): void => {
    section.list.replaceChildren();
    const year = selectedYear(section);
    const items = productsForYear(section, year);
    if (!items.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "opacity:0.7;font-size:12px;";
      empty.textContent = labels.emptyTask;
      section.list.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText = LIST_ITEM_STYLE;
      const title = document.createElement("div");
      title.textContent = item.name;
      const metric = document.createElement("div");
      metric.style.cssText = "opacity:0.7;font-size:12px;";
      metric.textContent = metricsSummary(item.product);
      row.append(title, metric);
      row.addEventListener("click", () => {
        void ensureLoaded(item);
      });
      section.list.append(row);
    }
  };

  const syncSection = (section: TaskSection): void => {
    const years = yearsOf(section.products);
    section.yearSelect.replaceChildren();
    if (!years.length) {
      section.yearSelect.style.display = "none";
      section.loadButton.style.display = "none";
    } else {
      section.yearSelect.style.display = "";
      section.loadButton.style.display = "";
      for (const year of years) {
        const option = document.createElement("option");
        option.value = year;
        option.textContent = year;
        section.yearSelect.append(option);
      }
    }
    section.loadButton.textContent = labels.loadYear(selectedYear(section) ?? "…");
    renderList(section);
  };

  const sectionsRoot = document.createElement("div");
  for (const descriptor of CASE_TASKS) {
    const details = document.createElement("details");
    details.style.cssText = SECTION_STYLE;
    if (descriptor.id === "hazard") details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = descriptor.title;
    summary.style.cssText = "cursor:pointer;opacity:0.9;";
    const note = document.createElement("p");
    note.style.cssText = "margin:4px 0 0;opacity:0.7;font-size:12px;";
    note.textContent = descriptor.intro;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
    const yearSelect = document.createElement("select");
    yearSelect.setAttribute("aria-label", `${descriptor.title} 年份`);
    yearSelect.style.cssText = SELECT_STYLE;
    const loadButton = document.createElement("button");
    loadButton.type = "button";
    loadButton.textContent = labels.loadYear("…");
    loadButton.style.cssText = BUTTON_STYLE;
    row.append(yearSelect, loadButton);
    const list = document.createElement("div");
    list.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    details.append(summary, note, row, list);
    sectionsRoot.append(details);
    const section: TaskSection = { task: descriptor.id, details, yearSelect, loadButton, list, products: [] };
    sections.set(descriptor.id, section);

    yearSelect.addEventListener("change", () => {
      section.loadButton.textContent = labels.loadYear(selectedYear(section) ?? "…");
      renderList(section);
    });
    loadButton.addEventListener("click", () => {
      void loadSection(section);
    });
  }

  // 成果库地址行 + 全局按钮
  const settingsRow = document.createElement("div");
  settingsRow.style.cssText = "display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;";
  const urlLabel = document.createElement("label");
  urlLabel.style.cssText = "flex:1 1 260px;display:flex;flex-direction:column;gap:2px;";
  const urlText = document.createElement("span");
  urlText.style.cssText = "opacity:0.8;";
  urlText.textContent = labels.productsUrlLabel;
  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.value = settings.productsUrl;
  urlInput.style.cssText = INPUT_STYLE;
  urlInput.setAttribute("autocomplete", "off");
  urlInput.setAttribute("spellcheck", "false");
  urlLabel.append(urlText, urlInput);
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.textContent = labels.refresh;
  refreshButton.style.cssText = BUTTON_STYLE;
  const removeLayers = document.createElement("button");
  removeLayers.type = "button";
  removeLayers.textContent = labels.removeLayers;
  removeLayers.style.cssText = BUTTON_STYLE;
  settingsRow.append(urlLabel, refreshButton, removeLayers);

  root.append(intro, settingsRow, status, sectionsRoot);
  container.append(root);

  urlInput.addEventListener("change", () => {
    const next = mergeCasesSettings({ productsUrl: urlInput.value });
    settings.productsUrl = next.productsUrl;
    urlInput.value = settings.productsUrl;
    saveCasesSettings(storage, settings);
  });

  refreshButton.addEventListener("click", () => {
    void refreshManifest();
  });

  removeLayers.addEventListener("click", () => {
    const store = useAppStore.getState();
    let count = 0;
    for (const id of [...trackedLayerIds]) {
      store.removeLayer(id);
      trackedLayerIds.delete(id);
      count += 1;
    }
    status.textContent = `已移除 ${count} 个图层`;
  });

  const ensureLoaded = async (item: ParsedCaseProduct): Promise<void> => {
    try {
      // 非图层产品（报告/指标表）不上图：定位到产品范围并展示指标摘要。
      const LOADABLE = new Set(["geojson", "cog", "tif"]);
      if (!LOADABLE.has(item.product.format)) {
        const bbox = productBbox(item.product);
        if (bbox) appRef?.fitBounds?.(bbox);
        status.textContent = `报告（不上图）：${metricsSummary(item.product) || item.name}`;
        return;
      }
      const existing = layerByName(item.name);
      if (!existing) await addProduct(item, (message) => (status.textContent = message));
      const bbox = productBbox(item.product);
      if (bbox) appRef?.fitBounds?.(bbox);
      status.textContent = labels.added(item.name);
    } catch (error: unknown) {
      status.textContent = labels.failed(
        item.name,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const loadSection = async (section: TaskSection): Promise<void> => {
    const items = productsForYear(section, selectedYear(section)).filter(
      (item) => item.product.format === "geojson" || item.product.format === "cog" || item.product.format === "tif",
    );
    let added = 0;
    let skipped = 0;
    let failed = 0;
    for (const item of items) {
      if (layerByName(item.name)) {
        skipped += 1;
        continue;
      }
      try {
        status.textContent = `${labels.loading} ${item.name}`;
        await addProduct(item, (message) => (status.textContent = message));
        trackedLayerIds.add(layerByName(item.name)!.id);
        added += 1;
      } catch {
        failed += 1;
      }
    }
    status.textContent = labels.summary(added, skipped, failed);
  };

  const addProduct = async (
    item: ParsedCaseProduct,
    onStatus: (message: string) => void,
  ): Promise<void> => {
    const preset = presetFor(item.product.style_preset ?? item.product.type);
    if (preset.kind === "cog") {
      if (typeof appRef?.addCogLayer !== "function") {
        throw new Error(labels.hostMissingCogApi);
      }
      const id = await appRef.addCogLayer(item.name, item.url, { ...preset.options });
      trackedLayerIds.add(id);
      return;
    }
    const response = await fetch(item.url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as FeatureCollection;
    if (!data || data.type !== "FeatureCollection") {
      throw new Error("not a GeoJSON FeatureCollection");
    }
    const id = appRef!.addGeoJsonLayer(item.name, data, item.url);
    useAppStore.getState().setLayerStyle(id, { ...preset.style });
    trackedLayerIds.add(id);
    onStatus(labels.added(item.name));
  };

  const refreshManifest = async (): Promise<void> => {
    const manifestUrl = settings.productsUrl;
    refreshButton.disabled = true;
    try {
      status.textContent = labels.loading;
      const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = (await response.json()) as unknown;
      for (const section of sections.values()) {
        section.products = parseProducts(manifest, manifestUrl, section.task);
        syncSection(section);
        const years = yearsOf(section.products);
        section.loadButton.textContent = labels.loadYear(years[0] ?? "…");
      }
      const total = [...sections.values()].reduce((sum, s) => sum + s.products.length, 0);
      status.textContent = `成果清单已刷新：${total} 个产品`;
    } catch (error: unknown) {
      status.textContent = labels.failed(
        labels.refresh,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      refreshButton.disabled = false;
    }
  };

  void refreshManifest();

  return () => {
    container.replaceChildren();
  };
}

export const maplibreCasesPlugin: GeoLibrePlugin = {
  id: CASES_PLUGIN_ID,
  name: "案例验证（三任务）",
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
    // 与矿山总览/InSAR 一致：从插件菜单激活即刻开面板，否则无入口。
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

export default maplibreCasesPlugin;
