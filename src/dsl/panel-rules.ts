/**
 * 复合组件规则表：触发器 / 面板 / 可见项 / 行 / 值属性 / 开合信号。
 *
 * 录制、转换、回放三方共用，替代此前在 dom-recorder 与 engine 各抄一份的类名表。
 * 选择器的合法性（哪些类名允许出现在哪个区、哪些禁止）见
 * docs/record-to-steps-redesign.md 附录 A；本文件是那张表的代码投影。
 *
 * 版本绑定：antd 5.5.0（6.4 交叉验证）。升级 antd 必须先重跑附录 A 的探针再改这里，
 * 否则规则会静默失效（例如 v6 的可见项没有 role=option）。
 */

/** 目标系统是 antd 5.x；6.4.4 已交叉验证，差异只有 Select 的容器类名。 */
export const RULES_LIBRARY = "antd@5.5.0";

export type PanelZone = "trigger" | "panel" | "item" | "row" | "other";

/** 命中来源：role/aria 属性 vs 组件库类名。报告按这两类分开计数。 */
export type Detection = "aria" | "class" | "heuristic";

export interface PanelRule {
  id: string;
  /** trigger 区允许的选择器；空数组表示没有专用触发器（如 Modal）。 */
  trigger: string[];
  /** 面板容器。portal 到 body 也能命中。 */
  panel: string[];
  /** 可点击的可见项，必须落在 panel 内。 */
  item: string[];
  /** 表格行：弹窗选择器 byRow 的目标。 */
  row?: string[];
  /** 面板内的提交/确认控件（弹窗「确定」、日期 range 的「确定」），不算选择项。 */
  commit?: string[];
  /** 选项的列表根；缺省用面板根。级联有多列，序号必须按列计算。 */
  itemScope?: string;
  /** 选项值的来源属性，按顺序取第一个非空。 */
  valueAttr?: string[];
  /** 打开/关闭判据：组件契约优先，没有契约时看面板可见性。 */
  openSignal: "aria-expanded" | "panel-visible";
  triggerAction: "click" | "hover";
  /** 面板/选项的通用 role 兜底。v6 Select 故意不填 itemRole：role=option 只在 0x0 镜像里。 */
  panelRole?: string;
  itemRole?: string;
}

/**
 * 顺序即优先级：同等 zone 命中时排在前面的规则胜出。
 * Cascader 必须排在 Select 之前——它的触发器同时带 .ant-select 类。
 */
export const PANEL_RULES: PanelRule[] = [
  {
    id: "antd-cascader",
    trigger: [".ant-cascader"],
    panel: [".ant-cascader-dropdown", ".ant-cascader-menu"],
    item: [".ant-cascader-menu-item"],
    itemScope: ".ant-cascader-menu",
    // v5 的 data-path-key 是内部编码（330000__RC_CASCADER_SPLIT__330100），不是业务值
    valueAttr: ["title"],
    openSignal: "aria-expanded",
    triggerAction: "click",
    panelRole: "menu",
    itemRole: "menuitemcheckbox",
  },
  {
    id: "antd-select",
    // v5 是 .ant-select-content 之前的 .ant-select-selector；v6 换成 .ant-select-content
    trigger: ['input[role="combobox"]', ".ant-select-selector", ".ant-select-content", ".ant-select-input", ".ant-select"],
    panel: [".ant-select-dropdown"],
    item: [".ant-select-item-option"],
    valueAttr: ["title"],
    openSignal: "aria-expanded",
    triggerAction: "click",
    panelRole: "listbox",
  },
  {
    id: "antd-date",
    trigger: [".ant-picker", ".ant-picker-input"],
    panel: [".ant-picker-dropdown", ".ant-picker-panel"],
    item: ["td.ant-picker-cell-in-view"],
    // antd v5 的确定按钮自身就带 .ant-picker-ok；兼容外层包裹的写法。
    commit: [".ant-picker-ok", ".ant-picker-ok button"],
    valueAttr: ["title"],
    openSignal: "panel-visible",
    triggerAction: "click",
  },
  {
    id: "antd-dropdown",
    trigger: ['[aria-haspopup="menu"]', ".ant-dropdown-trigger"],
    panel: [".ant-dropdown"],
    item: [".ant-dropdown-menu-item"],
    openSignal: "panel-visible",
    triggerAction: "hover",
    panelRole: "menu",
    itemRole: "menuitem",
  },
  {
    id: "antd-modal",
    trigger: [],
    panel: ['[role="dialog"]', ".ant-modal"],
    item: [".ant-modal-close"],
    commit: [".ant-modal-footer button"],
    row: ["tr.ant-table-row[data-row-key]"],
    // 行选择用 data-row-key 定位，避免同名行；取不到时 pickValue 退回行文本。
    valueAttr: ["data-row-key"],
    openSignal: "panel-visible",
    triggerAction: "click",
    panelRole: "dialog",
  },
];

