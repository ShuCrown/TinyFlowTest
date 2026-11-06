import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  Ban,
  Crosshair,
  Mic,
  Play,
  Plus,
  Power,
  Save,
  Trash2,
  TriangleAlert,
  Variable,
  Workflow,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui";
import { FlowRunDialog } from "@/components/FlowRunDialog";
import { cn } from "@/lib/utils";
import { getFlow, listRecords, listSystems, newId, saveFlow } from "@/lib/store";
import type {
  ExtractResponseConfig,
  ExtractSourceKind,
  FlowCanvasNode,
  FlowExtractNode,
  FlowGraph,
  FlowInjection,
  FlowItem,
  FlowRecordNode,
  OperationRecord,
} from "@/lib/types";
import type { CellRef } from "@/dsl/index.ts";
import { compileFlow, FlowCompileError } from "@/flow/compile.ts";
import { listRecordSlots, type RecordSlot } from "@/flow/slots.ts";

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

function extractSummary(node: FlowExtractNode): string {
  const source = node.source ?? "dom";
  if (source === "response") {
    return `接口 · ${node.response?.urlContains || "未设置 URL"}`;
  }
  if (source === "js") {
    return `JS · ${node.js?.trim() || "未设置表达式"}`;
  }
  if ((node.locate ?? "css") === "cell") {
    const cell = node.cell;
    const row = cell?.rowValue || cell?.rowText || "未设置行";
    const column = cell?.header || (cell?.colIndex ? `第${cell.colIndex}列` : "未设置列");
    return `表格 · ${row} / ${column}`;
  }
  return `${node.read} · ${node.selector || "未设置选择器"}`;
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
  return graph.nodes
    .filter((node): node is FlowExtractNode => node.kind === "extract")
    .map((node) => node.varName.trim())
    .filter(Boolean);
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
      const name = dslNode.varName.trim();
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
        const title =
          node.kind === "record"
            ? record?.name ?? "记录已删除"
            : `取值 ${node.varName || "未命名"}`;
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
            : `ENV · ${node.varName || "未命名变量"}`;
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
    [graph.nodes, recordMap, systemNames, entryId, selectedId],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
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

  const hasRecordNode = graph.nodes.some((node) => node.kind === "record");
  const fitView = (): void => {
    void instanceRef.current?.fitView({ padding: 0.24, minZoom: 0.45, maxZoom: 0.95 });
  };

  return (
    <div className="flex flex-col pb-4 xl:h-[calc(100vh-32px)] xl:overflow-hidden xl:pb-0">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="outline" onClick={() => navigate("/flows")}>
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
          <Button variant="outline" onClick={save}>
            <Save />
            保存画布
          </Button>
          <Button
            variant="default"
            onClick={() => setRunOpen(true)}
            disabled={Boolean(compiled.error) || !hasRecordNode}
            title={compiled.error ?? (!hasRecordNode ? "先添加至少一条操作记录" : undefined)}
          >
            <Play />
            运行流程
          </Button>
        </div>
      </header>

      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative">
          <Button variant="default" onClick={() => setAddOpen((value) => !value)}>
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

        <Button variant="outline" size="sm" onClick={fitView} title="适应画布">
          <Crosshair className="size-3.5" />
          适应视图
        </Button>
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
          选中节点或连线后按 Delete 删除
        </span>
      </div>

      <div className="mt-3 grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-h-0 flex-col gap-2">
          <div className="tf-flow relative h-[68vh] min-h-[520px] overflow-hidden rounded-xl border border-line bg-paper xl:h-auto xl:flex-1">
            <ReactFlow<FlowRfNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={FLOW_NODE_TYPES}
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
                onSlotSource={(slot, mode, value) => setSlotSource(selected.id, slot, mode, value)}
              />
            ) : (
              <ExtractInspector
                node={selected}
                graph={graph}
                onPatch={(patch) => patchNode(selected.id, patch)}
                onDelete={() => removeNode(selected.id)}
              />
            )
          ) : (
            <VarPanel graph={graph} onChange={setGraph} />
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
  onSlotSource,
}: {
  node: FlowRecordNode;
  record?: OperationRecord;
  graph: FlowGraph;
  vars: string[];
  onPatch: (patch: Partial<FlowRecordNode>) => void;
  onDelete: () => void;
  onSlotSource: (slot: RecordSlot, mode: SlotsMode, value?: string) => void;
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
        <Link to={`/records/${record.id}/record`}>
          <Button size="sm" variant="ghost">
            <Mic />
            打开录制
          </Button>
        </Link>
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
            {recordExtracts.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5"
              >
                <Variable className="size-3.5 text-moss" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-moss">
                  {item.varName || "未命名变量"}
                </span>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-muted">
                  {item.source === "response"
                    ? "接口"
                    : item.source === "js"
                      ? "JS"
                      : item.read}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10.5px] leading-4 text-muted">
            执行这条记录后写入环境变量，可在后续记录的槽位里选择。
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
        <select
          className="tf-select h-7 py-1 text-[11px]"
          value={mode}
          onChange={(event) => onChange(event.target.value as SlotsMode)}
        >
          <option value="recorded">录制值</option>
          <option value="literal">字面值</option>
          <option value="var">环境变量</option>
        </select>

        {mode === "literal" ? (
          <Input
            className="h-7 text-[11.5px]"
            value={value}
            placeholder="输入值"
            onChange={(event) => onChange("literal", event.target.value)}
          />
        ) : mode === "var" ? (
          <select
            className="tf-select h-7 py-1 text-[11px]"
            value={value}
            onChange={(event) => onChange("var", event.target.value)}
          >
            <option value="">选择变量</option>
            {vars.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
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

function ExtractInspector({
  node,
  graph,
  onPatch,
  onDelete,
}: {
  node: FlowExtractNode;
  graph: FlowGraph;
  onPatch: (patch: Partial<FlowExtractNode>) => void;
  onDelete: () => void;
}) {
  const consumers = graph.injections.filter(
    (item) => item.source.kind === "var" && item.source.name === node.varName,
  ).length;
  const source = node.source ?? "dom";
  const locate = node.locate ?? "css";
  const cell = node.cell ?? {};
  const patchCell = (patch: Partial<CellRef>): void =>
    onPatch({ cell: { ...cell, ...patch } });
  const patchResponse = (patch: Partial<ExtractResponseConfig>): void => {
    onPatch({ response: { ...(node.response ?? { urlContains: "" }), ...patch } });
  };

  return (
    <div>
      <InspectorTitle code="CODE" title={node.varName || "取值节点"} />
      <p className="mt-1 text-[11px] leading-4 text-muted">
        读取一个值写入流程环境变量；数据可以来自页面元素、页面实际收到的接口响应，或在目标页执行的表达式。
      </p>

      <div className="mt-3 grid gap-2.5">
        <Field label="变量名">
          <Input
            className="h-8 text-[12px]"
            value={node.varName}
            placeholder="例如 customerCode"
            onChange={(event) => onPatch({ varName: event.target.value })}
          />
        </Field>
        <Field label="取值来源">
          <select
            className="tf-select h-8 py-1 text-[12px]"
            value={source}
            onChange={(event) =>
              onPatch({ source: event.target.value as ExtractSourceKind })
            }
          >
            <option value="dom">页面元素</option>
            <option value="response">接口响应（页面未展示的数据）</option>
            <option value="js">JS 表达式（高级）</option>
          </select>
        </Field>

        {source === "dom" ? (
          <>
            <Field label="定位方式">
              <select
                className="tf-select h-8 py-1 text-[12px]"
                value={locate}
                onChange={(event) => {
                  const next = event.target.value as "css" | "cell";
                  onPatch(
                    next === "cell"
                      ? { locate: next, cell: node.cell ?? {} }
                      : { locate: next },
                  );
                }}
              >
                <option value="css">CSS 选择器</option>
                <option value="cell">表格单元格</option>
              </select>
            </Field>

            {locate === "cell" ? (
              <CellLocatorFields cell={cell} onPatch={patchCell} />
            ) : (
              <Field
                label="目标选择器"
                hint="当前页面的 CSS 选择器，指向保存后出现的编号元素。"
              >
                <Input
                  className="h-8 font-mono text-[11.5px]"
                  value={node.selector}
                  placeholder="例如 #success-code 或 .result .code"
                  spellCheck={false}
                  onChange={(event) => onPatch({ selector: event.target.value })}
                />
              </Field>
            )}

            <Field label="读取方式">
              <select
                className="tf-select h-8 py-1 text-[12px]"
                value={node.read}
                onChange={(event) =>
                  onPatch({ read: event.target.value as FlowExtractNode["read"] })
                }
              >
                <option value="text">文本</option>
                <option value="value">表单值</option>
                <option value="attribute">属性</option>
              </select>
            </Field>
            {node.read === "attribute" ? (
              <Field label="属性名">
                <Input
                  className="h-8 text-[12px]"
                  value={node.attribute ?? ""}
                  placeholder="例如 data-code"
                  onChange={(event) => onPatch({ attribute: event.target.value })}
                />
              </Field>
            ) : null}

            <label className="flex items-start gap-2 rounded-lg border border-line bg-white px-2.5 py-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={node.includeHidden === true}
                onChange={(event) => onPatch({ includeHidden: event.target.checked })}
              />
              <span>
                <span className="block text-[12px] font-medium">包含隐藏元素</span>
                <span className="block text-[10.5px] leading-4 text-muted">
                  用于隐藏输入框、JSON script 等未展示但仍在 DOM 里的数据。
                </span>
              </span>
            </label>
          </>
        ) : null}

        {source === "response" ? (
          <>
            <Field label="请求方法">
              <select
                className="tf-select h-8 py-1 text-[12px]"
                value={node.response?.method ?? ""}
                onChange={(event) =>
                  patchResponse({ method: event.target.value || undefined })
                }
              >
                <option value="">任意</option>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
              </select>
            </Field>
            <Field label="URL 包含" hint="支持 {{变量名}}。">
              <Input
                className="h-8 font-mono text-[11.5px]"
                value={node.response?.urlContains ?? ""}
                placeholder="例如 /api/customer/save"
                spellCheck={false}
                onChange={(event) => patchResponse({ urlContains: event.target.value })}
              />
            </Field>
            <Field
              label="请求体包含（可选）"
              hint="区分同一 URL 的不同操作，例如 GraphQL operationName。"
            >
              <Input
                className="h-8 font-mono text-[11.5px]"
                value={node.response?.bodyContains ?? ""}
                placeholder="例如 saveCustomer"
                spellCheck={false}
                onChange={(event) => patchResponse({ bodyContains: event.target.value })}
              />
            </Field>
            <Field
              label="JSON 路径（可选）"
              hint="留空读取整段响应文本；支持 data.items[0].code。"
            >
              <Input
                className="h-8 font-mono text-[11.5px]"
                value={node.response?.path ?? ""}
                placeholder="例如 data.customer.code"
                spellCheck={false}
                onChange={(event) => patchResponse({ path: event.target.value })}
              />
            </Field>
            <p className="rounded-lg border border-amber/20 bg-amber-soft px-2.5 py-2 text-[10.5px] leading-4 text-amber">
              只捕获回放开始后页面真实发出的接口响应；首屏加载时已经完成的请求访问不到，请改用 JS 表达式或先触发一次查询。
            </p>
          </>
        ) : null}

        {source === "js" ? (
          <>
            <Field label="JS 表达式" hint="在目标页上下文执行，等同浏览器控制台。">
              <Textarea
                className="min-h-[72px] font-mono text-[11.5px]"
                value={node.js ?? ""}
                placeholder="例如 window.__DATA__.customer.code"
                spellCheck={false}
                onChange={(event) => onPatch({ js: event.target.value })}
              />
            </Field>
            <p className="rounded-lg border border-amber/20 bg-amber-soft px-2.5 py-2 text-[10.5px] leading-4 text-amber">
              表达式只在本机保存；目标页 CSP 禁止 eval 时会失败，请改用页面元素或接口响应。
            </p>
          </>
        ) : null}

        <Field label="清洗正则（可选）" hint="有捕获组时取第一组，否则取整个匹配。">
          <Input
            className="h-8 font-mono text-[11.5px]"
            value={node.pattern ?? ""}
            placeholder="例如 CUS-\d+"
            spellCheck={false}
            onChange={(event) => onPatch({ pattern: event.target.value })}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge variant={consumers > 0 ? "moss" : "secondary"}>{consumers} 处引用</Badge>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onPatch({ enabled: node.enabled === false })}
        >
          {node.enabled === false ? <Power /> : <Ban />}
          {node.enabled === false ? "启用节点" : "禁用节点"}
        </Button>
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

function CellLocatorFields({
  cell,
  onPatch,
}: {
  cell: CellRef;
  onPatch: (patch: Partial<CellRef>) => void;
}) {
  const rowMode: "rowValue" | "rowText" = cell.rowText !== undefined ? "rowText" : "rowValue";
  const changeRowMode = (mode: "rowValue" | "rowText"): void => {
    if (mode === rowMode) return;
    if (mode === "rowText") {
      onPatch({
        rowText: cell.rowValue ?? "",
        rowValue: undefined,
        keyHeader: undefined,
        keyIndex: undefined,
      });
      return;
    }
    onPatch({ rowValue: cell.rowText ?? "", rowText: undefined });
  };
  const patchIndex = (key: "keyIndex" | "colIndex", raw: string): void => {
    const value = Number.parseInt(raw, 10);
    const next = Number.isInteger(value) && value >= 1 ? value : undefined;
    onPatch(key === "keyIndex" ? { keyIndex: next } : { colIndex: next });
  };

  return (
    <>
      <Field label="表格（可选）" hint="表头 id 或 aria-label；留空在全部表格里找。">
        <Input
          className="h-8 font-mono text-[11.5px]"
          value={cell.table ?? ""}
          placeholder="例如 customer-table"
          spellCheck={false}
          onChange={(event) => onPatch({ table: event.target.value || undefined })}
        />
      </Field>
      <Field label="行定位方式">
        <select
          className="tf-select h-8 py-1 text-[12px]"
          value={rowMode}
          onChange={(event) => changeRowMode(event.target.value as "rowValue" | "rowText")}
        >
          <option value="rowValue">按列值</option>
          <option value="rowText">按整行文本</option>
        </select>
      </Field>

      {rowMode === "rowValue" ? (
        <>
          <Field label="行值所在列表头" hint="行值在这一列唯一即可。">
            <Input
              className="h-8 text-[12px]"
              value={cell.keyHeader ?? ""}
              placeholder="例如 客户名称"
              onChange={(event) => onPatch({ keyHeader: event.target.value || undefined })}
            />
          </Field>
          <Field label="行值所在列序号（可选）">
            <Input
              type="number"
              min={1}
              step={1}
              className="h-8 text-[12px]"
              value={cell.keyIndex ?? ""}
              placeholder="表头重名时使用"
              onChange={(event) => patchIndex("keyIndex", event.target.value)}
            />
          </Field>
          <Field label="行值" hint="支持 {{变量名}}，例如刚创建的客户名称。">
            <Input
              className="h-8 font-mono text-[11.5px]"
              value={cell.rowValue ?? ""}
              placeholder="例如 华东示例客户 或 {{customerName}}"
              spellCheck={false}
              onChange={(event) => onPatch({ rowValue: event.target.value })}
            />
          </Field>
        </>
      ) : (
        <Field label="整行文本" hint="支持 {{变量名}}；整行文本需能唯一匹配。">
          <Input
            className="h-8 font-mono text-[11.5px]"
            value={cell.rowText ?? ""}
            placeholder="例如 华东示例客户 华东区 …"
            spellCheck={false}
            onChange={(event) => onPatch({ rowText: event.target.value })}
          />
        </Field>
      )}

      <Field label="目标列表头" hint="表头文本；重名时改用列序号。">
        <Input
          className="h-8 text-[12px]"
          value={cell.header ?? ""}
          placeholder="例如 备注"
          onChange={(event) => onPatch({ header: event.target.value || undefined })}
        />
      </Field>
      <Field label="目标列序号（可选）">
        <Input
          type="number"
          min={1}
          step={1}
          className="h-8 text-[12px]"
          value={cell.colIndex ?? ""}
          placeholder="表头找不到时使用"
          onChange={(event) => patchIndex("colIndex", event.target.value)}
        />
      </Field>
      <Field label="单元格内控件">
        <select
          className="tf-select h-8 py-1 text-[12px]"
          value={cell.control ?? "self"}
          onChange={(event) =>
            onPatch({ control: event.target.value as CellRef["control"] })
          }
        >
          <option value="self">单元格本身</option>
          <option value="input">输入框</option>
          <option value="textarea">文本域</option>
          <option value="select">下拉框</option>
          <option value="contenteditable">可编辑区</option>
        </select>
      </Field>
    </>
  );
}

function VarPanel({ graph, onChange }: { graph: FlowGraph; onChange: (next: FlowGraph) => void }) {
  const extracts = graph.nodes.filter(
    (node): node is FlowExtractNode => node.kind === "extract",
  );
  const consumersOf = (name: string): number =>
    graph.injections.filter((item) => item.source.kind === "var" && item.source.name === name).length;

  return (
    <div>
      <InspectorTitle code="ENV" title="流程环境变量" />
      <p className="mt-1 text-[11px] leading-4 text-muted">
        取值节点产出的变量在运行时写入；也可以手工声明一个固定值。选中节点查看和编辑。
      </p>

      <div className="mt-3 grid gap-2">
        {extracts.length === 0 ? (
          <p className="text-[11px] leading-4 text-muted">还没有取值节点。</p>
        ) : (
          extracts.map((node) => (
            <div key={node.id} className="rounded-lg border border-line bg-white px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <Variable className="size-3.5 text-moss" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-moss">
                  {node.varName || "未命名变量"}
                </span>
                <Badge variant="secondary">{consumersOf(node.varName)} 引用</Badge>
              </div>
              <div className="mt-0.5 truncate font-mono text-[9.5px] text-muted">
                {extractSummary(node)}
              </div>
            </div>
          ))
        )}
      </div>

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
                <Input
                  className="h-7 font-mono text-[11px]"
                  value={item.name}
                  placeholder="变量名"
                  onChange={(event) =>
                    onChange({
                      ...graph,
                      vars: graph.vars.map((current, currentIndex) =>
                        currentIndex === index ? { ...current, name: event.target.value } : current,
                      ),
                    })
                  }
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

function InspectorTitle({ code, title }: { code: string; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Badge variant="accent">{code}</Badge>
      <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight">{title}</h2>
    </div>
  );
}
