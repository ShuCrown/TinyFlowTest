import type {
  FlowDsl,
  FlowNode,
  PickerFilterStep,
  PickerNode,
  SignalRef,
  TargetRef,
  ValueExpr,
  ValueLike,
  WaitSignal,
} from "./types.ts";

export class DslNormalizeError extends Error {
  readonly code = "DSL_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "DslNormalizeError";
  }
}

export function normalizeValue(input: ValueLike): ValueExpr {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean" ||
    Array.isArray(input)
  ) {
    return { kind: "literal", value: input };
  }
  if (typeof input !== "object") return { kind: "literal", value: input };
  const obj = input as Record<string, unknown>;
  if (typeof obj.kind === "string") return input as ValueExpr;
  return { kind: "literal", value: obj };
}

export function normalizeTarget(input: TargetRef): TargetRef {
  return {
    ...input,
    strategies: input.strategies.map((strategy) => ({ ...strategy })),
    scope: input.scope ? normalizeTarget(input.scope) : undefined,
  };
}

export function normalizeSignal(input: SignalRef): SignalRef {
  if (typeof input === "string") return input;
  return normalizeWait(input);
}

function normalizeWait(signal: WaitSignal): WaitSignal {
  switch (signal.kind) {
    case "visible":
    case "hidden":
    case "attached":
    case "enabled":
    case "count":
    case "text":
      return { ...signal, target: normalizeTarget(signal.target) };
    case "domStable":
      return { ...signal, target: signal.target ? normalizeTarget(signal.target) : undefined };
    case "url":
      return signal;
  }
}

function normalizeSignals(signals: SignalRef[] | undefined): SignalRef[] | undefined {
  return signals?.map(normalizeSignal);
}

function normalizePickerStep(step: PickerFilterStep): PickerFilterStep {
  return {
    ...step,
    target: normalizeTarget(step.target),
    value: step.value === undefined ? undefined : normalizeValue(step.value),
  };
}

function normalizePicker(node: PickerNode): PickerNode {
  return {
    ...node,
    trigger: normalizeTarget(node.trigger),
    panel: {
      ...node.panel,
      scope: {
        ...node.panel.scope,
        target: node.panel.scope.target ? normalizeTarget(node.panel.scope.target) : undefined,
      },
    },
    filter: node.filter ? { steps: node.filter.steps.map(normalizePickerStep) } : undefined,
    pick: {
      ...node.pick,
      byText: node.pick.byText
        ? {
            ...node.pick.byText,
            value:
              node.pick.byText.value === undefined ? undefined : normalizeValue(node.pick.byText.value),
          }
        : undefined,
      byIndex: node.pick.byIndex
        ? {
            indexes: node.pick.byIndex.indexes.map((index) => Number(index)),
            on: node.pick.byIndex.on,
          }
        : undefined,
      firstVisible: node.pick.firstVisible ? { ...node.pick.firstVisible } : undefined,
      byRow: node.pick.byRow
        ? {
            ...node.pick.byRow,
            keyValue:
              node.pick.byRow.keyValue === undefined
                ? undefined
                : normalizeValue(node.pick.byRow.keyValue),
            clickTarget: node.pick.byRow.clickTarget
              ? normalizeTarget(node.pick.byRow.clickTarget)
              : undefined,
          }
        : undefined,
    },
    commit: node.commit ? { ...node.commit, target: normalizeTarget(node.commit.target) } : undefined,
  };
}

function normalizeNode(node: FlowNode): FlowNode {
  const base = {
    ...node,
    pre: normalizeSignals(node.pre),
    expect: normalizeSignals(node.expect),
  };
  switch (base.type) {
    case "navigate":
      return { ...base, readySignal: base.readySignal ? normalizeSignal(base.readySignal) : undefined };
    case "interact":
      return {
        ...base,
        target: normalizeTarget(base.target),
        value: base.value === undefined ? undefined : normalizeValue(base.value),
      };
    case "picker":
      return normalizePicker(base);
    case "wait":
      return { ...base, condition: normalizeSignal(base.condition) };
    case "extract":
      return { ...base, target: normalizeTarget(base.target) };
  }
}

/**
 * 最小校验：节点 id 唯一、边端点存在、entry 指向真实节点。
 * 真实项目里这一步由 zod schema 完成。
 */
export function normalizeDsl(raw: FlowDsl): FlowDsl {
  if (!raw || typeof raw !== "object") throw new DslNormalizeError("流程 DSL 必须是对象");
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new DslNormalizeError("流程 DSL 至少需要一个节点");
  }
  const nodes = raw.nodes.map(normalizeNode);
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new DslNormalizeError("节点 id 重复");
  for (const edge of raw.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new DslNormalizeError(`边 ${edge.from} → ${edge.to} 指向不存在的节点`);
    }
  }
  if (!ids.has(raw.entry)) throw new DslNormalizeError("entry 指向不存在的节点");
  return { ...raw, nodes, edges: raw.edges, entry: raw.entry };
}
