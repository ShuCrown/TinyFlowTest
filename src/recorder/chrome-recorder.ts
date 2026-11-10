import {
  normalizeDsl,
  type CellRef,
  type ExtractNode,
  type FlowDsl,
  type FlowNode,
  type PickerFilterStep,
  type PickerNode,
  type PickerPick,
  type PickerPickValue,
  type Strategy,
  type SystemConfig,
  type TargetRef,
  type ValueLike,
} from "../dsl/index.ts";
import { isGeneratedId, PANEL_RULES } from "../dsl/panel-rules.ts";
import { fingerprintToTarget, type ElementFingerprint } from "./fingerprint.ts";
import { clusterSteps, type PickerCluster } from "./cluster.ts";

/**
 * Chrome DevTools「录制器」/ FlowGuard 浏览器扩展导出的录制 JSON → Flow DSL。
 *
 * 与注入式采集（RawEvent → 交互簇 → synthesize）是两条路径：
 * 录制 JSON 只有声明式步骤，没有 overlay-open/close 事件，因此不产出 picker 复合节点，
 * 弹窗筛选会被拆成顺序的 click / input 节点；悬浮菜单则保留 hover 节点，回放时先打开面板。
 */

/**
 * 事件发生时从 live DOM 读到的语义提示，纯增强：不改变 raw step 的映射，
 * 只让转换期能把触发器 / 筛选 / 选项折成一个 picker 簇。
 * 选择器沿用 Chrome Recorder 的 selector 组格式，转换期复用 selectorsToTarget。
 */
export interface StepSemantic {
  /** 命中的 panel-rules 规则 id，如 antd-select。 */
  rule?: string;
  zone?: "trigger" | "panel" | "item" | "row";
  detection?: "aria" | "class" | "heuristic";
  role?: string | null;
  /** 触发器元素的选择器组；只有 zone=trigger 时存在。 */
  controlSelectors?: string[][];
  panelRole?: string | null;
  /** 面板元素自身的 id；antd 面板普遍没有 id，所以可能为 null。 */
  panelId?: string | null;
  /** 触发器 aria-controls 指向的 id，在首次 popupOpen=true 时回填。 */
  popupId?: string | null;
  /** 事件发生时面板是否已展开；用于切簇，不用于回放。 */
  popupOpen?: boolean;
  /** 选项/行的值（Cascader 是 title，日期是 title，Select 是标签）。 */
  value?: string;
  /** 选项在可见列表中的位置（1 基），用于「按位置」配置与回放。 */
  index?: number;
  /** 级联的列序号（1 基）：同名条目在相邻列（如 北京→北京）时靠它区分。 */
  column?: number;
  /** 面板内的提交控件（如弹窗「确定」），转换期记为 commit 而不是选择项。 */
  commit?: boolean;
  /** 这次点击之后 800ms 内出现了弹层（无规则组件靠它起簇）。 */
  overlayOpen?: boolean;
  /** 点击落在当前弹层内、且目标带 option / menuitem 等角色。 */
  overlayItem?: boolean;
  /** 表格单元格地址：行标识 + 列标识 + 单元格里的控件。 */
  cell?: CellRef;
}

/** 提交动作触发的 fetch / XHR 请求参数与响应（查看 JSON 用）。 */
export interface CapturedRequest {
  method: string;
  url: string;
  body?: unknown;
  status?: number;
  /** 响应 content-type，便于判断是否为 JSON。 */
  contentType?: string;
  /** 响应体原文；JSON 接口保留原始文本，过长会截断。 */
  responseText?: string;
}

export interface ChromeRecorderStep {
  type?: string;
  selectors?: string[][];
  semantic?: StepSemantic;
  /** 取值步骤的变量名；录制时自动生成，可在工作台修改。 */
  varName?: string;
  /** 取值步骤的读取方式，默认 text。 */
  readMode?: "text" | "value" | "attribute";
  /** readMode=attribute 时读取的属性名。 */
  attributeName?: string;
  /** 该步骤之后短窗口内触发的网络请求（提交接口参数随步骤一起展示）。 */
  requests?: CapturedRequest[];
  /** 事件发生在已可见的弹窗/抽屉内；回放时目标必须限定在该容器里。 */
  dialog?: boolean;
  /** 弹窗根节点（或最近带 id 的祖先）的 id，作为回放 scope 的首选锚点。 */
  dialogId?: string | null;
  /** 录制时读到的表单标签文本，用于节点名与微调面板标题，不参与定位策略。 */
  labelText?: string;
  value?: unknown;
  url?: string;
  key?: string;
  timeout?: number;
  tagName?: string;
  inputType?: string;
  assertedEvents?: Array<{ type?: string; url?: string; title?: string }>;
  [key: string]: unknown;
}

