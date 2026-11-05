import { normalizeDsl } from "../dsl/normalize.ts";
import type {
  FlowDsl,
  FlowEdge as DslEdge,
  FlowNode,
  PickerNode,
  ValueExpr,
} from "../dsl/index.ts";
import type {
  FlowCanvasNode,
  FlowExtractNode,
  FlowGraph,
  FlowInjection,
  FlowItem,
  FlowRecordNode,
  OperationRecord,
} from "../lib/types.ts";

export class FlowCompileError extends Error {
  readonly code = "FLOW_COMPILE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "FlowCompileError";
  }
}

export interface CompiledFlow {
  dsl: FlowDsl;
  /** 按（前缀后的）微节点 id 覆盖的录制值。 */
  values: Record<string, unknown>;
  /** 流程环境变量初始值。 */
  vars: Record<string, unknown>;
  /** 画布节点 id → 展开后的微节点 id。 */
  groups: Record<string, string[]>;
  /** 取值节点产出的变量，供变量面板展示。 */
  extractVars: Array<{ nodeId: string; name: string }>;
  warnings: string[];
}

interface MacroBuild {
  macro: FlowCanvasNode;
  entry: string;
  exits: string[];
  microIds: string[];
  /** 原始微节点 id → 加前缀后的节点。 */
  microNodes: Map<string, FlowNode>;
  internalEdges: DslEdge[];
  systems: FlowDsl["systems"];
  values: Record<string, unknown>;
}

const EDITABLE_INTERACT = new Set(["input", "select", "nativeSelect", "check"]);

function isRecordNode(node: FlowCanvasNode): node is FlowRecordNode {
  return node.kind === "record";
}

function isExtractNode(node: FlowCanvasNode): node is FlowExtractNode {
  return node.kind === "extract";
}

/**
 * 把画布展开成一条可执行 DSL：
 * 操作记录 → 带前缀的微节点；取值节点 → extract 微步骤；注入值改写槽位。
 */
export function compileFlow(flow: FlowItem, records: OperationRecord[]): CompiledFlow {
  const graph = flow.graph;
  if (!graph || graph.nodes.length === 0) {
    throw new FlowCompileError("画布还没有节点，先从左侧添加操作记录或取值节点。");
  }
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const ordered = orderMacroNodes(graph);
  const orderIndex = new Map(ordered.map((node, index) => [node.id, index]));
  const warnings: string[] = [];

  const builds = new Map<string, MacroBuild>();
  const nodes: FlowNode[] = [];
  const edges: DslEdge[] = [];
  const systems = new Map<string, FlowDsl["systems"][number]>();
  let defaults: FlowDsl["defaults"];

  for (const macro of graph.nodes) {
    const build = isRecordNode(macro)
      ? buildRecordNode(macro, recordMap, warnings)
      : buildExtractNode(macro);
    builds.set(macro.id, build);
    nodes.push(...build.microNodes.values());
    for (const system of build.systems) systems.set(system.id, system);
  }

  const firstRecord = graph.nodes.find(isRecordNode);
  const firstRecordDsl = firstRecord ? recordMap.get(firstRecord.recordId)?.dsl : undefined;
  defaults = firstRecordDsl?.defaults;

  // 内部边：记录 DSL 自身的执行顺序，节点 id 加前缀。
  for (const build of builds.values()) {
    edges.push(...build.internalEdges);
  }

  // 画布边：上一个宏节点的出口连到下一个的入口。
  const macroEdges = resolveMacroEdges(graph, ordered, warnings);
  for (const edge of macroEdges) {
    const from = builds.get(edge.from)!;
    const to = builds.get(edge.to)!;
    for (const exit of from.exits) edges.push({ from: exit, to: to.entry });
  }

  const vars = collectManualVars(graph);
  const extractVars = graph.nodes.filter(isExtractNode).map((node) => ({
    nodeId: node.id,
    name: node.varName.trim(),
  }));
  validateVariables(graph, ordered, orderIndex, extractVars, vars);

  applyInjections(graph, builds, warnings);

  const values: Record<string, unknown> = {};
  for (const build of builds.values()) {
    for (const [nodeId, value] of Object.entries(build.values)) {
      if (values[nodeId] === undefined) values[nodeId] = value;
    }
  }

  const groups: Record<string, string[]> = {};
  for (const [macroId, build] of builds) groups[macroId] = [...build.microIds];

  const entry = builds.get(ordered[0]!.id)!.entry;
  const dsl = normalizeDsl({
    dslVersion: "1.0",
    meta: { name: flow.name, description: flow.description },
    systems: [...systems.values()],
    defaults,
    nodes,
    edges,
    entry,
  });

  return {
    dsl,
    values,
    vars,
    groups,
    extractVars,
    warnings,
  };
}

