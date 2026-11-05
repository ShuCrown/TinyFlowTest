import { isVisible, PANEL_RULES } from "../dsl/panel-rules.ts";

/**
 * 弹层生命周期跟踪（对齐 FlowTest collector 的 overlay 检测）。
 *
 * 只服务录制端：给「没有命中规则表」的自造下拉补一个开合信号，
 * 让 cluster 能把 click →（面板出现）→ 选项点击 折成意图簇。
 * 已知组件（antd 等）仍走 semantic.rule，不走这里。
 */

const OVERLAY_ROLES = ["dialog", "alertdialog", "menu", "listbox", "tree", "grid"];

/** 规则表里的面板选择器 + 通用 role，避免再维护一份组件类名。 */
const OVERLAY_SELECTOR = Array.from(
  new Set([
    ...PANEL_RULES.flatMap((rule) => rule.panel),
    ...OVERLAY_ROLES.map((role) => `[role="${role}"]`),
  ]),
).join(", ");

export interface OverlayWatcherHandlers {
  onOpen: (overlay: Element) => void;
  onClose: (overlay: Element) => void;
}

export class OverlayWatcher {
  private readonly handlers: OverlayWatcherHandlers;
  private observer: MutationObserver | null = null;
  private active: Element | null = null;
  private timer = 0;
  private doc: Document | null = null;

  constructor(handlers: OverlayWatcherHandlers) {
    this.handlers = handlers;
  }

  start(doc: Document): void {
    this.stop();
    this.doc = doc;
    this.observer = new MutationObserver(() => this.schedule(doc));
    this.observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "style", "class", "aria-hidden", "aria-expanded"],
    });
    this.scan(doc);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.doc = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    this.active = null;
  }

  /** 当前展开的弹层；点击落在它内部时就是「面板内点击」。 */
  get overlay(): Element | null {
    return this.active;
  }

  /** 同步扫描一次：点击间隔很短时，不能等 60ms 的防抖。 */
  refresh(): void {
    if (this.doc) this.scan(this.doc);
  }

  private schedule(doc: Document): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.scan(doc);
    }, 60);
  }

  private scan(doc: Document): void {
    const next = topOverlay(doc);
    if (next === this.active) return;
    const previous = this.active;
    this.active = next;
    if (previous) this.handlers.onClose(previous);
    if (next) this.handlers.onOpen(next);
  }
}

/** 取最后一个可见弹层：组件通常把新面板 append 到 body 末尾。 */
function topOverlay(doc: Document): Element | null {
  const candidates = Array.from(doc.querySelectorAll(OVERLAY_SELECTOR)).filter(isVisible);
  return candidates[candidates.length - 1] ?? null;
}