export interface ChromeRecorderRecording {
  title?: string;
  steps?: ChromeRecorderStep[];
}

export interface RecordingImportReport {
  steps: number;
  nodes: number;
  needsConfirm: number;
  skipped: Array<{ type: string; count: number }>;
  warnings: string[];
}

export interface RecordingImportInput {
  recording: unknown;
  system: SystemConfig;
  flowName?: string;
}

export interface RecordingImportResult {
  dsl: FlowDsl;
  report: RecordingImportReport;
  /** 生成节点 id → 对应的原始步骤下标；删除节点时按它整组剔除录制事件。 */
  sources?: Record<string, number[]>;
}

interface SelectorTokens {
  css?: string;
  /** 主 css 失效时依次回退的候选（含生成 id）。 */
  cssFallbacks?: string[];
  /** 表单标签文本；生成 id 的控件靠它做语义兜底。 */
  label?: string;
  /** 元素自身带生成 id 时保留它作为可读标签，策略里只作兜底。 */
  labelHint?: string;
  xpath?: string;
  text?: string;
  aria?: string;
  ignored: string[];
}

const PRESS_KEYS = new Set(["Enter", "Tab", "Escape"]);
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** 容器类令牌：出现在 css 末尾两段时，点击等于“点容器中心”，回放会误选内部元素 */
const CONTAINER_TOKENS = /(?:^|[-_])(?:list|holder|container|table|form|tbody|body|inner)(?:$|[-_])/i;
const CONTAINER_TAG = /^(form|table|tbody|ul|ol|body|section)$/i;
/** 这些标签本身就是可点条目，即使父级是 ul/table 也不能按容器跳过 */
const ACTIONABLE_TAG = /^(a|button|input|select|textarea|label|option|li|tr|td|th)$/i;

/** 录制里“点在容器空白处”的点击对流程没有意义，回放却会退化成点容器中心。 */
function isContainerClick(step: ChromeRecorderStep): boolean {
  const tokens = parseSelectorGroups(step.selectors);
  if (tokens.text || tokens.aria) return false;
  return isContainerSelector(tokens.css);
}

