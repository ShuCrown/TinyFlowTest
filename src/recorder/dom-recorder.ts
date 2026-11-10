import type {
  CapturedRequest,
  ChromeRecorderStep,
  StepSemantic,
} from "./chrome-recorder.ts";
import {
  expandedState,
  isCommitTarget,
  isGeneratedId,
  isVisible,
  itemScopeOf,
  matchElement,
  pickValue,
  visibleItems,
} from "../dsl/panel-rules.ts";
import type { PanelRule, RuleMatch } from "../dsl/panel-rules.ts";
import type { CellControl, CellRef } from "../dsl/types.ts";
import { observeNetwork, type ObservedResponse } from "../lib/network-observer.ts";
import { OverlayWatcher } from "./overlay.ts";

/** 弹层内的可选项角色：只有这些才把点击当成「选择」。 */
const OVERLAY_ITEM_SELECTOR =
  '[role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="treeitem"], [role="gridcell"]';

const ACTIONABLE_SELECTOR = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "label",
  '[role="button"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="treeitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  ".ant-dropdown-menu-item",
  ".ant-select-item-option",
].join(",");

const HOVER_TRIGGER_SELECTOR =
  '[aria-haspopup],[aria-expanded],[class*="dropdown-trigger"],.ant-dropdown-trigger';

const PRESS_KEYS = new Set(["Enter", "Tab", "Escape"]);

/** 每条请求保留的响应体上限；录制 JSON 存在 localStorage，避免撑满。 */
const MAX_CAPTURED_BODY_CHARS = 32 * 1024;

interface TextStep {
  element: Element;
  step: ChromeRecorderStep;
}

export interface DomRecorderOptions {
  onChange?: (steps: ChromeRecorderStep[]) => void;
  /** 取值拾取模式的开关状态；reason 用于区分捕获成功和取消。 */
  onValueModeChange?: (armed: boolean, reason?: "captured" | "canceled") => void;
}

/**
 * 在目标页 DOM 上直接录制用户操作，产出与 Chrome Recorder 同构的 steps。
 *
 * - 文本输入用 change/blur + 停止时补采，避免每个字符都生成节点；
 * - select / checkbox 走 change，交给转换器识别 nativeSelect / check；
 * - hover 只记录带 aria-haspopup / dropdown-trigger 的悬浮触发器；
 * - 页面导航由外层的 iframe load 事件调用 recordNavigation。
 */
export class DomRecorder {
  private readonly options: DomRecorderOptions;
  private readonly steps: ChromeRecorderStep[] = [];
  private readonly listeners: Array<{ type: string; handler: EventListener }> = [];
  private committed = new WeakMap<Element, string>();
  private readonly pendingText = new Map<Element, { timer: number; order: number }>();
  private inputOrder = 0;
  private doc: Document | null = null;
  private recording = false;
  private lastHover: Element | null = null;
  private lastTextStep: TextStep | null = null;
  /** 等待回填 popupId 的触发器步骤：面板打开前 aria-controls 不存在。 */
  private pendingTrigger: { step: ChromeRecorderStep; element: Element } | null = null;
  /** mousedown 时的面板状态：click 派发时组件往往已经把面板打开，事后读不出「之前」。 */
  private preGestureOpen: boolean | null = null;
  /** 无规则组件的弹层观察器。 */
  private overlays: OverlayWatcher | null = null;
  /** 刚记录的点击：800ms 内出现弹层就回填 overlayOpen。 */
  private lastClick: { step: ChromeRecorderStep; at: number } | null = null;
  /** 选项 mousedown 时面板可能已经开始关闭，aria-controls 要趁这一刻读。 */
  private preGesturePopupId: string | null = null;
  /** 选项在可见列表中的位置（1 基）。必须在 mousedown 算：单选 click 时面板已经关了。 */
  private preGestureIndex: number | null = null;
  /** 最近一次进入编辑的单元格：编辑器渲染前先记地址，编辑键列时也能拿到原始行标识。 */
  private lastCell: { cell: HTMLTableCellElement; ref: CellRef } | null = null;
  /** 输入控件 → 单元格地址；应用可能在 change 前移除临时编辑器。 */
  private cellRefs = new WeakMap<Element, CellRef>();
  /** 本次聚焦后是否真的发生过 input；只有输入过的字段才允许 flush 兜底。 */
  private dirtyText = new WeakSet<Element>();
  /** 最近一次可能触发接口的步骤；请求在短窗口内到达就挂到该步骤上。 */
  private networkAction: { step: ChromeRecorderStep; at: number } | null = null;
  /** 目标页 fetch / XHR 包装的恢复函数。 */
  private networkCleanup: (() => void) | null = null;
  /** 取值模式：点击目标页字段时生成 extract 步骤而不是操作步骤。 */
  private valueMode = false;
  private valueModeCleanup: (() => void) | null = null;

  constructor(options: DomRecorderOptions = {}) {
    this.options = options;
  }

  start(): void {
    this.detach();
    this.steps.length = 0;
    this.committed = new WeakMap();
    this.pendingText.clear();
    this.inputOrder = 0;
    this.lastHover = null;
    this.lastTextStep = null;
    this.pendingTrigger = null;
    this.preGestureOpen = null;
    this.preGesturePopupId = null;
    this.preGestureIndex = null;
    this.lastCell = null;
    this.cellRefs = new WeakMap();
    this.dirtyText = new WeakSet();
    this.networkAction = null;
    this.recording = true;
    this.emit();
  }

