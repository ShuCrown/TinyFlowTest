import type { FlowExtractNode, FlowGraph, OperationRecord } from "../lib/types.ts";

export interface ExtractProducer {
  /** 画布取值节点 id，或记录内取值步骤的 `${macroNodeId}::${dslNodeId}`。 */
  key: string;
  /** 录制/画布节点自身记录的变量名。 */
  recordedName: string;
  /** 应用流程别名后的变量名；流程里应统一使用它。 */
  name: string;
  source: "canvas" | "record";
  recordNodeId?: string;
  dslNodeId?: string;
  recordName?: string;
  enabled: boolean;
}

export function effectiveExtractName(
  graph: FlowGraph | undefined,
  key: string,
  recordedName: string,
): string {
  return graph?.varAliases?.[key]?.trim() || recordedName.trim();
}

/** 旧版单步取值的定位配置是否完整。 */
export function hasManualExtractConfig(node: FlowExtractNode): boolean {
  const source = node.source ?? "dom";
  if (source === "response") return Boolean(node.response?.urlContains?.trim());
  if (source === "js") return Boolean(node.js?.trim());
  if (node.locate === "cell") {
    return Boolean(node.cell?.rowValue || node.cell?.rowText || node.cell?.rowIndex);
  }
  return Boolean(node.selector.trim());
}

/** 取值节点是否已经有可执行的取值（录制、手动行或旧版单步配置）。 */
export function hasExtractSteps(node: FlowExtractNode): boolean {
  if (node.recordedDsl?.nodes.some((item) => item.type === "extract")) return true;
  if ((node.manualVars?.length ?? 0) > 0) return true;
  return hasManualExtractConfig(node);
}

export function listExtractProducers(
  graph: FlowGraph,
  recordMap: Map<string, OperationRecord>,
): ExtractProducer[] {
  const producers: ExtractProducer[] = [];
  for (const node of graph.nodes) {
    if (node.kind === "extract") {
      if (!hasExtractSteps(node)) continue;
      if (node.recordedDsl) {
        for (const dslNode of node.recordedDsl.nodes) {
          if (dslNode.type !== "extract") continue;
          const key = `${node.id}::${dslNode.id}`;
          producers.push({
            key,
            recordedName: dslNode.varName,
            name: effectiveExtractName(graph, key, dslNode.varName),
            source: "canvas",
            dslNodeId: dslNode.id,
            enabled: node.enabled !== false && dslNode.enabled !== false,
          });
        }
      } else if (hasManualExtractConfig(node)) {
        producers.push({
          key: node.id,
          recordedName: node.varName,
          name: effectiveExtractName(graph, node.id, node.varName),
          source: "canvas",
          enabled: node.enabled !== false,
        });
      }
      for (const row of node.manualVars ?? []) {
        const key = `${node.id}::manual::${row.id}`;
        producers.push({
          key,
          recordedName: row.varName,
          name: effectiveExtractName(graph, key, row.varName),
          source: "canvas",
          enabled: node.enabled !== false,
        });
      }
      continue;
    }
    const record = recordMap.get(node.recordId);
    if (!record?.dsl) continue;
    for (const dslNode of record.dsl.nodes) {
      if (dslNode.type !== "extract") continue;
      const key = `${node.id}::${dslNode.id}`;
      producers.push({
        key,
        recordedName: dslNode.varName,
        name: effectiveExtractName(graph, key, dslNode.varName),
        source: "record",
        recordNodeId: node.id,
        dslNodeId: dslNode.id,
        recordName: record.name,
        enabled: node.enabled !== false && dslNode.enabled !== false,
      });
    }
  }
  return producers;
}

/**
 * 流程级改名：只写别名，并同步本流程里引用旧名的注入。
 * 共享的操作记录 DSL 不动，模板引用由 compileFlow 在编译产物上重写。
 */
export function renameExtractVar(
  graph: FlowGraph,
  key: string,
  recordedName: string,
  oldName: string,
  nextName: string,
): FlowGraph {
  const name = nextName.trim();
  if (!name) return graph;
  const base = recordedName.trim();
  const aliases = { ...(graph.varAliases ?? {}) };
  if (name === base) delete aliases[key];
  else aliases[key] = name;
  return {
    ...graph,
    varAliases: aliases,
    injections: renameInjectionSource(graph.injections, oldName, name),
  };
}

/** 手工变量改名，同样同步注入引用。 */
export function renameManualVar(
  graph: FlowGraph,
  index: number,
  nextName: string,
): FlowGraph {
  const current = graph.vars[index];
  const name = nextName.trim();
  if (!current || !name) return graph;
  return {
    ...graph,
    vars: graph.vars.map((item, itemIndex) =>
      itemIndex === index ? { ...item, name } : item,
    ),
    injections: renameInjectionSource(graph.injections, current.name, name),
  };
}

/** 生成画布内不重名的变量名；extracted1 冲突时依次尝试 extracted2、extracted3。 */
export function uniqueVarName(base: string, used: ReadonlySet<string>): string {
  const clean = base.trim() || "extracted";
  if (!used.has(clean)) return clean;
  const match = clean.match(/^(.*?)(\d+)$/);
  const prefix = match?.[1] ?? clean;
  let index = match ? Number(match[2]) + 1 : 2;
  let candidate = `${prefix}${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${prefix}${index}`;
  }
  return candidate;
}

function renameInjectionSource(
  injections: FlowGraph["injections"],
  oldName: string,
  nextName: string,
): FlowGraph["injections"] {
  const from = oldName.trim();
  if (!from || from === nextName) return injections;
  return injections.map((item) =>
    item.source.kind === "var" && item.source.name === from
      ? { ...item, source: { kind: "var" as const, name: nextName } }
      : item,
  );
}