function buildRecordNode(
  macro: FlowRecordNode,
  records: Map<string, OperationRecord>,
  warnings: string[],
): MacroBuild {
  const record = records.get(macro.recordId);
  if (!record) throw new FlowCompileError(`画布节点引用了不存在的操作记录: ${macro.recordId}`);
  const dsl = record.dsl;
  if (!dsl || dsl.nodes.length === 0) {
    throw new FlowCompileError(`操作记录「${record.name}」还没有可执行节点，请先录制并保存。`);
  }

  const prefix = `${macro.id}::`;
  const microNodes = new Map<string, FlowNode>();
  const microIds: string[] = [];
  for (const source of dsl.nodes) {
    const node = structuredClone(source) as FlowNode;
    node.id = prefix + source.id;
    node.meta = { ...node.meta, flowNodeId: macro.id };
    if (macro.enabled === false) node.enabled = false;
    microNodes.set(source.id, node);
    microIds.push(node.id);
  }

  let internalEdges: DslEdge[] = [];
  let entry = prefix + dsl.entry;
  let exits: string[] = [];
  if (dsl.edges.length === 0) {
    // 老记录可能没有边：按节点顺序补一条链，避免只执行第一个节点。
    if (dsl.nodes.length > 1) {
      const chain: DslEdge[] = [];
      for (let index = 0; index < dsl.nodes.length - 1; index += 1) {
        chain.push({ from: dsl.nodes[index]!.id, to: dsl.nodes[index + 1]!.id });
      }
      internalEdges = chain.map((edge) => ({
        ...edge,
        from: prefix + edge.from,
        to: prefix + edge.to,
      }));
      warnings.push(`记录「${record.name}」没有内部边，已按节点顺序串联。`);
    }
    entry = prefix + dsl.nodes[0]!.id;
    exits = [prefix + dsl.nodes[dsl.nodes.length - 1]!.id];
  } else {
    internalEdges = dsl.edges.map((edge) => ({
      ...edge,
      from: prefix + edge.from,
      to: prefix + edge.to,
    }));
    const outSet = new Set(dsl.edges.map((edge) => edge.from));
    exits = dsl.nodes
      .filter((node) => !outSet.has(node.id))
      .map((node) => prefix + node.id);
  }
  if (!microNodes.has(dsl.entry) && dsl.edges.length > 0) {
    entry = prefix + dsl.nodes[0]!.id;
  }
  if (exits.length === 0) {
    throw new FlowCompileError(`操作记录「${record.name}」没有终止节点，无法接到下一个节点。`);
  }

  const values: Record<string, unknown> = {};
  for (const [nodeId, value] of Object.entries(record.values ?? {})) {
    values[prefix + nodeId] = value;
  }

  return {
    macro,
    entry,
    exits,
    microIds,
    microNodes,
    internalEdges,
    systems: dsl.systems,
    values,
  };
}

function buildExtractNode(macro: FlowExtractNode): MacroBuild {
  const varName = macro.varName.trim();
  const selector = macro.selector.trim();
  if (!varName) throw new FlowCompileError(`取值节点 ${macro.id} 缺少变量名。`);
  if (!selector) throw new FlowCompileError(`取值节点「${varName}」缺少目标选择器。`);
  const id = `${macro.id}::extract`;
  const node: FlowNode = {
    id,
    type: "extract",
    name: `取值 ${varName}`,
    target: {
      label: varName,
      strategies: [{ type: "css", value: selector }],
    },
    read: macro.read,
    attribute: macro.attribute?.trim() || undefined,
    pattern: macro.pattern?.trim() || undefined,
    varName,
    enabled: macro.enabled !== false,
    meta: { flowNodeId: macro.id },
  };
  return {
    macro,
    entry: id,
    exits: [id],
    microIds: [id],
    microNodes: new Map([["extract", node]]),
    internalEdges: [],
    systems: [],
    values: {},
  };
}