  attach(doc: Document): void {
    if (this.doc === doc) return;
    this.detach();
    this.doc = doc;
    this.listen(doc, "click", (event) => this.onClick(event));
    this.listen(doc, "mousedown", (event) => this.onPointerDown(event));
    this.listen(doc, "change", (event) => this.onChange(event));
    this.listen(doc, "input", (event) => this.onInput(event));
    this.listen(doc, "focusin", (event) => this.onFocusIn(event));
    this.listen(doc, "mouseover", (event) => this.onHover(event));
    this.listen(doc, "keydown", (event) => this.onKeydown(event));
    this.overlays = new OverlayWatcher({ onOpen: (overlay) => this.onOverlayOpen(overlay), onClose: () => {} });
    this.overlays.start(doc);
    this.installNetworkObserver(doc);
  }

  stop(): ChromeRecorderStep[] {
    if (!this.recording) return this.steps.slice();
    this.flushPendingText();
    this.flushActiveText();
    this.recording = false;
    this.detach();
    this.emit();
    return this.steps.slice();
  }

  getSteps(): ChromeRecorderStep[] {
    return this.steps.slice();
  }

  /** 进入取值拾取模式：下一次点击目标页字段会生成 extract 步骤。 */
  armValueCapture(): boolean {
    if (!this.recording || !this.doc) return false;
    if (this.valueMode) return true;
    // 先把刚输入还没落盘的内容记下来，保证取值步骤排在搜索/输入之后。
    this.flushPendingText();
    this.flushActiveText();
    this.valueMode = true;
    this.mountValuePicker(this.doc);
    this.options.onValueModeChange?.(true);
    return true;
  }

  cancelValueCapture(reason: "captured" | "canceled" = "canceled"): void {
    if (!this.valueMode) return;
    this.valueMode = false;
    this.valueModeCleanup?.();
    this.valueModeCleanup = null;
    this.options.onValueModeChange?.(false, reason);
  }

  isValueCaptureArmed(): boolean {
    return this.valueMode;
  }

  recordNavigation(url: string): void {
    if (!this.recording || !url || url === "about:blank") return;
    const last = this.steps[this.steps.length - 1];
    if (last?.type === "navigate" && last.url === url) return;
    this.steps.push({ type: "navigate", url });
    this.lastTextStep = null;
    this.pendingTrigger = null;
    this.networkAction = null;
    this.emit();
  }

  private listen(doc: Document, type: string, handler: (event: Event) => void): void {
    const listener = handler as EventListener;
    doc.addEventListener(type, listener, true);
    this.listeners.push({ type, handler: listener });
  }

  private detach(): void {
    this.cancelValueCapture("canceled");
    if (this.doc) {
      for (const { type, handler } of this.listeners) {
        this.doc.removeEventListener(type, handler, true);
      }
    }
    for (const { timer } of this.pendingText.values()) window.clearTimeout(timer);
    this.pendingText.clear();
    this.overlays?.stop();
    this.overlays = null;
    this.networkCleanup?.();
    this.networkCleanup = null;
    this.networkAction = null;
    this.lastClick = null;
    this.listeners.length = 0;
    this.doc = null;
  }

  /**
   * 在捕获阶段先记下「这次手势之前面板是否已展开」。
   * antd 在 mousedown 里打开面板，等到 click 时 aria-expanded 已经是 true，
   * 直接读会把「打开动作」误记成「打开状态下的一次点击」，切簇就丢了边界。
   */
  private onPointerDown(event: Event): void {
    if (!this.recording || this.valueMode) return;
    const raw = event.target as Element | null;
    if (!raw || raw.nodeType !== 1) {
      this.preGestureOpen = null;
      return;
    }
    const match = matchElement(raw);
    this.preGestureOpen = match
      ? match.zone === "trigger"
        ? (expandedState(match.element) ?? hasVisiblePanel(match.element, match.rule))
        : true
      : null;
    this.preGesturePopupId = this.readPopupId(this.pendingTrigger?.element ?? null);
    this.preGestureIndex = itemOrdinal(raw, match);
    // 捕获阶段先记下单元格：应用若在 click 里立刻渲染编辑器，等到 change 时原值已经不在了。
    this.rememberCell(raw);
  }

  private onClick(event: Event): void {
    if (!this.recording || this.valueMode) return;
    this.flushPendingText();
    this.flushActiveText();
    this.lastHover = null;

    const raw = event.target as Element | null;
    if (!raw || raw.nodeType !== 1) return;
    // 同步扫一次弹层：用户点得很快时，等 60ms 防抖会漏掉「点开 → 立刻选项」。
    this.overlays?.refresh();
    const match = matchElement(raw);
    const element = clickTargetFor(raw, match);
    if (!element) return;
    const overlay = this.overlays?.overlay ?? null;
    const semantic =
      buildSemantic(element, match, this.preGestureOpen, this.preGestureIndex) ??
      (overlay ? overlayItemSemantic(element, overlay) : undefined);
    this.preGestureOpen = null;
    this.preGestureIndex = null;
    const step: ChromeRecorderStep = {
      type: "click",
      selectors: selectorsFor(element, true),
      ...dialogContext(element),
      ...labelContext(element),
    };
    // 已知组件由规则处理；无规则的点击登记为候选触发器，等弹层出现再回填。
    this.lastClick = semantic?.rule || (overlay && overlay.contains(element)) ? null : { step, at: Date.now() };
    // 只有真正记下 click 才切断文本合并；点回同一个输入框不该把一次编辑拆成两步。
    this.lastTextStep = null;
    // 用真正记录的元素（控件本身）登记待回填：命中可能是外层容器，容器上没有 aria-controls。
    this.record(step, semantic, element);
  }

