import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  Ban,
  Mic,
  Play,
  Plus,
  Power,
  Save,
  Trash2,
  TriangleAlert,
  Variable,
  Workflow,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FlowRunDialog } from "@/components/FlowRunDialog";
import { ExtractRecorderDialog } from "@/components/ExtractRecorderDialog";
import { RecordReplayDialog } from "@/components/RecordReplayDialog";
import {
  describeExtractNode,
  type ExtractRecordingApplied,
} from "@/flow/extract-recording.ts";
import { cn } from "@/lib/utils";
import { getFlow, listRecords, listSystems, newId, saveFlow } from "@/lib/store";
import type {
  FlowCanvasNode,
  FlowExtractNode,
  FlowGraph,
  FlowInjection,
  FlowItem,
  FlowRecordNode,
  OperationRecord,
} from "@/lib/types";
import type { ExtractNode, FlowNode } from "@/dsl/index.ts";
import { compileFlow, FlowCompileError } from "@/flow/compile.ts";
import { listRecordSlots, type RecordSlot } from "@/flow/slots.ts";
import {
  effectiveExtractName,
  hasExtractSteps,
  hasManualExtractConfig,
  listExtractProducers,
  renameExtractVar,
  renameManualVar,
  uniqueVarName,
} from "@/flow/vars.ts";

const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [], injections: [], vars: [] };
const RECORD_COLOR = "#c14b2a";
const EXTRACT_COLOR = "#2d6a4f";

type SlotsMode = "recorded" | "literal" | "var";

interface FlowNodeData {
  node: FlowCanvasNode;
  title: string;
  summary: string;
  footer: string;
  entry: boolean;
  missing: boolean;
  disabled: boolean;
  [key: string]: unknown;
}

type FlowRfNode = Node<FlowNodeData, "flowNode">;

const FLOW_NODE_TYPES = { flowNode: FlowNodeCard };

function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const { deleteElements } = useReactFlow();
  const show = (): void => {
    window.clearTimeout(hideTimer.current);
    setHovered(true);
  };
  const hide = (): void => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHovered(false), 180);
  };
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const visible = hovered || selected;

  return (
    <>
      <g onMouseEnter={show} onMouseLeave={hide}>
        <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      </g>
      <EdgeLabelRenderer>
        <button
          type="button"
          className={cn(
            "nodrag nopan absolute grid size-5 place-items-center rounded-full border border-line bg-white text-muted shadow-sm transition-opacity hover:border-danger/40 hover:text-danger",
            visible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: visible ? "all" : "none",
          }}
          title="删除连线"
          aria-label="删除连线"
          onMouseEnter={show}
          onMouseLeave={hide}
          onClick={(event) => {
            event.stopPropagation();
            void deleteElements({ edges: [{ id }] });
          }}
        >
          <X className="size-3" />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const FLOW_EDGE_TYPES = { flowEdge: DeletableEdge };

function extractSummary(node: FlowExtractNode): string {
  const recordedCount = recordedExtractNodes(node).length;
  const manualCount = node.manualVars?.length ?? 0;
  if (node.recordedDsl && node.recordedDsl.nodes.length > 0) {
    return `${node.recordedDsl.nodes.length} 步骤 · ${recordedCount + manualCount} 个取值${
      manualCount > 0 ? `（${manualCount} 手动）` : ""
    }`;
  }
  if (manualCount > 0 && !hasManualExtractConfig(node)) {
    return `${manualCount} 个手动取值`;
  }
  if (!hasExtractSteps(node)) return "未录制";
  const source = node.source ?? "dom";
  let summary: string;
  if (source === "response") {
    summary = `接口 · ${node.response?.urlContains || "未设置 URL"}`;
  } else if (source === "js") {
    summary = `JS · ${node.js?.trim() || "未设置表达式"}`;
  } else if ((node.locate ?? "css") === "cell") {
    const cell = node.cell;
    const row = cell?.rowValue || cell?.rowText || "未设置行";
    const column = cell?.header || (cell?.colIndex ? `第${cell.colIndex}列` : "未设置列");
    summary = `表格 · ${row} / ${column}`;
  } else {
    summary = `${node.read} · ${node.selector || "未设置选择器"}`;
  }
  const preSteps = node.preDsl?.nodes.length ?? 0;
  const preSuffix = preSteps > 0 ? ` · ${preSteps} 前置步骤` : "";
  const manualSuffix = manualCount > 0 ? ` · ${manualCount} 个手动取值` : "";
  return `${summary}${preSuffix}${manualSuffix}`;
}

function injectionKey(
  recordNodeId: string,
  slot: Pick<RecordSlot, "dslNodeId" | "slot" | "index">,
): string {
  return `${recordNodeId}|${slot.dslNodeId}|${slot.slot}|${slot.index ?? ""}`;
}

function findInjection(
  graph: FlowGraph,
  recordNodeId: string,
  slot: RecordSlot,
): FlowInjection | undefined {
  const key = injectionKey(recordNodeId, slot);
  return graph.injections.find(
    (item) =>
      injectionKey(item.recordNodeId, {
        dslNodeId: item.dslNodeId,
        slot: item.slot,
        index: item.index,
      }) === key,
  );
}

function upsertInjection(
  graph: FlowGraph,
  recordNodeId: string,
  slot: RecordSlot,
  source: FlowInjection["source"] | undefined,
): FlowGraph {
  const next = graph.injections.filter(
    (item) =>
      !(
        item.recordNodeId === recordNodeId &&
        item.dslNodeId === slot.dslNodeId &&
        item.slot === slot.slot &&
        item.index === slot.index
      ),
  );
  if (!source) return { ...graph, injections: next };
  next.push({
    id: newId("inj"),
    recordNodeId,
    dslNodeId: slot.dslNodeId,
    slot: slot.slot,
    index: slot.index,
    source,
  });
  return { ...graph, injections: next };
}

function extractVars(graph: FlowGraph): string[] {
  const names: string[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "extract") continue;
    if (!hasExtractSteps(node)) continue;
    if (node.recordedDsl) {
      for (const dslNode of node.recordedDsl.nodes) {
        if (dslNode.type !== "extract") continue;
        const name = effectiveExtractName(
          graph,
          `${node.id}::${dslNode.id}`,
          dslNode.varName,
        );
        if (name) names.push(name);
      }
    } else if (hasManualExtractConfig(node)) {
      const name = effectiveExtractName(graph, node.id, node.varName);
      if (name) names.push(name);
    }
    for (const row of node.manualVars ?? []) {
      const name = effectiveExtractName(
        graph,
        `${node.id}::manual::${row.id}`,
        row.varName,
      );
      if (name) names.push(name);
    }
  }
  return names;
}

function recordedExtractNodes(node: FlowExtractNode): ExtractNode[] {
  return (
    node.recordedDsl?.nodes.filter(
      (item): item is ExtractNode => item.type === "extract",
    ) ?? []
  );
}

