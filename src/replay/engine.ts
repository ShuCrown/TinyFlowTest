import type {
  CellControl,
  CellRef,
  ExtractNode,
  FlowDsl,
  FlowNode,
  InteractNode,
  NavigateNode,
  PickerNode,
  SignalRef,
  Strategy,
  TargetRef,
  WaitNode,
  WaitSignal,
} from "../dsl/index.ts";
import {
  isGeneratedId,
  matchElement,
  PANEL_CONTAINER_SELECTOR,
  visibleItems,
} from "../dsl/panel-rules.ts";
import type { PanelRule } from "../dsl/panel-rules.ts";
import {
  isPanelOpen,
  itemSelectorsOf,
  panelSelectorOf,
  pickerRule,
  pickScopes,
  waitForPanel,
  waitForPanelClosed,
} from "./panel.ts";
import {
  ReplayError,
  type ReplayAttempt,
  type ReplayEvent,
  type ReplayHost,
  type ReplayNodeResult,
  type ReplayOptions,
  type ReplayResult,
  type ReplayStatus,
} from "./types.ts";

interface ResolveOptions {
  requireVisible: boolean;
  allowMultiple: boolean;
  /**
   * 自定义下拉的搜索输入常被 `opacity: 0` 隐藏，但它的可见触发容器还在。
   * 交互节点允许把这类隐藏输入解析出来，由执行器改点可见容器。
   */
  allowHiddenSelectInput?: boolean;
  /** 单元格里的控件还没渲染时，先点同一单元格进入编辑。 */
  activateCell?: boolean;
  /** 解析触发器时排除落在其它弹出面板里的同名元素（残留面板会劫持下一节点）。 */
  exclude?: (element: Element) => boolean;
  /** 目标所在容器：只接受该容器内的命中（弹窗内字段不能落到背景表格）。 */
  within?: Element;
}

interface ResolvedTarget {
  element: Element;
  strategy: string;
  healed: boolean;
  multiple: boolean;
  attempts: ReplayAttempt[];
}

interface FindResult {
  resolved?: ResolvedTarget;
  attempts: ReplayAttempt[];
}