  private onChange(event: Event): void {
    if (!this.recording || this.valueMode) return;
    const target = event.target as Element | null;
    if (!target || target.nodeType !== 1) return;
    // 行 / 选项里的勾选是点击的副作用：点击已经记录了意图，
    // 再记一条 change 会让回放把同一个勾选框点两次（等于取消选择）。
    const match = matchElement(target);
    if (match?.zone === "row" || match?.zone === "item") return;
    const tag = target.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return;
    const type = tag === "input" ? (target.getAttribute("type") || "text").toLowerCase() : "";
    const cellRef = this.cellRefForElement(target);

    if (tag === "select") {
      this.flushPendingText();
      const select = target as HTMLSelectElement;
      const value = select.selectedOptions[0]?.textContent?.trim() ?? select.value;
      this.record(
        {
          type: "change",
          selectors: selectorsFor(target, false),
          value,
          tagName: "select",
          ...dialogContext(target),
          ...labelContext(target),
        },
        withCell(target, buildSemantic(target, matchElement(target)), cellRef),
      );
      this.lastTextStep = null;
      return;
    }

    if (type === "checkbox" || type === "radio") {
      this.flushPendingText();
      this.record(
        {
          type: "change",
          selectors: selectorsFor(target, false),
          value: String((target as HTMLInputElement).checked),
          tagName: "input",
          inputType: type,
          ...dialogContext(target),
          ...labelContext(target),
        },
        withCell(target, buildSemantic(target, matchElement(target)), cellRef),
      );
      this.lastTextStep = null;
      return;
    }

    if (type === "button" || type === "submit" || type === "reset" || type === "file" || type === "password") {
      return;
    }
    this.cancelPendingText(target);
    this.recordText(target as HTMLInputElement | HTMLTextAreaElement, tag, type);
  }

  private onInput(event: Event): void {
    if (!this.recording || this.valueMode) return;
    const target = event.target as Element | null;
    if (!target || target.nodeType !== 1) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return;
    const field = target as HTMLInputElement | HTMLTextAreaElement;
    const type = tag === "input" ? (target.getAttribute("type") || "text").toLowerCase() : "";
    if (
      type === "checkbox" ||
      type === "radio" ||
      type === "button" ||
      type === "submit" ||
      type === "reset" ||
      type === "file" ||
      type === "password"
    ) {
      return;
    }
    this.dirtyText.add(field);
    this.rememberFieldCell(field);
    // 输入过程中清除已提交值，下一轮 debounce/change 才会生成新步骤
    if (this.committed.get(field) !== field.value) this.committed.delete(field);

    const pending = this.pendingText.get(field);
    if (pending) window.clearTimeout(pending.timer);
    this.inputOrder += 1;
    const order = this.inputOrder;
    const timer = window.setTimeout(() => {
      const current = this.pendingText.get(field);
      if (!current || current.order !== order) return;
      this.pendingText.delete(field);
      if (this.recording) this.recordText(field, tag, type);
    }, 350);
    this.pendingText.set(field, { timer, order });
  }

  /** 聚焦只清脏标记：没有 input 的字段不应该在 flush 时生成步骤。 */
  private onFocusIn(event: Event): void {
    if (this.valueMode) return;
    const target = event.target as Element | null;
    if (!target || target.nodeType !== 1) return;
    this.dirtyText.delete(target);
  }

  private onHover(event: Event): void {
    if (!this.recording || this.valueMode) return;
    this.flushPendingText();
    const raw = event.target as Element | null;
    if (!raw || raw.nodeType !== 1) return;
    const trigger = raw.closest(HOVER_TRIGGER_SELECTOR);
    if (!trigger || trigger === this.lastHover) return;
    this.lastHover = trigger;
    const match = matchElement(trigger);
    // Select / DatePicker / Cascader 的 aria-expanded 也会命中悬浮触发器，
    // 但它们的意图是 click，记下来只会在 picker 前多一个无意义的悬停节点。
    if (match && match.rule.triggerAction !== "hover") return;
    const semantic = match ? buildSemantic(trigger, match) : undefined;
    this.record(
      {
        type: "hover",
        selectors: selectorsFor(trigger, true),
        ...dialogContext(trigger),
        ...labelContext(trigger),
      },
      semantic,
      trigger,
    );
    this.lastTextStep = null;
  }

  private onKeydown(event: Event): void {
    if (!this.recording) return;
    if (this.valueMode) {
      // 拾取期间拦下页面快捷键；Esc 退出取值模式。
      event.preventDefault();
      event.stopPropagation();
      if ((event as KeyboardEvent).key === "Escape") this.cancelValueCapture("canceled");
      return;
    }
    const key = (event as KeyboardEvent).key;
    if (!PRESS_KEYS.has(key)) return;
    const active = this.doc?.activeElement;
    const eventTarget = event.target as Element | null;
    const target =
      eventTarget && eventTarget.nodeType === 1 && isCellEditor(eventTarget)
        ? eventTarget
        : active && active !== this.doc?.body
          ? active
          : null;
    if (target && isCellEditor(target)) {
      // 单元格编辑的 Enter / Tab 是提交、Escape 是取消；输入节点带 blurAfter，不再生成按键节点。
      if (key === "Escape") this.cancelCellEdit(target);
      else this.flushPendingText();
      return;
    }
    this.flushPendingText();
    this.steps.push({
      type: "keydown",
      key,
      ...(target
        ? {
            selectors: selectorsFor(target, false),
            ...dialogContext(target),
            ...labelContext(target),
          }
        : {}),
    });
    this.lastTextStep = null;
    this.emit();
  }