function primaryExtractName(graph: FlowGraph, node: FlowExtractNode): string {
  const first = recordedExtractNodes(node)[0];
  if (first) {
    return effectiveExtractName(graph, `${node.id}::${first.id}`, first.varName);
  }
  const manual = node.manualVars?.[0];
  if (manual) {
    return effectiveExtractName(
      graph,
      `${node.id}::manual::${manual.id}`,
      manual.varName,
    );
  }
  return effectiveExtractName(graph, node.id, node.varName);
}

/** 录制时记在操作记录内部的取值步骤产出的变量。 */
function recordExtractVars(
  graph: FlowGraph,
  recordMap: Map<string, OperationRecord>,
): string[] {
  const names: string[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "record" || node.enabled === false) continue;
    const record = recordMap.get(node.recordId);
    for (const dslNode of record?.dsl?.nodes ?? []) {
      if (dslNode.type !== "extract" || dslNode.enabled === false) continue;
      const name = effectiveExtractName(
        graph,
        `${node.id}::${dslNode.id}`,
        dslNode.varName,
      );
      if (name) names.push(name);
    }
  }
  return names;
}

function entryNodeId(graph: FlowGraph): string | undefined {
  if (graph.nodes.length === 0) return undefined;
  if (graph.edges.length === 0) return graph.nodes[0]?.id;
  const targets = new Set(graph.edges.map((edge) => edge.to));
  return graph.nodes.find((node) => !targets.has(node.id))?.id;
}

