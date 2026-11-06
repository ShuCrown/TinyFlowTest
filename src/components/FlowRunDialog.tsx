import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipForward,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { getSystemToken, saveSystemToken } from "@/lib/store";
import {
  describeTargetFailure,
  loadProxyConfig,
  resolveTargetUrl,
  type ProxyConfig,
} from "@/lib/proxy";
import { injectSystemToken } from "@/lib/session";
import { compileFlow } from "@/flow/compile.ts";
import { createIframeHost, runFlow, type ReplayNodeStatus } from "@/replay/index.ts";
import type { NodeFailureDecision, NodeFailureInfo } from "@/replay/index.ts";
import type { ExtractNode, InteractNode, PickerNode, ValueLike } from "@/dsl/index.ts";
import type { FlowItem, OperationRecord } from "@/lib/types";
import { effectiveExtractName } from "@/flow/vars";
import {
  ExtractTuningFields,
  extractEditorOf,
  extractTuningDiff,
  recordedExtractEditor,
  type ExtractEditor,
} from "@/components/ExtractTuningFields";

type RunPhase =
  | "idle"
  | "loading"
  | "login"
  | "running"
  | "paused"
  | "intervening"
  | "finished"
  | "failed";

interface RunItem {
  nodeId: string;
  name?: string;
  groupId?: string;
  status: "running" | ReplayNodeStatus;
  message: string;
  durationMs?: number;
}

type PickerStrategy = "byText" | "byRow" | "byIndex" | "firstVisible";

interface PickerDraft {
  strategy: PickerStrategy;
  filters: string[];
  picks: string[];
  indexes: string[];
  on: "item" | "row";
}

interface TunableNode {
  microId: string;
  node: InteractNode | PickerNode | ExtractNode;
}

interface TuningGroup {
  macroId: string;
  recordName: string;
  nodes: TunableNode[];
}

const EDITABLE_INTERACT = new Set(["input", "select", "nativeSelect", "check"]);

const PICKER_STRATEGY_LABEL: Record<PickerStrategy, string> = {
  byText: "按文本",
  byRow: "按行文本",
  byIndex: "按位置",
  firstVisible: "筛选后第一项",
};

const PHASE_LABEL: Record<RunPhase, string> = {
  idle: "待运行",
  loading: "加载中",
  login: "需要登录",
  running: "运行中",
  paused: "已暂停",
  intervening: "待人工处理",
  finished: "已完成",
  failed: "失败",
};

const ITEM_BADGE: Record<
  RunItem["status"],
  { label: string; variant: "secondary" | "moss" | "accent" | "amber" | "destructive" }
> = {
  running: { label: "执行中", variant: "secondary" },
  pass: { label: "通过", variant: "moss" },
  healed: { label: "自愈", variant: "amber" },
  manual: { label: "人工完成", variant: "accent" },
  fail: { label: "失败", variant: "destructive" },
  skipped: { label: "跳过", variant: "secondary" },
};

function readValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(readValueText).filter(Boolean).join(",");
  if (value && typeof value === "object" && "kind" in value) {
    const expr = value as { kind?: unknown; value?: unknown };
    if (expr.kind === "literal") {
      return expr.value === null || expr.value === undefined ? "" : String(expr.value);
    }
  }
  return "";
}

function literalText(value: ValueLike | undefined): string {
  return readValueText(value);
}

function valueHint(value: ValueLike | undefined): string {
  if (value && typeof value === "object" && !Array.isArray(value) && "kind" in value) {
    const expr = value as { kind?: unknown; name?: string; template?: string };
    if (expr.kind === "var" && expr.name) return `变量 ${expr.name}`;
    if (expr.kind === "template" && expr.template) return `模板 ${expr.template}`;
  }
  const text = literalText(value);
  return text ? `录制值 ${text}` : "录制值 空";
}

function defaultPickerDraft(node: PickerNode): PickerDraft {
  const strategy = node.pick.strategy;
  const filters = (node.filter?.steps ?? []).map((step) => literalText(step.value));
  const picks = (node.pick.values ?? []).map((item) => item.value ?? "").filter(Boolean);
  if (picks.length === 0) {
    const raw = node.pick.byText?.value ?? node.pick.byRow?.keyValue;
    if (Array.isArray(raw)) picks.push(...raw.map(readValueText).filter(Boolean));
    else if (raw !== undefined) {
      const text = literalText(raw);
      if (text) picks.push(text);
    }
  }
  if (picks.length === 0 && strategy !== "firstVisible" && strategy !== "byIndex") {
    picks.push("");
  }
  const indexes =
    strategy === "byIndex" ? (node.pick.byIndex?.indexes ?? []).map(String) : [];
  if (indexes.length === 0 && strategy === "byIndex") indexes.push("1");
  const on = node.pick.byIndex?.on ?? node.pick.firstVisible?.on ?? (strategy === "byRow" ? "row" : "item");
  return { strategy, filters, picks, indexes, on };
}

function pickerOverrideOf(draft: PickerDraft): Record<string, unknown> {
  const override: Record<string, unknown> = {
    strategy: draft.strategy,
    filters: draft.filters,
    on: draft.on,
  };
  if (draft.strategy === "byIndex") {
    override.indexes = draft.indexes
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isInteger(item) && item >= 1);
  } else if (draft.strategy === "byText" || draft.strategy === "byRow") {
    override.picks = draft.picks.filter(Boolean);
  }
  return override;
}