  private recordText(element: HTMLInputElement | HTMLTextAreaElement, tagName: string, inputType: string): void {
    const value = element.value;
    // 自定义下拉的搜索输入在点击展开时还是空值；这不是用户输入，记下来只会多一个空输入节点。
    if (value === "" && selectTriggerFor(element)) return;
    if (this.committed.get(element) === value) return;
    this.committed.set(element, value);
    const last = this.lastTextStep;
    if (last && last.element === element && this.steps[this.steps.length - 1] === last.step) {
      last.step.value = value;
      this.emit();
      return;
    }
    const step: ChromeRecorderStep = {
      type: "change",
      selectors: selectorsFor(element, false),
      value,
      tagName,
      ...(tagName === "input" ? { inputType } : {}),
      ...dialogContext(element),
      ...labelContext(element),
    };
    this.record(
      step,
      withCell(
        element,
        buildSemantic(element, matchElement(element)),
        this.cellRefs.get(element) ?? this.cellRefForElement(element),
      ),
    );
    this.lastTextStep = { element, step };
  }

  /** 在编辑器渲染前记下单元格地址；编辑键列时，change 发生时原键值已经被输入框替换。 */
  private rememberCell(target: Element): void {
    const cell = target.closest("td, th") as HTMLTableCellElement | null;
    if (!cell || cell.querySelector(EDIT_CONTROL_SELECTOR)) return;
    const ref = cellRefFor(cell);
    if (ref) this.lastCell = { cell, ref };
  }

  /** 输入控件出现时绑定单元格地址；之后编辑器被移除也能补上 semantic.cell。 */
  private rememberFieldCell(element: HTMLInputElement | HTMLTextAreaElement): void {
    const ref = this.cellRefForElement(element);
    if (ref) this.cellRefs.set(element, ref);
  }

  private cellRefForElement(element: Element): CellRef | undefined {
    const cell = element.closest("td, th") as HTMLTableCellElement | null;
    if (!cell) return undefined;
    if (this.lastCell?.cell === cell) return this.lastCell.ref;
    return cellRefFor(cell);
  }

  /** Escape 取消单元格编辑：丢弃未提交值，撤回已经去抖记录的 change。 */
  private cancelCellEdit(element: Element): void {
    this.cancelPendingText(element);
    this.committed.delete(element);
    const last = this.lastTextStep;
    if (last?.element === element && this.steps[this.steps.length - 1] === last.step) {
      this.steps.pop();
      this.lastTextStep = null;
      this.emit();
    }
  }

  private flushPendingText(): void {
    if (this.pendingText.size === 0) return;
    const entries = Array.from(this.pendingText.entries()).sort(
      (a, b) => a[1].order - b[1].order,
    );
    this.pendingText.clear();
    for (const [element, { timer }] of entries) {
      window.clearTimeout(timer);
      const tag = element.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") continue;
      const field = element as HTMLInputElement | HTMLTextAreaElement;
      const type = tag === "input" ? (element.getAttribute("type") || "text").toLowerCase() : "";
      if (["checkbox", "radio", "button", "submit", "reset", "file", "password"].includes(type)) continue;
      this.recordText(field, tag, type);
    }
  }

  private cancelPendingText(element: Element): void {
    const pending = this.pendingText.get(element);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.pendingText.delete(element);
  }

  private flushActiveText(): void {
    const active = this.doc?.activeElement;
    if (!active || active === this.doc?.body) return;
    const tag = active.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return;
    const field = active as HTMLInputElement | HTMLTextAreaElement;
    const type = tag === "input" ? (active.getAttribute("type") || "text").toLowerCase() : "";
    if (["checkbox", "radio", "button", "submit", "reset", "file", "password"].includes(type)) return;
    if (!this.dirtyText.has(field)) return;
    this.recordText(field, tag, type);
  }

  /**
   * 统一的入队口：附带 semantic、登记待回填的触发器、面板一打开就回填 popupId。
   */
  private record(step: ChromeRecorderStep, semantic?: StepSemantic, trigger?: Element): void {
    if (semantic) step.semantic = semantic;
    if (semantic?.zone === "trigger" && trigger && (step.type === "click" || step.type === "hover")) {
      this.pendingTrigger = { step, element: trigger };
    } else if (semantic?.popupOpen) {
      this.backfillTrigger();
    }
    this.steps.push(step);
    // 表单提交 / 自动保存的请求通常在动作后几百毫秒内发出，先登记最近动作。
    if (step.type === "click" || step.type === "change" || step.type === "keydown") {
      this.networkAction = { step, at: Date.now() };
    }
    this.emit();
  }

  /** 覆盖目标页的取值拾取层：拦截点击并描边悬停字段，不触发页面自身操作。 */
  private mountValuePicker(doc: Document): void {
    const layer = doc.createElement("div");
    layer.setAttribute("data-tf-value-picker", "layer");
    layer.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "cursor:crosshair",
      "background:rgba(37,99,235,0.04)",
    ].join(";");

    const highlight = doc.createElement("div");
    highlight.setAttribute("data-tf-value-picker", "highlight");
    highlight.style.cssText = [
      "position:fixed",
      "z-index:2147483646",
      "pointer-events:none",
      "box-sizing:border-box",
      "border:2px solid #2563eb",
      "border-radius:4px",
      "background:rgba(37,99,235,0.08)",
      "display:none",
    ].join(";");