export function FlowCanvasPage() {
  const { flowId } = useParams<{ flowId: string }>();
  const navigate = useNavigate();
  const [flow, setFlow] = useState<FlowItem | undefined>(() => (flowId ? getFlow(flowId) : undefined));
  const [graph, setGraph] = useState<FlowGraph>(() => flow?.graph ?? EMPTY_GRAPH);
  const [records] = useState<OperationRecord[]>(() => listRecords());
  const [systems] = useState(() => listSystems());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [recordingNodeId, setRecordingNodeId] = useState<string | null>(null);
  const [replayRecordId, setReplayRecordId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("");
  const instanceRef = useRef<ReactFlowInstance<FlowRfNode, Edge> | null>(null);

  const recordMap = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const systemNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const system of systems) map.set(system.id, system.name);
    return map;
  }, [systems]);

  const currentFlow = useMemo<FlowItem | undefined>(
    () => (flow ? { ...flow, graph } : undefined),
    [flow, graph],
  );

  const compiled = useMemo(() => {
    if (!currentFlow) return { value: null, error: "流程不存在。" as string | null };
    try {
      return { value: compileFlow(currentFlow, records), error: null as string | null };
    } catch (error) {
      return {
        value: null,
        error: error instanceof FlowCompileError ? error.message : String(error),
      };
    }
  }, [currentFlow, records]);

  const selected = graph.nodes.find((node) => node.id === selectedId);
  const recordingNode = recordingNodeId
    ? graph.nodes.find(
        (node): node is FlowExtractNode =>
          node.id === recordingNodeId && node.kind === "extract",
      )
    : undefined;
  const replayRecord = replayRecordId ? recordMap.get(replayRecordId) : undefined;
  const availableVars = useMemo(() => {
    const names = new Set<string>();
    for (const name of extractVars(graph)) names.add(name);
    for (const name of recordExtractVars(graph, recordMap)) names.add(name);
    for (const item of graph.vars) {
      const name = item.name.trim();
      if (name) names.add(name);
    }
    return [...names];
  }, [graph, recordMap]);

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    const add = (name: string): void => {
      const clean = name.trim();
      if (!clean) return;
      counts.set(clean, (counts.get(clean) ?? 0) + 1);
    };
    for (const name of extractVars(graph)) add(name);
    for (const name of recordExtractVars(graph, recordMap)) add(name);
    for (const item of graph.vars) add(item.name);
    return new Set(
      [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
    );
  }, [graph, recordMap]);

  const entryId = useMemo(() => entryNodeId(graph), [graph]);

  const rfNodes = useMemo<FlowRfNode[]>(
    () =>
      graph.nodes.map((node) => {
        const record = node.kind === "record" ? recordMap.get(node.recordId) : undefined;
        const extractCount =
          node.kind === "record"
            ? (record?.dsl?.nodes.filter(
                (item) => item.type === "extract" && item.varName.trim(),
              ).length ?? 0)
            : 0;
        const extractName =
          node.kind === "extract" ? primaryExtractName(graph, node) : "";
        const recordedCount =
          node.kind === "extract"
            ? recordedExtractNodes(node).length + (node.manualVars?.length ?? 0)
            : 0;
        const title =
          node.kind === "record"
            ? record?.name ?? "记录已删除"
            : recordedCount > 1
              ? `取值 ${extractName || "未命名"} 等 ${recordedCount} 项`
              : `取值 ${extractName || "未命名"}`;
        const summary =
          node.kind === "record"
            ? record
              ? `${record.nodes} 节点 · ${record.status === "ready" ? "可运行" : "草稿"}${
                  extractCount > 0 ? ` · ${extractCount} 取值` : ""
                }`
              : "记录不存在"
            : extractSummary(node);
        const footer =
          node.kind === "record"
            ? record?.systemId
              ? systemNames.get(record.systemId) ?? "系统已删除"
              : "未绑定系统"
            : !hasExtractSteps(node)
              ? "ENV · 未录制"
              : `ENV · ${extractName || "未命名变量"}${recordedCount > 1 ? ` +${recordedCount - 1}` : ""}`;
        return {
          id: node.id,
          type: "flowNode",
          position: { x: node.x, y: node.y },
          selected: node.id === selectedId,
          data: {
            node,
            title,
            summary,
            footer,
            entry: entryId === node.id,
            missing: node.kind === "record" && !record,
            disabled: node.enabled === false,
          },
        } satisfies FlowRfNode;
      }),
    [graph.nodes, graph.varAliases, recordMap, systemNames, entryId, selectedId],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: "flowEdge",
        markerEnd: { type: MarkerType.ArrowClosed, color: "#b34a2b", width: 17, height: 17 },
        style: { stroke: "rgba(193,75,42,0.55)", strokeWidth: 1.5 },
      })),
    [graph.edges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowRfNode>(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(rfEdges);

  useEffect(() => {
    setNodes(rfNodes);
  }, [rfNodes, setNodes]);
  useEffect(() => {
    setEdges(rfEdges);
  }, [rfEdges, setEdges]);

  const nodeCount = graph.nodes.length;
  useEffect(() => {
    if (!instanceRef.current) return;
    const timer = setTimeout(() => {
      void instanceRef.current?.fitView({ padding: 0.24, minZoom: 0.45, maxZoom: 0.95 });
    }, 180);
    return () => clearTimeout(timer);
  }, [nodeCount]);

  if (!flow) {
    return (
      <div className="mt-8 rounded-2xl border border-line bg-panel px-6 py-12 text-center">
        <h1 className="text-[16px] font-semibold">流程不存在</h1>
        <p className="mt-1 text-[12.5px] text-muted">可能已被删除，返回流程列表重新选择。</p>
        <Button className="mt-5" onClick={() => navigate("/flows")}>
          <ArrowLeft />
          返回流程列表
        </Button>
      </div>
    );
  }

  const patchNode = (id: string, patch: Partial<FlowExtractNode> | Partial<FlowRecordNode>): void => {
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === id ? ({ ...node, ...patch } as FlowCanvasNode) : node,
      ),
    }));
  };

  const renameNodeVar = (
    key: string,
    recordedName: string,
    oldName: string,
    nextName: string,
  ): void => {
    setGraph((current) => renameExtractVar(current, key, recordedName, oldName, nextName));
  };

  const applyExtractRecording = (result: ExtractRecordingApplied): void => {
    if (!recordingNodeId) return;
    const nodeId = recordingNodeId;
    const used = new Set<string>();
    for (const producer of listExtractProducers(graph, recordMap)) {
      if (producer.key === nodeId || producer.key.startsWith(`${nodeId}::`)) continue;
      if (producer.name) used.add(producer.name);
    }
    for (const item of graph.vars) {
      const name = item.name.trim();
      if (name) used.add(name);
    }
    const renamed = result.extracts.map((item) => {
      const name = uniqueVarName(item.varName, used);
      used.add(name);
      return { ...item, name };
    });
    const aliasesForNode = new Map<string, string>();
    for (const [index, item] of result.extracts.entries()) {
      const name = renamed[index]!.name;
      if (name !== item.varName.trim()) aliasesForNode.set(item.id, name);
    }
    setGraph((current) => {
      const aliases = { ...(current.varAliases ?? {}) };
      for (const key of Object.keys(aliases)) {
        if (key === nodeId || key.startsWith(`${nodeId}::`)) delete aliases[key];
      }
      for (const [id, name] of aliasesForNode) {
        aliases[`${nodeId}::${id}`] = name;
      }
      return {
        ...current,
        varAliases: aliases,
        nodes: current.nodes.map((node) =>
          node.id === nodeId && node.kind === "extract"
            ? {
                ...node,
                varName: renamed[0]?.name ?? node.varName,
                source: "dom" as const,
                recordedDsl: result.recordedDsl,
                preDsl: undefined,
                systemId: result.systemId,
                response: undefined,
                js: undefined,
              }
            : node,
        ),
      };
    });
    setStatusText(
      `已应用录制：${result.extracts.length} 个取值、${result.preStepCount} 个操作步骤。`,
    );
    setRecorderOpen(false);
    setRecordingNodeId(null);
  };

  const clearExtractRecording = (nodeId: string): void => {
    setGraph((current) => {
      const aliases = { ...(current.varAliases ?? {}) };
      for (const key of Object.keys(aliases)) {
        if (key.startsWith(`${nodeId}::manual::`)) continue;
        if (key === nodeId || key.startsWith(`${nodeId}::`)) delete aliases[key];
      }
      return {
        ...current,
        varAliases: aliases,
        nodes: current.nodes.map((node) =>
          node.id === nodeId && node.kind === "extract"
            ? { ...node, recordedDsl: undefined, preDsl: undefined }
            : node,
        ),
      };
    });
  };

  const addManualRow = (nodeId: string): void => {
    setGraph((current) => {
      const used = new Set<string>();
      for (const producer of listExtractProducers(current, recordMap)) {
        if (producer.name) used.add(producer.name);
      }
      for (const item of current.vars) {
        const name = item.name.trim();
        if (name) used.add(name);
      }
      const row = {
        id: newId("mv"),
        varName: uniqueVarName("manual1", used),
        value: "",
      };
      return {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === nodeId && node.kind === "extract"
            ? { ...node, manualVars: [...(node.manualVars ?? []), row] }
            : node,
        ),
      };
    });
  };

  const patchManualRow = (
    nodeId: string,
    rowId: string,
    patch: Partial<{ varName: string; value: string }>,
  ): void => {
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId && node.kind === "extract"
          ? {
              ...node,
              manualVars: (node.manualVars ?? []).map((row) =>
                row.id === rowId ? { ...row, ...patch } : row,
              ),
            }
          : node,
      ),
    }));
  };

  const removeManualRow = (nodeId: string, rowId: string): void => {
    setGraph((current) => {
      const aliases = { ...(current.varAliases ?? {}) };
      delete aliases[`${nodeId}::manual::${rowId}`];
      return {
        ...current,
        varAliases: aliases,
        nodes: current.nodes.map((node) =>
          node.id === nodeId && node.kind === "extract"
            ? {
                ...node,
                manualVars: (node.manualVars ?? []).filter((row) => row.id !== rowId),
              }
            : node,
        ),
      };
    });
  };

  const nextPosition = (): { x: number; y: number } => {
    const index = graph.nodes.length;
    return {
      x: 80 + (index % 4) * 300,
      y: 80 + Math.floor(index / 4) * 180,
    };
  };

  const addNode = (node: FlowCanvasNode): void => {
    const last = graph.nodes[graph.nodes.length - 1];
    setGraph((current) => {
      const edgesWithoutLast = current.edges.filter(
        (edge) => edge.from !== last?.id && edge.to !== node.id,
      );
      return {
        ...current,
        nodes: [...current.nodes, node],
        edges: last ? [...edgesWithoutLast, { from: last.id, to: node.id }] : edgesWithoutLast,
      };
    });
    setSelectedId(node.id);
    setAddOpen(false);
    setStatusText("");
  };

  const addRecordNode = (recordId: string): void => {
    addNode({
      id: newId("fn"),
      kind: "record",
      recordId,
      ...nextPosition(),
    });
  };

  const addExtractNode = (): void => {
    const used = new Set(availableVars);
    let index = 1;
    while (used.has(`code${index}`)) index += 1;
    addNode({
      id: newId("fn"),
      kind: "extract",
      varName: `code${index}`,
      read: "text",
      selector: "",
      ...nextPosition(),
    });
  };

  const removeNode = (id: string): void => {
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== id),
      edges: current.edges.filter((edge) => edge.from !== id && edge.to !== id),
      injections: current.injections.filter((item) => item.recordNodeId !== id),
    }));
    setSelectedId(null);
  };

  const connectNodes = (connection: Connection): void => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    setGraph((current) => ({
      ...current,
      edges: [
        ...current.edges.filter(
          (edge) => edge.from !== connection.source && edge.to !== connection.target,
        ),
        { from: connection.source, to: connection.target },
      ],
    }));
  };

  const setSlotSource = (
    recordNodeId: string,
    slot: RecordSlot,
    mode: SlotsMode,
    value?: string,
  ): void => {
    const injection = findInjection(graph, recordNodeId, slot);
    let source: FlowInjection["source"] | undefined;
    if (mode === "literal") {
      source = {
        kind: "literal",
        value:
          value ??
          (injection?.source.kind === "literal"
            ? injection.source.value
            : slot.recordedValue),
      };
    } else if (mode === "var") {
      source = {
        kind: "var",
        name:
          value ??
          (injection?.source.kind === "var"
            ? injection.source.name
            : (availableVars[0] ?? "")),
      };
    }
    setGraph((current) => upsertInjection(current, recordNodeId, slot, source));
  };

  const save = (): void => {
    if (!currentFlow) return;
    const next: FlowItem = {
      ...currentFlow,
      recordCount: graph.nodes.filter((node) => node.kind === "record").length,
      status: compiled.error ? "draft" : "ready",
      updatedAt: new Date().toISOString(),
    };
    saveFlow(next);
    setFlow(next);
    setStatusText(compiled.error ? `已保存草稿：${compiled.error}` : "画布已保存。");
  };

  return (
    <div className="flex flex-col pb-4 xl:h-[calc(100vh-32px)] xl:overflow-hidden xl:pb-0">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => navigate("/flows")}>
            <ArrowLeft />
            返回流程列表
          </Button>
          <div className="min-w-0">
            <span className="tf-kicker">FLW / CANVAS</span>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <h1 className="tf-display truncate text-[22px] leading-tight">{flow.name}</h1>
              {compiled.error ? <Badge variant="amber">草稿</Badge> : <Badge variant="moss">可运行</Badge>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statusText ? (
            <span className={cn("text-[11px]", compiled.error ? "text-danger" : "text-moss")}>
              {statusText}
            </span>
          ) : null}
          <Button size="sm" variant="outline" onClick={save}>
            <Save />
            保存画布
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={() => setRunOpen(true)}
            disabled={Boolean(compiled.error) || graph.nodes.length === 0}
            title={compiled.error ?? (graph.nodes.length === 0 ? "先添加节点" : undefined)}
          >
            <Play />
            运行流程
          </Button>
        </div>
      </header>

      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative">
          <Button size="sm" variant="default" onClick={() => setAddOpen((value) => !value)}>
            <Plus />
            添加节点
          </Button>
          {addOpen ? (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setAddOpen(false)} />
              <div className="absolute left-0 top-full z-30 mt-1 w-[280px] rounded-xl border border-line bg-panel p-1.5 shadow-[0_18px_50px_rgba(27,28,29,0.18)]">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-accent-soft/40"
                  onClick={addExtractNode}
                >
                  <Variable className="size-3.5 text-moss" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium">取值节点</span>
                    <span className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
                      CODE · 写入环境变量
                    </span>
                  </span>
                </button>
                <div className="mt-1 border-t border-line px-2.5 pb-1 pt-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted">
                    <Workflow className="size-3" />
                    操作记录
                  </div>
                </div>
                <div className="grid max-h-[300px] gap-0.5 overflow-y-auto">
                  {records.length === 0 ? (
                    <p className="px-2.5 py-3 text-[11px] leading-4 text-muted">
                      还没有操作记录，先到
                      <Link className="mx-1 text-accent underline underline-offset-2" to="/records">
                        操作记录
                      </Link>
                      录制一条。
                    </p>
                  ) : (
                    records.map((record) => (
                      <button
                        key={record.id}
                        type="button"
                        disabled={!record.dsl}
                        className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent-soft/40 disabled:cursor-not-allowed disabled:opacity-45"
                        onClick={() => addRecordNode(record.id)}
                        title={record.dsl ? "添加到画布" : "这条记录还没有可执行节点"}
                      >
                        <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-accent" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium">{record.name}</span>
                          <span className="mt-0.5 block truncate font-mono text-[9px] text-muted">
                            {record.nodes} 节点 ·{" "}
                            {record.systemId
                              ? systemNames.get(record.systemId) ?? "系统已删除"
                              : "未绑定系统"}
                          </span>
                        </span>
                        <Badge variant={record.status === "ready" ? "moss" : "amber"}>
                          {record.status === "ready" ? "可运行" : "草稿"}
                        </Badge>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>

        <span className="h-5 w-px bg-line" />
        <Badge variant="secondary">{graph.nodes.length} 节点</Badge>
        <Badge variant="secondary">{graph.nodes.filter((node) => node.kind === "record").length} 记录</Badge>
        <Badge variant="moss">{availableVars.length} 环境变量</Badge>
        {compiled.value ? (
          <Badge variant="moss">编译通过</Badge>
        ) : (
          <Badge variant="amber">待修正</Badge>
        )}
        <span className="ml-auto hidden font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted lg:inline">
          选中节点后按 Delete 删除；连线悬停或选中后点 × 删除
        </span>
      </div>

      <div className="mt-3 grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex min-h-0 flex-col gap-2">
          <div className="tf-flow relative h-[68vh] min-h-[520px] overflow-hidden rounded-xl border border-line bg-paper xl:h-auto xl:flex-1">
            <ReactFlow<FlowRfNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={FLOW_NODE_TYPES}
              edgeTypes={FLOW_EDGE_TYPES}
              onInit={(instance) => {
                instanceRef.current = instance;
                setTimeout(() => {
                  void instance.fitView({ padding: 0.24, minZoom: 0.45, maxZoom: 0.95 });
                }, 120);
              }}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={connectNodes}
              isValidConnection={(connection) =>
                Boolean(
                  connection.source &&
                    connection.target &&
                    connection.source !== connection.target,
                )
              }
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              onNodeDragStop={(_, node) => {
                setGraph((current) => ({
                  ...current,
                  nodes: current.nodes.map((item) =>
                    item.id === node.id
                      ? { ...item, x: node.position.x, y: node.position.y }
                      : item,
                  ),
                }));
              }}
              onNodesDelete={(deleted) => {
                const ids = new Set(deleted.map((node) => node.id));
                setGraph((current) => ({
                  ...current,
                  nodes: current.nodes.filter((node) => !ids.has(node.id)),
                  edges: current.edges.filter(
                    (edge) => !ids.has(edge.from) && !ids.has(edge.to),
                  ),
                  injections: current.injections.filter(
                    (item) => !ids.has(item.recordNodeId),
                  ),
                }));
                setSelectedId((current) => (current && ids.has(current) ? null : current));
              }}
              onEdgesDelete={(deleted) => {
                setGraph((current) => ({
                  ...current,
                  edges: current.edges.filter(
                    (edge) =>
                      !deleted.some(
                        (item) => item.source === edge.from && item.target === edge.to,
                      ),
                  ),
                }));
              }}
              fitView
              fitViewOptions={{ padding: 0.24, minZoom: 0.45, maxZoom: 0.95 }}
              minZoom={0.3}
              maxZoom={1.8}
              defaultEdgeOptions={{ type: "smoothstep" }}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#c8c2b5" />
              <Controls position="bottom-left" showInteractive={false} />
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                style={{ width: 140, height: 100 }}
                nodeColor={(node) => {
                  const data = node.data as FlowNodeData | undefined;
                  return data?.node.kind === "extract" ? EXTRACT_COLOR : RECORD_COLOR;
                }}
                maskColor="rgba(242,240,233,0.72)"
              />
              {graph.nodes.length === 0 ? (
                <div className="pointer-events-none absolute inset-0 grid place-items-center px-8 text-center">
                  <div className="max-w-[420px]">
                    <div className="mx-auto grid size-12 place-items-center rounded-xl border border-line bg-white text-accent">
                      <Workflow className="size-5" />
                    </div>
                    <h2 className="mt-3 text-[15px] font-semibold">画布还是空的</h2>
                    <p className="mt-1 text-[12px] leading-5 text-muted">
                      从左上角「添加节点」放入操作记录；中间插入取值节点，把上一步保存后的主键
                      code 变成环境变量，再注入下一条记录的筛选值。
                    </p>
                  </div>
                </div>
              ) : null}
            </ReactFlow>
          </div>

          <div
            className={cn(
              "flex shrink-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px]",
              compiled.error
                ? "border-danger/20 bg-[#fdf3f0] text-danger"
                : "border-moss/20 bg-moss-soft/60 text-moss",
            )}
          >
            {compiled.error ? (
              <TriangleAlert className="size-3.5 shrink-0" />
            ) : (
              <Workflow className="size-3.5 shrink-0" />
            )}
            {compiled.error ? (
              <span className="min-w-0 flex-1">{compiled.error}</span>
            ) : (
              <>
                <span>
                  {compiled.value?.dsl.nodes.length ?? 0} 个微节点 ·{" "}
                  {compiled.value?.dsl.edges.length ?? 0} 条执行边
                </span>
                {compiled.value?.warnings.map((warning, index) => (
                  <span key={index} className="text-amber">
                    {warning}
                  </span>
                ))}
              </>
            )}
          </div>
        </div>

        <aside className="tf-panel max-h-[70vh] min-h-0 overflow-y-auto p-4 xl:max-h-none">
          {selected ? (
            selected.kind === "record" ? (
              <RecordInspector
                node={selected}
                record={recordMap.get(selected.recordId)}
                graph={graph}
                vars={availableVars}
                onPatch={(patch) => patchNode(selected.id, patch)}
                onDelete={() => removeNode(selected.id)}
                onReplay={() => setReplayRecordId(selected.recordId)}
                onSlotSource={(slot, mode, value) => setSlotSource(selected.id, slot, mode, value)}
                onRenameVar={renameNodeVar}
              />
            ) : (
              <ExtractInspector
                node={selected}
                graph={graph}
                onRenameExtract={(extractId, recordedName, oldName, nextName) =>
                  renameNodeVar(
                    `${selected.id}::${extractId}`,
                    recordedName,
                    oldName,
                    nextName,
                  )
                }
                onRecordSteps={() => {
                  setRecordingNodeId(selected.id);
                  setRecorderOpen(true);
                }}
                recordReady={systems.some((system) => system.enabled)}
                onClearRecording={() => clearExtractRecording(selected.id)}
                onAddManualRow={() => addManualRow(selected.id)}
                onPatchManualRow={(rowId, patch) =>
                  patchManualRow(selected.id, rowId, patch)
                }
                onRemoveManualRow={(rowId) => removeManualRow(selected.id, rowId)}
                duplicateNames={duplicateNames}
                onDelete={() => removeNode(selected.id)}
              />
            )
          ) : (
            <VarPanel graph={graph} recordMap={recordMap} onChange={setGraph} />
          )}
        </aside>
      </div>

      {runOpen ? (
        <FlowRunDialog
          open={runOpen}
          flow={{ ...flow, graph }}
          records={records}
          onClose={() => setRunOpen(false)}
        />
      ) : null}

      {recorderOpen ? (
        <ExtractRecorderDialog
          open={recorderOpen}
          systems={systems}
          initialSystemId={recordingNode?.systemId}
          onOpenChange={(next) => {
            setRecorderOpen(next);
            if (!next) setRecordingNodeId(null);
          }}
          onApply={applyExtractRecording}
        />
      ) : null}

      {replayRecord ? (
        <RecordReplayDialog
          open
          record={replayRecord}
          onClose={() => setReplayRecordId(null)}
        />
      ) : null}
    </div>
  );
}

function FlowNodeCard({ data, selected }: NodeProps<FlowRfNode>) {
  const { node } = data;
  const accent = node.kind === "extract" ? EXTRACT_COLOR : RECORD_COLOR;
  return (
    <div
      className={cn(
        "relative w-[240px] rounded-[10px] border border-line bg-white text-left shadow-[0_10px_28px_rgba(27,28,29,0.08)] transition-shadow",
        data.disabled ? "opacity-50" : "",
      )}
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ width: 8, height: 8, background: "#fff", borderColor: accent }}
      />
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="font-mono text-[10px] font-semibold tracking-[0.16em]"
            style={{ color: accent }}
          >
            {node.kind === "record" ? "OP" : "CODE"}
          </span>
          <span className="truncate font-mono text-[9px] text-muted">
            {node.id.slice(-8)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {data.entry ? (
            <span className="rounded border border-accent/30 bg-accent-soft px-1 font-mono text-[8px] text-accent">
              ENTRY
            </span>
          ) : null}
          {data.disabled ? (
            <span className="rounded border border-amber/30 bg-amber-soft px-1 font-mono text-[8px] text-amber">
              OFF
            </span>
          ) : null}
          {data.missing ? (
            <span className="rounded border border-danger/25 bg-[#fdf3f0] px-1 font-mono text-[8px] text-danger">
              MISSING
            </span>
          ) : null}
        </div>
      </div>
      <div className="px-3 py-2.5">
        <div className="truncate text-[14.5px] font-medium leading-tight text-ink">
          {data.title}
        </div>
        <div className="mt-1 truncate font-mono text-[10.5px] text-muted">{data.summary}</div>
        <div className="mt-2 truncate font-mono text-[9px] uppercase tracking-[0.12em] text-muted/70">
          {data.footer}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ width: 8, height: 8, background: "#fff", borderColor: accent }}
      />
      {selected ? (
        <div className="pointer-events-none absolute inset-0 rounded-[10px] ring-2 ring-accent/25" />
      ) : null}
    </div>
  );
}