/**
 * 弹出容器（不含弹窗）的合集：用于「触发器是否落在别的面板里」与
 * aria-controls 镜像到容器的映射，避免在回放侧再抄一份类名。
 */
export const PANEL_CONTAINER_SELECTOR = PANEL_RULES.filter((rule) => rule.id !== "antd-modal")
  .flatMap((rule) => rule.panel)
  .join(", ");

/**
 * rc-select 的 id 由模块级计数器按挂载顺序生成（rc_select_11 / rc_select_11_list）。
 * 页面重新挂载后编号会变，不能当作稳定定位。
 */
export function isGeneratedId(id: string): boolean {
  return /^rc_select_(?:\d+(?:_|$)|TEST_OR_SSR$)/i.test(id);
}

const ZONE_RANK: Record<PanelZone, number> = {
  item: 3,
  row: 3,
  trigger: 2,
  panel: 1,
  other: 0,
};

/** 附录 A.3 的禁止项：CSS-in-JS 哈希、主题 token、位置选择器、类名子串、状态类。 */
const DENIED_CSS: RegExp[] = [
  /\.css-[a-z0-9]{4,}/i,
  /css-var-/,
  /css-dev-only-do-not-override/,
  /:nth-(child|of-type)/,
  /\[class\*=/,
];
const STATE_SELECTOR = /-{1,2}(selected|active|disabled)\b/;

export function isDeniedCss(selector: string): boolean {
  if (DENIED_CSS.some((pattern) => pattern.test(selector))) return true;
  if ((selector.match(/>/g)?.length ?? 0) >= 2) return true;
  return STATE_SELECTOR.test(selector);
}

export function selectorsOf(rule: PanelRule, zone: PanelZone): string[] {
  switch (zone) {
    case "trigger":
      return rule.trigger;
    case "panel":
      return rule.panel;
    case "item":
      return rule.item;
    case "row":
      return rule.row ?? [];
    default:
      return [];
  }
}

/** 附录 A.4：other 区一律拒绝；其余区必须命中白名单且不在禁止项里。 */
export function canUseCss(rule: PanelRule, zone: PanelZone, selector: string): boolean {
  if (zone === "other") return false;
  if (isDeniedCss(selector)) return false;
  return selectorsOf(rule, zone).includes(selector);
}

export interface RuleMatch {
  rule: PanelRule;
  zone: Exclude<PanelZone, "other">;
  selector: string;
  detection: Detection;
  /** 命中区的元素：item/row 是那一项，panel 是面板根，trigger 是触发器。 */
  element: Element;
}

export function matchElement(element: Element): RuleMatch | null {
  let best: RuleMatch | null = null;
  for (const rule of PANEL_RULES) {
    const match = matchInRule(rule, element);
    if (!match) continue;
    if (!best || ZONE_RANK[match.zone] > ZONE_RANK[best.zone]) best = match;
  }
  return best;
}

function matchInRule(rule: PanelRule, element: Element): RuleMatch | null {
  const panelSelector = closestMatch(element, rule.panel);
  if (panelSelector) {
    const panel = element.closest(panelSelector)!;
    const rowSelector = rule.row ? closestWithin(element, rule.row, panel) : null;
    if (rowSelector) return toMatch(rule, "row", rowSelector, element.closest(rowSelector)!);
    const itemSelector = closestWithin(element, rule.item, panel);
    if (itemSelector) return toMatch(rule, "item", itemSelector, element.closest(itemSelector)!);
    // 提交按钮（弹窗「确定」、日期 range 的「确定」）也算 item 区，但要标 commit。
    const commitSelector = closestWithin(element, rule.commit ?? [], panel);
    if (commitSelector) return toMatch(rule, "item", commitSelector, element.closest(commitSelector)!);
    return toMatch(rule, "panel", panelSelector, panel);
  }
  const triggerSelector = closestMatch(element, rule.trigger);
  if (triggerSelector) {
    return toMatch(rule, "trigger", triggerSelector, element.closest(triggerSelector)!);
  }
  return null;
}

function closestMatch(element: Element, selectors: string[]): string | null {
  for (const selector of selectors) {
    if (element.closest(selector)) return selector;
  }
  return null;
}

function closestWithin(element: Element, selectors: string[], root: Element): string | null {
  for (const selector of selectors) {
    const found = element.closest(selector);
    if (found && root.contains(found)) return selector;
  }
  return null;
}

function toMatch(
  rule: PanelRule,
  zone: Exclude<PanelZone, "other">,
  selector: string,
  element: Element,
): RuleMatch {
  return { rule, zone, selector, detection: detectionOf(selector), element };
}

function detectionOf(selector: string): Detection {
  return selector.includes("role=") || selector.includes("aria-") ? "aria" : "class";
}

/** 面板内的提交按钮：模态「确定」、日期 range 的「确定」。 */
export function isCommitTarget(element: Element, rule: PanelRule): boolean {
  return (rule.commit ?? []).some((selector) => element.matches(selector));
}

/**
 * 选项的值：按 valueAttr 取属性，取不到退回文本。
 * 注意 antd 的 Select 可见项只有 title（=标签），DOM 里没有 value；
 * Cascader 的 data-path-key 是内部编码（v5），日期格子的 title 才是真值。
 */
export function pickValue(element: Element, rule: PanelRule): string | undefined {
  for (const attr of rule.valueAttr ?? []) {
    const value = element.getAttribute(attr);
    if (value) return value;
  }
  const text = (element.textContent ?? "").trim();
  return text || undefined;
}

/** 读触发器的 aria-expanded；没有契约时返回 null，由面板可见性兜底。 */
export function expandedState(element: Element): boolean | null {
  const box = element.matches("[aria-expanded]") ? element : element.querySelector("[aria-expanded]");
  const value = box?.getAttribute("aria-expanded");
  if (value === undefined || value === null) return null;
  return value === "true";
}

/** 录制、回放、overlay 共用一份可见性判定，避免三处实现漂移。 */
export function isVisible(element: Element): boolean {
  const win = element.ownerDocument.defaultView;
  if (!win) return false;
  const style = win.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
    return false;
  }
  if (Number(style.opacity) === 0) return false;
  return element.getClientRects().length > 0;
}