    const hint = doc.createElement("div");
    hint.setAttribute("data-tf-value-picker", "hint");
    hint.textContent = "取值模式：点击要读取的字段 · Esc 取消";
    hint.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:18px",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "pointer-events:none",
      "padding:6px 14px",
      "border-radius:999px",
      "background:#1f2937",
      "color:#fff",
      "font:12px/1.5 system-ui, sans-serif",
      "box-shadow:0 8px 24px rgba(15,23,42,0.28)",
      "white-space:nowrap",
    ].join(";");

    let hovered: Element | null = null;

    const pickAt = (x: number, y: number): Element | null => {
      const elements = doc.elementsFromPoint(x, y);
      const hit = elements.find(
        (element) =>
          !element.closest("[data-tf-value-picker]") &&
          !/^(html|body)$/i.test(element.tagName),
      );
      return hit ? resolveValueTarget(hit) : null;
    };

    const onMove = (event: MouseEvent): void => {
      hovered = pickAt(event.clientX, event.clientY);
      if (!hovered) {
        highlight.style.display = "none";
        return;
      }
      const rect = hovered.getBoundingClientRect();
      highlight.style.display = "block";
      highlight.style.left = `${rect.left - 2}px`;
      highlight.style.top = `${rect.top - 2}px`;
      highlight.style.width = `${rect.width + 4}px`;
      highlight.style.height = `${rect.height + 4}px`;
    };

    const block = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };

    const onClick = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const target = hovered ?? pickAt(event.clientX, event.clientY);
      if (target) this.captureValue(target);
    };

    layer.addEventListener("mousemove", onMove);
    layer.addEventListener("mousedown", block);
    layer.addEventListener("mouseup", block);
    layer.addEventListener("pointerdown", block);
    layer.addEventListener("pointerup", block);
    layer.addEventListener("click", onClick);
    layer.addEventListener("contextmenu", (event) => event.preventDefault());
    doc.documentElement.append(layer, highlight, hint);

    this.valueModeCleanup = () => {
      layer.removeEventListener("mousemove", onMove);
      layer.removeEventListener("mousedown", block);
      layer.removeEventListener("mouseup", block);
      layer.removeEventListener("pointerdown", block);
      layer.removeEventListener("pointerup", block);
      layer.removeEventListener("click", onClick);
      layer.remove();
      highlight.remove();
      hint.remove();
    };
  }

  private captureValue(element: Element): void {
    if (!this.recording) return;
    const tag = element.tagName.toLowerCase();
    if (tag === "html" || tag === "body") return;
    this.flushPendingText();
    this.flushActiveText();
    const cell = element.closest("td, th") as HTMLTableCellElement | null;
    const cellRef = cell ? this.cellRefForElement(element) : undefined;
    const readMode: "text" | "value" = isValueControl(element) ? "value" : "text";
    const step: ChromeRecorderStep = {
      type: "extract",
      selectors: selectorsFor(element, true),
      varName: this.nextExtractVarName(),
      readMode,
      value: extractSample(element),
      ...dialogContext(element),
      ...labelContext(element),
    };
    if (cellRef) {
      step.semantic = { cell: { ...cellRef, control: controlKind(element) } };
    }
    if (!step.labelText) step.labelText = extractLabelFor(element, cell);
    this.record(step, step.semantic);
    this.cancelValueCapture("captured");
  }

  private nextExtractVarName(): string {
    const used = new Set(
      this.steps
        .filter((step) => step.type === "extract")
        .map((step) => String(step.varName ?? "")),
    );
    let index = 1;
    while (used.has(`extracted${index}`)) index += 1;
    return `extracted${index}`;
  }

  /** 包装目标页 fetch / XHR；请求参数与响应体挂在触发它的步骤上，随录制 JSON 一起输出。 */
  private installNetworkObserver(doc: Document): void {
    const win = doc.defaultView;
    if (!win) return;
    this.networkCleanup?.();
    this.networkCleanup = observeNetwork(win, {
      readResponseBody: true,
      maxBodyChars: MAX_CAPTURED_BODY_CHARS,
      shouldReadResponseBody: (contentType) =>
        !contentType || /json|text\/|xml/i.test(contentType),
      onRequest: (request) => this.onNetworkRequest(request),
      onResponse: (response) => this.onNetworkResponse(response),
    });
  }

  private onNetworkRequest(request: CapturedRequest): void {
    if (!this.recording || !this.networkAction) return;
    if (Date.now() - this.networkAction.at > 2000) return;
    // 只记录提交类接口，GET 查询与轮询不挂在步骤上。
    if (!["POST", "PUT", "DELETE"].includes(request.method)) return;
    const step = this.networkAction.step;
    if (!this.steps.includes(step)) return;
    const requests = step.requests ?? (step.requests = []);
    if (requests.length >= 8) return;
    requests.push(request);
    this.emit();
  }

  /** 响应回来后把状态、content-type 与响应体回写到同一条请求上并刷新列表。 */
  private onNetworkResponse(response: ObservedResponse): void {
    const request = response as CapturedRequest & { bodyText?: string };
    request.responseText = request.bodyText;
    delete request.bodyText;
    if (this.recording) this.emit();
  }

  /**
   * antd v5 / v6 都是面板打开后才出现 aria-controls（关闭即移除），
   * 所以 popupId 不能在触发器 click 时读，等第一次 popupOpen=true 的事件回填。
   * Cascader 的 aria-controls 指向不存在的 id，解析不到就留 null，回放按结构/时序降级。
   */
  private backfillTrigger(): void {
    const pending = this.pendingTrigger;
    if (!pending) return;
    this.pendingTrigger = null;
    const resolved = this.preGesturePopupId ?? this.readPopupId(pending.element);
    this.preGesturePopupId = null;
    pending.step.semantic = { ...pending.step.semantic, popupId: resolved };
  }

  private readPopupId(trigger: Element | null): string | null {
    if (!trigger) return null;
    const id = trigger.getAttribute("aria-controls")?.split(/\s+/)[0] ?? "";
    return id && trigger.ownerDocument.getElementById(id) ? id : null;
  }

  /**
   * 点击后 800ms 内出现弹层：说明这次点击是「打开面板」。
   * 只标注没有命中规则表的组件，已知组件走 semantic.rule。
   */
  private onOverlayOpen(overlay: Element): void {
    const last = this.lastClick;
    this.lastClick = null;
    if (!last || Date.now() - last.at > 800) return;
    if (last.step.semantic?.rule) return;
    // 已知组件的面板（.ant-modal / .ant-select-dropdown 等）交给规则处理，
    // 否则弹窗会被 overlay 抢走，丢掉 commit 与 byRow 的规则信息。
    if (matchElement(overlay)) return;
    last.step.semantic = {
      ...(last.step.semantic ?? {}),
      overlayOpen: true,
      panelRole: overlay.getAttribute("role") ?? null,
      panelId: overlay.id || null,
      popupOpen: true,
      detection: "heuristic",
    };
    this.emit();
  }

  private emit(): void {
    this.options.onChange?.(this.steps.slice());
  }
}