function RecordInspector({
  node,
  record,
  graph,
  vars,
  onPatch,
  onDelete,
  onReplay,
  onSlotSource,
  onRenameVar,
}: {
  node: FlowRecordNode;
  record?: OperationRecord;
  graph: FlowGraph;
  vars: string[];
  onPatch: (patch: Partial<FlowRecordNode>) => void;
  onDelete: () => void;
  onReplay: () => void;
  onSlotSource: (slot: RecordSlot, mode: SlotsMode, value?: string) => void;
  onRenameVar: (key: string, recordedName: string, oldName: string, nextName: string) => void;
}) {
  if (!record) {
    return (
      <div>
        <InspectorTitle code="OP" title="记录已删除" />
        <p className="mt-2 text-[11.5px] leading-5 text-danger">
          这条操作记录不在本地存储里，请删除节点或重新录制。
        </p>
        <Button className="mt-3" size="sm" variant="destructive" onClick={onDelete}>
          <Trash2 />
          删除节点
        </Button>
      </div>
    );
  }

  const slots = record.dsl ? listRecordSlots(record.dsl) : [];
  const recordExtracts =
    record.dsl?.nodes.filter((item) => item.type === "extract") ?? [];
  const filterlessPickers =
    record.dsl?.nodes.filter(
      (item) => item.type === "picker" && (item.filter?.steps.length ?? 0) === 0,
    ) ?? [];

  return (
    <div>
      <InspectorTitle code="OP" title={record.name} />
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Badge variant="secondary">{record.nodes} 节点</Badge>
        <Badge variant="secondary">{record.status === "ready" ? "已录制" : "草稿"}</Badge>
        {node.enabled === false ? <Badge variant="amber">已禁用</Badge> : null}
      </div>
      <p className="mt-2 break-all font-mono text-[10px] text-muted">{record.targetUrl}</p>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" onClick={() => onPatch({ enabled: node.enabled === false })}>
          {node.enabled === false ? <Power /> : <Ban />}
          {node.enabled === false ? "启用记录" : "禁用记录"}
        </Button>
        <Button
          size="sm"
          variant="default"
          onClick={onReplay}
          disabled={!record.dsl}
          title={record.dsl ? undefined : "这条记录还没有可执行节点"}
        >
          <Play />
          回放
        </Button>
      </div>

      {recordExtracts.length > 0 ? (
        <div className="mt-4 border-t border-line pt-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
              ENV · 记录内取值
            </span>
            <Badge variant="moss">{recordExtracts.length}</Badge>
          </div>
          <div className="mt-2 grid gap-1.5">
            {recordExtracts.map((item) => {
              const name = effectiveExtractName(
                graph,
                `${node.id}::${item.id}`,
                item.varName,
              );
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5"
                >
                  <Variable className="size-3.5 shrink-0 text-moss" />
                  <VarNameInput
                    className="h-6 min-w-0 flex-1 font-mono text-[10.5px] text-moss"
                    value={name}
                    placeholder="变量名"
                    onCommit={(next) =>
                      onRenameVar(`${node.id}::${item.id}`, item.varName, name, next)
                    }
                  />
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-muted">
                    {item.source === "response"
                      ? "接口"
                      : item.source === "js"
                        ? "JS"
                        : item.source === "const"
                          ? "手动"
                          : item.read}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10.5px] leading-4 text-muted">
            执行这条记录后写入环境变量，可在后续记录的槽位里选择；改名会同步本流程的引用和模板。
          </p>
        </div>
      ) : null}

      <div className="mt-4 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
            INJECT · 微调值
          </span>
          <Badge variant="secondary">{slots.length}</Badge>
        </div>

        {!record.dsl ? (
          <p className="mt-2 text-[11px] leading-4 text-muted">这条记录还没有可执行节点。</p>
        ) : slots.length === 0 ? (
          <p className="mt-2 text-[11px] leading-4 text-muted">
            录制里没有输入或筛选槽位。需要注入主键 code 时，请重录一条带筛选框的操作记录。
          </p>
        ) : (
          <div className="mt-2 grid gap-2">
            {slots.map((slot) => (
              <SlotEditor
                key={slot.id}
                slot={slot}
                injection={findInjection(graph, node.id, slot)}
                vars={vars}
                onChange={(mode, value) => onSlotSource(slot, mode, value)}
              />
            ))}
          </div>
        )}

        <p className="mt-2 text-[10.5px] leading-4 text-muted">
          环境变量注入只在本流程「运行流程」时生效；画布「回放」和录制页的「开始回放」只使用记录自己的录制值/微调值。
        </p>

        {filterlessPickers.length > 0 ? (
          <p className="mt-3 rounded-lg border border-amber/20 bg-amber-soft/60 px-2.5 py-2 text-[10.5px] leading-4 text-amber">
            有 {filterlessPickers.length} 个选择器没有录到筛选框，只能沿用录制选项；需要筛选注入时请重录带占位值的模板。
          </p>
        ) : null}
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <Button size="sm" variant="destructive" onClick={onDelete}>
          <Trash2 />
          从画布删除
        </Button>
      </div>
    </div>
  );
}

function SlotEditor({
  slot,
  injection,
  vars,
  onChange,
}: {
  slot: RecordSlot;
  injection?: FlowInjection;
  vars: string[];
  onChange: (mode: SlotsMode, value?: string) => void;
}) {
  const mode: SlotsMode = !injection
    ? "recorded"
    : injection.source.kind === "literal"
      ? "literal"
      : "var";
  const value =
    injection?.source.kind === "literal"
      ? injection.source.value
      : injection?.source.kind === "var"
        ? injection.source.name
        : "";

  return (
    <div className="rounded-lg border border-line bg-white px-2.5 py-2">
      <div className="min-w-0">
        <div className="truncate text-[11.5px] font-medium">{slot.label}</div>
        <div className="mt-0.5 truncate font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted">
          {slot.kindLabel} · 录制值 {JSON.stringify(slot.recordedValue)}
        </div>
      </div>

      <div className="mt-1.5 grid grid-cols-[88px_minmax(0,1fr)] items-center gap-1.5">
        <Select
          value={mode}
          onValueChange={(next) => onChange(next as SlotsMode)}
        >
          <SelectTrigger size="xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recorded">录制值</SelectItem>
            <SelectItem value="literal">字面值</SelectItem>
            <SelectItem value="var">环境变量</SelectItem>
          </SelectContent>
        </Select>

        {mode === "literal" ? (
          <Input
            className="h-7 text-[11.5px]"
            value={value}
            placeholder="输入值"
            onChange={(event) => onChange("literal", event.target.value)}
          />
        ) : mode === "var" ? (
          <Select value={value} onValueChange={(next) => onChange("var", next)}>
            <SelectTrigger size="xs">
              <SelectValue placeholder="选择变量" />
            </SelectTrigger>
            <SelectContent>
              {vars.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="truncate text-[10.5px] text-muted">使用录制时的值</span>
        )}
      </div>

      {slot.slot === "filter" && mode !== "recorded" ? (
        <div className="mt-1.5 text-[10px] leading-4 text-moss">
          筛选值由流程注入；回放会自动改选筛选后的结果项，不再点录制项。
        </div>
      ) : null}
    </div>
  );
}

const RECORDED_STEP_LABEL: Record<FlowNode["type"], string> = {
  navigate: "导航",
  interact: "操作",
  picker: "选择",
  wait: "等待",
  extract: "取值",
};

function recordedStepSummary(node: FlowNode): string {
  switch (node.type) {
    case "navigate":
      return node.url;
    case "interact":
      return `${node.adapter} · ${node.target.label ?? node.name ?? node.id}`;
    case "picker":
      return node.trigger.label ?? node.name ?? node.id;
    case "wait":
      return typeof node.condition === "string" ? node.condition : node.condition.kind;
    case "extract":
      return (
        (node.source === "dom" ? node.target.label : undefined) ??
        node.name ??
        node.varName ??
        node.id
      );
  }
}

function ExtractInspector({
  node,
  graph,
  onRenameExtract,
  onRecordSteps,
  recordReady,
  onClearRecording,
  onAddManualRow,
  onPatchManualRow,
  onRemoveManualRow,
  duplicateNames,
  onDelete,
}: {
  node: FlowExtractNode;
  graph: FlowGraph;
  onRenameExtract: (
    extractId: string,
    recordedName: string,
    oldName: string,
    nextName: string,
  ) => void;
  onRecordSteps: () => void;
  recordReady: boolean;
  onClearRecording: () => void;
  onAddManualRow: () => void;
  onPatchManualRow: (rowId: string, patch: Partial<{ value: string }>) => void;
  onRemoveManualRow: (rowId: string) => void;
  duplicateNames: ReadonlySet<string>;
  onDelete: () => void;
}) {
  const varName = effectiveExtractName(graph, node.id, node.varName);
  const recorded = node.recordedDsl;
  const recordedExtracts = recordedExtractNodes(node);
  const manualRows = node.manualVars ?? [];
  const totalRows = recordedExtracts.length + manualRows.length;
  const titleName = recordedExtracts[0]
    ? effectiveExtractName(
        graph,
        `${node.id}::${recordedExtracts[0].id}`,
        recordedExtracts[0].varName,
      )
    : manualRows[0]
      ? effectiveExtractName(
          graph,
          `${node.id}::manual::${manualRows[0].id}`,
          manualRows[0].varName,
        )
      : varName;
  const preStepCount = node.preDsl?.nodes.length ?? 0;
  const consumersOf = (name: string): number =>
    graph.injections.filter(
      (item) => item.source.kind === "var" && item.source.name === name,
    ).length;

  return (
    <div>
      <InspectorTitle code="CODE" title={titleName || "取值节点"} />
      <p className="mt-1 text-[11px] leading-4 text-muted">
        在弹窗里录制真实操作和取值步骤；每个取值会生成一个环境变量。
      </p>

      <div className="mt-3 rounded-lg border border-line bg-white px-2.5 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11.5px] font-medium">录制步骤</div>
            <div className="mt-0.5 text-[10.5px] leading-4 text-muted">
              {recorded
                ? `${recordedExtracts.length} 个录制取值、${manualRows.length} 个手动取值、${recorded.nodes.length - recordedExtracts.length} 个操作步骤。`
                : manualRows.length > 0
                  ? `${manualRows.length} 个手动取值。`
                  : preStepCount > 0
                    ? `已录制 ${preStepCount} 个前置步骤。`
                    : "弹窗选择系统并录制真实操作，完成后保存到当前取值节点。"}
              {!recordReady ? "请先到「系统管理」添加并启用一个系统。" : ""}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {recorded || preStepCount > 0 ? (
              <Button size="sm" variant="ghost" onClick={onClearRecording}>
                清除录制
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={onRecordSteps}
              disabled={!recordReady}
            >
              <Mic />
              {recorded || preStepCount > 0 ? "重新录制" : "录制步骤"}
            </Button>
          </div>
        </div>
      </div>

      {recorded ? (
        <div className="mt-3 rounded-lg border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
            <span className="text-[11.5px] font-medium">录制步骤</span>
            <Badge variant="secondary">{recorded.nodes.length}</Badge>
          </div>
          <ol className="max-h-[200px] overflow-y-auto p-1.5">
            {recorded.nodes.map((item, index) => (
              <li
                key={item.id}
                className={cn(
                  "flex items-start gap-1.5 rounded px-1.5 py-1 text-[10.5px]",
                  item.type === "extract" && "bg-moss/10",
                )}
              >
                <span className="pt-0.5 font-mono text-[9px] text-muted">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {RECORDED_STEP_LABEL[item.type] ?? item.type}
                  </span>
                  <span className="block truncate text-[9.5px] text-muted">
                    {recordedStepSummary(item)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="mt-3 rounded-lg border border-line bg-white">
        <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5">
          <span className="text-[11.5px] font-medium">取值表格</span>
          <div className="flex items-center gap-1.5">
            <Badge variant="moss">{totalRows}</Badge>
            <Button size="sm" variant="ghost" onClick={onAddManualRow}>
              <Plus className="size-3" />
              新增
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-left">
            <thead className="text-[9px] uppercase tracking-[0.1em] text-muted">
              <tr>
                <th className="w-5 px-1 py-1.5">#</th>
                <th className="px-1 py-1.5">取值目标</th>
                <th className="w-[94px] px-1 py-1.5">变量名</th>
                <th className="w-[84px] px-1 py-1.5">值</th>
                <th className="w-7 px-1 py-1.5 text-right">引用</th>
                <th className="w-6 px-0 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {recordedExtracts.map((item, index) => {
                const name = effectiveExtractName(
                  graph,
                  `${node.id}::${item.id}`,
                  item.varName,
                );
                const duplicate = duplicateNames.has(name);
                const value = item.meta?.sampleValue;
                return (
                  <tr key={item.id} className="border-t border-line">
                    <td className="px-1 py-1.5 font-mono text-[9.5px] text-muted">
                      {index + 1}
                    </td>
                    <td className="px-1 py-1.5 text-[10px] leading-4 text-muted">
                      <span
                        className="block truncate"
                        title={describeExtractNode(item)}
                      >
                        {describeExtractNode(item)}
                      </span>
                    </td>
                    <td className="px-1 py-1.5">
                      <VarNameInput
                        className={cn(
                          "h-7 w-full px-2 font-mono text-[10.5px]",
                          duplicate && "border-danger",
                        )}
                        value={name}
                        placeholder="变量名"
                        onCommit={(next) =>
                          onRenameExtract(item.id, item.varName, name, next)
                        }
                      />
                      {duplicate ? (
                        <span className="mt-0.5 block text-[9px] text-danger">
                          变量名重复
                        </span>
                      ) : null}
                    </td>
                    <td className="px-1 py-1.5">
                      <span
                        className="block truncate font-mono text-[10px] text-muted"
                        title={value === undefined ? "" : String(value)}
                      >
                        {value === undefined || value === "" ? "—" : String(value)}
                      </span>
                    </td>
                    <td className="px-1 py-1.5 text-right text-[10px] text-muted">
                      {consumersOf(name)}
                    </td>
                    <td />
                  </tr>
                );
              })}
              {manualRows.map((row, index) => {
                const name = effectiveExtractName(
                  graph,
                  `${node.id}::manual::${row.id}`,
                  row.varName,
                );
                const duplicate = duplicateNames.has(name);
                return (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-1 py-1.5 font-mono text-[9.5px] text-muted">
                      {recordedExtracts.length + index + 1}
                    </td>
                    <td className="px-1 py-1.5 text-[10px] text-muted">手动值</td>
                    <td className="px-1 py-1.5">
                      <VarNameInput
                        className={cn(
                          "h-7 w-full px-2 font-mono text-[10.5px]",
                          duplicate && "border-danger",
                        )}
                        value={name}
                        placeholder="变量名"
                        onCommit={(next) =>
                          onRenameExtract(
                            `manual::${row.id}`,
                            row.varName,
                            name,
                            next,
                          )
                        }
                      />
                      {duplicate ? (
                        <span className="mt-0.5 block text-[9px] text-danger">
                          变量名重复
                        </span>
                      ) : null}
                    </td>
                    <td className="px-1 py-1.5">
                      <Input
                        className="h-7 px-2 text-[10.5px]"
                        value={row.value}
                        placeholder="值"
                        spellCheck={false}
                        onChange={(event) =>
                          onPatchManualRow(row.id, { value: event.target.value })
                        }
                      />
                    </td>
                    <td className="px-1 py-1.5 text-right text-[10px] text-muted">
                      {consumersOf(name)}
                    </td>
                    <td className="px-0 py-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="size-5 p-0 text-muted hover:text-danger"
                        title="删除手动取值"
                        aria-label="删除手动取值"
                        onClick={() => onRemoveManualRow(row.id)}
                      >
                        <X className="size-3" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {totalRows === 0 ? (
                <tr className="border-t border-line">
                  <td
                    colSpan={6}
                    className="px-2 py-3 text-center text-[10.5px] text-muted"
                  >
                    还没有取值。可以录制，也可以点「新增」手动添加。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <Button size="sm" variant="destructive" onClick={onDelete}>
          <Trash2 />
          从画布删除
        </Button>
      </div>
    </div>
  );
}

function VarPanel({
  graph,
  recordMap,
  onChange,
}: {
  graph: FlowGraph;
  recordMap: Map<string, OperationRecord>;
  onChange: (next: FlowGraph) => void;
}) {
  const producers = listExtractProducers(graph, recordMap);
  const consumersOf = (name: string): number =>
    graph.injections.filter((item) => item.source.kind === "var" && item.source.name === name).length;
  const counts = new Map<string, number>();
  for (const producer of producers) {
    if (!producer.name) continue;
    counts.set(producer.name, (counts.get(producer.name) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);

  return (
    <div>
      <InspectorTitle code="ENV" title="流程环境变量" />
      <p className="mt-1 text-[11px] leading-4 text-muted">
        画布取值和记录内取值产出的变量都在这里统一改名；改名会同步更新本流程的注入引用和
        {" {{变量}} "}模板。也可以手工声明一个固定值。
      </p>

      <div className="mt-3 grid gap-2">
        {producers.length === 0 ? (
          <p className="text-[11px] leading-4 text-muted">还没有取值节点或记录内取值。</p>
        ) : (
          producers.map((producer) => {
            const canvasNode =
              producer.source === "canvas"
                ? graph.nodes.find(
                    (node): node is FlowExtractNode => node.id === producer.key,
                  )
                : undefined;
            return (
              <div
                key={producer.key}
                className="rounded-lg border border-line bg-white px-2.5 py-2"
              >
                <div className="flex items-center gap-1.5">
                  <Variable className="size-3.5 shrink-0 text-moss" />
                  <VarNameInput
                    className="h-7 min-w-0 flex-1 font-mono text-[11px] text-moss"
                    value={producer.name}
                    placeholder="变量名"
                    onCommit={(next) =>
                      onChange(
                        renameExtractVar(
                          graph,
                          producer.key,
                          producer.recordedName,
                          producer.name,
                          next,
                        ),
                      )
                    }
                  />
                  <Badge variant="secondary">{consumersOf(producer.name)} 引用</Badge>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">
                    {producer.source === "canvas"
                      ? "画布取值"
                      : `记录「${producer.recordName ?? "已删除"}」`}
                  </Badge>
                  {!producer.enabled ? <Badge variant="amber">已禁用</Badge> : null}
                  {canvasNode ? (
                    <span className="truncate font-mono text-[9.5px] text-muted">
                      {extractSummary(canvasNode)}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {duplicates.length > 0 ? (
        <p className="mt-2 rounded-lg border border-danger/20 bg-[#fdf3f0] px-2.5 py-2 text-[10.5px] leading-4 text-danger">
          变量重名：{duplicates.join("、")}。同名产出无法编译，请改掉其中一个。
        </p>
      ) : null}

      <div className="mt-4 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
            MANUAL
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onChange({
                ...graph,
                vars: [...graph.vars, { name: "", value: "" }],
              })
            }
          >
            <Plus className="size-3" />
            手工变量
          </Button>
        </div>
        <div className="mt-2 grid gap-2">
          {graph.vars.map((item, index) => (
            <div key={index} className="grid gap-1.5 rounded-lg border border-line bg-white p-2">
              <div className="flex items-center gap-1.5">
                <VarNameInput
                  className="h-7 font-mono text-[11px]"
                  value={item.name}
                  placeholder="变量名"
                  onCommit={(next) => onChange(renameManualVar(graph, index, next))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="删除变量"
                  onClick={() =>
                    onChange({
                      ...graph,
                      vars: graph.vars.filter((_, currentIndex) => currentIndex !== index),
                    })
                  }
                >
                  <Trash2 className="size-3.5" />
                  删除
                </Button>
              </div>
              <Input
                className="h-7 text-[11px]"
                value={item.value ?? ""}
                placeholder="初始值"
                onChange={(event) =>
                  onChange({
                    ...graph,
                    vars: graph.vars.map((current, currentIndex) =>
                      currentIndex === index ? { ...current, value: event.target.value } : current,
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function VarNameInput({
  value,
  placeholder,
  className,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  className?: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = (): void => {
    const next = draft.trim();
    if (!next || next === value) {
      setDraft(value);
      return;
    }
    onCommit(next);
  };
  return (
    <Input
      className={className}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

function InspectorTitle({ code, title }: { code: string; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Badge variant="accent">{code}</Badge>
      <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight">{title}</h2>
    </div>
  );
}
