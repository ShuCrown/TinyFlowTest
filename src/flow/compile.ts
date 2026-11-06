import { normalizeDsl } from "../dsl/normalize.ts";
import type {
  DomExtractNode,
  FlowDsl,
  FlowEdge as DslEdge,
  FlowNode,
  JsExtractNode,
  PickerNode,
  ResponseExtractNode,
  SignalRef,
  TargetRef,
  ValueExpr,
  ValueLike,
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
import { effectiveExtractName } from "./vars.ts";

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
  /** 取值节点产出的变量，供变量面板展示；recordNodeId 表示来自操作记录内部的取值步骤。 */
  extractVars: Array<{ nodeId: string; name: string; recordNodeId?: string }>;
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

  const aliases = graph.varAliases ?? {};
  for (const macro of graph.nodes) {
    const build = isRecordNode(macro)
      ? buildRecordNode(macro, recordMap, warnings, aliases)
      : buildExtractNode(
          macro,
          effectiveExtractName(graph, macro.id, macro.varName),
          aliases,
        );
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
  const extractVars: Array<{ nodeId: string; name: string; recordNodeId?: string }> = [];
  for (const node of graph.nodes) {
    if (!isExtractNode(node)) continue;
    if (node.recordedDsl) {
      for (const dslNode of node.recordedDsl.nodes) {
        if (dslNode.type !== "extract" || dslNode.enabled === false) continue;
        const name = effectiveExtractName(
          graph,
          `${node.id}::${dslNode.id}`,
          dslNode.varName,
        );
        if (!name) throw new FlowCompileError(`取值节点 ${node.id} 的记录步骤缺少变量名。`);
        extractVars.push({ nodeId: node.id, name });
      }
      continue;
    }
    extractVars.push({
      nodeId: node.id,
      name: effectiveExtractName(graph, node.id, node.varName),
    });
  }
  // 录制时记在操作记录内部的取值步骤，同样在流程里作为变量产出。
  for (const macro of ordered) {
    if (!isRecordNode(macro) || macro.enabled === false) continue;
    const record = recordMap.get(macro.recordId);
    if (!record?.dsl) continue;
    for (const dslNode of record.dsl.nodes) {
      if (dslNode.type !== "extract" || dslNode.enabled === false) continue;
      const name = effectiveExtractName(
        graph,
        `${macro.id}::${dslNode.id}`,
        dslNode.varName,
      );
      if (!name) {
        throw new FlowCompileError(`记录「${record.name}」的取值节点缺少变量名。`);
      }
      extractVars.push({
        nodeId: `${macro.id}::${dslNode.id}`,
        name,
        recordNodeId: macro.id,
      });
    }
  }
  validateVariables(graph, ordered, orderIndex, extractVars, vars);

  applyInjections(graph, builds, warnings);
  rewriteVarReferences(nodes, collectVarRenames(graph, recordMap, warnings));

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
  aliases: Record<string, string>,
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
    if (node.type === "extract") {
      const alias = aliases[`${macro.id}::${source.id}`]?.trim();
      if (alias) node.varName = alias;
    }
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

function buildExtractNode(
  macro: FlowExtractNode,
  varNameInput: string,
  aliases: Record<string, string>,
): MacroBuild {
  if (macro.recordedDsl && macro.recordedDsl.nodes.length > 0) {
    return buildRecordedExtractNode(macro, macro.recordedDsl, aliases);
  }
  const varName = varNameInput.trim();
  if (!varName) throw new FlowCompileError(`取值节点 ${macro.id} 缺少变量名。`);
  const id = `${macro.id}::extract`;
  const pattern = macro.pattern?.trim() || undefined;
  const enabled = macro.enabled !== false;
  const source = macro.source ?? "dom";

  let node: FlowNode;
  if (source === "response") {
    const urlContains = macro.response?.urlContains?.trim() ?? "";
    if (!urlContains) {
      throw new FlowCompileError(`取值节点「${varName}」缺少接口 URL 匹配。`);
    }
    node = {
      id,
      type: "extract",
      name: `取值 ${varName}`,
      source: "response",
      response: {
        method: macro.response?.method?.trim().toUpperCase() || undefined,
        urlContains,
        bodyContains: macro.response?.bodyContains?.trim() || undefined,
        path: macro.response?.path?.trim() || undefined,
      },
      pattern,
      varName,
      enabled,
      meta: { flowNodeId: macro.id },
    } satisfies ResponseExtractNode;
  } else if (source === "js") {
    const expression = macro.js?.trim() ?? "";
    if (!expression) {
      throw new FlowCompileError(`取值节点「${varName}」缺少 JS 表达式。`);
    }
    node = {
      id,
      type: "extract",
      name: `取值 ${varName}`,
      source: "js",
      js: expression,
      pattern,
      varName,
      enabled,
      meta: { flowNodeId: macro.id },
    } satisfies JsExtractNode;
  } else {
    let target: TargetRef;
    if (macro.locate === "cell") {
      const cell = macro.cell;
      if (!cell) throw new FlowCompileError(`取值节点「${varName}」缺少表格定位信息。`);
      const normalizedCell = Object.fromEntries(
        Object.entries({
          ...cell,
          table: cell.table?.trim(),
          keyHeader: cell.keyHeader?.trim(),
          header: cell.header?.trim(),
          rowValue: cell.rowValue?.trim(),
          rowText: cell.rowText?.trim(),
        }).filter(([, value]) => value !== undefined && value !== ""),
      ) as typeof cell;
      if (
        normalizedCell.rowValue === undefined &&
        normalizedCell.rowText === undefined &&
        normalizedCell.rowIndex === undefined
      ) {
        throw new FlowCompileError(`取值节点「${varName}」缺少行定位值。`);
      }
      if (
        normalizedCell.rowIndex !== undefined &&
        (!Number.isInteger(normalizedCell.rowIndex) || normalizedCell.rowIndex < 1)
      ) {
        throw new FlowCompileError(`取值节点「${varName}」的行序号必须是大于 0 的整数。`);
      }
      if (
        normalizedCell.rowValue !== undefined &&
        normalizedCell.keyHeader === undefined &&
        normalizedCell.keyIndex === undefined
      ) {
        throw new FlowCompileError(
          `取值节点「${varName}」按行值定位时需要填写行值所在列（表头或列序号）。`,
        );
      }
      if (normalizedCell.header === undefined && normalizedCell.colIndex === undefined) {
        throw new FlowCompileError(`取值节点「${varName}」缺少目标列（表头或列序号）。`);
      }
      target = { label: varName, strategies: [{ type: "cell", cell: normalizedCell }] };
    } else {
      const selector = macro.selector.trim();
      if (!selector) {
        throw new FlowCompileError(
          `取值节点「${varName}」还没有录制内容，请先点「录制步骤」。`,
        );
      }
      target = { label: varName, strategies: [{ type: "css", value: selector }] };
    }
    const attribute = macro.attribute?.trim() || undefined;
    if (macro.read === "attribute" && !attribute) {
      throw new FlowCompileError(`取值节点「${varName}」缺少属性名。`);
    }
    node = {
      id,
      type: "extract",
      name: `取值 ${varName}`,
      source: "dom",
      target,
      read: macro.read,
      attribute,
      includeHidden: macro.includeHidden === true,
      pattern,
      varName,
      enabled,
      meta: { flowNodeId: macro.id },
    } satisfies DomExtractNode;
  }

  const microNodes = new Map<string, FlowNode>();
  const microIds: string[] = [];
  const internalEdges: DslEdge[] = [];
  let entry = id;
  const preNodes: FlowNode[] = [];
  const prefix = `${macro.id}::pre::`;
  for (const source of macro.preDsl?.nodes ?? []) {
    // 前置步骤里的取值步骤不进入节点；取值目标由当前节点自己承担。
    if (source.type === "extract") continue;
    const preNode = structuredClone(source) as FlowNode;
    preNode.id = prefix + source.id;
    preNode.meta = { ...preNode.meta, flowNodeId: macro.id };
    if (macro.enabled === false) preNode.enabled = false;
    microNodes.set(preNode.id, preNode);
    microIds.push(preNode.id);
    preNodes.push(preNode);
  }
  for (let index = 0; index < preNodes.length - 1; index += 1) {
    internalEdges.push({ from: preNodes[index]!.id, to: preNodes[index + 1]!.id });
  }
  if (preNodes.length > 0) {
    internalEdges.push({ from: preNodes[preNodes.length - 1]!.id, to: id });
    entry = preNodes[0]!.id;
  }
  microNodes.set(id, node);
  microIds.push(id);

  return {
    macro,
    entry,
    exits: [id],
    microIds,
    microNodes,
    internalEdges,
    systems: macro.preDsl?.systems ?? [],
    values: {},
  };
}

/** 录制型取值节点：整段录制（含多个取值步骤）展开成宏内部微节点。 */
function buildRecordedExtractNode(
  macro: FlowExtractNode,
  dsl: FlowDsl,
  aliases: Record<string, string>,
): MacroBuild {
  const prefix = `${macro.id}::rec::`;
  const microNodes = new Map<string, FlowNode>();
  const microIds: string[] = [];
  for (const source of dsl.nodes) {
    const node = structuredClone(source) as FlowNode;
    node.id = prefix + source.id;
    node.meta = { ...node.meta, flowNodeId: macro.id };
    if (macro.enabled === false) node.enabled = false;
    if (node.type === "extract") {
      const alias = aliases[`${macro.id}::${source.id}`]?.trim();
      if (alias) node.varName = alias;
    }
    microNodes.set(node.id, node);
    microIds.push(node.id);
  }
  const internalEdges =
    dsl.edges.length > 0
      ? dsl.edges.map((edge) => ({
          ...edge,
          from: prefix + edge.from,
          to: prefix + edge.to,
        }))
      : dsl.nodes.slice(0, -1).map((node, index) => ({
          from: prefix + node.id,
          to: prefix + dsl.nodes[index + 1]!.id,
        }));
  const outSet = new Set(dsl.edges.map((edge) => edge.from));
  const exits =
    dsl.edges.length > 0
      ? dsl.nodes.filter((node) => !outSet.has(node.id)).map((node) => prefix + node.id)
      : [prefix + dsl.nodes[dsl.nodes.length - 1]!.id];
  const entry = microNodes.has(prefix + dsl.entry)
    ? prefix + dsl.entry
    : prefix + dsl.nodes[0]!.id;
  return {
    macro,
    entry,
    exits: exits.length > 0 ? exits : [entry],
    microIds,
    microNodes,
    internalEdges,
    systems: dsl.systems,
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
  extractVars: Array<{ nodeId: string; name: string; recordNodeId?: string }>,
  manualVars: Record<string, unknown>,
): void {
  const producers = new Map<string, number>();
  for (const [name] of Object.entries(manualVars)) producers.set(name, -1);
  for (const item of extractVars) {
    if (!item.name) throw new FlowCompileError("取值节点缺少变量名。");
    if (producers.has(item.name)) {
      throw new FlowCompileError(
        `环境变量重复产出: ${item.name}（画布取值与记录内取值只能有一个同名变量，可在流程 ENV 面板改名）`,
      );
    }
    const producerIndex = item.recordNodeId
      ? orderIndex.get(item.recordNodeId)
      : orderIndex.get(item.nodeId);
    if (producerIndex === undefined) {
      throw new FlowCompileError(`变量 ${item.name} 的产出节点不在画布顺序里。`);
    }
    producers.set(item.name, producerIndex);
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

/** 旧变量名 → 流程别名；同一旧名有多个目标时不做模板重写。 */
function collectVarRenames(
  graph: FlowGraph,
  records: Map<string, OperationRecord>,
  warnings: string[],
): Map<string, string> {
  const aliases = graph.varAliases ?? {};
  const bucket = new Map<string, Set<string>>();
  const producerCounts = new Map<string, number>();
  const add = (key: string, recordedName: string): void => {
    const from = recordedName.trim();
    if (!from) return;
    producerCounts.set(from, (producerCounts.get(from) ?? 0) + 1);
    const to = aliases[key]?.trim() ?? "";
    if (!to || from === to) return;
    const targets = bucket.get(from) ?? new Set<string>();
    targets.add(to);
    bucket.set(from, targets);
  };
  for (const node of graph.nodes) {
    if (node.kind === "extract") {
      if (node.recordedDsl) {
        for (const dslNode of node.recordedDsl.nodes) {
          if (dslNode.type === "extract") {
            add(`${node.id}::${dslNode.id}`, dslNode.varName);
          }
        }
      } else {
        add(node.id, node.varName);
      }
      continue;
    }
    const record = records.get(node.recordId);
    for (const dslNode of record?.dsl?.nodes ?? []) {
      if (dslNode.type === "extract") {
        add(`${node.id}::${dslNode.id}`, dslNode.varName);
      }
    }
  }
  const renames = new Map<string, string>();
  for (const [from, targets] of bucket) {
    const unique = targets.size === 1 ? [...targets][0]! : "";
    if (unique && producerCounts.get(from) === 1) renames.set(from, unique);
    else warnings.push(`变量 ${from} 有多个产出或改名目标，模板引用未自动更新，请手工确认。`);
  }
  return renames;
}

/** 别名只在编译产物上生效：把节点里的 {{旧名}} / var 引用统一换成新名。 */
function rewriteVarReferences(nodes: FlowNode[], renames: Map<string, string>): void {
  if (renames.size === 0) return;
  const patterns = [...renames.entries()].map(([from, to]) => ({
    regex: new RegExp(`\\{\\{\\s*${escapeRegExp(from)}\\s*\\}\\}`, "g"),
    to,
  }));
  const rewriteText = (text: string): string => {
    let next = text;
    for (const item of patterns) next = next.replace(item.regex, `{{${item.to}}}`);
    return next;
  };
  const rewriteValue = (value: ValueLike | undefined): ValueLike | undefined => {
    if (typeof value === "string") return rewriteText(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || !("kind" in value)) {
      return value;
    }
    const expr = value as ValueExpr;
    if (expr.kind === "var") {
      const next = renames.get(expr.name);
      return next ? { kind: "var", name: next } : value;
    }
    if (expr.kind === "template") {
      return { kind: "template", template: rewriteText(expr.template) };
    }
    return value;
  };
  const rewriteTarget = (target: TargetRef | undefined): TargetRef | undefined => {
    if (!target) return target;
    let changed = false;
    const strategies = target.strategies.map((strategy) => {
      if (strategy.type !== "cell") return strategy;
      const rowValue =
        strategy.cell.rowValue !== undefined
          ? rewriteText(strategy.cell.rowValue)
          : undefined;
      const rowText =
        strategy.cell.rowText !== undefined ? rewriteText(strategy.cell.rowText) : undefined;
      if (rowValue === strategy.cell.rowValue && rowText === strategy.cell.rowText) {
        return strategy;
      }
      changed = true;
      return { ...strategy, cell: { ...strategy.cell, rowValue, rowText } };
    });
    const scope = rewriteTarget(target.scope);
    if (scope !== target.scope) changed = true;
    return changed ? { ...target, strategies, scope } : target;
  };
  const rewriteSignal = (signal: SignalRef): SignalRef => {
    if (typeof signal === "string") return signal;
    switch (signal.kind) {
      case "visible":
      case "hidden":
      case "attached":
      case "enabled":
        return { ...signal, target: rewriteTarget(signal.target)! };
      case "count":
        return { ...signal, target: rewriteTarget(signal.target)! };
      case "text":
        return {
          ...signal,
          target: rewriteTarget(signal.target)!,
          equals: rewriteValue(signal.equals),
        };
      case "domStable":
        return { ...signal, target: rewriteTarget(signal.target) };
      case "url":
        return signal;
    }
  };
  const rewriteSignals = (signals: SignalRef[] | undefined): SignalRef[] | undefined =>
    signals?.map(rewriteSignal);

  for (const node of nodes) {
    node.pre = rewriteSignals(node.pre);
    node.expect = rewriteSignals(node.expect);
    switch (node.type) {
      case "navigate":
        node.readySignal = node.readySignal ? rewriteSignal(node.readySignal) : undefined;
        break;
      case "interact":
        node.target = rewriteTarget(node.target)!;
        node.value = rewriteValue(node.value);
        break;
      case "picker":
        node.trigger = rewriteTarget(node.trigger)!;
        if (node.panel.scope.target) {
          node.panel.scope.target = rewriteTarget(node.panel.scope.target);
        }
        if (node.filter) {
          node.filter.steps = node.filter.steps.map((step) => ({
            ...step,
            target: rewriteTarget(step.target)!,
            value: rewriteValue(step.value),
          }));
        }
        if (node.pick.byText) {
          node.pick.byText.value = rewriteValue(node.pick.byText.value);
        }
        if (node.pick.byRow) {
          node.pick.byRow.keyValue = rewriteValue(node.pick.byRow.keyValue);
          if (node.pick.byRow.clickTarget) {
            node.pick.byRow.clickTarget = rewriteTarget(node.pick.byRow.clickTarget);
          }
        }
        if (node.commit) node.commit.target = rewriteTarget(node.commit.target)!;
        break;
      case "wait":
        node.condition = rewriteSignal(node.condition);
        break;
      case "extract":
        if (node.source === "response") {
          node.response = {
            ...node.response,
            urlContains: rewriteText(node.response.urlContains),
            bodyContains:
              node.response.bodyContains !== undefined
                ? rewriteText(node.response.bodyContains)
                : undefined,
          };
        } else if (node.source !== "js") {
          node.target = rewriteTarget(node.target)!;
        }
        break;
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