function isPlainField(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = (element.getAttribute("type") || "text").toLowerCase();
  return !["button", "submit", "reset", "image"].includes(type);
}

/** 单元格编辑态的控件：提交键属于编辑动作，不再单独生成 press 节点。 */
function isCellEditor(element: Element): boolean {
  if (!element.closest("td, th")) return false;
  const tag = element.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    (element as HTMLElement).isContentEditable
  );
}

/**
 * 点击落点 → 实际要记录的元素。
 * - 面板内的可见项 / 表格行：即使标签不在 ACTIONABLE 列表里也要记（td、li、div）；
 * - 普通可点元素：沿用原规则，输入框交给 change；
 * - 触发器：点击目标常是覆盖在容器上的搜索 input（可能 opacity: 0），
 *   必须记录一次打开动作，否则后续选项永远不出现。
 */
function clickTargetFor(raw: Element, match: RuleMatch | null): Element | null {
  if (match && (match.zone === "item" || match.zone === "row")) return match.element;

  const actionable = raw.closest(ACTIONABLE_SELECTOR);
  if (actionable && !actionable.closest("svg") && !isPlainField(actionable)) return actionable;

  if (match?.zone === "trigger") return controlFor(match.element);
  return null;
}

/** 触发器里真正接收事件的控件：优先带稳定 id/name 的输入，其次可见输入，最后才是容器。 */
function controlFor(trigger: Element): Element {
  const byIdentity = selectInputFor(trigger);
  if (byIdentity) return byIdentity;
  const field = Array.from(trigger.querySelectorAll("input, textarea")).find(isVisible);
  return field ?? trigger;
}

/** 从元素向上找本规则的面板根；找不到说明不在面板内。 */
function panelOf(element: Element, rule: PanelRule): Element | null {
  for (const selector of rule.panel) {
    const panel = element.closest(selector);
    if (panel) return panel;
  }
  return null;
}

/** 没有 aria-expanded 契约时（如 DatePicker），用「文档里存在可见面板」兜底。 */
function hasVisiblePanel(element: Element, rule: PanelRule): boolean {
  const doc = element.ownerDocument;
  return rule.panel.some((selector) =>
    Array.from(doc.querySelectorAll(selector)).some(isVisible),
  );
}

function buildSemantic(
  element: Element,
  match: RuleMatch | null,
  preGestureOpen?: boolean | null,
  ordinal?: number | null,
): StepSemantic | undefined {
  if (!match) return undefined;
  const { rule, zone, detection } = match;
  const panel = zone === "trigger" ? null : panelOf(element, rule);
  const semantic: StepSemantic = {
    rule: rule.id,
    zone,
    detection,
    role: element.getAttribute("role"),
    popupOpen:
      zone === "trigger"
        ? (preGestureOpen ?? expandedState(match.element) ?? hasVisiblePanel(match.element, rule))
        : true,
    panelRole: panel?.getAttribute("role") ?? rule.panelRole ?? null,
    panelId: panel?.id || null,
  };
  if (zone === "trigger") {
    semantic.controlSelectors = selectorsFor(controlFor(match.element), true);
    semantic.popupId = null;
  } else {
    semantic.value = pickValue(match.element, rule);
    semantic.commit = isCommitTarget(match.element, rule);
    if (!semantic.commit && ordinal) semantic.index = ordinal;
    // 级联是多列：记下列序号，转换期才能区分「同一项被重复点击」和「相邻列同名值」。
    if (!semantic.commit && rule.id === "antd-cascader" && rule.itemScope) {
      const panel = panelOf(match.element, rule);
      const scope = itemScopeOf(match.element, rule);
      const columns = panel
        ? Array.from(panel.querySelectorAll(rule.itemScope)).filter(isVisible)
        : [];
      const position = scope ? columns.indexOf(scope) : -1;
      if (position >= 0) semantic.column = position + 1;
    }
  }
  return semantic;
}

/**
 * 选项在「当前可见列表」里的位置，1 基。
 * 必须用 visibleItems 与回放侧同一个列表，否则滤镜 / 提交按钮会让两边差一位。
 */
function itemOrdinal(element: Element, match: RuleMatch | null): number | null {
  if (!match || (match.zone !== "item" && match.zone !== "row")) return null;
  if (isCommitTarget(match.element, match.rule)) return null;
  const scope = itemScopeOf(match.element, match.rule);
  if (!scope) return null;
  const items = visibleItems(scope, match.rule, match.zone === "row");
  const index = items.indexOf(match.element);
  return index >= 0 ? index + 1 : null;
}

/** 无规则组件的弹层内点击：目标带 option / menuitem 等角色时才记为选择。 */
function overlayItemSemantic(element: Element, overlay: Element): StepSemantic | undefined {
  if (!overlay.contains(element)) return undefined;
  const item = element.matches(OVERLAY_ITEM_SELECTOR) ? element : element.closest(OVERLAY_ITEM_SELECTOR);
  if (!item) return undefined;
  return {
    zone: "item",
    overlayItem: true,
    role: item.getAttribute("role"),
    value: normalizeText(item.textContent ?? "") || undefined,
    panelRole: overlay.getAttribute("role"),
    panelId: overlay.id || null,
    popupOpen: true,
    detection: "heuristic",
  };
}