/** 单个 css 是否属于“容器级”：末尾裸标签 + 末尾两到三段含容器令牌/容器标签。 */
export function isContainerSelector(css: string | undefined): boolean {
  if (!css) return false;
  const segments = css.split(">").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length < 2) return false;
  const last = segments[segments.length - 1]!;
  if (/[#.[:]/.test(last)) return false;
  // 裸 `li` / `tr` 是菜单项、表格行等可点条目，父级是 ul/table 也不该按容器跳过
  const lastTag = last.match(/^([a-z][\w-]*)/i)?.[1] ?? "";
  if (ACTIONABLE_TAG.test(lastTag)) return false;
  // 容器令牌通常出现在倒数第 2~3 段（`…-list-holder > div > div`），再往外多半是定位用的祖先
  const tail = segments.slice(-3).join(" > ");
  return CONTAINER_TOKENS.test(tail) || CONTAINER_TAG.test(segments[segments.length - 2] ?? "");
}

/**
 * 录制 JSON → DSL 草稿。只做可判定的映射，猜测的部分标 needsConfirm 并写 warning。
 */
export function importChromeRecorder(input: RecordingImportInput): RecordingImportResult {
  const recording = asRecording(input.recording);
  const steps = recording.steps ?? [];
  if (steps.length === 0) throw new Error("录制 JSON 没有任何步骤");

  const system = input.system;
  const nodes: FlowNode[] = [];
  const edges: Array<{ from: string; to: string }> = [];
  const warnings: string[] = [];
  const skipped = new Map<string, number>();
  const counters: Record<string, number> = {};
  const sources: Record<string, number[]> = {};
  let lastNavigate = "";
  let lastNavigateNodeId = "";
  let lastTarget: ReturnType<typeof fingerprintToTarget> | undefined;
  let typedRecently = false;

  const nextId = (prefix: string): string => {
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `${prefix}-${counters[prefix]}`;
  };
  const skip = (type: string): void => {
    skipped.set(type, (skipped.get(type) ?? 0) + 1);
  };
  const warn = (message: string): void => {
    if (warnings.length < 50) warnings.push(message);
  };

  // 先把语义步骤折成意图簇，再按段映射；折叠失败时保留原始步骤，行为与之前一致。
  const folded = new Set<number>();
  const pickerNodes = new Map<number, PickerNode>();
  for (const segment of clusterSteps(steps).segments) {
    if (segment.kind !== "picker") continue;
    const node = pickerNodeFromCluster(segment, system, nextId);
    if (!node) {
      warn(`第 ${segment.trigger.index + 1} 步的复合组件无法生成 picker 节点，保留为事件级步骤`);
      continue;
    }
    pickerNodes.set(segment.trigger.index, node);
    sources[node.id] = [...segment.indices];
    for (const index of segment.indices) {
      if (index !== segment.trigger.index) folded.add(index);
    }
    for (const message of segment.warnings) warn(message);
  }

  steps.forEach((step, index) => {
    const type = String(step.type ?? "");
    const position = index + 1;

    const picker = pickerNodes.get(index);
    if (picker) {
      nodes.push(picker);
      lastTarget = picker.trigger;
      typedRecently = false;
      return;
    }
    if (folded.has(index)) return;
    if (!type) {
      skip("unknown");
      return;
    }

    if (type === "navigate") {
      const raw = step.url ?? step.assertedEvents?.find((event) => event.url)?.url;
      if (!raw) {
        skip("navigate");
        warn(`第 ${position} 步 navigate 缺少 url，已跳过`);
        return;
      }
      const url = toFlowUrl(raw, system, position, warn);
      if (url === lastNavigate) {
        if (lastNavigateNodeId) sources[lastNavigateNodeId]!.push(index);
        return;
      }
      lastNavigate = url;
      const id = nextId("navigate");
      nodes.push({
        id,
        type: "navigate",
        name: nodes.some((node) => node.type === "navigate") ? `导航 ${position}` : "打开页面",
        system: system.id,
        url,
        waitUntil: "domcontentloaded",
        readySignal: "page-ready",
        meta: { sourceText: `navigate ${raw}`, needsConfirm: false },
      });
      sources[id] = [index];
      lastNavigateNodeId = id;
      lastTarget = undefined;
      typedRecently = false;
      return;
    }

    if (type === "extract") {
      const target = targetFromStep(step);
      if (!target) {
        skip(type);
        warn(`第 ${position} 步取值没有可用选择器，已跳过`);
        return;
      }
      const used = new Set(
        nodes
          .filter((node): node is ExtractNode => node.type === "extract")
          .map((node) => node.varName.trim())
          .filter(Boolean),
      );
      let varName = String(step.varName ?? "").trim();
      if (!varName) {
        let index = 1;
        while (used.has(`extracted${index}`)) index += 1;
        varName = `extracted${index}`;
        warn(`第 ${position} 步取值缺少变量名，已使用 ${varName}`);
      } else if (used.has(varName)) {
        warn(`第 ${position} 步取值的变量 ${varName} 重复，后一个会覆盖前一个，请在录制页重命名`);
      }
      const read =
        step.readMode === "value" || step.readMode === "attribute" ? step.readMode : "text";
      const attribute =
        read === "attribute" ? String(step.attributeName ?? "").trim() || undefined : undefined;
      if (read === "attribute" && !attribute) {
        warn(`第 ${position} 步取值选择属性读取但缺少属性名，需要补充`);
      }
      const id = nextId("extract");
      nodes.push({
        id,
        type: "extract",
        name: `取值 ${target.label ?? varName}`,
        system: system.id,
        source: "dom",
        target,
        read,
        ...(attribute ? { attribute } : {}),
        varName,
        meta: {
          sourceText: "extract",
          needsConfirm: read === "attribute" && !attribute,
          sourceIndex: index,
          sampleValue: step.value === undefined ? undefined : String(step.value),
        },
      });
      sources[id] = [index];
      lastTarget = target;
      typedRecently = false;
      return;
    }

    if (type === "click" || type === "doubleClick") {
      if (isContainerClick(step)) {
        skip(type);
        warn(
          `第 ${position} 步 ${type} 的目标是容器级选择器（${parseSelectorGroups(step.selectors).css}）：` +
            `回放会点容器中心并误选内部元素，已跳过；如确需点击请在流程里手工补文本/属性定位`,
        );
        return;
      }
      const target = targetFromStep(step);
      if (!target) {
        skip(type);
        warn(`第 ${position} 步 ${type} 没有可用选择器，已跳过`);
        return;
      }
      const assertion = step.assertedEvents?.find((event) => event.url)?.url;
      const expect = assertion
        ? [{ kind: "url" as const, matches: toFlowUrl(assertion, system, position, () => undefined) }]
        : undefined;
      const id = nextId("click");
      nodes.push({
        id,
        type: "interact",
        name: `点击 ${target.label ?? type}`,
        system: system.id,
        adapter: "click",
        target,
        expect,
        ...(type === "doubleClick"
          ? {
              meta: {
                sourceText: "doubleClick",
                needsConfirm: true,
                ...(step.requests?.length ? { requests: step.requests } : {}),
              },
            }
          : {
              meta: {
                sourceText: "click",
                needsConfirm: false,
                ...(step.requests?.length ? { requests: step.requests } : {}),
              },
            }),
      });
      sources[id] = [index];
      if (type === "doubleClick") {
        warn(`第 ${position} 步是 doubleClick，DSL 无双击动作，已降级为 click，需要确认`);
      }
      lastTarget = target;
      typedRecently = false;
      return;
    }

    if (type === "change") {
      const target = targetFromStep(step);
      if (!target) {
        skip(type);
        warn(`第 ${position} 步 change 没有可用选择器，已跳过`);
        return;
      }
      const value = typeof step.value === "string" ? step.value : step.value === undefined ? "" : String(step.value);
      const inputType = String(step.inputType ?? "").toLowerCase();
      const tokens = parseSelectorGroups(step.selectors);
      const selectLike = isSelectLike(tokens.css);
      const uncertain = step.tagName === undefined && inputType === "";
      let adapter: "input" | "nativeSelect" | "check" = "input";
      if (inputType === "checkbox" || inputType === "radio") {
        adapter = "check";
      } else if (step.tagName === "select" || selectLike) {
        adapter = "nativeSelect";
      }
      // tagName / inputType 缺失时按 css 或前面的输入按键判定；两条线索都没有才需要确认
      const needsConfirm = uncertain && !selectLike && !typedRecently && adapter !== "check";
      const id = nextId(adapter === "check" ? "check" : "input");
      nodes.push({
        id,
        type: "interact",
        name: `${adapter === "check" ? "勾选" : adapter === "nativeSelect" ? "选择" : "输入"} ${
          target.label ?? position
        }`,
        system: system.id,
        adapter,
        target,
        value: { kind: "literal", value } as ValueLike,
        ...(adapter === "check" ? { checked: value === "true" } : {}),
        ...(adapter === "input" ? { verify: "readBack" as const } : {}),
        // 单元格编辑通常在失焦时提交，回放写完值要主动 blur。
        ...(adapter === "input" && step.semantic?.cell && step.semantic.cell.control !== "self"
          ? { blurAfter: true }
          : {}),
        meta: {
          sourceText: `change ${tokens.css ?? ""}`.trim(),
          needsConfirm,
          ...(step.requests?.length ? { requests: step.requests } : {}),
        },
      });
      sources[id] = [index];
      if (step.value === undefined) {
        warn(`第 ${position} 步 change 没有录制值，已留空，需要补充取值绑定`);
      }
      if (needsConfirm) {
        warn(`第 ${position} 步 change 无法判定控件类型（缺 tagName），先按 ${adapter} 生成，需在检查器确认`);
      }
      lastTarget = target;
      typedRecently = false;
      return;
    }

    if (
      type === "hover" ||
      type === "mouseover" ||
      type === "mouseenter" ||
      type === "pointerover" ||
      type === "pointerenter"
    ) {
      const target = targetFromStep(step);
      if (!target) {
        skip(type);
        warn(`第 ${position} 步 ${type} 没有可用选择器，已跳过`);
        return;
      }
      // antd Dropdown / Menu 的二级菜单依赖悬浮打开：hover 必须保留，
      // 否则后续点击菜单项时面板还没出现，只能等到 target 超时。
      const id = nextId("hover");
      nodes.push({
        id,
        type: "interact",
        name: `悬停 ${target.label ?? position}`,
        system: system.id,
        adapter: "hover",
        target,
        meta: { sourceText: type, needsConfirm: false },
      });
      sources[id] = [index];
      lastTarget = target;
      typedRecently = false;
      return;
    }

    if (type === "keydown") {
      const key = String(step.key ?? "");
      if (PRESS_KEYS.has(key)) {
        const target =
          targetFromStep(step) ??
          lastTarget ?? {
            label: "页面",
            strategies: [{ type: "css" as const, value: "body" }],
            strict: true,
          };
        const id = nextId("press");
        nodes.push({
          id,
          type: "interact",
          name: `按键 ${key}`,
          system: system.id,
          adapter: "press",
          target,
          key,
          meta: { sourceText: `keydown ${key}`, needsConfirm: lastTarget === undefined },
        });
        sources[id] = [index];
        lastTarget = target;
        return;
      }
      if (!MODIFIER_KEYS.has(key)) typedRecently = true;
      skip("keydown");
      return;
    }

    if (type === "keyup" || type === "keypress") {
      skip(type);
      return;
    }

    if (type === "waitForElement") {
      const target = targetFromStep(step);
      if (!target) {
        skip(type);
        warn(`第 ${position} 步 waitForElement 没有可用选择器，已跳过`);
        return;
      }
      const id = nextId("wait");
      nodes.push({
        id,
        type: "wait",
        name: `等待 ${target.label ?? position}`,
        system: system.id,
        condition: {
          kind: "visible",
          target,
          timeoutMs: clampTimeout(step.timeout),
        },
        meta: { sourceText: "waitForElement", needsConfirm: false },
      });
      sources[id] = [index];
      return;
    }

    skip(type);
    warn(`第 ${position} 步 ${type} 不在支持范围，已跳过`);
  });

  if (nodes.length === 0) {
    throw new Error("录制中没有可转换的步骤（全部被跳过或缺少选择器）");
  }
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({ from: nodes[i]!.id, to: nodes[i + 1]!.id });
  }

  const dsl = normalizeDsl({
    dslVersion: "1.0",
    meta: {
      name: input.flowName ?? (typeof recording.title === "string" && recording.title ? recording.title : undefined) ?? `录制导入 ${new Date().toISOString().slice(11, 16)}`,
      tags: ["imported"],
    },
    systems: [system],
    defaults: {
      nodeTimeoutMs: 15000,
      pickerTimeoutMs: 30000,
      screenshot: "onFailure",
      resourcePolicy: "balanced",
      trace: false,
    },
    nodes,
    edges,
    entry: nodes[0]!.id,
  });

  return {
    dsl,
    report: {
      steps: steps.length,
      nodes: nodes.length,
      needsConfirm: nodes.filter((node) => node.meta?.needsConfirm).length,
      skipped: Array.from(skipped.entries()).map(([skippedType, count]) => ({
        type: skippedType,
        count,
      })),
      warnings,
    },
    sources,
  };
}