interface NodeOutcome {
  message: string;
  strategy?: string;
  healed?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15000;
const POLL_MS = 100;

/**
 * 等组件把展开状态提交到 DOM 的上限。
 * 只用于交互节点的最小兜底；超时不判失败，后续节点会等自己的目标可见。
 */
const PANEL_OPEN_TIMEOUT_MS = 1500;

/**
 * 最小回放器：沿 DSL 边顺序执行 navigate / interact / wait。
 *
 * 浏览器演示把同源 iframe 包装成 ReplayHost；生产环境可替换为 Playwright 适配器，
 * 节点语义（定位候选链、回读校验、等待信号）保持一致。
 */
export async function runFlow(options: ReplayOptions): Promise<ReplayResult> {
  const {
    dsl,
    host,
    values = {},
    vars = {},
    onBeforeNode,
    onNodeError,
    signal,
    onEvent,
  } = options;
  const started = Date.now();
  const emit = (event: ReplayEvent): void => onEvent?.(event);
  const env: Record<string, unknown> = { ...seedVars(dsl), ...vars };
  const nodes = new Map(dsl.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, FlowDsl["edges"]>();
  for (const edge of dsl.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const results: ReplayNodeResult[] = [];
  const executed = new Set<string>();
  let status: ReplayStatus = "finished";
  let failure: string | undefined;
  let current: string | undefined = dsl.entry;

  emit({ type: "run.started", totalNodes: dsl.nodes.length });

  while (current) {
    if (signal?.aborted) {
      status = "canceled";
      failure = "回放已取消";
      break;
    }
    const node = nodes.get(current);
    if (!node) {
      status = "failed";
      failure = `节点不存在: ${current}`;
      break;
    }
    if (executed.has(current)) {
      status = "failed";
      failure = `检测到重复执行节点: ${current}`;
      break;
    }

    let attempt = 0;
    let interrupted = false;
    let next: string | undefined;

    // 失败后人工可以要求重试：同一节点在此循环内重新执行，直到做出继续/跳过/停止的决定。
    while (true) {
      attempt += 1;
      if (onBeforeNode) {
        await onBeforeNode(node.id);
        if (signal?.aborted) {
          status = "canceled";
          failure = "回放已取消";
          interrupted = true;
          break;
        }
      }
      executed.add(node.id);

      const index = results.length;
      emit({
        type: "node.started",
        nodeId: node.id,
        index,
        name: node.name,
        groupId: groupIdOf(node),
      });
      const nodeStarted = Date.now();

      if (node.enabled === false) {
        const skipped: ReplayNodeResult = {
          nodeId: node.id,
          name: node.name,
          groupId: groupIdOf(node),
          status: "skipped",
          message: "节点已禁用，跳过执行",
          durationMs: 0,
        };
        results.push(skipped);
        emit({ type: "node.finished", node: skipped });
        next = nextNode(outgoing.get(node.id));
        break;
      }

      try {
        const outcome = await executeNode({
          dsl,
          host,
          values,
          env,
          node,
          isFirst: index === 0,
          emit,
        });
        const record: ReplayNodeResult = {
          nodeId: node.id,
          name: node.name,
          groupId: groupIdOf(node),
          status: outcome.healed ? "healed" : "pass",
          message: outcome.message,
          strategy: outcome.strategy,
          durationMs: Date.now() - nodeStarted,
        };
        results.push(record);
        emit({ type: "node.finished", node: record });
        next = nextNode(outgoing.get(node.id));
        break;
      } catch (error) {
        const record: ReplayNodeResult = {
          nodeId: node.id,
          name: node.name,
          groupId: groupIdOf(node),
          status: "fail",
          message: errorMessage(error),
          durationMs: Date.now() - nodeStarted,
        };
        results.push(record);
        emit({ type: "node.finished", node: record });
        if (!onNodeError) {
          status = "failed";
          failure = `${node.name ?? node.id}: ${record.message}`;
          interrupted = true;
          break;
        }
        const decision = await onNodeError({
          nodeId: node.id,
          name: node.name,
          type: node.type,
          message: record.message,
          attempt,
          durationMs: record.durationMs,
          varName: node.type === "extract" ? node.varName : undefined,
        });
        if (signal?.aborted) {
          status = "canceled";
          failure = "回放已取消";
          interrupted = true;
          break;
        }
        if (decision.action === "stop") {
          status = "failed";
          failure = `${node.name ?? node.id}: ${record.message}`;
          interrupted = true;
          break;
        }
        if (decision.action === "retry") {
          // 撤销本次失败记录与去重标记，等价于重新执行当前节点。
          results.pop();
          executed.delete(node.id);
          continue;
        }
        const finalRecord: ReplayNodeResult =
          decision.action === "skip"
            ? { ...record, status: "skipped", message: `人工跳过：${record.message}` }
            : { ...record, status: "manual", message: `人工补全：${record.message}` };
        if (decision.action === "continue" && node.type === "extract") {
          for (const [name, value] of Object.entries(decision.vars ?? {})) {
            env[name] = value;
            emit({ type: "var.set", nodeId: node.id, name, value });
          }
        }
        results[results.length - 1] = finalRecord;
        emit({ type: "node.finished", node: finalRecord });
        next = nextNode(outgoing.get(node.id));
        break;
      }
    }

    if (interrupted) break;
    current = next;
  }

  const durationMs = Date.now() - started;
  const passed = results.filter(
    (item) => item.status === "pass" || item.status === "healed" || item.status === "manual",
  ).length;
  emit({
    type: "run.finished",
    status,
    durationMs,
    passed,
    total: dsl.nodes.length,
    error: failure,
  });

  return {
    status,
    nodes: results,
    error: failure,
    durationMs,
    vars: { ...env },
  };
}

function groupIdOf(node: FlowNode): string | undefined {
  const value = node.meta?.flowNodeId;
  return typeof value === "string" ? value : undefined;
}

/** dsl.vars 只是环境变量的初始声明；运行期变量由 extract 节点写入。 */
function seedVars(dsl: FlowDsl): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(dsl.vars ?? {})) {
    const resolved = valueFromExpression(value, {});
    if (resolved !== undefined) env[name] = resolved;
  }
  return env;
}

function nextNode(edges: FlowDsl["edges"] | undefined): string | undefined {
  if (!edges || edges.length === 0) return undefined;
  return (edges.find((edge) => !edge.when) ?? edges[0])?.to;
}

interface ExecuteContext {
  dsl: FlowDsl;
  host: ReplayHost;
  values: Record<string, unknown>;
  /** 流程环境变量；extract 节点写入，后续节点读取。 */
  env: Record<string, unknown>;
  node: FlowNode;
  isFirst: boolean;
  emit: (event: ReplayEvent) => void;
}

/** 表达式作用域：环境变量优先，节点 id 覆盖值只用于按节点取值。 */
function expressionScope(context: ExecuteContext): Record<string, unknown> {
  return { ...context.values, ...context.env };
}

async function executeNode(context: ExecuteContext): Promise<NodeOutcome> {
  const { node } = context;
  const timeoutMs = node.timeoutMs ?? context.dsl.defaults?.nodeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (const signal of node.pre ?? []) {
    await waitSignal(context.host, signal, timeoutMs, expressionScope(context));
  }
  let outcome: NodeOutcome;
  switch (node.type) {
    case "navigate":
      outcome = await executeNavigate(context, node, timeoutMs);
      break;
    case "interact":
      outcome = await executeInteract(context, node, timeoutMs);
      break;
    case "wait":
      outcome = await executeWait(context, node, timeoutMs);
      break;
    case "picker":
      outcome = await executePicker(context, node, timeoutMs);
      break;
    case "extract":
      outcome = await executeExtract(context, node, timeoutMs);
      break;
  }
  for (const signal of node.expect ?? []) {
    await waitSignal(context.host, signal, timeoutMs, expressionScope(context));
  }
  return outcome;
}

async function executeNavigate(
  context: ExecuteContext,
  node: NavigateNode,
  timeoutMs: number,
): Promise<NodeOutcome> {
  const system =
    context.dsl.systems.find((item) => item.id === node.system) ?? context.dsl.systems[0];
  if (!system) throw new ReplayError(`节点 ${node.id} 引用了未知系统: ${node.system}`);
  const url = new URL(node.url, system.baseUrl).toString();
  // 上一步的点击/输入可能已经触发了这次导航：给浏览器一个提交窗口，
  // 页面已在该地址时直接跳过，否则 reload 会把客户端刚写入的数据
  // （如演示页的 sessionStorage 草稿）再清掉。
  // 首个导航节点仍强制加载，保证每次回放都从干净页面开始。
  if (!context.isFirst) {
    const deadline = Date.now() + Math.min(1500, timeoutMs);
    let matched = false;
    while (Date.now() < deadline) {
      if (context.host.getUrl() === url) {
        matched = true;
        try {
          if (context.host.getDocument().readyState === "complete") break;
        } catch {
          // 文档仍在切换，继续等下一轮。
        }
      }
      await sleep(POLL_MS);
    }
    if (matched) {
      return { message: `已位于 ${url}，跳过重复导航` };
    }
  }
  await context.host.navigate(url, timeoutMs);
  if (node.readySignal) {
    await waitSignal(context.host, node.readySignal, timeoutMs, context.values);
  }
  return { message: `导航到 ${url}` };
}

async function executeInteract(
  context: ExecuteContext,
  node: InteractNode,
  timeoutMs: number,
): Promise<NodeOutcome> {
  const target = await waitForTarget(context.host, node.target, timeoutMs, {
    requireVisible: true,
    allowMultiple: false,
    allowHiddenSelectInput: true,
    activateCell:
      node.adapter === "input" ||
      node.adapter === "nativeSelect" ||
      node.adapter === "select" ||
      node.adapter === "check",
  });
  const element = target.element;
  const strategy = target.strategy;
  const healed = target.healed;
  const label = node.target.label ?? node.name ?? node.id;
  const selectTrigger = resolveSelectTrigger(element);
  const hiddenSelectControl =
    Boolean(selectTrigger) && !isVisible(element) && /^(input|textarea)$/i.test(element.tagName);

  switch (node.adapter) {
    case "input": {
      const value = valueString(resolveNodeValue(node, expressionScope(context)));
      // 搜索输入通常会随下拉一起出现；先确保面板打开，再写入筛选值。
      if (selectTrigger) await openSelect(selectTrigger);
      fillElement(element, value);
      const actual = readElementValue(element);
      if (node.verify === "readBack" && actual !== value) {
        throw new ReplayError(
          `输入回读不一致: 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(actual)}`,
          target.attempts,
        );
      }
      // 单元格编辑靠失焦提交：fill 已经 focus 过，blur 会派发 focusout 让组件落库。
      if (node.blurAfter) {
        (element as HTMLElement).blur();
        await sleep(0);
      }
      return { message: `输入 ${label} ${JSON.stringify(value)}`, strategy, healed };
    }
    case "nativeSelect":
    case "select": {
      const value = valueString(resolveNodeValue(node, expressionScope(context)));
      const actual = selectOption(element, value);
      return { message: `选择 ${label} ${JSON.stringify(actual)}`, strategy, healed };
    }
    case "check": {
      const expected = resolveChecked(node, expressionScope(context));
      const actual = setChecked(element, expected);
      if (actual !== expected) {
        throw new ReplayError(
          `勾选状态回读不一致: 期望 ${expected}，实际 ${actual}`,
          target.attempts,
        );
      }
      return { message: `${expected ? "勾选" : "取消勾选"} ${label}`, strategy, healed };
    }
    case "click": {
      if (hiddenSelectControl && selectTrigger) {
        // 录制的点击目标可能是下拉的隐藏搜索输入；回放时点它的可见容器来展开面板。
        await openSelect(selectTrigger);
        return { message: `打开下拉 ${label}`, strategy, healed };
      }
      clickElement(element);
      await sleep(0);
      return { message: `点击 ${label}`, strategy, healed };
    }
    case "press": {
      const key = node.key ?? "Enter";
      pressKey(element, key);
      return { message: `按键 ${key}`, strategy, healed };
    }
    case "hover": {
      hoverElement(hiddenSelectControl && selectTrigger ? selectTrigger : element);
      // 给 hover 触发的展开动画/React 状态更新留一拍，后续节点仍会等待目标可见。
      await sleep(50);
      return { message: `悬停 ${label}`, strategy, healed };
    }
    case "upload": {
      throw new ReplayError("浏览器演示暂不支持 upload 适配器（需真实文件系统）");
    }
    default:
      throw new ReplayError(`不支持的交互适配器: ${node.adapter}`);
  }
}


/** 其它弹出面板的容器；解析触发器时要跳过，否则残留面板会劫持下一个节点。 */
const FOREIGN_PANEL = PANEL_CONTAINER_SELECTOR;

async function executePicker(
  context: ExecuteContext,
  node: PickerNode,
  timeoutMs: number,
): Promise<NodeOutcome> {
  const host = context.host;
  const doc = host.getDocument();
  const rule = pickerRule(node);
  const selector = panelSelectorOf(node);
  const label = node.trigger.label ?? node.name ?? node.id;
  const override = pickerOverride(context.values[node.id]);
  // 阶段超时可单独覆盖；未配置时沿用节点超时，关闭阶段保持宽松默认。
  const stage = {
    open: node.stageTimeouts?.openMs ?? timeoutMs,
    filter: node.stageTimeouts?.filterMs ?? timeoutMs,
    pick: node.stageTimeouts?.pickMs ?? timeoutMs,
    close: node.stageTimeouts?.closeMs ?? 5000,
    // 多选面板本来就常驻；收尾只是 best-effort，不能按单选的 5s 超时阻塞后续步骤。
    multiClose: node.stageTimeouts?.closeMs ?? 1200,
  };

  const trigger = await waitForTarget(host, node.trigger, timeoutMs, {
    requireVisible: true,
    allowMultiple: false,
    allowHiddenSelectInput: true,
    exclude: (element) => Boolean(element.closest(FOREIGN_PANEL)),
  });
  const control = resolveSelectTrigger(trigger.element) ?? trigger.element;

  // open 幂等：inline 已展开就不再点（否则会 toggle 关掉）；dialog 每次都要点触发器。
  if (node.mode === "dialog" || !isPanelOpen(control, selector)) {
    if (node.triggerAction === "hover") {
      hoverElement(control);
      await sleep(80);
    } else {
      clickElement(control);
    }
  }

  // 录制时的 popupId 会被重新挂载后的组件复用：每轮以触发器当前的 aria-controls 为准。
  const resolution = await waitForPanel(doc, node, selector, stage.open, () =>
    ariaControlsOf(control),
  );
  if (!resolution) {
    throw new ReplayError(
      `面板未在 ${stage.open}ms 内打开: ${label}（面板选择器 ${selector ?? "缺失"}）`,
      trigger.attempts,
    );
  }
  let panel = resolution.element;
  /**
   * 面板解析后仍可能被页面自身关闭（异步校验 / 重渲染 / 自动收起）。
   * 保留触发器，面板被关掉时重新打开并重新解析，而不是对着隐藏元素等满超时。
   */
  let reopenCount = 0;
  const reopenPanel = async (): Promise<Element | null> => {
    if (node.mode !== "inline" || reopenCount >= 3) return null;
    reopenCount += 1;
    clickElement(control);
    const next = await waitForPanel(doc, node, selector, Math.min(stage.open, 1500), () =>
      ariaControlsOf(control),
    );
    return next?.element ?? null;
  };

  if (node.filter && node.filter.steps.length > 0) {
    for (const [index, step] of node.filter.steps.entries()) {
      const found = await waitForScoped(host, panel, step.target, stage.filter);
      const edited = override?.filters?.[index];
      const value =
        edited !== undefined && edited !== ""
          ? edited
          : step.value === undefined
            ? ""
            : valueString(
                valueFromExpression(step.value, expressionScope(context), true),
              );
      if (step.adapter === "input") {
        fillElement(found.element, value);
        const actual = readElementValue(found.element);
        if (actual !== value) {
          throw new ReplayError(
            `筛选输入回读不一致: 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(actual)}`,
            found.attempts,
          );
        }
      } else if (step.adapter === "nativeSelect") {
        selectOption(found.element, value);
      } else if (step.adapter === "check") {
        setChecked(found.element, step.checked ?? true);
      } else {
        clickElement(found.element);
        await sleep(0);
      }
    }

    // 筛选后必须真的有结果，否则 pick 会退化成「找不到选项」，无法归因。
    const remaining = await waitForResults(panel, rule, stage.filter);
    if (remaining === 0) throw new ReplayError(`筛选后无结果: ${label}`);
  }

  const targets = pickTargets(node, override, expressionScope(context));
  if (targets.length === 0) throw new ReplayError(`picker 没有可用的选择值: ${label}`);

  const rowOverride =
    override?.strategy === "byRow"
      ? true
      : override?.strategy === "byText"
        ? false
        : override?.on === "row"
          ? true
          : override?.on === "item"
            ? false
            : undefined;

  for (const target of targets) {
    const picked = await waitForPick(
      panel,
      node,
      rule,
      target,
      stage.pick,
      control,
      reopenPanel,
      rowOverride,
    );
    panel = picked.panel;
    clickElement(pickClickTarget(picked.element, node, rowOverride));
    await sleep(0);
  }

  if (node.commit) {
    const target = await waitForScoped(host, panel, node.commit.target, timeoutMs);
    clickElement(target.element);
    await sleep(0);
  }

  let message = `选择 ${label} ${describeTargets(targets)}`;
  if (resolution.binding === "temporal") message += "（面板时序降级）";
  const mustClose = node.mode === "dialog" && node.commit?.waitHidden !== false;
  if (mustClose) {
    const closed = await waitForPanelClosed(panel, stage.close);
    if (!closed) throw new ReplayError(`弹窗未在 5s 内关闭: ${label}`);
  } else if (node.pick.multi === true) {
    // 多选面板选完不会自己关：先 Escape，不行再点触发器 toggle；收尾最多等 1.2s。
    const closed = await closeMultiSelect(panel, control, stage.multiClose);
    if (!closed) message += "（多选面板未关闭，已继续）";
  } else {
    const closed = await waitForPanelClosed(panel, stage.close);
    if (!closed) message += "（面板未在 5s 内关闭，已继续）";
  }

  return { message, strategy: trigger.strategy, healed: trigger.healed };
}

/** 一次选择：按文本/行值、按可见列表位置，或筛选后的第一条。 */
type PickTarget =
  | { kind: "text"; value: string; column?: number }
  | { kind: "index"; index: number; column?: number }
  | { kind: "first"; column?: number };

type PickerRuntimeStrategy = "byText" | "byRow" | "byIndex" | "firstVisible";

/** 运行期微调：可覆盖筛选值、选择项、按位置序号和选择方式。 */
interface PickerRuntimeOverride {
  picks?: string[];
  filters?: string[];
  strategy?: PickerRuntimeStrategy;
  indexes?: number[];
  on?: "item" | "row";
}

/**
 * 选择目标。按位置时不做任何回退——位置错了要报错，不能悄悄换一项；
 * 位置配置本身不合法（空、小数、0）也直接判配置错误。
 */
function pickTargets(
  node: PickerNode,
  override: PickerRuntimeOverride | null,
  values: Record<string, unknown>,
): PickTarget[] {
  const strategy = override?.strategy ?? node.pick.strategy;
  if (strategy === "firstVisible") {
    return [{ kind: "first" as const, column: recordedColumn(node, 0) }];
  }
  if (strategy === "byIndex") {
    const indexes =
      override?.strategy === "byIndex"
        ? (override.indexes ?? [])
        : (node.pick.byIndex?.indexes ?? []);
    const invalid = indexes.filter((index) => !Number.isInteger(index) || index < 1);
    if (invalid.length > 0) {
      throw new ReplayError(`picker 的位置配置无效: ${node.trigger.label ?? node.id}（${invalid.join(", ")}）`);
    }
    return indexes.map((index, position) => ({
      kind: "index" as const,
      index,
      column: recordedColumn(node, position),
    }));
  }
  const edited = (override?.picks ?? []).filter((item) => item !== "");
  const picked = edited.length > 0 ? edited : pickerValues(node, values);
  return picked.map((value, position) => ({
    kind: "text" as const,
    value,
    column: recordedColumn(node, position),
  }));
}

/** 级联的录制列号；外部 JSON / 手工节点没有该信息，回放会退回最后一列。 */
function recordedColumn(node: PickerNode, position: number): number | undefined {
  return node.pick.values?.[position]?.column;
}

function describeTargets(targets: PickTarget[]): string {
  return targets
    .map((target) => {
      if (target.kind === "index") return `第${target.index}项`;
      if (target.kind === "first") return "筛选后第一项";
      return target.value;
    })
    .join(" / ");
}

/** 值微调面板写入 { picks, filters, strategy, indexes, on }；形状不对就当没改。 */
function pickerOverride(value: unknown): PickerRuntimeOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as {
    picks?: unknown;
    filters?: unknown;
    strategy?: unknown;
    indexes?: unknown;
    on?: unknown;
  };
  const strategy: PickerRuntimeStrategy | undefined =
    record.strategy === "byText" ||
    record.strategy === "byRow" ||
    record.strategy === "byIndex" ||
    record.strategy === "firstVisible"
      ? record.strategy
      : undefined;
  return {
    picks: Array.isArray(record.picks) ? record.picks.map((item) => String(item)) : undefined,
    filters: Array.isArray(record.filters) ? record.filters.map((item) => String(item)) : undefined,
    strategy,
    indexes: Array.isArray(record.indexes) ? record.indexes.map((item) => Number(item)) : undefined,
    on: record.on === "row" ? "row" : record.on === "item" ? "item" : undefined,
  };
}