/** 原生 <select> 不在规则表里；这里只判断「点击是否落在某个触发器上」。 */
function selectTriggerFor(element: Element): Element | null {
  const match = matchElement(element);
  if (!match || match.zone !== "trigger") return null;
  return isVisible(match.element) ? match.element : null;
}

/** 下拉内带稳定 id/name/testid 的输入最稳；没有稳定标识时退回触发容器本身。 */
function selectInputFor(trigger: Element): Element | null {
  const inputs = Array.from(trigger.querySelectorAll("input, textarea")).filter(
    (element) => (element.getAttribute("type") || "text").toLowerCase() !== "hidden",
  );
  return inputs.find(hasStableIdentity) ?? null;
}

function hasStableIdentity(element: Element): boolean {
  return Boolean(
    stableId(element) ||
      element.getAttribute("name") ||
      element.getAttribute("data-testid") ||
      element.getAttribute("data-test-id") ||
      element.getAttribute("data-test"),
  );
}


function selectorsFor(element: Element, actionable: boolean): string[][] {
  const group: string[] = [];
  const id = stableId(element);
  if (id) group.push(`css/#${cssEscape(id)}`);

  const testid =
    element.getAttribute("data-testid") ??
    element.getAttribute("data-test-id") ??
    element.getAttribute("data-test");
  if (testid) group.push(`css/[data-testid=${JSON.stringify(testid)}]`);

  const tag = element.tagName.toLowerCase();
  const name = element.getAttribute("name");
  if (name) group.push(`css/${tag}[name=${JSON.stringify(name)}]`);

  const placeholder = element.getAttribute("placeholder");
  if (placeholder) group.push(`css/[placeholder=${JSON.stringify(placeholder)}]`);

  const aria = element.getAttribute("aria-label");
  if (aria) group.push(`aria/${normalizeText(aria)}`);

  if (actionable) {
    // 必须用 textContent：innerText 会按块级布局在单元格之间插空格
    // （"1 涤纶 PET"），而回放侧比较的是 textContent（"1涤纶PET"），
    // 两边不一致就会 0 命中，只剩歧义的 css 候选。
    const text = normalizeText(element.textContent ?? "").slice(0, 50);
    if (text) group.push(`text/${text}`);
  }

  // 生成 id 不稳定；同构控件多时结构路径也会歧义，表单标签才是语义锚点。
  if (isGeneratedId(element.id)) {
    const label = formLabelFor(element);
    if (label) group.push(`label/${label}`);
  }

  group.push(`css/${cssPath(element)}`);
  // 生成 id 只作最后兜底：重新挂载后编号会变，结构路径才是主定位。
  if (isGeneratedId(element.id)) group.push(`css/#${cssEscape(element.id)}`);
  return [Array.from(new Set(group))];
}

/** 弹窗/抽屉容器：录制时标记上下文，回放时把字段限定在当前可见弹窗内。 */
const DIALOG_SCOPE = '[role="dialog"], [aria-modal="true"], .ant-modal, .ant-drawer-content';

function dialogContext(
  element: Element,
): Pick<ChromeRecorderStep, "dialog" | "dialogId"> {
  const dialog = element.closest(DIALOG_SCOPE);
  if (!dialog) return {};
  return {
    dialog: true,
    // 只取弹窗自身或直接包裹层（antd modal wrap / overlay）的 id；
    // 再往上爬到 #app/#root 会让 scope 退化成整页。
    dialogId: dialog.id || dialog.parentElement?.id || null,
  };
}

/** 只用于可读标题：表单标签优先于字段名 / 生成 id。 */
function labelContext(element: Element): Pick<ChromeRecorderStep, "labelText"> {
  const label = formLabelFor(element);
  return label ? { labelText: label } : {};
}

/** 标签和控件可能没有 for 关联（antd Form.Item），文本仍在最近的标签区域里。 */
function formLabelFor(element: Element): string {
  const associated = (element as HTMLInputElement).labels?.[0];
  const text =
    normalizeText(associated?.textContent ?? "") ||
    normalizeText(
      element.closest(".ant-form-item")?.querySelector(".ant-form-item-label label")
        ?.textContent ?? "",
    );
  return text.slice(0, 50);
}

function stableId(element: Element): string {
  const id = element.id;
  if (!id || isGeneratedId(id)) return "";
  return /^[A-Za-z][\w-]*$/.test(id) ? id : "";
}

/** 结构路径至少向上取 6 级；不够唯一就继续加祖先，直到能唯一定位。 */
const CSS_PATH_MIN_DEPTH = 6;
const CSS_PATH_MAX_DEPTH = 40;

/**
 * 结构路径必须真的唯一：同构控件很多时，截断在固定层级会匹配几十个元素，
 * 回放侧只能报「目标存在歧义」。生成 id 不稳定，不能用来救场。
 */