/**
 * 录制选择器组 → TargetRef。复用指纹转换，保证与采集链路同一套有序候选链：
 * testid → role+name → label → placeholder → text → name → css → xpath。
 */
/**
 * 意图簇 → PickerNode。
 *
 * 面板选择器来自 panel-rules（附录 A 的白名单），不在这里另写一份类名。
 * pick.values 保留录制顺序：级联三级路径、多选多个值都靠它回放。
 */
function pickerNodeFromCluster(
  cluster: PickerCluster,
  system: SystemConfig,
  nextId: (prefix: string) => string,
): PickerNode | null {
  const trigger = targetFromStep(cluster.trigger.step);
  if (!trigger) return null;

  const rule = PANEL_RULES.find((item) => item.id === cluster.rule);
  const selector =
    rule?.panel[0] ??
    (cluster.mode === "dialog" ? '[role="dialog"]' : '[role="listbox"], [role="menu"], [role="dialog"]');
  const panelTarget: TargetRef | undefined = selector
    ? {
        label: cluster.mode === "dialog" ? "弹窗" : "面板",
        strategies: [{ type: "css", value: selector }],
      }
    : undefined;

  const filters: PickerFilterStep[] = [];
  for (const { step } of cluster.filters) {
    const target = targetFromStep(step);
    if (!target) continue;
    if (step.type === "change") {
      filters.push({
        adapter: "input",
        target,
        value: { kind: "literal", value: String(step.value ?? "") },
      });
    } else if (step.type === "click") {
      filters.push({ adapter: "click", target });
    }
  }

  const values: PickerPickValue[] = cluster.picks.map(({ step }) => ({
    role: step.semantic?.role ?? null,
    // 语义录制直接给值；外部 JSON 的结构折叠只能从 text= 选择器里取标签。
    value: step.semantic?.value ?? parseSelectorGroups(step.selectors).text ?? "",
    ...(step.semantic?.index ? { index: step.semantic.index } : {}),
    // 级联多列：同一值可能在相邻列重复出现（如 北京→北京），回放必须回到录制列。
    ...(step.semantic?.column ? { column: step.semantic.column } : {}),
  }));
  const isRow = cluster.picks.some(({ step }) => step.semantic?.zone === "row");
  const first = values[0]?.value ?? "";
  const pick: PickerPick = isRow
    ? {
        strategy: "byRow",
        byRow: { keyValue: { kind: "literal", value: first } },
        multi: values.length > 1,
        values,
      }
    : {
        strategy: "byText",
        byText: { value: { kind: "literal", value: first }, match: "exact" },
        // 级联的多级路径是「按顺序点」，不是多选。
        multi: cluster.rule !== "antd-cascader" && values.length > 1,
        values,
      };

  // 预置「按位置」候选。带筛选的单选 Select，筛选后的列表通常很短，
  // 文本可能带状态后缀或重复，默认直接按筛选结果中的位置定位；
  // 其余场景仍默认按文本 / 按行，UI 可随时切换。
  const indexes = values.map((item) => item.index);
  if (
    indexes.length > 0 &&
    indexes.every((index): index is number => typeof index === "number" && index > 0)
  ) {
    pick.byIndex = { indexes, on: isRow ? "row" : "item" };
    const filteredSelect =
      cluster.rule === "antd-select" &&
      filters.length > 0 &&
      !isRow &&
      pick.multi !== true &&
      values.length === 1;
    if (filteredSelect) pick.strategy = "byIndex";
  }

  const commitTarget = cluster.commit ? targetFromStep(cluster.commit.step) : null;
  const popupId = cluster.trigger.step.semantic?.popupId ?? null;

  return {
    id: nextId("picker"),
    type: "picker",
    name: `${cluster.mode === "dialog" ? "弹窗选择" : "选择"} ${trigger.label ?? ""}`.trim(),
    system: system.id,
    mode: cluster.mode,
    trigger,
    triggerAction: rule?.triggerAction ?? "click",
    panel: {
      scope: {
        type: cluster.mode === "dialog" ? "dialog" : "dropdown",
        target: panelTarget,
      },
      binding: cluster.mode === "dialog" ? "dialog" : popupId ? "contract" : "temporal",
      popupId,
    },
    ...(filters.length > 0 ? { filter: { steps: filters } } : {}),
    pick,
    ...(commitTarget
      ? { commit: { adapter: "click" as const, target: commitTarget, waitHidden: cluster.mode === "dialog" } }
      : {}),
    meta: {
      sourceText: `picker ${cluster.rule}`,
      needsConfirm: cluster.needsConfirm,
      notes: `confidence ${cluster.confidence}`,
      rule: cluster.rule,
    },
  };
}