function resolveMacroEdges(
  graph: FlowGraph,
  ordered: FlowCanvasNode[],
  warnings: string[],
): Array<{ from: string; to: string }> {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const explicit = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  if (explicit.length > 0 && explicit.length < graph.edges.length) {
    warnings.push("画布上有边指向不存在的节点，已忽略。");
  }
  if (explicit.length === 0) {
    if (ordered.length > 1) warnings.push("画布未连线，已按节点添加顺序执行。");
    return ordered.slice(0, -1).map((node, index) => ({
      from: node.id,
      to: ordered[index + 1]!.id,
    }));
  }

  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(ordered.map((node) => [node.id, 0]));
  for (const edge of explicit) {
    const list = out.get(edge.from) ?? [];
    list.push(edge.to);
    out.set(edge.from, list);
    indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  }
  const roots = [...indeg.entries()].filter(([, value]) => value === 0).map(([id]) => id);
  if (roots.length !== 1) {
    throw new FlowCompileError("流程只能有一条串联链：请让画布只有一个起点，且每个节点只有一个上游。");
  }
  for (const [nodeId, list] of out) {
    if (list.length > 1) {
      throw new FlowCompileError("流程暂不支持分支：节点「" + nodeId + "」有多个下游。");
    }
  }
  for (const [nodeId, count] of indeg) {
    if (count > 1) throw new FlowCompileError(`节点「${nodeId}」有多个上游，暂不支持合并。`);
  }
  if (roots.length === 1 && ordered.length > 0 && roots[0] !== ordered[0]!.id) {
    warnings.push("画布起点与节点添加顺序不同，按连线起点执行。");
  }
  return explicit;
}

/** 拓扑排序只用于校验顺序和变量上下游；执行顺序由画布边决定。 */
function orderMacroNodes(graph: FlowGraph): FlowCanvasNode[] {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const indeg = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]));
  const out = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
    const list = out.get(edge.from) ?? [];
    list.push(edge.to);
    out.set(edge.from, list);
  }
  const queue = graph.nodes.filter((node) => (indeg.get(node.id) ?? 0) === 0).map((node) => node.id);
  const ordered: FlowCanvasNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = graph.nodes.find((item) => item.id === id);
    if (node) ordered.push(node);
    for (const next of out.get(id) ?? []) {
      const count = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, count);
      if (count === 0) queue.push(next);
    }
  }
  if (ordered.length !== graph.nodes.length) {
    throw new FlowCompileError("画布存在环，流程不能循环执行。");
  }
  return ordered;
}

function collectManualVars(graph: FlowGraph): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  const names = new Set<string>();
  for (const item of graph.vars) {
    const name = item.name.trim();
    if (!name) throw new FlowCompileError("环境变量名不能为空。");
    if (names.has(name)) throw new FlowCompileError(`环境变量重名: ${name}`);
    names.add(name);
    vars[name] = item.value ?? "";
  }
  return vars;
}

function validateVariables(
  graph: FlowGraph,
  ordered: FlowCanvasNode[],
  orderIndex: Map<string, number>,
  extractVars: Array<{ nodeId: string; name: string }>,
  manualVars: Record<string, unknown>,
): void {
  const producers = new Map<string, number>();
  for (const [name] of Object.entries(manualVars)) producers.set(name, -1);
  for (const item of extractVars) {
    if (!item.name) throw new FlowCompileError("取值节点缺少变量名。");
    if (producers.has(item.name)) {
      throw new FlowCompileError(`环境变量重复产出: ${item.name}`);
    }
    producers.set(item.name, orderIndex.get(item.nodeId) ?? Number.MAX_SAFE_INTEGER);
  }

  for (const node of ordered) {
    if (node.kind !== "record") continue;
    const consumerIndex = orderIndex.get(node.id) ?? 0;
    for (const injection of graph.injections.filter((item) => item.recordNodeId === node.id)) {
      if (injection.source.kind !== "var") continue;
      const name = injection.source.name.trim();
      if (!name) throw new FlowCompileError("注入值引用了空变量名。");
      const producerIndex = producers.get(name);
      if (producerIndex === undefined) {
        throw new FlowCompileError(`变量 ${name} 没有任何节点产出。`);
      }
      if (producerIndex >= consumerIndex) {
        throw new FlowCompileError(`变量 ${name} 在消费节点之后才产出，无法使用。`);
      }
    }
  }
}