function cssPath(element: Element): string {
  const doc = element.ownerDocument;
  const parts: string[] = [];
  let node: Element | null = element;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < CSS_PATH_MAX_DEPTH) {
    const id = stableId(node);
    if (id) {
      parts.unshift(`#${cssEscape(id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const name = node.getAttribute("name");
    const parent: HTMLElement | null = node.parentElement;
    if (parent) {
      const tagName = node.tagName;
      const current: Element = node;
      let same = 0;
      let index = 0;
      for (let i = 0; i < parent.children.length; i += 1) {
        const child = parent.children.item(i);
        if (child?.tagName === tagName) {
          same += 1;
          if (child === current) index = same;
        }
      }
      if (same > 1) part += `:nth-of-type(${index})`;
    }
    parts.unshift(name ? `${part}[name=${JSON.stringify(name)}]` : part);
    node = parent;
    depth += 1;
    const path = parts.join(" > ");
    if (depth >= CSS_PATH_MIN_DEPTH && isUniquePath(path, element, doc)) return path;
  }
  return parts.join(" > ") || "body";
}

function isUniquePath(path: string, element: Element, doc: Document): boolean {
  try {
    const matches = doc.querySelectorAll(path);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/([^\w-])/g, "\\$1");
}

/** 单元格里已经存在编辑器：沿用进入编辑时记下的地址，不再按当前 DOM 重算。 */
const EDIT_CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

/** 给 change 步骤补单元格地址；没有单元格上下文就原样返回。 */
function withCell(
  element: Element,
  semantic: StepSemantic | undefined,
  recorded?: CellRef,
): StepSemantic | undefined {
  const cell = element.closest("td, th") as HTMLTableCellElement | null;
  // 编辑器可能已经被应用移除；此时 recorded 是进入编辑前抓到的地址。
  const ref = recorded ?? (cell ? cellRefFor(cell) : undefined);
  if (!ref) return semantic;
  return { ...(semantic ?? {}), cell: { ...ref, control: controlKind(element) } };
}

function controlKind(element: Element): CellControl {
  const tag = element.tagName.toLowerCase();
  if (tag === "input") return "input";
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if ((element as HTMLElement).isContentEditable) return "contenteditable";
  return "self";
}

/** 取值拾取：表单控件取控件本身，按钮/链接取自身，普通文本落在表格里取整格。 */
function resolveValueTarget(element: Element): Element {
  if (isValueControl(element)) return element;
  const actionable = element.closest(
    'button, a, [role="button"], [role="link"], [role="menuitem"]',
  );
  if (actionable) return actionable;
  return element.closest("td, th") ?? element;
}

function isValueControl(element: Element): boolean {
  return (
    /^(input|textarea|select)$/i.test(element.tagName) ||
    (element as HTMLElement).isContentEditable
  );
}

function extractSample(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "select") {
    const select = element as HTMLSelectElement;
    return select.selectedOptions[0]?.textContent?.trim() ?? select.value;
  }
  if (tag === "input" || tag === "textarea") {
    return String((element as HTMLInputElement).value ?? "");
  }
  return normalizeText(element.textContent ?? "");
}

function extractLabelFor(element: Element, cell: HTMLTableCellElement | null): string {
  const table = cell?.closest("table") as HTMLTableElement | null;
  const header = table && cell ? headerTexts(table).byIndex.get(cell.cellIndex) : undefined;
  if (header) return header;
  const aria = element.getAttribute("aria-label");
  if (aria) return normalizeText(aria);
  const text = normalizeText(element.textContent ?? "").slice(0, 40);
  if (text) return text;
  const name = element.getAttribute("name");
  if (name) return name;
  return element.tagName.toLowerCase();
}

/**
 * 单元格地址：行标识取「表内取值唯一的列」（优先第一列），列标识取表头文本。
 * 表内没有唯一列时退回整行文本，并在回放侧按唯一匹配处理。
 */
function cellRefFor(cell: HTMLTableCellElement): CellRef | undefined {
  const table = cell.closest("table") as HTMLTableElement | null;
  const row = cell.parentElement as HTMLTableRowElement | null;
  if (!table || !row || !row.cells) return undefined;

  const headers = headerTexts(table);
  const header = headers.byIndex.get(cell.cellIndex);
  const ref: CellRef = {
    table: table.id || table.getAttribute("aria-label") || undefined,
    header: header && headers.counts.get(header) === 1 ? header : undefined,
    colIndex: cell.cellIndex + 1,
    control: "self",
  };

  const keyIndex = uniqueColumnIndex(table);
  if (keyIndex === undefined) {
    ref.rowText = normalizeText(row.textContent ?? "");
  } else {
    ref.rowValue = normalizeText(row.cells[keyIndex]?.textContent ?? "");
    ref.keyIndex = keyIndex + 1;
    const keyHeader = headers.byIndex.get(keyIndex);
    if (keyHeader && headers.counts.get(keyHeader) === 1) ref.keyHeader = keyHeader;
  }

  return ref.rowValue || ref.rowText ? ref : undefined;
}

function headerTexts(table: HTMLTableElement): {
  byIndex: Map<number, string>;
  counts: Map<string, number>;
} {
  const byIndex = new Map<number, string>();
  const counts = new Map<string, number>();
  const heads = table.querySelectorAll('thead th, [role="columnheader"]');
  for (const head of Array.from(heads)) {
    if (!isVisible(head)) continue;
    const text = normalizeText(head.textContent ?? "");
    if (!text) continue;
    const index = (head as HTMLTableCellElement).cellIndex;
    byIndex.set(index, text);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return { byIndex, counts };
}

function dataRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.rows).filter(
    (row) =>
      !row.closest("thead") &&
      row.cells.length > 0 &&
      row.getAttribute("aria-hidden") !== "true" &&
      row.getBoundingClientRect().height > 0 &&
      isVisible(row),
  );
}

/** 选第一个「非空且互不重复」的列做行标识。 */
function uniqueColumnIndex(table: HTMLTableElement): number | undefined {
  const rows = dataRows(table);
  if (rows.length === 0) return undefined;
  const width = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  for (let index = 0; index < width; index += 1) {
    const values = rows.map((row) => normalizeText(row.cells[index]?.textContent ?? ""));
    if (values.some((value) => !value)) continue;
    if (new Set(values).size !== values.length) continue;
    return index;
  }
  return undefined;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