export function selectorsToTarget(groups: string[][] | undefined) {
  const tokens = parseSelectorGroups(groups);
  const fp = tokensToFingerprint(tokens);
  if (!fp) return null;
  const base = fingerprintToTarget(fp);
  const target = withReadableLabel(base, fp, tokens);
  const seen = new Set(
    target.strategies.map((strategy) => `${strategy.type}:${"value" in strategy ? strategy.value : ""}`),
  );
  const fallbacks: Strategy[] = [];
  for (const value of tokens.cssFallbacks ?? []) {
    if (seen.has(`css:${value}`)) continue;
    seen.add(`css:${value}`);
    fallbacks.push({ type: "css", value });
  }
  return { ...target, strategies: orderStrategies([...target.strategies, ...fallbacks]) };
}

/**
 * 导入录制的候选顺序：testid → role → name → css → label → placeholder → text → xpath。
 *
 * 与采集链路（fingerprintToTarget）相比只把 css 提到纯文本候选之前：
 * 录制 JSON 里的 `text=保存` / `aria/华东区` 只描述可见文本，同名字符串在背景列表与
 * 弹窗里常常各有一份，先生效会点到错误元素；录制路径才是录制时命中的那个元素，
 * 路径失效时会按顺序回退到文本候选并记 HEALED。
 */