/** 选择值优先用录制顺序（values），回退到 byText / byRow 的可调值。 */
function pickerValues(node: PickerNode, values: Record<string, unknown>): string[] {
  const recorded = (node.pick.values ?? []).map((item) => item.value ?? "").filter(Boolean);
  if (recorded.length > 0) return recorded;
  const raw = node.pick.byText?.value ?? node.pick.byRow?.keyValue;
  if (raw === undefined) return [];
  const resolved = valueFromExpression(raw, values, true);
  if (Array.isArray(resolved)) return resolved.map(valueString).filter(Boolean);
  return resolved === undefined || resolved === null ? [] : [valueString(resolved)];
}

/** 先在面板内找，找不到再退回整页（筛选输入常挂在触发器里，而不是面板里）。 */
async function waitForScoped(
  host: ReplayHost,
  root: Element,
  target: TargetRef,
  timeoutMs: number,
): Promise<ResolvedTarget> {
  const deadline = Date.now() + timeoutMs;
  let attempts: ReplayAttempt[] = [];
  do {
    const doc = safeDocument(host);
    if (doc) {
      const options = { requireVisible: true, allowMultiple: false, allowHiddenSelectInput: true };
      const within = findTarget(root, target, options);
      if (within.resolved) return within.resolved;
      const global = findTarget(doc, target, options);
      attempts = global.attempts;
      if (global.resolved) return global.resolved;
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  } while (true);
  throw new ReplayError(`面板内找不到目标: ${target.label ?? "未命名目标"}`, attempts);
}

/**
 * 多选面板的收尾：已关闭就直接通过；否则 Escape → 再点触发器 toggle。
 * 整个收尾受 timeoutMs 约束（默认 1.2s），面板不响应时立刻继续，不能等满 5s。
 */
async function closeMultiSelect(
  panel: Element,
  control: Element,
  timeoutMs: number,
): Promise<boolean> {
  if (!isVisible(panel)) return true;
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());
  pressKey(control, "Escape");
  if (await waitForPanelClosed(panel, Math.min(400, remaining()))) return true;
  clickElement(control);
  return waitForPanelClosed(panel, remaining());
}