function interactDefaultText(node: InteractNode): string {
  return node.adapter === "check"
    ? String(node.checked ?? literalText(node.value) === "true")
    : literalText(node.value);
}

function loadFrame(frame: HTMLIFrameElement, source: string): Promise<Document> {
  return new Promise<Document>((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      frame.removeEventListener("load", onLoad);
      callback();
    };
    const onLoad = (): void => {
      const doc = frame.contentDocument;
      if (!doc) {
        finish(() => reject(new Error("目标页与当前页面不同源，无法读取 DOM。请配置同源代理。")));
        return;
      }
      finish(() => resolve(doc));
    };
    timer = window.setTimeout(() => {
      finish(() => reject(new Error("目标页加载超时（20s）。")));
    }, 20000);
    frame.addEventListener("load", onLoad);
    frame.src = source;
  });
}

export function FlowRunDialog({
  open,
  flow,
  records,
  onClose,
}: {
  open: boolean;
  flow: FlowItem;
  records: OperationRecord[];
  onClose: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hostRef = useRef<{ dispose(): void } | null>(null);
  const pausedRef = useRef(false);
  const resumeRef = useRef<(() => void) | null>(null);
  const interventionRef = useRef<((decision: NodeFailureDecision) => void) | null>(null);
  const runtimeValuesRef = useRef<Record<string, unknown> | null>(null);
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [statusText, setStatusText] = useState("点「开始运行」加载目标页并按画布顺序执行。");
  const [items, setItems] = useState<RunItem[]>([]);
  const [vars, setVars] = useState<Record<string, unknown>>({});
  const [failure, setFailure] = useState<NodeFailureInfo | null>(null);
  const [extractValue, setExtractValue] = useState("");
  const [frameUrl, setFrameUrl] = useState("");
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | null>(null);
  const [asideTab, setAsideTab] = useState<"run" | "tune">("run");
  const [inputTuning, setInputTuning] = useState<Record<string, string>>({});
  const [pickerTuning, setPickerTuning] = useState<Record<string, PickerDraft>>({});
  const [extractTuning, setExtractTuning] = useState<Record<string, ExtractEditor>>({});

  const recordMap = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const compiledState = useMemo(() => {
    try {
      return { value: compileFlow(flow, records), error: null as string | null };
    } catch (error) {
      return {
        value: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [flow, records]);
  const firstRecord = useMemo(() => {
    const node = flow.graph?.nodes.find((item) => item.kind === "record");
    return node && node.kind === "record" ? recordMap.get(node.recordId) : undefined;
  }, [flow.graph, recordMap]);

  const groupLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const node of flow.graph?.nodes ?? []) {
      if (node.kind === "record") {
        labels.set(node.id, recordMap.get(node.recordId)?.name ?? "记录已删除");
      } else {
        const name = effectiveExtractName(flow.graph, node.id, node.varName);
        labels.set(node.id, `取值 ${name || "未命名"}`);
      }
    }
    return labels;
  }, [flow.graph, recordMap]);

  const tuningGroups = useMemo<TuningGroup[]>(() => {
    const dsl = compiledState.value?.dsl;
    if (!dsl) return [];
    const groups: TuningGroup[] = [];
    const byMacro = new Map<string, TuningGroup>();
    for (const node of flow.graph?.nodes ?? []) {
      if (node.kind !== "record") continue;
      const group: TuningGroup = {
        macroId: node.id,
        recordName: recordMap.get(node.recordId)?.name ?? "记录已删除",
        nodes: [],
      };
      groups.push(group);
      byMacro.set(node.id, group);
    }
    for (const node of dsl.nodes) {
      const macroId = typeof node.meta?.flowNodeId === "string" ? node.meta.flowNodeId : "";
      const group = byMacro.get(macroId);
      if (!group) continue;
      if (node.type === "interact") {
        if (!EDITABLE_INTERACT.has(node.adapter)) continue;
        group.nodes.push({ microId: node.id, node });
      } else if (node.type === "picker" || node.type === "extract") {
        group.nodes.push({ microId: node.id, node });
      }
    }
    for (const node of flow.graph?.nodes ?? []) {
      if (node.kind !== "extract") continue;
      const tunable = dsl.nodes.filter(
        (item): item is InteractNode | PickerNode | ExtractNode =>
          item.meta?.flowNodeId === node.id &&
          ((item.type === "interact" && EDITABLE_INTERACT.has(item.adapter)) ||
            item.type === "picker" ||
            item.type === "extract"),
      );
      if (tunable.length === 0) continue;
      const primary = tunable.find((item): item is ExtractNode => item.type === "extract");
      const name =
        primary?.varName || effectiveExtractName(flow.graph, node.id, node.varName);
      groups.push({
        macroId: node.id,
        recordName: `取值 ${name || "未命名"}`,
        nodes: tunable.map((item) => ({ microId: item.id, node: item })),
      });
    }
    return groups;
  }, [compiledState.value, flow.graph, recordMap]);

  const setInputTuningValue = (microNodeId: string, value: string): void => {
    setInputTuning((current) => {
      const next = { ...current };
      if (value) next[microNodeId] = value;
      else delete next[microNodeId];
      return next;
    });
    // 引擎在节点执行时才读取 values，同一个对象上的属性更新会生效。
    const runtime = runtimeValuesRef.current;
    if (runtime) {
      if (value) runtime[microNodeId] = value;
      else delete runtime[microNodeId];
    }
  };

  const patchPickerTuning = (
    microNodeId: string,
    node: PickerNode,
    patch: Partial<PickerDraft>,
  ): void => {
    const next = { ...(pickerTuning[microNodeId] ?? defaultPickerDraft(node)), ...patch };
    setPickerTuning((current) => ({ ...current, [microNodeId]: next }));
    const runtime = runtimeValuesRef.current;
    if (runtime) runtime[microNodeId] = pickerOverrideOf(next);
  };

  const patchExtractTuning = (
    microNodeId: string,
    node: ExtractNode,
    editor: ExtractEditor,
  ): void => {
    setExtractTuning((current) => ({ ...current, [microNodeId]: editor }));
    const runtime = runtimeValuesRef.current;
    if (!runtime) return;
    const diff = extractTuningDiff(editor, recordedExtractEditor(node)).tuning;
    if (diff) runtime[microNodeId] = diff;
    else delete runtime[microNodeId];
  };

  const reset = (): void => {
    setPhase("idle");
    setStatusText("点「开始运行」加载目标页并按画布顺序执行。");
    setItems([]);
    setVars({});
    setFailure(null);
    setExtractValue("");
  };

  useEffect(() => {
    if (!open) {
      pausedRef.current = false;
      resumeRef.current?.();
      resumeRef.current = null;
      interventionRef.current?.({ action: "stop" });
      interventionRef.current = null;
      runtimeValuesRef.current = null;
      abortRef.current?.abort();
      hostRef.current?.dispose();
      hostRef.current = null;
      reset();
    }
  }, [open]);

  useEffect(
    () => () => {
      pausedRef.current = false;
      resumeRef.current?.();
      resumeRef.current = null;
      interventionRef.current?.({ action: "stop" });
      interventionRef.current = null;
      abortRef.current?.abort();
      hostRef.current?.dispose();
    },
    [],
  );

  const stop = (): void => {
    pausedRef.current = false;
    resumeRef.current?.();
    resumeRef.current = null;
    interventionRef.current?.({ action: "stop" });
    interventionRef.current = null;
    abortRef.current?.abort();
  };

  const pause = (): void => {
    if (phase !== "running") return;
    pausedRef.current = true;
    setStatusText("已请求暂停，当前节点结束后停下。");
  };

  const resume = (): void => {
    pausedRef.current = false;
    resumeRef.current?.();
    resumeRef.current = null;
    setPhase("running");
    setStatusText("运行中…");
  };

  const decideIntervention = (decision: NodeFailureDecision): void => {
    const resolve = interventionRef.current;
    if (!resolve) return;
    interventionRef.current = null;
    resolve(decision);
  };

  const continueAfterManual = (): void => {
    const name = failure?.varName;
    const value = extractValue.trim();
    decideIntervention(
      name && value ? { action: "continue", vars: { [name]: value } } : { action: "continue" },
    );
  };

  const start = async (): Promise<void> => {
    if (phase === "running" || phase === "loading" || phase === "paused") return;
    const frame = frameRef.current;
    if (!frame) return;

    reset();
    pausedRef.current = false;
    resumeRef.current = null;
    setPhase("loading");
    setStatusText("正在编译画布并加载目标系统…");
    const compiled = compiledState.value;
    if (!compiled) {
      setPhase("failed");
      setStatusText(compiledState.error ?? "画布编译失败。");
      return;
    }
    try {
      const config = firstRecord ? (proxyConfig ?? (await loadProxyConfig())) : proxyConfig;
      if (config) setProxyConfig(config);
      if (firstRecord) {
        const resolved = resolveTargetUrl(firstRecord.targetUrl, config);
        if (!resolved) throw new Error(describeTargetFailure(config, ""));

        let doc = await loadFrame(frame, resolved.url.toString());
        const token = firstRecord.systemId ? getSystemToken(firstRecord.systemId) : "";
        if (resolved.viaProxy && token.trim()) {
          injectSystemToken(doc, token);
          doc = await loadFrame(frame, resolved.url.toString());
        }
        if (doc.querySelector('input[type="password"]')) {
          setPhase("login");
          setStatusText("检测到登录页：请先在右侧完成登录，再点「开始运行」。");
          return;
        }
        if (firstRecord.systemId) saveSystemToken(firstRecord.systemId, token);
        try {
          setFrameUrl(frame.contentWindow?.location.href ?? "");
        } catch {
          setFrameUrl("");
        }
      }

      const host = createIframeHost(frame);
      hostRef.current = host;
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase("running");
      setStatusText("运行中…");
      setItems([]);

      const dsl = {
        ...compiled.dsl,
        systems: compiled.dsl.systems.map((system) => ({
          ...system,
          baseUrl: window.location.origin,
        })),
      };
      const runValues: Record<string, unknown> = { ...compiled.values };
      for (const [microNodeId, value] of Object.entries(inputTuning)) {
        if (value) runValues[microNodeId] = value;
      }
      for (const [microNodeId, draft] of Object.entries(pickerTuning)) {
        runValues[microNodeId] = pickerOverrideOf(draft);
      }
      for (const [microNodeId, editor] of Object.entries(extractTuning)) {
        const node = compiled.dsl.nodes.find(
          (item) => item.id === microNodeId && item.type === "extract",
        );
        if (!node || node.type !== "extract") continue;
        const diff = extractTuningDiff(editor, recordedExtractEditor(node)).tuning;
        if (diff) runValues[microNodeId] = diff;
        else delete runValues[microNodeId];
      }
      runtimeValuesRef.current = runValues;
      const result = await runFlow({
        dsl,
        host,
        values: runValues,
        vars: compiled.vars,
        signal: controller.signal,
        onBeforeNode: async () => {
          if (!pausedRef.current) return;
          setPhase("paused");
          setStatusText("已暂停：可在「微调」里改后续表单，完成后点「继续」。");
          await new Promise<void>((resolve) => {
            resumeRef.current = resolve;
          });
          resumeRef.current = null;
          setPhase("running");
          setStatusText("运行中…");
        },
        onNodeError: async (info) => {
          setFailure(info);
          setExtractValue("");
          setPhase("intervening");
          setStatusText(
            `节点失败：${info.name ?? info.nodeId}。可在目标页手动补全这一步，再选择继续、重试或跳过。`,
          );
          const decision = await new Promise<NodeFailureDecision>((resolve) => {
            interventionRef.current = resolve;
          });
          interventionRef.current = null;
          setFailure(null);
          setExtractValue("");
          if (decision.action === "retry") {
            setPhase("running");
            setStatusText("正在重试失败节点…");
          } else if (decision.action === "skip") {
            setPhase("running");
            setStatusText("已跳过失败节点，继续执行…");
          } else if (decision.action === "continue") {
            setPhase("running");
            setStatusText("已按人工补全继续执行…");
          }
          return decision;
        },
        onEvent: (event) => {
          if (event.type === "run.started") {
            setStatusText(`运行中 · 0/${event.totalNodes} 节点`);
            return;
          }
          if (event.type === "node.started") {
            setItems((current) => {
              // 重试会再次发出 node.started：复用原有行，不追加重复记录。
              if (current.some((item) => item.nodeId === event.nodeId)) {
                return current.map((item) =>
                  item.nodeId === event.nodeId
                    ? {
                        ...item,
                        name: event.name,
                        groupId: event.groupId,
                        status: "running",
                        message: "执行中…",
                        durationMs: undefined,
                      }
                    : item,
                );
              }
              return [
                ...current,
                {
                  nodeId: event.nodeId,
                  name: event.name,
                  groupId: event.groupId,
                  status: "running",
                  message: "执行中…",
                },
              ];
            });
            return;
          }
          if (event.type === "node.finished") {
            setItems((current) =>
              current.map((item) =>
                item.nodeId === event.node.nodeId
                  ? {
                      ...item,
                      status: event.node.status,
                      message: event.node.message,
                      durationMs: event.node.durationMs,
                    }
                  : item,
              ),
            );
            return;
          }
          if (event.type === "var.set") {
            setVars((current) => ({ ...current, [event.name]: event.value }));
            return;
          }
          setFailure(null);
          setPhase(event.status === "finished" ? "finished" : "failed");
          setStatusText(
            event.status === "finished"
              ? `完成 · ${event.passed}/${event.total} 节点通过`
              : `${event.status === "canceled" ? "已取消" : "失败"} · ${event.error ?? "未知错误"}`,
          );
        },
      });
      setVars(result.vars);
      if (result.status !== "canceled") {
        setPhase(result.status === "finished" ? "finished" : "failed");
        setStatusText(
          result.status === "finished"
            ? `完成 · ${result.nodes.filter((node) => node.status === "pass" || node.status === "healed" || node.status === "manual").length}/${result.nodes.length} 节点通过`
            : `失败 · ${result.error ?? "未知错误"}`,
        );
      } else {
        setPhase("idle");
        setStatusText("已取消运行。");
      }
    } catch (error) {
      setPhase("failed");
      setStatusText(`运行失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      hostRef.current?.dispose();
      hostRef.current = null;
      abortRef.current = null;
      runtimeValuesRef.current = null;
      pausedRef.current = false;
      resumeRef.current = null;
    }
  };

  const tunedCount =
    Object.keys(inputTuning).length +
    Object.keys(pickerTuning).length +
    Object.keys(extractTuning).length;
  const active =
    phase === "running" || phase === "loading" || phase === "paused" || phase === "intervening";
  const phaseVariant =
    phase === "finished"
      ? "moss"
      : phase === "failed" || phase === "intervening"
        ? "destructive"
        : phase === "login" || phase === "paused"
          ? "amber"
          : phase === "running"
            ? "accent"
            : "secondary";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="w-[95vw] max-w-[95vw] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="size-4 text-accent" />
            运行流程 · {flow.name}
          </DialogTitle>
          <DialogDescription>
            按画布顺序执行操作记录与取值节点；取值节点产出的环境变量会注入下一条记录的筛选值。
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="min-h-0 flex-1 overflow-hidden p-0">
          <div className="flex h-[calc(100vh-190px)] min-h-[460px] flex-col lg:flex-row">
            <div className="relative min-h-[320px] flex-1 bg-white">
              <iframe
                ref={frameRef}
                title="流程运行窗口"
                className="h-full min-h-[320px] w-full bg-white"
              />
              {phase === "idle" ? (
                <div className="pointer-events-none absolute inset-0 grid place-items-center bg-paper/75 p-8 text-center backdrop-blur-[2px]">
                  <div className="max-w-[320px]">
                    <div className="mx-auto grid size-11 place-items-center rounded-xl border border-line bg-white text-accent">
                      <Play className="size-5" />
                    </div>
                    <h3 className="mt-3 text-[14px] font-semibold">目标系统尚未加载</h3>
                    <p className="mt-1 text-[12px] leading-5 text-muted">
                      点下方「开始运行」加载目标页；遇到登录页时先在窗口内登录，再重新运行。
                    </p>
                  </div>
                </div>
              ) : null}
              {frameUrl ? (
                <div className="absolute bottom-2 left-2 max-w-[70%] truncate rounded-md border border-line bg-white/90 px-2 py-1 font-mono text-[10px] text-muted">
                  {frameUrl}
                </div>
              ) : null}
            </div>

            <aside className="flex w-full shrink-0 flex-col border-t border-line bg-panel/70 lg:w-[460px] lg:border-l lg:border-t-0">
              <div className="border-b border-line px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] font-semibold">运行状态</span>
                  <Badge variant={phaseVariant}>{PHASE_LABEL[phase]}</Badge>
                </div>
                <p className="mt-1 break-words text-[11.5px] leading-5 text-muted">{statusText}</p>
              </div>

              {phase === "intervening" && failure ? (
                <div className="shrink-0 border-b border-danger/20 bg-[#fdf3f0] px-4 py-3">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-danger">
                    <TriangleAlert className="size-3.5" />
                    节点失败：{failure.name ?? failure.nodeId}
                  </div>
                  <p className="mt-1 break-words font-mono text-[10.5px] leading-4 text-danger/80">
                    {failure.message}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-4 text-muted">
                    可直接在左侧目标页手动完成这一步，然后点「已补全，继续」。继续不会重复执行该节点。
                  </p>
                  {failure.varName ? (
                    <div className="mt-2">
                      <span className="mb-1 block font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted">
                        变量 {failure.varName}
                      </span>
                      <Input
                        className="h-7 text-[11.5px]"
                        value={extractValue}
                        placeholder="手动补写变量值，留空则不写入"
                        onChange={(event) => setExtractValue(event.target.value)}
                      />
                    </div>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Button size="sm" onClick={continueAfterManual}>
                      <Check />
                      已补全，继续
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decideIntervention({ action: "retry" })}
                    >
                      <RefreshCw />
                      重试节点
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => decideIntervention({ action: "skip" })}
                    >
                      <SkipForward />
                      跳过节点
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[10px] leading-4 text-muted">
                    重试会再次执行该节点；若已手动提交，可能产生重复操作。
                  </p>
                </div>
              ) : null}

              <div className="flex shrink-0 border-b border-line">
                <button
                  type="button"
                  className={cn(
                    "flex-1 border-r border-line px-3 py-2 text-[11.5px] font-medium transition-colors",
                    asideTab === "run" ? "bg-white text-ink" : "text-muted hover:text-ink",
                  )}
                  onClick={() => setAsideTab("run")}
                >
                  执行
                </button>
                <button
                  type="button"
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-[11.5px] font-medium transition-colors",
                    asideTab === "tune" ? "bg-white text-ink" : "text-muted hover:text-ink",
                  )}
                  onClick={() => setAsideTab("tune")}
                >
                  <SlidersHorizontal className="size-3.5" />
                  微调
                  {tunedCount > 0 ? <Badge variant="amber">{tunedCount}</Badge> : null}
                </button>
              </div>

              {asideTab === "tune" ? (
                <TuningPanel
                  groups={tuningGroups}
                  items={items}
                  inputValues={inputTuning}
                  pickerValues={pickerTuning}
                  extractValues={extractTuning}
                  valueOverrides={compiledState.value?.values ?? {}}
                  onInputChange={setInputTuningValue}
                  onPickerChange={patchPickerTuning}
                  onExtractChange={patchExtractTuning}
                />
              ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {items.length === 0 ? (
                  <p className="text-[11.5px] leading-5 text-muted">还没有执行节点。</p>
                ) : (
                  <ol className="grid gap-2">
                    {items.map((item) => (
                      <li key={item.nodeId} className="rounded-lg border border-line bg-white px-2.5 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                            {item.name ?? item.nodeId}
                          </span>
                          {item.durationMs !== undefined ? (
                            <span className="font-mono text-[9.5px] text-muted">{item.durationMs}ms</span>
                          ) : null}
                          <Badge variant={ITEM_BADGE[item.status].variant}>
                            {ITEM_BADGE[item.status].label}
                          </Badge>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted">
                          {item.groupId ? (groupLabels.get(item.groupId) ?? item.groupId) : "—"}
                        </div>
                        <p className="mt-0.5 break-words text-[10.5px] leading-4 text-muted">
                          {item.message}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}

                {Object.keys(vars).length > 0 ? (
                  <div className="mt-4 rounded-lg border border-line bg-white p-2.5">
                    <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted">
                      ENV · 运行变量
                    </div>
                    <div className="mt-1.5 grid gap-1">
                      {Object.entries(vars).map(([name, value]) => (
                        <div key={name} className="flex items-start gap-2 text-[11px]">
                          <span className="shrink-0 font-mono text-accent">{name}</span>
                          <span className="min-w-0 break-all text-muted">{String(value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              )}
            </aside>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 sm:justify-between">
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <TriangleAlert className="size-3.5" />
            运行会真实写入目标系统数据，重复执行可能产生重复记录。
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              <X />
              关闭
            </Button>
            {active ? (
              <>
                {phase === "paused" ? (
                  <Button variant="default" onClick={resume}>
                    <Play />
                    继续
                  </Button>
                ) : phase === "intervening" ? null : (
                  <Button variant="outline" onClick={pause} disabled={phase !== "running"}>
                    <Pause />
                    暂停
                  </Button>
                )}
                <Button variant="destructive" onClick={stop}>
                  <Loader2 className="animate-spin" />
                  停止
                </Button>
              </>
            ) : (
              <Button variant="default" onClick={() => void start()}>
                <Play />
                {phase === "login" ? "重新运行" : "开始运行"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TuningPanel({
  groups,
  items,
  inputValues,
  pickerValues,
  extractValues,
  valueOverrides,
  onInputChange,
  onPickerChange,
  onExtractChange,
}: {
  groups: TuningGroup[];
  items: RunItem[];
  inputValues: Record<string, string>;
  pickerValues: Record<string, PickerDraft>;
  extractValues: Record<string, ExtractEditor>;
  valueOverrides: Record<string, unknown>;
  onInputChange: (microNodeId: string, value: string) => void;
  onPickerChange: (microNodeId: string, node: PickerNode, patch: Partial<PickerDraft>) => void;
  onExtractChange: (microNodeId: string, node: ExtractNode, editor: ExtractEditor) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <p className="px-4 py-2.5 text-[11px] leading-4 text-muted">
        运行中可改尚未执行的字段；留空表示使用画布注入或录制值。执行中的记录也能改，但已执行的步骤不会被回写。
      </p>

      {groups.length === 0 ? (
        <p className="px-4 pb-3 text-[11.5px] leading-5 text-muted">流程里还没有操作记录节点。</p>
      ) : (
        <Table className="table-fixed">
          <TableHeader className="sticky top-0 z-10 bg-panel">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8 px-2">#</TableHead>
              <TableHead className="w-[108px] px-2">节点</TableHead>
              <TableHead className="w-[92px] px-2">可调项</TableHead>
              <TableHead className="px-2">回放值</TableHead>
              <TableHead className="w-8 px-1" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => {
              const groupItems = items.filter((item) => item.groupId === group.macroId);
              const running = groupItems.some((item) => item.status === "running");
              const failed = groupItems.some((item) => item.status === "fail");
              const finished =
                groupItems.length > 0 &&
                !running &&
                groupItems.every(
                  (item) =>
                    item.status === "pass" ||
                    item.status === "healed" ||
                    item.status === "manual" ||
                    item.status === "skipped",
                );
              const label = running
                ? "执行中"
                : failed
                  ? "失败"
                  : finished
                    ? "已执行"
                    : "未执行";
              const variant = running
                ? "accent"
                : failed
                  ? "destructive"
                  : finished
                    ? "moss"
                    : "secondary";

              return (
                <Fragment key={group.macroId}>
                  <TableRow className="bg-ink/[0.04] hover:bg-ink/[0.04]">
                    <TableCell colSpan={5} className="px-2.5 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">
                          {group.recordName}
                        </span>
                        <Badge variant={variant}>{label}</Badge>
                      </div>
                    </TableCell>
                  </TableRow>
                  {group.nodes.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="px-2.5 py-3 text-center text-[10.5px] text-muted"
                      >
                        没有可微调的字段
                      </TableCell>
                    </TableRow>
                  ) : (
                    group.nodes.map((item, nodeIndex) =>
                      item.node.type === "interact" ? (
                        <InteractTuningRows
                          key={item.microId}
                          node={item.node}
                          microId={item.microId}
                          nodeIndex={nodeIndex}
                          value={inputValues[item.microId]}
                          disabled={finished}
                          onChange={onInputChange}
                        />
                      ) : item.node.type === "picker" ? (
                        <PickerTuningRows
                          key={item.microId}
                          node={item.node}
                          microId={item.microId}
                          nodeIndex={nodeIndex}
                          draft={pickerValues[item.microId] ?? defaultPickerDraft(item.node)}
                          disabled={finished}
                          onChange={onPickerChange}
                        />
                      ) : (
                        <ExtractTuningRows
                          key={item.microId}
                          node={item.node}
                          microId={item.microId}
                          nodeIndex={nodeIndex}
                          editor={
                            extractValues[item.microId] ??
                            extractEditorOf(item.node, valueOverrides[item.microId])
                          }
                          disabled={finished}
                          onChange={onExtractChange}
                        />
                      ),
                    )
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

interface TuningTableRow {
  key: string;
  option: ReactNode;
  control: ReactNode;
  reset: () => void;
}

function InteractTuningRows({
  node,
  microId,
  nodeIndex,
  value,
  disabled,
  onChange,
}: {
  node: InteractNode;
  microId: string;
  nodeIndex: number;
  value?: string;
  disabled: boolean;
  onChange: (microNodeId: string, value: string) => void;
}) {
  const label = node.target.label ?? node.name ?? node.id;
  const isCheck = node.adapter === "check";
  const fallback = interactDefaultText(node) === "true" ? "勾选" : "取消";

  return (
    <TableRow>
      <TableCell className="px-2 py-1.5 font-mono text-[9.5px] text-muted">
        {String(nodeIndex + 1).padStart(2, "0")}
      </TableCell>
      <TableCell className="px-2 py-1.5">
        <div className="truncate text-[11px] font-medium">{label}</div>
        <Badge variant="secondary" className="mt-0.5">
          {isCheck ? "勾选" : node.adapter}
        </Badge>
      </TableCell>
      <TableCell className="px-2 py-1.5 text-[10px] leading-4 text-muted">
        {isCheck ? "勾选状态" : "输入值"}
      </TableCell>
      <TableCell className="px-2 py-1.5">
        {isCheck ? (
          <select
            className="tf-select h-7 py-1 text-[11px]"
            value={value ?? ""}
            disabled={disabled}
            onChange={(event) => onChange(microId, event.target.value)}
          >
            <option value="">跟随画布（{fallback}）</option>
            <option value="true">回放时勾选</option>
            <option value="false">回放时取消</option>
          </select>
        ) : (
          <Input
            className="h-7 text-[11.5px]"
            value={value ?? interactDefaultText(node)}
            placeholder={valueHint(node.value)}
            disabled={disabled}
            onChange={(event) => onChange(microId, event.target.value)}
          />
        )}
      </TableCell>
      <TableCell className="px-1 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          title="恢复录制值"
          aria-label="恢复录制值"
          disabled={disabled}
          onClick={() => onChange(microId, "")}
        >
          <RotateCcw className="size-3.5" />
          恢复
        </Button>
      </TableCell>
    </TableRow>
  );
}

function ExtractTuningRows({
  node,
  microId,
  nodeIndex,
  editor,
  disabled,
  onChange,
}: {
  node: ExtractNode;
  microId: string;
  nodeIndex: number;
  editor: ExtractEditor;
  disabled: boolean;
  onChange: (microNodeId: string, node: ExtractNode, editor: ExtractEditor) => void;
}) {
  const label =
    node.source === "response" || node.source === "js" || node.source === "const"
      ? (node.name ?? node.varName ?? node.id)
      : (node.target.label ?? node.name ?? node.varName ?? node.id);
  const sourceLabel =
    editor.source === "response"
      ? "接口"
      : editor.source === "js"
        ? "JS"
        : editor.source === "const"
          ? "手动"
          : "DOM";

  return (
    <TableRow>
      <TableCell className="px-2 py-1.5 font-mono text-[9.5px] text-muted">
        {String(nodeIndex + 1).padStart(2, "0")}
      </TableCell>
      <TableCell className="px-2 py-1.5">
        <div className="truncate text-[11px] font-medium">{label}</div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          <Badge variant="secondary">取值</Badge>
          <Badge variant="outline">{sourceLabel}</Badge>
        </div>
        <div className="mt-0.5 truncate font-mono text-[9.5px] text-muted">
          {node.varName || "未命名"}
        </div>
      </TableCell>
      <TableCell className="px-2 py-1.5 text-[10px] leading-4 text-muted">
        取值配置
      </TableCell>
      <TableCell className="px-2 py-1.5">
        <fieldset disabled={disabled} className="min-w-0">
          <ExtractTuningFields
            editor={editor}
            onChange={(next) => onChange(microId, node, next)}
          />
        </fieldset>
      </TableCell>
      <TableCell className="px-1 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          title="恢复录制值"
          aria-label="恢复取值配置"
          disabled={disabled}
          onClick={() => onChange(microId, node, recordedExtractEditor(node))}
        >
          <RotateCcw className="size-3.5" />
          恢复
        </Button>
      </TableCell>
    </TableRow>
  );
}

function PickerTuningRows({
  node,
  microId,
  nodeIndex,
  draft,
  disabled,
  onChange,
}: {
  node: PickerNode;
  microId: string;
  nodeIndex: number;
  draft: PickerDraft;
  disabled: boolean;
  onChange: (microNodeId: string, node: PickerNode, patch: Partial<PickerDraft>) => void;
}) {
  const label = node.trigger.label ?? node.name ?? node.id;
  const defaultDraft = defaultPickerDraft(node);
  const filterSteps = (node.filter?.steps ?? [])
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.adapter === "input" || step.adapter === "nativeSelect");
  const patch = (next: Partial<PickerDraft>): void => onChange(microId, node, next);
  const changeStrategy = (strategy: PickerStrategy): void => {
    const next: Partial<PickerDraft> = { strategy };
    if (strategy === "byIndex" && draft.indexes.length === 0) {
      next.indexes =
        defaultDraft.strategy === "byIndex"
          ? defaultDraft.indexes
          : draft.picks.length > 0
            ? draft.picks.map((_, index) => String(index + 1))
            : ["1"];
    }
    if ((strategy === "byText" || strategy === "byRow") && draft.picks.length === 0) {
      next.picks = defaultDraft.strategy === strategy ? defaultDraft.picks : [""];
    }
    patch(next);
  };

  const rows: TuningTableRow[] = [];
  rows.push({
    key: "strategy",
    option: "定位方式",
    control: (
      <select
        className="tf-select h-7 py-1 text-[11px]"
        value={draft.strategy}
        disabled={disabled}
        onChange={(event) => changeStrategy(event.target.value as PickerStrategy)}
      >
        {(Object.keys(PICKER_STRATEGY_LABEL) as PickerStrategy[]).map((strategy) => (
          <option key={strategy} value={strategy}>
            {PICKER_STRATEGY_LABEL[strategy]}
          </option>
        ))}
      </select>
    ),
    reset: () =>
      patch({
        strategy: defaultDraft.strategy,
        indexes: defaultDraft.indexes,
        picks: defaultDraft.picks,
        on: defaultDraft.on,
      }),
  });

  for (const { step, index } of filterSteps) {
    rows.push({
      key: `filter-${index}`,
      option: (
        <span className="block truncate">
          筛选值 <span className="text-muted/70">{step.target.label ?? step.adapter}</span>
        </span>
      ),
      control: (
        <Input
          className="h-7 text-[11.5px]"
          value={draft.filters[index] ?? ""}
          placeholder={valueHint(step.value)}
          disabled={disabled}
          onChange={(event) => {
            const filters = [...draft.filters];
            while (filters.length <= index) filters.push("");
            filters[index] = event.target.value;
            patch({ filters });
          }}
        />
      ),
      reset: () => {
        const filters = [...draft.filters];
        while (filters.length <= index) filters.push("");
        filters[index] = defaultDraft.filters[index] ?? "";
        patch({ filters });
      },
    });
  }

  if (draft.strategy === "byIndex") {
    draft.indexes.forEach((indexValue, index) => {
      rows.push({
        key: `index-${index}`,
        option: `位置 ${index + 1}`,
        control: (
          <Input
            type="number"
            min={1}
            step={1}
            className="h-7 text-[11.5px]"
            value={indexValue}
            disabled={disabled}
            onChange={(event) => {
              const indexes = [...draft.indexes];
              indexes[index] = event.target.value;
              patch({ indexes });
            }}
          />
        ),
        reset: () => {
          const indexes = [...draft.indexes];
          indexes[index] = defaultDraft.indexes[index] ?? "1";
          patch({ indexes });
        },
      });
    });
    rows.push({
      key: "on",
      option: "点击目标",
      control: (
        <select
          className="tf-select h-7 py-1 text-[11px]"
          value={draft.on}
          disabled={disabled}
          onChange={(event) => patch({ on: event.target.value as "item" | "row" })}
        >
          <option value="item">选项本身</option>
          <option value="row">表格行</option>
        </select>
      ),
      reset: () => patch({ on: defaultDraft.on }),
    });
  } else if (draft.strategy === "firstVisible") {
    rows.push({
      key: "first",
      option: "选择结果",
      control: <span className="text-[10px] text-moss">自动选第一条可见结果</span>,
      reset: () => undefined,
    });
    rows.push({
      key: "on",
      option: "点击目标",
      control: (
        <select
          className="tf-select h-7 py-1 text-[11px]"
          value={draft.on}
          disabled={disabled}
          onChange={(event) => patch({ on: event.target.value as "item" | "row" })}
        >
          <option value="item">选项本身</option>
          <option value="row">表格行</option>
        </select>
      ),
      reset: () => patch({ on: defaultDraft.on }),
    });
  } else {
    draft.picks.forEach((pick, index) => {
      rows.push({
        key: `pick-${index}`,
        option: `选择项 ${index + 1}`,
        control: (
          <Input
            className="h-7 text-[11.5px]"
            value={pick}
            placeholder={pickHint(node, index)}
            disabled={disabled}
            onChange={(event) => {
              const picks = [...draft.picks];
              picks[index] = event.target.value;
              patch({ picks });
            }}
          />
        ),
        reset: () => {
          const picks = [...draft.picks];
          picks[index] = defaultDraft.picks[index] ?? "";
          patch({ picks });
        },
      });
    });
  }

  return (
    <>
      {rows.map((row, index) => (
        <TableRow key={row.key}>
          {index === 0 ? (
            <>
              <TableCell
                rowSpan={rows.length}
                className="px-2 py-1.5 align-top font-mono text-[9.5px] text-muted"
              >
                {String(nodeIndex + 1).padStart(2, "0")}
              </TableCell>
              <TableCell rowSpan={rows.length} className="px-2 py-1.5 align-top">
                <div className="truncate text-[11px] font-medium">{label}</div>
                <Badge variant="secondary" className="mt-0.5">
                  选择器
                </Badge>
              </TableCell>
            </>
          ) : null}
          <TableCell className="px-2 py-1.5 text-[10px] leading-4 text-muted">
            {row.option}
          </TableCell>
          <TableCell className="px-2 py-1.5">{row.control}</TableCell>
          <TableCell className="px-1 py-1.5">
            <Button
              size="sm"
              variant="ghost"
              title="恢复录制值"
              aria-label="恢复录制值"
              disabled={disabled || row.key === "first"}
              onClick={row.reset}
            >
              <RotateCcw className="size-3.5" />
              恢复
            </Button>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function pickHint(node: PickerNode, index: number): string {
  const recorded = node.pick.values?.[index]?.value;
  if (recorded) return `录制值 ${recorded}`;
  const raw = node.pick.byText?.value ?? node.pick.byRow?.keyValue;
  if (Array.isArray(raw)) return valueHint(raw[index] as ValueLike);
  return valueHint(raw);
}