const IMPORT_STRATEGY_RANK: Record<string, number> = {
  testid: 0,
  role: 1,
  name: 2,
  css: 3,
  label: 4,
  placeholder: 5,
  text: 6,
  xpath: 7,
};

function orderStrategies<T extends { type: string }>(strategies: T[]): T[] {
  return strategies
    .slice()
    .sort(
      (a, b) =>
        (IMPORT_STRATEGY_RANK[a.type] ?? 99) - (IMPORT_STRATEGY_RANK[b.type] ?? 99),
    );
}

function withReadableLabel(
  target: ReturnType<typeof fingerprintToTarget>,
  fp: ElementFingerprint,
  tokens: SelectorTokens,
) {
  // 录制 JSON 没有 label/aria 时 fingerprintToTarget 会退化成标签名（div 之类），
  // 用 name / testid / id 兜一个可读标签，改善节点名与运行报告里的 field
  const hint = readableLabel(tokens);
  if (!hint || (target.label && target.label !== fp.tag)) return target;
  return { ...target, label: hint };
}

function readableLabel(tokens: SelectorTokens): string | undefined {
  if (tokens.label) return tokens.label;
  if (tokens.labelHint) return tokens.labelHint;
  const css = tokens.css;
  return (
    tokens.aria ??
    tokens.text ??
    (css ? cssMatch(css, "name") : undefined) ??
    (css ? cssMatch(css, "data-testid") : undefined) ??
    (css ? cssMatch(css, "placeholder") : undefined) ??
    css?.match(/#([\w-]+)/)?.[1] ??
    css ??
    tokens.xpath
  );
}

/** 解析 `css/…`、`text=…`、`aria/…`、`xpath/…`、`pierce/…` 与裸 css。 */
export function parseSelectorGroups(groups: string[][] | undefined): SelectorTokens {
  const tokens: SelectorTokens = { ignored: [] };
  const cssCandidates: Array<{ value: string; tier: number; generated: boolean }> = [];
  for (const group of groups ?? []) {
    for (const raw of group ?? []) {
      const value = String(raw ?? "").trim();
      if (!value) continue;
      if (/^pierce[/=]/i.test(value)) {
        tokens.ignored.push(value);
        continue;
      }
      if (/^xpath[/=]/i.test(value) || value.startsWith("//") || value.startsWith("(//")) {
        // DevTools 里形如 `xpath//*[@id="x"]`，去掉前缀后保留 `//` 表达式本身
        tokens.xpath ??= value.replace(/^xpath=/i, "").replace(/^xpath(?=\/)/i, "");
        continue;
      }
      if (/^label[/=]/i.test(value)) {
        tokens.label ??= value.replace(/^label[/=]/i, "").trim();
        continue;
      }
      if (/^aria[/=]/i.test(value)) {
        tokens.aria ??= value.replace(/^aria[/=]/i, "").replace(/\[.*\]$/, "").trim();
        continue;
      }
      if (/^text[/=]/i.test(value)) {
        tokens.text ??= value.replace(/^text[/=]/i, "").trim();
        continue;
      }
      const css = value.replace(/^css[/=]/i, "");
      cssCandidates.push({ value: css, tier: cssTier(value), generated: isGeneratedCss(css) });
    }
  }
  // 生成 id 重新挂载后会变：排在同层级最后，只作兜底。
  cssCandidates.sort((a, b) => {
    if (a.generated !== b.generated) return a.generated ? 1 : -1;
    return a.tier - b.tier;
  });
  // 丢弃“匹配一整类元素”的兜底候选（[role=option]、裸标签等）：它们无法唯一定位，
  // 且会让探测运行停在歧义确认；仅当完全没有其它候选时才退回使用。
  const hasOther = Boolean(tokens.aria ?? tokens.text ?? tokens.xpath);
  const usable = cssCandidates.filter((item) => !isGenericCss(item.value));
  const chosen = usable.length > 0 ? usable : hasOther ? [] : cssCandidates.slice(0, 1);
  tokens.css = chosen[0]?.value;
  // 只额外保留生成 id 兜底；其它次级 css 仍按原规则丢弃，避免把过泛路径放回候选链。
  tokens.cssFallbacks = chosen
    .slice(1)
    .filter((item) => item.generated)
    .map((item) => item.value);
  tokens.labelHint = cssCandidates.find((item) => item.generated)?.value.replace(/^#/, "");
  return tokens;
}

function isGeneratedCss(value: string): boolean {
  return value.startsWith("#") && isGeneratedId(value.slice(1));
}

/** 过泛的 css：裸标签、只有 role 之类的通配属性（没有 id / class / 具体属性 / 层级路径）。 */
function isGenericCss(value: string): boolean {
  const css = value.trim();
  if (!css) return true;
  if (/#[\w-]/.test(css)) return false;
  if (/\.[\w-]/.test(css)) return false;
  if (/\[\s*(name|value|type|href|title|for|placeholder|aria-label|data-[\w-]+)\s*[*^$|~]?=/i.test(css)) {
    return false;
  }
  if (/[>\s]/.test(css)) return false;
  return true;
}

function cssTier(value: string): number {
  const css = value.replace(/^css[/=]/i, "");
  if (/^#/.test(css)) return 0;
  if (/#/.test(css)) return 1;
  if (/^\[[^\]]*(data-test|name|aria-label|placeholder)/i.test(css)) return 2;
  return 3;
}

function tokensToFingerprint(tokens: SelectorTokens): ElementFingerprint | null {
  if (!tokens.css && !tokens.xpath && !tokens.text && !tokens.aria) return null;
  const css = tokens.css;
  return {
    tag: (css ? inferTag(css) : undefined) ?? "div",
    css,
    xpath: tokens.xpath,
    testid: css ? cssMatch(css, "data-testid") : undefined,
    name: css ? cssMatch(css, "name") : undefined,
    placeholder: css ? cssMatch(css, "placeholder") : undefined,
    ariaLabel: tokens.aria,
    labelText: tokens.label,
    // text= 与 aria/ 都当作可访问名使用；aria 名称在无 role 时降级为文本候选
    text: tokens.text ?? tokens.aria,
  };
}

function cssMatch(css: string, attribute: string): string | undefined {
  const match = css.match(new RegExp(`\\[${attribute}\\s*=\\s*["']?([^"'\\]]+)["']?\\]`, "i"));
  return match?.[1]?.trim();
}

function inferTag(css: string): string | undefined {
  return css.match(/^([a-z][a-z0-9-]*)/i)?.[1]?.toLowerCase();
}

function isSelectLike(css: string | undefined): boolean {
  if (!css) return false;
  return /^select\b/i.test(css) || /role\s*=\s*["']?combobox/i.test(css);
}

/**
 * 单元格目标不保留 css 兜底：单元格里的输入框常常是临时渲染的，
 * css 路径会命中别的行；宁可等到超时并报「第 N 行没有出现控件」，也不要静默改错数据。
 */
function targetFromStep(step: ChromeRecorderStep) {
  const target = withStepLabel(
    withDialogScope(selectorsToTarget(step.selectors), step),
    step,
  );
  const cell = step.semantic?.cell;
  if (!cell) return target;
  const strategies = cellStrategies(cell);
  if (strategies.length === 0) return target;
  return {
    ...(target ?? {}),
    label: cellLabel(cell),
    strategies,
    strict: true,
  };
}

/**
 * 展示标题优先用表单标签（「客户名称」），不要用实际字段名（customerName / source）。
 * labelText 只是可读标题，不改变候选策略顺序。
 */
function withStepLabel(target: TargetRef | null, step: ChromeRecorderStep): TargetRef | null {
  if (!target || !step.labelText) return target;
  return { ...target, label: step.labelText };
}

/**
 * 弹窗内录制的目标带上 scope：回放先等可见弹窗，再只在弹窗里查候选。
 * 否则弹窗异步出现前，背景表格里的同名列/单元格会先被命中。
 */
function withDialogScope(target: TargetRef | null, step: ChromeRecorderStep): TargetRef | null {
  if (!target || !step.dialog) return target;
  const strategies: Strategy[] = [];
  if (step.dialogId) {
    strategies.push({ type: "css", value: `[id=${JSON.stringify(step.dialogId)}]` });
  }
  strategies.push({
    type: "css",
    value: '[role="dialog"], [aria-modal="true"], .ant-modal, .ant-drawer-content',
  });
  return {
    ...target,
    scope: { label: "弹窗", strategies, strict: true },
  };
}

function cellStrategies(cell: CellRef): Strategy[] {
  const rows: Array<Partial<CellRef>> = [];
  if (cell.rowIndex !== undefined) {
    rows.push({ rowIndex: cell.rowIndex });
  } else if (cell.rowValue !== undefined) {
    const row: Partial<CellRef> = { rowValue: cell.rowValue };
    if (cell.keyHeader) row.keyHeader = cell.keyHeader;
    if (cell.keyIndex !== undefined) row.keyIndex = cell.keyIndex;
    rows.push(row);
  } else if (cell.rowText !== undefined) {
    rows.push({ rowText: cell.rowText });
  }

  const columns: Array<Partial<CellRef>> = [];
  if (cell.header) columns.push({ header: cell.header });
  if (cell.colIndex !== undefined) columns.push({ colIndex: cell.colIndex });

  const strategies: Strategy[] = [];
  for (const row of rows) {
    for (const column of columns) {
      const merged: CellRef = { ...row, ...column, control: cell.control };
      if (cell.table) merged.table = cell.table;
      strategies.push({ type: "cell", cell: merged });
    }
  }
  return strategies;
}

function cellLabel(cell: CellRef): string {
  const row =
    cell.rowIndex !== undefined
      ? `筛选后第 ${cell.rowIndex} 行`
      : cell.rowValue ?? cell.rowText;
  return [row, cell.header ?? `第 ${cell.colIndex ?? "?"} 列`].filter(Boolean).join(" · ");
}

/**
 * 同源 URL 落成 path（运行期按 system.baseUrl 还原），异源保留绝对地址并告警。
 */
function toFlowUrl(
  raw: string,
  system: SystemConfig,
  position: number,
  warn: (message: string) => void,
): string {
  try {
    const url = new URL(raw);
    if (url.origin === new URL(system.baseUrl).origin) return `${url.pathname}${url.search}`;
    warn(`第 ${position} 步导航到 ${url.origin}，与系统 ${system.id} 不同源，按绝对地址保留`);
    return url.toString();
  } catch {
    return raw;
  }
}

function clampTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(60000, Math.round(value)));
}

function asRecording(input: unknown): ChromeRecorderRecording {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("录制 JSON 必须是对象");
  }
  const recording = input as ChromeRecorderRecording;
  if (!Array.isArray(recording.steps)) {
    throw new Error("录制 JSON 缺少 steps 数组（请用 DevTools 录制器或扩展导出的 JSON）");
  }
  return recording;
}
