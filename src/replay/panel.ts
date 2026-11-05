import type { PickerNode } from "../dsl/index.ts";
import {
  isVisible,
  PANEL_CONTAINER_SELECTOR,
  PANEL_RULES,
  selectorsForZone,
  type PanelRule,
} from "../dsl/panel-rules.ts";

/**
 * 面板绑定与开合谓词。
 *
 * 判据顺序（docs 5.3）：
 * 1. 触发器 aria-expanded 契约；
 * 2. 面板容器可见性（antd 关闭时保留 DOM，只加 hidden 类，不能用「元素不在 DOM」判断）；
 * 3. 面板选择器来自 panel-rules，不在引擎里另写一份类名。
 */

const POLL_MS = 100;

/** aria-controls 常指向容器里的 0x0 镜像，必须映射到容器再判可见。 */
const PANEL_CONTAINERS = PANEL_CONTAINER_SELECTOR;

export function pickerRule(node: PickerNode): PanelRule | undefined {
  const id = typeof node.meta?.rule === "string" ? node.meta.rule : "";
  return PANEL_RULES.find((rule) => rule.id === id);
}

/** 面板 scope 的 css 选择器；转换期已从规则表取到，这里不再猜。 */
export function panelSelectorOf(node: PickerNode): string | null {
  const target = node.panel.scope.target;
  const css = target?.strategies.find((strategy) => strategy.type === "css");
  return css?.value ?? null;
}

export function visiblePanels(doc: Document, selector: string | null): Element[] {
  if (!selector) return [];
  return Array.from(doc.querySelectorAll(selector)).filter(isVisible);
}

/**
 * 触发器契约优先；没有 aria-expanded 时看面板是否可见。
 * 有显式 false 时以组件状态为准——否则页面上别的面板还开着会被误判成本组件已展开。
 */
export function isPanelOpen(control: Element, selector: string | null): boolean {
  const boxes = [control, ...Array.from(control.querySelectorAll("[aria-expanded]"))];
  let hasContract = false;
  for (const box of boxes) {
    const value = box.getAttribute("aria-expanded");
    if (value === null) continue;
    hasContract = true;
    if (value === "true") return true;
  }
  if (hasContract) return false;
  return visiblePanels(control.ownerDocument, selector).length > 0;
}

export type PanelBinding = "contract" | "structural" | "temporal" | "dialog";

export interface PanelResolution {
  element: Element;
  binding: PanelBinding;
}

/**
 * 绑定优先级（docs 5.3）：
 * A 契约：aria-controls 的 id 能解析，且其最近的弹出容器可见；
 * B 结构：规则表的面板选择器有可见命中（录制到 id 但失效时走这里）；
 * C 时序：没有任何契约线索时，取唯一可见的面板，报告里标降级。
 */
export function resolvePanel(
  doc: Document,
  node: PickerNode,
  selector: string | null,
  livePopupId?: string | null,
): PanelResolution | null {
  // 触发器当前的 aria-controls 比录制值更可信：重新挂载后 id 会被别的组件复用。
  const currentId = livePopupId?.trim();
  if (currentId) {
    const target = doc.getElementById(currentId);
    if (target) {
      // aria-controls 常指向 0×0 镜像 / listbox，不能把它本身当面板；必须先映射到容器。
      const container = target.closest(PANEL_CONTAINERS);
      if (container) {
        // 当前契约存在但不可见 = 本组件的面板还没开，不能拿别的可见面板顶替。
        return isVisible(container) ? { element: container, binding: "contract" } : null;
      }
      // 不是可识别容器（例如镜像节点挂到 body 下）：继续走结构兜底找可见面板。
    }
    // 目标没挂载：可能是异步渲染，也可能是 Cascader 这类悬空 aria-controls。
    // 继续走结构兜底；真正已挂载但不可见的面板仍在上面的分支里严格等待。
  }
  const popupId = node.panel.popupId;
  if (popupId) {
    const target = doc.getElementById(popupId);
    // id 能解析但不可见 = 本组件的面板还没开，不能拿别的可见面板顶替。
    if (target) {
      const container = target.closest(PANEL_CONTAINERS);
      if (container) {
        return isVisible(container) ? { element: container, binding: "contract" } : null;
      }
    }
  }
  const panels = visiblePanels(doc, selector);
  if (panels.length === 0) return null;
  return {
    element: panels[panels.length - 1]!,
    binding: node.mode === "dialog" ? "dialog" : popupId ? "structural" : "temporal",
  };
}

/** 等面板出现；返回元素与命中的绑定档位。 */
export async function waitForPanel(
  doc: Document,
  node: PickerNode,
  selector: string | null,
  timeoutMs: number,
  /** 每轮重读触发器契约：aria-controls 可能由组件在点击后异步挂载。 */
  livePopupId?: () => string | null,
): Promise<PanelResolution | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const found = resolvePanel(doc, node, selector, livePopupId?.());
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await delay(POLL_MS);
  } while (true);
}

/** 等这个面板消失。antd 关闭后元素仍在 DOM，只是不可见；元素被卸载也算关闭。 */
export async function waitForPanelClosed(
  panel: Element,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!isVisible(panel)) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  } while (true);
}

/**
 * 级联的多列同时可见：
 * - 有录制列号：只查该列；列还没渲染时返回空，让回放继续等待而不是在别的列里试；
 * - 无录制列号（旧录制 / 外部 JSON）：从最后一列往前找，并优先命中更深层。
 */
export function pickScopes(
  panel: Element,
  rule: PanelRule | undefined,
  column?: number,
): Element[] {
  if (rule?.id !== "antd-cascader") return [panel];
  const columns = Array.from(panel.querySelectorAll(rule.panel.at(-1) ?? ".ant-cascader-menu")).filter(
    isVisible,
  );
  if (column && column > 0) {
    const target = columns[column - 1];
    return target ? [target] : [];
  }
  return columns.length > 0 ? columns.slice().reverse() : [panel];
}

/** 与录制序号共用同一份选择器定义，见 panel-rules.selectorsForZone。 */
export function itemSelectorsOf(rule: PanelRule | undefined, byRow: boolean): string[] {
  return selectorsForZone(rule, byRow);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