/** 面板里的滚动容器（antd 虚拟列表的 holder）；没有就返回 null。 */
function findScrollable(root: Element): Element | null {
  const candidates = [root, ...Array.from(root.querySelectorAll("*"))];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const element = candidates[index]!;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style || !/(auto|scroll)/.test(style.overflowY)) continue;
    if (element.scrollHeight > element.clientHeight + 8) return element;
  }
  return null;
}

async function waitForPick(
  panel: Element,
  node: PickerNode,
  rule: PanelRule | undefined,
  target: PickTarget,
  timeoutMs: number,
  control?: Element,
  reopen?: () => Promise<Element | null>,
  byRowOverride?: boolean,
): Promise<{ element: Element; panel: Element }> {
  const deadline = Date.now() + timeoutMs;
  const byRow =
    byRowOverride ??
    (node.pick.strategy === "byRow" ||
      node.pick.byIndex?.on === "row" ||
      node.pick.firstVisible?.on === "row");
  let currentPanel = panel;
  let exhausted = false;
  let reopenAttempts = 0;
  do {
    // 面板可能在解析后被页面自身关掉：重新打开再继续，而不是等满超时。
    if (!isVisible(currentPanel) && reopen && reopenAttempts < 3) {
      reopenAttempts += 1;
      const next = await reopen();
      if (next) {
        currentPanel = next;
        exhausted = false;
      }
    }
    const scopes = pickScopes(currentPanel, rule, target.column);
    // 按位置的序号是按「当前列」算的；没有列号时只查最后一列，避免跨列误点。
    const candidates = target.kind === "index" ? scopes.slice(0, 1) : scopes;
    for (const scope of candidates) {
      const found =
        target.kind === "index"
          ? findPickByIndex(scope, rule, byRow, target.index)
          : target.kind === "first"
            ? (visibleItems(scope, rule, byRow)[0] ?? null)
            : findPickInScope(scope, rule, byRow, target.value);
      if (found) return { element: found, panel: currentPanel };
    }
    // 列表已经渲染出来还越界，就不是「再等等」能解决的：立即报错，别耗满超时。
    if (target.kind === "index" && scopes[0]) {
      const count = visibleItems(scopes[0], rule, byRow).length;
      if (count > 0 && target.index > count) {
        throw new ReplayError(`位置超出范围: 期望第 ${target.index} 项，当前面板 ${count} 项`);
      }
    }
    // 按位置时不能滚动：虚拟列表的「第 N 项」随渲染窗口变化，滚动只会让序号漂移。
    const scroller = target.kind === "index" ? null : findScrollable(currentPanel);
    // 虚拟列表只渲染窗口内的项：没找到就往下滚一屏，滚到底再回顶部补一遍。
    if (scroller) {
      const before = scroller.scrollTop;
      const step = Math.max(60, Math.floor(scroller.clientHeight * 0.9));
      scroller.scrollTop = Math.min(before + step, scroller.scrollHeight);
      if (scroller.scrollTop === before) {
        if (exhausted) break;
        scroller.scrollTop = 0;
        exhausted = true;
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  } while (true);
  if (target.kind === "index") {
    const count = visibleItems(scopeForReport(currentPanel, rule, target), rule, byRow).length;
    throw new ReplayError(`位置超出范围: 期望第 ${target.index} 项，当前面板 ${count} 项`);
  }
  const options = visibleItems(scopeForReport(currentPanel, rule, target), rule, byRow)
    .slice(0, 8)
    .map((element) => {
      const label =
        normalizeText(element.textContent ?? "") ||
        normalizeText(element.getAttribute("title") ?? "") ||
        normalizeText(element.getAttribute("aria-label") ?? "");
      return JSON.stringify(label);
    });
  const detail =
    options.length > 0
      ? `（面板可见项：${options.join("、")}）`
      : "（面板内没有可见选项）";
  const columnNote = target.column ? `（目标第 ${target.column} 列）` : "";
  const wanted = target.kind === "first" ? "筛选后第一项" : target.value;
  throw new ReplayError(
    `选择项不存在: ${wanted}${detail}${columnNote}${describePickerPanel(currentPanel, node, rule, byRow, control)}`,
  );
}

/** 诊断用：目标列已渲染就用目标列，否则退回最后一列，保证报错仍列出可视项。 */
function scopeForReport(panel: Element, rule: PanelRule | undefined, target: PickTarget): Element {
  return pickScopes(panel, rule, target.column)[0] ?? pickScopes(panel, rule)[0] ?? panel;
}

/** 面板绑定诊断：区分「绑错面板」与「选项未渲染/被隐藏」。 */
function describePickerPanel(
  panel: Element,
  node: PickerNode,
  rule: PanelRule | undefined,
  byRow: boolean,
  control?: Element,
): string {
  const selector = panelSelectorOf(node);
  const panels = selector
    ? Array.from(panel.ownerDocument.querySelectorAll(selector)).filter(isVisible)
    : [];
  const itemSelectors = itemSelectorsOf(rule, byRow);
  const query = itemSelectors.join(", ");
  const items = query ? Array.from(panel.querySelectorAll(query)) : [];
  const visible = items.filter(isVisible).length;
  const describe = (element: Element): string => {
    const classes = (element.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter((item) => item && !/^css-/.test(item) && !/^-/.test(item))
      .slice(0, 2)
      .join(".");
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${classes ? `.${classes}` : ""}`;
  };
  const siblings = panels.map((element) => {
    const count = query ? element.querySelectorAll(query).length : 0;
    return `${describe(element)}(${count}项)`;
  });
  const content = normalizeText(panel.textContent ?? "").slice(0, 80);
  const popupId = node.panel.popupId;
  // 同名字段在多个表单/隐藏页里重复挂载时，id 会撞车；getElementById 只能拿到第一个。
  const popupNodes = popupId
    ? panel.ownerDocument.querySelectorAll(`[id=${JSON.stringify(popupId)}]`).length
    : 0;
  const controlName = control
    ? `${control.tagName.toLowerCase()}${control.id ? `#${control.id}` : ""}${control.getAttribute("name") ? `[name=${control.getAttribute("name")}]` : ""}`
    : "-";
  return `；rule=${typeof node.meta?.rule === "string" ? node.meta.rule : "?"} strategy=${node.pick.strategy} binding=${node.panel.binding ?? "?"} popupId=${popupId ?? "-"} popupNodes=${popupNodes} liveControls=${control ? ariaControlsOf(control) ?? "-" : "-"} control=${controlName} trigger=${node.trigger.label ?? "-"}；当前面板 ${describe(panel)} ${items.length} 项（可见 ${visible}）文本=${JSON.stringify(content)}；可见面板 ${panels.length} 个${siblings.length > 0 ? `：${siblings.join(" / ")}` : ""}`;
}

/** 第 N 项就是可见列表的第 N 个元素；与录制序号共用同一个 visibleItems。 */
function findPickByIndex(
  scope: Element,
  rule: PanelRule | undefined,
  byRow: boolean,
  index: number,
): Element | null {
  return visibleItems(scope, rule, byRow)[index - 1] ?? null;
}

function findPickInScope(
  scope: Element,
  rule: PanelRule | undefined,
  byRow: boolean,
  value: string,
): Element | null {
  const wanted = normalizeText(value);
  let partial: Element | null = null;
  let partialCount = 0;
  for (const element of visibleItems(scope, rule, byRow)) {
    if (byRow) {
      if (element.getAttribute("data-row-key") === value) return element;
      if (normalizeText(element.textContent ?? "").includes(wanted)) return element;
      continue;
    }
    // title / 可访问名 / 文本都按归一化值比较：选项可能带图标、状态后缀或额外空白。
    const title = element.getAttribute("title");
    if (title && normalizeText(title) === wanted) return element;
    const aria = element.getAttribute("aria-label");
    if (aria && normalizeText(aria) === wanted) return element;
    const text = normalizeText(element.textContent ?? "");
    if (text === wanted) return element;
    if (wanted && text.includes(wanted)) {
      partialCount += 1;
      partial = element;
    }
  }
  // 只有唯一包含时才当作命中；多个候选包含同一段文本时继续判不存在，避免选错项。
  return partialCount === 1 ? partial : null;
}

/** 行选择点行本身往往不生效，antd 的勾选控件在行内。 */
function pickClickTarget(
  element: Element,
  node: PickerNode,
  byRowOverride?: boolean,
): Element {
  const rowMode =
    byRowOverride ??
    (node.pick.strategy === "byRow" ||
      node.pick.byIndex?.on === "row" ||
      node.pick.firstVisible?.on === "row");
  if (!rowMode) return element;
  return element.querySelector('input[type="checkbox"]') ?? element;
}

/** 筛选后等结果刷新：数量稳定两拍或至少有一条；返回最终数量。 */
async function waitForResults(
  panel: Element,
  rule: PanelRule | undefined,
  timeoutMs: number,
): Promise<number> {
  const selectors = [...itemSelectorsOf(rule, false), ...itemSelectorsOf(rule, true)];
  const deadline = Date.now() + Math.min(timeoutMs, 8000);
  let last = -1;
  let stable = 0;
  do {
    const count =
      selectors.length === 0
        ? 0
        : Array.from(panel.querySelectorAll(selectors.join(", "))).filter(isVisible).length;
    if (count > 0 && count === last) stable += 1;
    else stable = 0;
    if (count > 0 && stable >= 2) return count;
    last = count;
    if (Date.now() >= deadline) return count;
    await sleep(POLL_MS);
  } while (true);
}

async function executeWait(
  context: ExecuteContext,
  node: WaitNode,
  timeoutMs: number,
): Promise<NodeOutcome> {
  const condition = node.condition;
  await waitSignal(context.host, condition, timeoutMs, expressionScope(context));
  return {
    message:
      typeof condition === "string"
        ? `等待预设信号 ${condition}`
        : `等待 ${condition.kind} 条件`,
    strategy: typeof condition === "string" ? condition : condition.kind,
  };
}

async function executeExtract(
  context: ExecuteContext,
  node: ExtractNode,
  timeoutMs: number,
): Promise<NodeOutcome> {
  const target = await waitForTarget(context.host, node.target, timeoutMs, {
    requireVisible: true,
    allowMultiple: false,
  });
  const raw = readExtractValue(target.element, node);
  const value = applyExtractPattern(raw, node);
  if (!value) {
    const message = `取值节点未取到 ${node.varName}: ${node.target.label ?? node.id}`;
    if (node.optional) return { message: `${message}（已忽略）`, strategy: target.strategy, healed: target.healed };
    throw new ReplayError(message, target.attempts);
  }
  context.env[node.varName] = value;
  context.emit({ type: "var.set", nodeId: node.id, name: node.varName, value });
  return {
    message: `取值 ${node.varName} = ${JSON.stringify(value)}`,
    strategy: target.strategy,
    healed: target.healed,
  };
}

function readExtractValue(element: Element, node: ExtractNode): string {
  if (node.read === "value") return readElementValue(element);
  if (node.read === "attribute") {
    const attribute = (node.attribute ?? "").trim();
    if (!attribute) throw new ReplayError(`取值节点 ${node.id} 未配置属性名`);
    return element.getAttribute(attribute) ?? "";
  }
  return element.textContent ?? "";
}

function applyExtractPattern(raw: string, node: ExtractNode): string {
  const text = raw.trim();
  if (!node.pattern) return normalizeText(text);
  let regex: RegExp;
  try {
    regex = new RegExp(node.pattern);
  } catch {
    throw new ReplayError(`取值节点 ${node.id} 的正则无效: ${node.pattern}`);
  }
  const match = text.match(regex);
  if (!match) return "";
  return normalizeText(match[1] ?? match[0]);
}

function resolveNodeValue(node: InteractNode, values: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(values, node.id)) return values[node.id];
  const value = node.value;
  if (value === undefined) return "";
  return valueFromExpression(value, values, true);
}

function resolveChecked(node: InteractNode, values: Record<string, unknown>): boolean {
  const override = resolveNodeValue(node, values);
  if (typeof override === "boolean") return override;
  const raw = String(override).toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "") return node.checked ?? false;
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

function valueString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(valueString).join(",");
  return String(value);
}

function fillElement(element: Element, value: string): void {
  const win = ownerWindow(element);
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    (element as HTMLElement).focus();
    const prototype =
      tag === "textarea" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else (element as HTMLInputElement).value = value;
    element.dispatchEvent(new win.Event("input", { bubbles: true }));
    element.dispatchEvent(new win.Event("change", { bubbles: true }));
    return;
  }
  if ((element as HTMLElement).isContentEditable) {
    element.textContent = value;
    element.dispatchEvent(new win.Event("input", { bubbles: true }));
    return;
  }
  throw new ReplayError(`目标不是可输入控件: <${tag}>`);
}

function readElementValue(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return String((element as HTMLInputElement).value ?? "");
  }
  return normalizeText(element.textContent ?? "");
}

function selectOption(element: Element, desired: string): string {
  if (element.tagName.toLowerCase() !== "select") {
    throw new ReplayError(`目标不是 <select>: <${element.tagName.toLowerCase()}>`);
  }
  const select = element as HTMLSelectElement;
  const win = ownerWindow(element);
  const wanted = normalizeText(desired);
  const option =
    Array.from(select.options).find(
      (item) => normalizeText(item.textContent ?? "") === wanted || item.value === desired,
    ) ??
    Array.from(select.options).find((item) =>
      normalizeText(item.textContent ?? "").includes(wanted),
    );
  if (!option) {
    throw new ReplayError(
      `下拉选项不存在: ${JSON.stringify(desired)}（可选 ${Array.from(select.options)
        .map((item) => JSON.stringify(normalizeText(item.textContent ?? "")))
        .join("、")}）`,
    );
  }
  select.value = option.value;
  select.dispatchEvent(new win.Event("input", { bubbles: true }));
  select.dispatchEvent(new win.Event("change", { bubbles: true }));
  const selected = select.options[select.selectedIndex];
  const actual = normalizeText(selected?.textContent ?? "") || select.value;
  if (actual !== wanted && select.value !== desired) {
    throw new ReplayError(
      `下拉回读不一致: 期望 ${JSON.stringify(desired)}，实际 ${JSON.stringify(actual)}`,
    );
  }
  return actual;
}

function setChecked(element: Element, expected: boolean): boolean {
  const input = element as HTMLInputElement;
  if (typeof input.checked !== "boolean") {
    throw new ReplayError(`目标不是可勾选控件: <${element.tagName.toLowerCase()}>`);
  }
  if (input.checked !== expected) {
    const win = ownerWindow(element);
    input.click();
    if (input.checked !== expected) {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "checked")?.set;
      if (setter) setter.call(input, expected);
      else input.checked = expected;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
    }
  }
  return input.checked;
}

function pressKey(element: Element, key: string): void {
  const win = ownerWindow(element);
  (element as HTMLElement).focus();
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
  element.dispatchEvent(new win.KeyboardEvent("keydown", init));
  if (key.length === 1) {
    element.dispatchEvent(new win.KeyboardEvent("keypress", init));
  }
  element.dispatchEvent(new win.KeyboardEvent("keyup", init));
}

/**
 * 按真实点击顺序补发 pointer/mouse 事件。
 * antd Select 这类组件在 mousedown 上展开面板，只调用 element.click() 不会打开下拉。
 */
function clickElement(element: Element): void {
  const win = ownerWindow(element);
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  const Pointer = typeof win.PointerEvent === "function" ? win.PointerEvent : win.MouseEvent;
  element.dispatchEvent(new Pointer("pointerdown", init));
  element.dispatchEvent(new win.MouseEvent("mousedown", init));
  if (element instanceof win.HTMLElement && !isDisabled(element)) {
    element.focus({ preventScroll: true });
  }
  element.dispatchEvent(new Pointer("pointerup", init));
  element.dispatchEvent(new win.MouseEvent("mouseup", init));
  (element as HTMLElement).click();
}

/**
 * 可见的控件本身就能接收点击；只有隐藏输入（自定义下拉的搜索框）才向上找可见容器。
 * 触发容器统一由 panel-rules 判定，不再维护第二份类名表。
 */
function resolveSelectTrigger(element: Element): Element | null {
  const match = matchElement(element);
  if (!match || match.zone !== "trigger") return null;
  // 从点击目标向上找最近的可见节点：隐藏搜索输入要落到它的可见容器，
  // 但不能直接跳到规则命中的最外层（会越过组件自己的事件监听节点）。
  let node: Element | null = element;
  while (node) {
    if (isVisible(node)) return node;
    if (node === match.element) break;
    node = node.parentElement;
  }
  return isVisible(match.element) ? match.element : null;
}

/**
 * 触发器当前的弹出面板 id。antd 只在面板打开时挂 aria-controls，
 * 打开后再读才是本次挂载的真实契约。
 */
function ariaControlsOf(control: Element): string | null {
  const box = control.matches("[aria-controls]")
    ? control
    : control.querySelector("[aria-controls]");
  const id = box?.getAttribute("aria-controls")?.split(/\s+/)[0]?.trim();
  return id || null;
}

/** 命中规则的面板选择器；用于开合判定，不再另抄类名。 */
function panelSelectorFor(element: Element): string | null {
  const match = matchElement(element);
  if (!match) return null;
  return match.rule.panel.join(", ") || null;
}

/**
 * 确保面板打开（交互节点的最小兜底）。
 * 已展开就不再点，避免把面板点关；点击后只等组件把状态提交到 DOM，超时交给后续节点。
 */
async function openSelect(trigger: Element): Promise<void> {
  const selector = panelSelectorFor(trigger);
  if (isPanelOpen(trigger, selector)) return;
  clickElement(trigger);
  const deadline = Date.now() + PANEL_OPEN_TIMEOUT_MS;
  do {
    await sleep(20);
    if (isPanelOpen(trigger, selector)) return;
  } while (Date.now() < deadline);
}

/**
 * 悬停 antd Dropdown / Menu 这类组件时，只发 mouseover 往往不够：
 * React 的 onMouseEnter 由 mouseover 合成，而直接监听 mouseenter 的组件需要 enter 事件。
 * 因此按真实指针顺序补齐 pointer/mouse 的 over + enter + move。
 */
function hoverElement(element: Element): void {
  const win = ownerWindow(element);
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  const Pointer = typeof win.PointerEvent === "function" ? win.PointerEvent : win.MouseEvent;
  element.dispatchEvent(new Pointer("pointerover", init));
  element.dispatchEvent(new Pointer("pointerenter", { ...init, bubbles: false }));
  element.dispatchEvent(new win.MouseEvent("mouseover", init));
  element.dispatchEvent(new win.MouseEvent("mouseenter", { ...init, bubbles: false }));
  element.dispatchEvent(new win.MouseEvent("mousemove", init));
}

async function waitSignal(
  host: ReplayHost,
  ref: SignalRef,
  timeoutMs: number,
  values: Record<string, unknown>,
): Promise<void> {
  if (typeof ref === "string") {
    // 预设信号在最小演示里只用于可读展示；page-ready 已由 nav 的 load 事件覆盖。
    return;
  }
  const signal = ref;
  const budget = signal.timeoutMs ?? timeoutMs;
  switch (signal.kind) {
    case "visible":
      await waitForTarget(host, signal.target, budget, {
        requireVisible: true,
        allowMultiple: true,
      });
      return;
    case "hidden":
      await waitHidden(host, signal.target, budget);
      return;
    case "attached":
      await waitForTarget(host, signal.target, budget, {
        requireVisible: false,
        allowMultiple: true,
      });
      return;
    case "enabled":
      await waitEnabled(host, signal.target, budget);
      return;
    case "url":
      await poll(budget, () => host.getUrl().includes(signal.matches), `等待 URL 超时: ${signal.matches}`);
      return;
    case "count":
      await waitCount(host, signal, budget);
      return;
    case "text":
      await waitText(host, signal, budget, values);
      return;
    case "domStable":
      await sleep(Math.min(signal.quietMs ?? 200, budget));
      return;
  }
}

async function waitForTarget(
  host: ReplayHost,
  target: TargetRef,
  timeoutMs: number,
  options: ResolveOptions,
  root?: Document | Element,
): Promise<ResolvedTarget> {
  const deadline = Date.now() + timeoutMs;
  let attempts: ReplayAttempt[] = [];
  let ambiguous = false;
  const activation = options.activateCell ? cellActivationTarget(target) : null;
  let activationTried = false;
  do {
    const doc = safeDocument(host);
    if (doc) {
      const base = root ?? doc;
      // scope 通常是「当前可见弹窗」：弹窗没出现前不能退回全局查同名元素。
      let within: Element | undefined;
      if (target.scope) {
        const scoped = findTarget(
          base,
          { ...target.scope, scope: undefined },
          {
            requireVisible: true,
            allowMultiple: true,
            exclude: options.exclude,
          },
        );
        attempts = scoped.attempts;
        within = scoped.resolved?.element;
      }
      if (!target.scope || within) {
        const found = findTarget(base, target, { ...options, within });
        attempts = found.attempts;
        if (found.resolved) return found.resolved;
        ambiguous = found.attempts.some((attempt) => attempt.visibleCount > 1);
      }
      if (Date.now() < deadline && activation && !activationTried) {
        const cell = findTarget(base, activation, {
          requireVisible: true,
          allowMultiple: false,
          exclude: options.exclude,
          within,
        });
        if (cell.resolved) {
          activationTried = true;
          // 已经有编辑器还点一次可能把编辑态关掉；只在控件确实没渲染时激活。
          if (!cell.resolved.element.querySelector(CELL_EDITOR_SELECTOR)) {
            clickElement(cell.resolved.element);
          }
        }
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  } while (true);
  throw new ReplayError(targetErrorMessage(target, attempts, ambiguous), attempts);
}

async function waitHidden(host: ReplayHost, target: TargetRef, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts: ReplayAttempt[] = [];
  do {
    const doc = safeDocument(host);
    if (doc) {
      const found = findTarget(doc, target, { requireVisible: false, allowMultiple: true });
      attempts = found.attempts;
      if (!found.resolved || !isVisible(found.resolved.element)) return;
    } else {
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  } while (true);
  throw new ReplayError(
    `等待元素隐藏超时: ${target.label ?? "未命名目标"}`,
    attempts,
  );
}

async function waitEnabled(host: ReplayHost, target: TargetRef, timeoutMs: number): Promise<void> {
  const resolved = await waitForTarget(host, target, timeoutMs, {
    requireVisible: true,
    allowMultiple: true,
  });
  await poll(
    timeoutMs,
    () => !isDisabled(resolved.element),
    `等待元素可操作超时: ${target.label ?? "未命名目标"}`,
  );
}

async function waitCount(
  host: ReplayHost,
  signal: Extract<WaitSignal, { kind: "count" }>,
  timeoutMs: number,
): Promise<void> {
  await poll(
    timeoutMs,
    () => {
      const doc = safeDocument(host);
      if (!doc) return false;
      const count = queryAll(doc, signal.target).length;
      if (signal.equals !== undefined && count !== signal.equals) return false;
      if (signal.min !== undefined && count < signal.min) return false;
      if (signal.max !== undefined && count > signal.max) return false;
      return true;
    },
    `等待元素数量条件超时: ${signal.target.label ?? "未命名目标"}`,
  );
}

async function waitText(
  host: ReplayHost,
  signal: Extract<WaitSignal, { kind: "text" }>,
  timeoutMs: number,
  values: Record<string, unknown>,
): Promise<void> {
  const resolved = await waitForTarget(host, signal.target, timeoutMs, {
    requireVisible: true,
    allowMultiple: true,
  });
  const expected =
    signal.equals === undefined ? undefined : valueString(valueFromExpression(signal.equals, values));
  await poll(
    timeoutMs,
    () => {
      const text = normalizeText(resolved.element.textContent ?? "");
      if (signal.contains !== undefined) return text.includes(normalizeText(signal.contains));
      if (expected !== undefined) return text === normalizeText(expected);
      return text.length > 0;
    },
    `等待文本条件超时: ${signal.target.label ?? "未命名目标"}`,
  );
}

function valueFromExpression(
  value: unknown,
  values: Record<string, unknown>,
  strict = false,
): unknown {
  if (value && typeof value === "object" && "kind" in value) {
    const expr = value as {
      kind: string;
      value?: unknown;
      name?: string;
      template?: string;
    };
    if (expr.kind === "literal") return expr.value;
    if (expr.kind === "var" && expr.name) {
      if (Object.prototype.hasOwnProperty.call(values, expr.name)) return values[expr.name];
      if (strict) throw new ReplayError(`变量未提供值: ${expr.name}`);
      return undefined;
    }
    if (expr.kind === "template" && typeof expr.template === "string") {
      return expr.template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, name: string) => {
        if (!Object.prototype.hasOwnProperty.call(values, name)) {
          if (strict) throw new ReplayError(`变量未提供值: ${name}`);
          return "";
        }
        return valueString(values[name]);
      });
    }
    if (expr.kind === "dataset") {
      if (strict) throw new ReplayError("浏览器演示暂不支持 dataset 取值表达式");
      return undefined;
    }
  }
  return value;
}

function findTarget(root: Document | Element, target: TargetRef, options: ResolveOptions): FindResult {
  const attempts: ReplayAttempt[] = [];
  for (let index = 0; index < target.strategies.length; index += 1) {
    const strategy = target.strategies[index]!;
    let elements: Element[] = [];
    try {
      elements = queryStrategy(root, strategy);
    } catch {
      attempts.push({ strategy: strategyLabel(strategy), count: 0, visibleCount: 0 });
      continue;
    }
    if (options.within) {
      elements = elements.filter((element) => options.within!.contains(element));
    }
    const visible = elements.filter(
      (element) =>
        (isVisible(element) ||
          (options.allowHiddenSelectInput === true && isHiddenSelectControl(element))) &&
        !options.exclude?.(element),
    );
    attempts.push({
      strategy: strategyLabel(strategy),
      count: elements.length,
      visibleCount: visible.length,
    });

    if (options.allowMultiple) {
      if (visible.length > 0) {
        const element = visible[0]!;
        return {
          resolved: {
            element,
            strategy: strategyLabel(strategy),
            healed: index > 0,
            multiple: visible.length > 1,
            attempts,
          },
          attempts,
        };
      }
      if (!options.requireVisible && elements.length > 0) {
        return {
          resolved: {
            element: elements[0]!,
            strategy: strategyLabel(strategy),
            healed: index > 0,
            multiple: elements.length > 1,
            attempts,
          },
          attempts,
        };
      }
      continue;
    }

    if (visible.length === 1) {
      return {
        resolved: {
          element: visible[0]!,
          strategy: strategyLabel(strategy),
          healed: index > 0,
          multiple: false,
          attempts,
        },
        attempts,
      };
    }
    if (visible.length > 1) {
      if (target.nth !== undefined && visible[target.nth]) {
        return {
          resolved: {
            element: visible[target.nth]!,
            strategy: strategyLabel(strategy),
            healed: index > 0,
            multiple: true,
            attempts,
          },
          attempts,
        };
      }
      if (target.strict === false) {
        return {
          resolved: {
            element: visible[0]!,
            strategy: strategyLabel(strategy),
            healed: index > 0,
            multiple: true,
            attempts,
          },
          attempts,
        };
      }
      continue;
    }
    if (!options.requireVisible && elements.length === 1) {
      return {
        resolved: {
          element: elements[0]!,
          strategy: strategyLabel(strategy),
          healed: index > 0,
          multiple: false,
          attempts,
        },
        attempts,
      };
    }
  }
  return { attempts };
}

function queryAll(doc: Document, target: TargetRef): Element[] {
  for (const strategy of target.strategies) {
    try {
      const elements = queryStrategy(doc, strategy).filter(isVisible);
      if (elements.length > 0) return elements;
    } catch {
      // 继续尝试下一策略
    }
  }
  return [];
}

function queryStrategy(root: Document | Element, strategy: Strategy): Element[] {
  const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument!;
  const scope = root.nodeType === 9 ? "body *" : "*";
  switch (strategy.type) {
    case "cell":
      return resolveCellStrategy(root, strategy.cell);
    case "testid":
      return Array.from(root.querySelectorAll(`[data-testid=${JSON.stringify(strategy.value)}]`));
    case "role": {
      const wanted = normalizeText(strategy.name ?? "");
      return Array.from(root.querySelectorAll(`[role~=${JSON.stringify(strategy.role)}]`)).filter(
        (element) => {
          if (!wanted) return true;
          const name = normalizeText(accessibleName(element));
          return strategy.exact === false ? name.includes(wanted) : name === wanted;
        },
      );
    }
    case "label": {
      const wanted = normalizeText(strategy.value);
      const controls: Element[] = [];
      for (const label of Array.from(root.querySelectorAll("label"))) {
        const text = normalizeText(label.textContent ?? "");
        const matches = strategy.exact === false ? text.includes(wanted) : text === wanted;
        if (!matches) continue;
        controls.push(...labelControls(label));
      }
      return Array.from(new Set(controls));
    }
    case "placeholder":
      return Array.from(root.querySelectorAll(`[placeholder=${JSON.stringify(strategy.value)}]`));
    case "text": {
      const wanted = normalizeText(strategy.value);
      const matches: Element[] = [];
      for (const element of Array.from(root.querySelectorAll(scope))) {
        const tag = element.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") continue;
        const text = normalizeText(element.textContent ?? "");
        if (strategy.exact === false ? text.includes(wanted) : text === wanted) {
          matches.push(element);
        }
      }
      // 只保留最内层匹配节点，避免 text=保存 同时命中 button 和它的祖先容器
      return matches.filter(
        (element) => !matches.some((other) => other !== element && element.contains(other)),
      );
    }
    case "name":
      return Array.from(root.querySelectorAll(`[name=${JSON.stringify(strategy.value)}]`));
    case "css":
      return Array.from(root.querySelectorAll(strategy.value));
    case "xpath": {
      const result = doc.evaluate(strategy.value, root, null, 7, null);
      const elements: Element[] = [];
      for (let index = 0; index < result.snapshotLength; index += 1) {
        const node = result.snapshotItem(index);
        if (node?.nodeType === 1) elements.push(node as Element);
      }
      return elements;
    }
  }
}

/** for / 嵌套查询命中的元素必须真的能交互：有布局，或是 opacity:0 的下拉搜索框。 */
function usableControl(element: Element | null): Element | null {
  if (!element) return null;
  return hasLayout(element) || isHiddenSelectControl(element) ? element : null;
}

/**
 * 标签对应的控件候选。
 *
 * 1. `for` 指向的元素（必须真的有布局，隐藏值字段 sale_name 会被拒绝）；
 * 2. 标签内部包裹的控件；
 * 3. 标签所属表单项 / 最近容器里的控件。
 *
 * 标签本身可能被 CSS 隐藏（例如只有表单项可见），所以第 3 步不能依赖标签可见性。
 */
function labelControls(label: Element): Element[] {
  const doc = label.ownerDocument;
  const forId = label.getAttribute("for");
  const controls = [
    usableControl(forId ? doc.getElementById(forId) : null),
    usableControl(label.querySelector('input, select, textarea, button, [role="combobox"]')),
  ].filter((element): element is Element => element !== null);
  if (controls.length > 0) return controls;
  const scoped = closestLabelControls(label);
  return scoped.length > 0 ? scoped : [label];
}

/**
 * 标签与控件是兄弟节点时（antd Form.Item），以最近的表单项为锚点找控件。
 * 不再限制向上 4 层：真实表单常有 label 包裹层 / 栅格列，固定层数会提前停住。
 */
function closestLabelControls(label: Element): Element[] {
  const formItem = label.closest(".ant-form-item");
  if (formItem) return controlsWithin(formItem);

  let node = label.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1) {
    const controls = controlsWithin(node);
    if (controls.length > 0) return controls;
    node = node.parentElement;
  }
  return [];
}

/**
 * 容器内的字段控件。按「有布局」而不是「可见」筛：antd 非 showSearch 的
 * 搜索框 opacity:0，isVisible 会拒绝它。
 * 容器里有多个控件时，只有恰好一个下拉类控件才收窄，否则交给后续候选判歧义。
 */
function controlsWithin(root: Element): Element[] {
  const controls = Array.from(
    root.querySelectorAll('input, select, textarea, [role="combobox"]'),
  ).filter((element) => {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (element.tagName === "INPUT" && type === "hidden") return false;
    return hasLayout(element) || isHiddenSelectControl(element);
  });
  if (controls.length <= 1) return controls;
  const triggers = controls.filter(
    (element) =>
      element.matches('select, [role="combobox"]') || matchElement(element)?.zone === "trigger",
  );
  return triggers.length === 1 ? triggers : controls;
}

function safeDocument(host: ReplayHost): Document | undefined {
  try {
    return host.getDocument();
  } catch {
    return undefined;
  }
}

const CELL_EDITOR_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

/** 把「单元格里的控件」目标降级成「单元格本身」，用于点击进入编辑。 */
function cellActivationTarget(target: TargetRef): TargetRef | null {
  const strategies: Strategy[] = [];
  for (const strategy of target.strategies) {
    if (strategy.type !== "cell") continue;
    const control = strategy.cell.control;
    if (!control || control === "self") continue;
    strategies.push({ ...strategy, cell: { ...strategy.cell, control: "self" } });
  }
  if (strategies.length === 0) return null;
  return { ...target, strategies, strict: true };
}

/**
 * 单元格解析：表 → 行（唯一列的值 / 整行文本）→ 列（表头 / 序号）→ 单元格里的控件。
 * 表头重名或找不到时返回 undefined，让下一个候选（列序号）接手，
 * 而不是随便取第一个同名列。
 */
function resolveCellStrategy(root: Document | Element, cell: CellRef): Element[] {
  const tables: HTMLTableElement[] = [];
  if (root.nodeType === 1 && (root as Element).tagName === "TABLE") {
    tables.push(root as HTMLTableElement);
  }
  tables.push(...(Array.from(root.querySelectorAll("table")) as HTMLTableElement[]));
  const scoped = cell.table
    ? tables.filter((table) => table.id === cell.table || table.getAttribute("aria-label") === cell.table)
    : tables;

  const found: Element[] = [];
  for (const table of scoped) {
    const headers = headerIndex(table);
    const keyColumn =
      (cell.keyHeader ? uniqueHeaderColumn(headers, cell.keyHeader) : undefined) ??
      (cell.keyIndex === undefined ? undefined : cell.keyIndex - 1);
    const column =
      (cell.header ? uniqueHeaderColumn(headers, cell.header) : undefined) ??
      (cell.colIndex === undefined ? undefined : cell.colIndex - 1);
    if (column === undefined) continue;

    for (const row of dataRowsOf(table)) {
      if (!rowMatches(row, cell, keyColumn)) continue;
      const target = row.cells[column];
      if (!target) continue;
      const control = controlIn(target, cell.control);
      if (control) found.push(control);
    }
  }
  return found;
}

interface HeaderIndex {
  byIndex: Map<number, string>;
  counts: Map<string, number>;
}

function headerIndex(table: HTMLTableElement): HeaderIndex {
  const byIndex = new Map<number, string>();
  const counts = new Map<string, number>();
  const heads = Array.from(
    table.querySelectorAll('thead th, [role="columnheader"]'),
  ) as HTMLTableCellElement[];
  for (const head of heads) {
    if (!isVisible(head)) continue;
    const text = normalizeText(head.textContent ?? "");
    if (!text) continue;
    byIndex.set(head.cellIndex, text);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return { byIndex, counts };
}

function uniqueHeaderColumn(headers: HeaderIndex, text: string): number | undefined {
  const wanted = normalizeText(text);
  if (headers.counts.get(wanted) !== 1) return undefined;
  for (const [column, value] of headers.byIndex) {
    if (value === wanted) return column;
  }
  return undefined;
}

function dataRowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.rows).filter(
    (row) =>
      !row.closest("thead") &&
      row.cells.length > 0 &&
      row.getAttribute("aria-hidden") !== "true" &&
      row.getBoundingClientRect().height > 0 &&
      isVisible(row),
  );
}

function rowMatches(
  row: HTMLTableRowElement,
  cell: CellRef,
  keyColumn: number | undefined,
): boolean {
  if (cell.rowValue !== undefined) {
    if (keyColumn === undefined) return false;
    return normalizeText(row.cells[keyColumn]?.textContent ?? "") === normalizeText(cell.rowValue);
  }
  if (cell.rowText !== undefined) {
    return normalizeText(row.textContent ?? "") === normalizeText(cell.rowText);
  }
  return false;
}

function controlIn(cell: HTMLTableCellElement, control: CellControl | undefined): Element | null {
  switch (control) {
    case "input":
      return firstVisible(cell, "input");
    case "textarea":
      return firstVisible(cell, "textarea");
    case "select":
      return firstVisible(cell, "select");
    case "contenteditable":
      return firstVisible(cell, '[contenteditable="true"]') ??
        ((cell as HTMLElement).isContentEditable ? cell : null);
    default:
      return cell;
  }
}

function firstVisible(root: Element, selector: string): Element | null {
  return Array.from(root.querySelectorAll(selector)).find(isVisible) ?? null;
}

async function poll(
  timeoutMs: number,
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  } while (true);
  throw new ReplayError(message);
}

function isVisible(element: Element): boolean {
  const win = ownerWindow(element);
  const style = win.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
    return false;
  }
  if (Number(style.opacity) === 0) return false;
  return element.getClientRects().length > 0;
}

/** 有布局即算（opacity:0 的 antd 搜索框也算）；display:none 祖先下的元素没有布局。 */
function hasLayout(element: Element): boolean {
  const style = ownerWindow(element).getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
    return false;
  }
  return element.getClientRects().length > 0;
}

/**
 * 不可见、但隶属于某个自定义下拉的搜索输入。
 * 必须仍有布局（opacity:0 的搜索框）；display:none 祖先下的隐藏控件不能被当成可交互，
 * 否则歧义计数会把抽屉/页签里的同名控件算成可见。
 */
function isHiddenSelectControl(element: Element): boolean {
  if (isVisible(element)) return false;
  if (!/^(input|textarea)$/i.test(element.tagName)) return false;
  if (!hasLayout(element)) return false;
  return matchElement(element)?.zone === "trigger";
}

function isDisabled(element: Element): boolean {
  if ((element as HTMLInputElement).disabled === true) return true;
  return element.getAttribute("aria-disabled") === "true";
}

function accessibleName(element: Element): string {
  const aria = element.getAttribute("aria-label");
  if (aria) return normalizeText(aria);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const doc = element.ownerDocument;
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (normalizeText(text)) return normalizeText(text);
  }
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    const id = element.getAttribute("id");
    if (id) {
      const label = Array.from(element.ownerDocument.querySelectorAll("label")).find(
        (item) => item.getAttribute("for") === id,
      );
      if (label) return normalizeText(label.textContent ?? "");
    }
  }
  return normalizeText(element.textContent ?? "");
}

function ownerWindow(element: Element): Window & typeof globalThis {
  const win = element.ownerDocument.defaultView;
  if (!win) throw new ReplayError("目标元素没有可用 window");
  return win;
}

function targetErrorMessage(
  target: TargetRef,
  attempts: ReplayAttempt[],
  ambiguous: boolean,
): string {
  const label = target.label ?? "未命名目标";
  const detail = attempts
    .map((attempt) => `${attempt.strategy}: 可见 ${attempt.visibleCount}/${attempt.count}`)
    .join("；");
  // 旧录制只存了生成 id；重新挂载后必然 0 命中，直接给出下一步。
  // 若同时存在 label / role / testid 等语义候选，说明已经尝试过自愈，不能再建议重录。
  const generated = target.strategies.some(
    (strategy) => strategy.type === "css" && isGeneratedId(strategy.value.replace(/^#/, "")),
  );
  const hasSemantic = target.strategies.some(
    (strategy) =>
      strategy.type === "label" ||
      strategy.type === "role" ||
      strategy.type === "testid" ||
      strategy.type === "placeholder" ||
      strategy.type === "name" ||
      strategy.type === "text",
  );
  const hint =
    generated && !hasSemantic
      ? "；该录制只保存了 rc_select 生成 id，重新挂载后必然失效，请重新录制该步骤"
      : "";
  // 候选存在但全不可见：目标大概率在未打开的抽屉/弹窗/页签里，和「找不到」是两种处置。
  const hiddenHint = attempts.some((attempt) => attempt.count > 0 && attempt.visibleCount === 0)
    ? "；有候选元素存在但不可见，目标可能在未打开的抽屉/弹窗/页签内"
    : "";
  return `${ambiguous ? "目标存在歧义" : "目标未找到"}: ${label}${detail ? `（${detail}）` : ""}${hint}${hiddenHint}`;
}

function strategyLabel(strategy: Strategy): string {
  switch (strategy.type) {
    case "role":
      return `role=${strategy.role}${strategy.name ? `[name=${strategy.name}]` : ""}`;
    case "testid":
      return `testid=${strategy.value}`;
    case "cell": {
      const { cell } = strategy;
      const row = cell.rowValue ?? cell.rowText ?? "";
      const column = cell.header ?? `第${cell.colIndex ?? "?"}列`;
      return `cell=${row}·${column}`;
    }
    default:
      return `${strategy.type}="${"value" in strategy ? strategy.value : ""}"`;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