/** 可见项 / 行的选择器；没有规则（overlay 兜底）时退回通用语义选择器。 */
export function selectorsForZone(rule: PanelRule | undefined, byRow: boolean): string[] {
  if (rule) return byRow ? (rule.row ?? []) : rule.item;
  return byRow
    ? ["tr[data-row-key]", "tr"]
    : ['[role="option"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', "li", "td.ant-picker-cell"];
}

/**
 * 选项所在的列表根。级联有多列，序号必须按当前列计算，否则第二列的
 * 「第 1 项」会被算成整个面板的第 3 项。
 */
export function itemScopeOf(element: Element, rule: PanelRule): Element | null {
  if (rule.itemScope) {
    const scope = element.closest(rule.itemScope);
    if (scope) return scope;
  }
  for (const selector of rule.panel) {
    const panel = element.closest(selector);
    if (panel) return panel;
  }
  return null;
}

/**
 * 当前可见项，按 DOM 顺序。录制序号与回放「第 N 项」都从这里取，
 * 保证两边是同一个列表（顺序、可见性、提交按钮排除规则完全一致）。
 */
export function visibleItems(
  scope: Element,
  rule: PanelRule | undefined,
  byRow: boolean,
): Element[] {
  const selectors = selectorsForZone(rule, byRow);
  if (selectors.length === 0) return [];
  const commit = rule?.commit ?? [];
  return Array.from(scope.querySelectorAll(selectors.join(", "))).filter(
    (element) => isVisible(element) && !commit.some((selector) => element.matches(selector)),
  );
}