function applyInjections(
  graph: FlowGraph,
  builds: Map<string, MacroBuild>,
  warnings: string[],
): void {
  const touched = new Map<string, Set<string>>();
  for (const injection of graph.injections) {
    const build = builds.get(injection.recordNodeId);
    if (!build) throw new FlowCompileError(`注入指向不存在的画布节点: ${injection.recordNodeId}`);
    if (build.macro.kind !== "record") {
      throw new FlowCompileError("取值节点没有可注入的微调槽位。");
    }
    const node = build.microNodes.get(injection.dslNodeId);
    if (!node) {
      throw new FlowCompileError(`注入指向不存在的微节点: ${injection.dslNodeId}`);
    }
    const expr = injectionExpr(injection);
    if (node.type === "interact") {
      if (injection.slot !== "input" || !EDITABLE_INTERACT.has(node.adapter)) {
        throw new FlowCompileError(`交互节点 ${node.id} 没有可注入的输入槽位。`);
      }
      node.value = expr;
    } else if (node.type === "picker") {
      if (injection.slot !== "filter") {
        throw new FlowCompileError(`选择器节点 ${node.id} 只支持筛选槽位。`);
      }
      const index = injection.index ?? -1;
      const step = node.filter?.steps[index];
      if (!step) throw new FlowCompileError(`选择器节点 ${node.id} 的筛选槽位 ${index} 不存在。`);
      const hadRecordedPick =
        (node.pick.values ?? []).length > 0 ||
        node.pick.byText?.value !== undefined ||
        node.pick.byRow?.keyValue !== undefined;
      step.value = expr;
      node.pick = rewritePick(node.pick, expr);
      if (hadRecordedPick) warnings.push("绑定筛选值后已忽略录制选项，改选筛选结果。");
    } else {
      throw new FlowCompileError(`节点 ${node.id} 不支持值注入。`);
    }
    const set = touched.get(injection.recordNodeId) ?? new Set<string>();
    set.add(injection.dslNodeId);
    touched.set(injection.recordNodeId, set);
  }

  // 被注入的节点不再使用操作记录里的微调覆盖，否则运行时会盖掉流程变量。
  for (const [macroId, nodeIds] of touched) {
    const build = builds.get(macroId);
    if (!build) continue;
    const prefix = `${macroId}::`;
    for (const nodeId of nodeIds) delete build.values[prefix + nodeId];
  }
}

function injectionExpr(injection: FlowInjection): ValueExpr {
  return injection.source.kind === "var"
    ? { kind: "var", name: injection.source.name.trim() }
    : { kind: "literal", value: injection.source.value };
}

/** 筛选值改成变量/字面值后，选择项也必须跟着改，不能点录制时的旧项。 */
function rewritePick(pick: PickerNode["pick"], expr: ValueExpr): PickerNode["pick"] {
  if (pick.strategy === "byRow") {
    return {
      ...pick,
      strategy: "byRow",
      byRow: { ...pick.byRow, keyValue: expr },
      values: undefined,
    };
  }
  if (pick.strategy === "byText") {
    return {
      ...pick,
      strategy: "byText",
      byText: { ...pick.byText, value: expr },
      values: undefined,
    };
  }
  const on = pick.byIndex?.on ?? pick.firstVisible?.on ?? "item";
  return {
    ...pick,
    strategy: "firstVisible",
    byIndex: undefined,
    firstVisible: { on },
    values: undefined,
  };
}
