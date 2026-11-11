import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Check,
  CirclePause,
  FileJson,
  ListOrdered,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipForward,
  SlidersHorizontal,
  Square,
  TriangleAlert,
  Variable,
  X,
} from "lucide-react";

import { ApiCallRows, type ApiCallEntry } from "@/components/ApiCallLog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { createIframeHost, RunController, type ReplayNodeStatus } from "@/replay/index.ts";
import type {
  CapturedHttpResponse,
  IframeHost,
  InterventionRequest,
  StepAttemptRecord,
} from "@/replay/index.ts";
import type {
  ExtractNode,
  FailureKind,
  FlowDsl,
  FlowNode,
  InteractNode,
  PickerNode,
  ValueLike,
} from "@/dsl/index.ts";
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
  /** 该节点全部执行尝试；重试后用于展示尝试时间线。 */
  attempts?: StepAttemptRecord[];
  failureKind?: FailureKind;
  /** 自动重试次数（不含首次）。 */
  retries?: number;
}

type PickerStrategy = "byText" | "byRow" | "byIndex" | "firstVisible";

const FOLLOW_CANVAS = "__canvas__";

interface PickerDraft {
  strategy: PickerStrategy;
  filters: string[];
  picks: string[];
  indexes: string[];
  on: "item" | "row";
}

interface RunStep {
  microId: string;
  node: FlowNode;
  groupId?: string;
  groupLabel: string;
  /** 全局执行序号（1 基），与运行日志同序。 */
  index: number;
  tunable: "interact" | "picker" | "extract" | null;
}

/** 回放宿主捕获的接口 → 接口日志条目。 */
function toApiCall(entry: CapturedHttpResponse): ApiCallEntry {
  return {
    method: entry.method,
    url: entry.url,
    status: entry.status || undefined,
    contentType: entry.contentType,
    params: entry.requestBody,
    response: entry.responseBody || undefined,
  };
}

type StepStatus = "pending" | RunItem["status"];

const EDITABLE_INTERACT = new Set(["input", "select", "nativeSelect", "check"]);

const PICKER_STRATEGY_LABEL: Record<PickerStrategy, string> = {
  byText: "按文本",
  byRow: "按行文本",
  byIndex: "按位置",
  firstVisible: "筛选后第一项",
};

const INTERACT_KIND: Record<string, string> = {
  input: "输入",
  select: "下拉",
  nativeSelect: "下拉",
  check: "勾选",
  click: "点击",
  press: "按键",
  hover: "悬停",
  upload: "上传",
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

type BadgeVariant =
  | "secondary"
  | "moss"
  | "accent"
  | "amber"
  | "destructive"
  | "running";

const ITEM_BADGE: Record<RunItem["status"], { label: string; variant: BadgeVariant }> = {
  running: { label: "执行中", variant: "running" },
  pass: { label: "通过", variant: "moss" },
  healed: { label: "自愈", variant: "amber" },
  manual: { label: "人工完成", variant: "accent" },
  fail: { label: "失败", variant: "destructive" },
  skipped: { label: "跳过", variant: "secondary" },
};

const STEP_BADGE: Record<StepStatus, { label: string; variant: BadgeVariant }> = {
  pending: { label: "待执行", variant: "secondary" },
  ...ITEM_BADGE,
};

const FAILURE_KIND_LABEL: Record<FailureKind, string> = {
  "not-executed": "未执行",
  partial: "部分已提交",
  unknown: "状态未知",
  assertion: "校验失败",
  interrupted: "被暂停中断",
};

const ATTEMPT_STATUS_LABEL: Record<StepAttemptRecord["status"], string> = {
  passed: "通过",
  healed: "自愈",
  failed: "失败",
  interrupted: "中断",
};

/** 中性行底 + 状态圆点 + 状态文字；只有执行中/失败用浅色底，其余状态保持安静。 */
const STEP_TONE: Record<StepStatus, { row: string; dot: string; text: string }> = {
  pending: { row: "bg-panel", dot: "border border-muted/40", text: "text-muted/70" },
  running: { row: "bg-running/10", dot: "bg-running ring-2 ring-running/20", text: "text-running" },
  pass: { row: "bg-panel", dot: "bg-moss", text: "text-moss" },
  healed: { row: "bg-panel", dot: "bg-amber", text: "text-amber" },
  manual: { row: "bg-panel", dot: "bg-accent", text: "text-accent" },
  fail: { row: "bg-danger/10", dot: "bg-danger ring-2 ring-danger/20", text: "text-danger" },
  skipped: { row: "bg-panel", dot: "border border-muted/30", text: "text-muted/70" },
};

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

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

/** 输入/勾选的默认值：记录级微调值优先，其次是录制值。 */
function interactBaseline(node: InteractNode, override: unknown): string {
  if (node.adapter === "check") {
    if (typeof override === "boolean") return String(override);
    const text = readValueText(override);
    if (text === "true" || text === "false") return text;
    return String(node.checked ?? literalText(node.value) === "true");
  }
  if (override !== undefined && override !== null) return readValueText(override);
  return literalText(node.value);
}

/** 选择器的默认草稿：记录级微调值覆盖录制值。 */
function pickerBaseline(node: PickerNode, override: unknown): PickerDraft {
  const base = defaultPickerDraft(node);
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const record = override as {
    strategy?: unknown;
    filters?: unknown;
    picks?: unknown;
    indexes?: unknown;
    on?: unknown;
  };
  return {
    strategy:
      record.strategy === "byText" ||
      record.strategy === "byRow" ||
      record.strategy === "byIndex" ||
      record.strategy === "firstVisible"
        ? record.strategy
        : base.strategy,
    filters: Array.isArray(record.filters)
      ? record.filters.map((item) => String(item))
      : base.filters,
    picks: Array.isArray(record.picks) ? record.picks.map((item) => String(item)) : base.picks,
    indexes: Array.isArray(record.indexes)
      ? record.indexes.map((item) => String(item))
      : base.indexes,
    on: record.on === "item" || record.on === "row" ? record.on : base.on,
  };
}

function sameTextList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function pickerDraftEquals(a: PickerDraft, b: PickerDraft): boolean {
  if (a.strategy !== b.strategy || a.on !== b.on) return false;
  if (!sameTextList(a.filters, b.filters)) return false;
  return a.strategy === "byIndex"
    ? sameTextList(a.indexes, b.indexes)
    : sameTextList(a.picks, b.picks);
}

function stepLabel(node: FlowNode): string {
  switch (node.type) {
    case "interact":
      return node.target.label ?? node.name ?? node.id;
    case "picker":
      return node.trigger.label ?? node.name ?? node.id;
    case "extract":
      return node.source === "response" || node.source === "js" || node.source === "const"
        ? (node.name ?? node.varName ?? node.id)
        : (node.target.label ?? node.name ?? node.varName ?? node.id);
    case "navigate":
      return node.name ?? "页面导航";
    case "wait":
      return node.name ?? "等待";
  }
}

function stepKind(node: FlowNode): string {
  if (node.type === "interact") return INTERACT_KIND[node.adapter] ?? node.adapter;
  if (node.type === "picker") return "选择器";
  if (node.type === "extract") {
    const source =
      node.source === "response"
        ? "接口"
        : node.source === "js"
          ? "脚本"
          : node.source === "const"
            ? "手动"
            : "页面";
    return `取值·${source}`;
  }
  return node.type === "navigate" ? "导航" : "等待";
}

function tunableKindOf(node: FlowNode): RunStep["tunable"] {
  if (node.type === "interact") return EDITABLE_INTERACT.has(node.adapter) ? "interact" : null;
  if (node.type === "picker") return "picker";
  if (node.type === "extract") return "extract";
  return null;
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
  const controllerRef = useRef<RunController | null>(null);
  const hostRef = useRef<IframeHost | null>(null);
  const apiTimerRef = useRef<number | undefined>(undefined);
  const apiSignatureRef = useRef("");
  const runtimeValuesRef = useRef<Record<string, unknown> | null>(null);
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [statusText, setStatusText] = useState("点「开始运行」加载目标页并按画布顺序执行。");
  const [items, setItems] = useState<RunItem[]>([]);
  const [apiCalls, setApiCalls] = useState<ApiCallEntry[]>([]);
  const [vars, setVars] = useState<Record<string, unknown>>({});
  const [failure, setFailure] = useState<InterventionRequest | null>(null);
  const [extractValue, setExtractValue] = useState("");
  const [verifyOnContinue, setVerifyOnContinue] = useState(true);
  const [frameUrl, setFrameUrl] = useState("");
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | null>(null);
  const [inputTuning, setInputTuning] = useState<Record<string, string>>({});
  const [pickerTuning, setPickerTuning] = useState<Record<string, PickerDraft>>({});
  const [extractTuning, setExtractTuning] = useState<Record<string, ExtractEditor>>({});
  const [stepFilter, setStepFilter] = useState<"all" | "tunable">("all");
  const stepRefs = useRef(new Map<string, HTMLLIElement>());

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

  // 与运行引擎同构：从 entry 沿第一条出边走到底，显示顺序即执行顺序。
  const executionSteps = useMemo<RunStep[]>(() => {
    const compiled = compiledState.value;
    if (!compiled) return [];
    const dsl = compiled.dsl;
    const byId = new Map(dsl.nodes.map((node) => [node.id, node]));
    const nextById = new Map<string, string>();
    for (const edge of dsl.edges) {
      if (!nextById.has(edge.from)) nextById.set(edge.from, edge.to);
    }
    const steps: RunStep[] = [];
    const seen = new Set<string>();
    let current: string | undefined = dsl.entry;
    while (current && !seen.has(current)) {
      const node = byId.get(current);
      if (!node) break;
      seen.add(current);
      const groupId =
        typeof node.meta?.flowNodeId === "string" ? node.meta.flowNodeId : undefined;
      steps.push({
        microId: node.id,
        node,
        groupId,
        groupLabel: groupId ? (groupLabels.get(groupId) ?? groupId) : "独立步骤",
        index: steps.length + 1,
        tunable: tunableKindOf(node),
      });
      current = nextById.get(current);
    }
    return steps;
  }, [compiledState.value, groupLabels]);

  const unreachableCount = Math.max(
    0,
    (compiledState.value?.dsl.nodes.length ?? 0) - executionSteps.length,
  );

  const itemMap = useMemo(
    () => new Map(items.map((item) => [item.nodeId, item])),
    [items],
  );

  const injectionLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const injection of flow.graph?.injections ?? []) {
      const microId = `${injection.recordNodeId}::${injection.dslNodeId}`;
      const source =
        injection.source.kind === "var"
          ? `变量 ${injection.source.name}`
          : `字面值 ${injection.source.value === "" ? "空" : injection.source.value}`;
      labels.set(
        injection.slot === "filter"
          ? `${microId}|filter|${injection.index ?? 0}`
          : `${microId}|input`,
        source,
      );
    }
    return labels;
  }, [flow.graph]);

  const dirtyIds = useMemo(() => {
    const dirty = new Set<string>();
    const overrides = compiledState.value?.values ?? {};
    for (const step of executionSteps) {
      const { node, microId } = step;
      if (node.type === "interact" && EDITABLE_INTERACT.has(node.adapter)) {
        const value = inputTuning[microId];
        if (value !== undefined && value !== interactBaseline(node, overrides[microId])) {
          dirty.add(microId);
        }
      } else if (node.type === "picker") {
        const draft = pickerTuning[microId];
        if (draft && !pickerDraftEquals(draft, pickerBaseline(node, overrides[microId]))) {
          dirty.add(microId);
        }
      } else if (node.type === "extract") {
        const editor = extractTuning[microId];
        if (
          editor &&
          extractTuningDiff(editor, extractEditorOf(node, overrides[microId])).tuning
        ) {
          dirty.add(microId);
        }
      }
    }
    return dirty;
  }, [executionSteps, inputTuning, pickerTuning, extractTuning, compiledState.value]);

  const activeMicroId = useMemo(() => {
    const running = items.find((item) => item.status === "running");
    if (running) return running.nodeId;
    if (phase === "intervening") {
      return [...items].reverse().find((item) => item.status === "fail")?.nodeId;
    }
    if (phase === "paused") {
      const done = new Set(items.map((item) => item.nodeId));
      return executionSteps.find((step) => !done.has(step.microId))?.microId;
    }
    return undefined;
  }, [items, phase, executionSteps]);

  useEffect(() => {
    if (!activeMicroId) return;
    stepRefs.current
      .get(activeMicroId)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeMicroId]);

  /** 失败节点所属画布分组：有分组才显示「重试本组」。 */
  const currentFailureGroupId = useMemo(() => {
    if (!failure) return undefined;
    return executionSteps.find((step) => step.microId === failure.nodeId)?.groupId;
  }, [failure, executionSteps]);

  /** 运行以失败/取消收尾时，尚未执行的步骤标记为「已阻断」。 */
  const blockedMode = phase === "failed" || (phase === "idle" && items.length > 0);

  const runSummary = useMemo(() => {
    const total = executionSteps.length;
    let done = 0;
    let failed = 0;
    let elapsedMs = 0;
    for (const step of executionSteps) {
      const item = itemMap.get(step.microId);
      const status = item?.status;
      if (status === "pass" || status === "healed" || status === "manual" || status === "skipped")
        done += 1;
      if (status === "fail") failed += 1;
      elapsedMs += item?.durationMs ?? 0;
    }
    const activeStep = activeMicroId
      ? executionSteps.find((step) => step.microId === activeMicroId)
      : undefined;
    const settled = done + failed;
    return {
      total,
      elapsedMs,
      tunable: executionSteps.filter((step) => step.tunable).length,
      currentStep:
        activeStep?.index ?? (phase === "finished" ? total : Math.min(total, settled + 1)),
      currentLabel: activeStep ? stepLabel(activeStep.node) : undefined,
      percent: total > 0 ? Math.round((settled / total) * 100) : 0,
    };
  }, [executionSteps, itemMap, activeMicroId, phase]);

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
    const baseline = pickerBaseline(node, compiledState.value?.values?.[microNodeId]);
    const next = { ...(pickerTuning[microNodeId] ?? baseline), ...patch };
    const dirty = !pickerDraftEquals(next, baseline);
    setPickerTuning((current) => {
      const copy = { ...current };
      if (dirty) copy[microNodeId] = next;
      else delete copy[microNodeId];
      return copy;
    });
    const runtime = runtimeValuesRef.current;
    if (runtime) {
      if (dirty) runtime[microNodeId] = pickerOverrideOf(next);
      else delete runtime[microNodeId];
    }
  };

  const resetPickerTuning = (microNodeId: string): void => {
    setPickerTuning((current) => {
      const next = { ...current };
      delete next[microNodeId];
      return next;
    });
    const runtime = runtimeValuesRef.current;
    if (runtime) delete runtime[microNodeId];
  };

  const patchExtractTuning = (
    microNodeId: string,
    node: ExtractNode,
    editor: ExtractEditor,
  ): void => {
    const baseline = extractEditorOf(node, compiledState.value?.values?.[microNodeId]);
    const dirty = extractTuningDiff(editor, baseline).tuning !== null;
    setExtractTuning((current) => {
      const next = { ...current };
      if (dirty) next[microNodeId] = editor;
      else delete next[microNodeId];
      return next;
    });
    const runtime = runtimeValuesRef.current;
    if (!runtime) return;
    const diff = extractTuningDiff(editor, recordedExtractEditor(node)).tuning;
    if (dirty && diff) runtime[microNodeId] = diff;
    else delete runtime[microNodeId];
  };

  const reset = (): void => {
    setPhase("idle");
    setStatusText("点「开始运行」加载目标页并按画布顺序执行。");
    setItems([]);
    setApiCalls([]);
    setVars({});
    setFailure(null);
    setExtractValue("");
  };

  const stopApiPolling = (): void => {
    if (apiTimerRef.current !== undefined) {
      window.clearInterval(apiTimerRef.current);
      apiTimerRef.current = undefined;
    }
  };

  const disposeRunHost = (): void => {
    stopApiPolling();
    hostRef.current?.dispose();
    hostRef.current = null;
  };

  /** 流程结束后继续观察接口，等提交响应回来再停；内容没变化时不触发重渲染。 */
  const startApiPolling = (host: IframeHost): void => {
    stopApiPolling();
    apiSignatureRef.current = "";
    const sync = (): void => {
      const captured = host.getCapturedResponses();
      const signature = captured
        .map((entry) => `${entry.method} ${entry.url} ${entry.status}`)
        .join("\n");
      if (signature === apiSignatureRef.current) return;
      apiSignatureRef.current = signature;
      setApiCalls(captured.map(toApiCall));
    };
    sync();
    apiTimerRef.current = window.setInterval(sync, 400);
  };

  useEffect(() => {
    if (!open) {
      controllerRef.current?.stop();
      controllerRef.current = null;
      runtimeValuesRef.current = null;
      disposeRunHost();
      reset();
    }
  }, [open]);

  useEffect(
    () => () => {
      controllerRef.current?.stop();
      controllerRef.current = null;
      disposeRunHost();
    },
    [],
  );

  const stop = (): void => {
    controllerRef.current?.stop();
  };

  const pause = (): void => {
    if (phase !== "running") return;
    controllerRef.current?.send({ action: "pause", mode: "after-step" });
    setStatusText("已请求暂停：当前节点结束后停下，可在下方改值。");
  };

  const pauseNow = (): void => {
    if (phase !== "running") return;
    controllerRef.current?.send({ action: "pause", mode: "immediate" });
    setStatusText("正在立即暂停：中断当前等待后进入人工处理。");
  };

  const resume = (): void => {
    controllerRef.current?.send({ action: "resume" });
    setPhase("running");
    setStatusText("运行中…");
  };

  const decideIntervention = (action: "retry" | "retryGroup" | "skip" | "stop"): void => {
    setFailure(null);
    setExtractValue("");
    if (action === "stop") {
      setStatusText("正在停止运行…");
      controllerRef.current?.send({ action: "stop" });
      return;
    }
    setPhase("running");
    if (action === "retryGroup") {
      setStatusText("正在从分组入口重试…");
      controllerRef.current?.send({ action: "retry", scope: "group" });
      return;
    }
    if (action === "retry") setStatusText("正在重试失败节点…");
    else setStatusText("已跳过失败节点，继续执行…");
    controllerRef.current?.send({ action });
  };

  const continueAfterManual = (): void => {
    const name = failure?.varName;
    const value = extractValue.trim();
    setPhase("running");
    setStatusText(
      verifyOnContinue ? "已按人工补全继续，正在校验 expect…" : "已按人工补全继续执行…",
    );
    controllerRef.current?.send({
      action: "continue",
      ...(name && value ? { vars: { [name]: value } } : {}),
      verify: verifyOnContinue,
    });
    setFailure(null);
    setExtractValue("");
  };

  const start = async (): Promise<void> => {
    if (phase === "running" || phase === "loading" || phase === "paused") return;
    const frame = frameRef.current;
    if (!frame) return;

    reset();
    disposeRunHost();
    controllerRef.current = null;
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
      // 运行期间始终抓取接口，便于查看每步提交的参数与返回结构。
      host.startNetworkCapture?.();
      setApiCalls([]);
      startApiPolling(host);
      setPhase("running");
      setStatusText("运行中…");
      setItems([]);

      // 节点副本：不再携带按步断点的运行期覆盖，执行顺序完全由画布决定。
      const dsl: FlowDsl = {
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
      const controller = new RunController({
        dsl,
        host,
        values: runValues,
        vars: compiled.vars,
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
                        message: event.attempt > 1 ? `第 ${event.attempt} 次尝试…` : "执行中…",
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
                  message: event.attempt > 1 ? `第 ${event.attempt} 次尝试…` : "执行中…",
                },
              ];
            });
            return;
          }
          if (event.type === "node.attempt") {
            setItems((current) =>
              current.map((item) =>
                item.nodeId === event.nodeId
                  ? {
                      ...item,
                      attempts: [...(item.attempts ?? []), event.attempt],
                      retries: Math.max(0, (item.attempts?.length ?? 0)),
                    }
                  : item,
              ),
            );
            return;
          }
          if (event.type === "node.finished") {
            const node = event.node;
            setItems((current) =>
              current.map((item) =>
                item.nodeId === node.nodeId
                  ? {
                      ...item,
                      status: node.status,
                      message: node.message,
                      durationMs: node.durationMs,
                      attempts: node.attempts ?? item.attempts,
                      failureKind: node.failureKind,
                      retries: Math.max(0, (node.attempts?.length ?? 1) - 1),
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
          if (event.type === "run.paused") {
            setPhase("paused");
            setStatusText(
              event.mode === "immediate"
                ? "已立即暂停：请在下方选择重试、补全或跳过。"
                : "已暂停：可在下方待执行步骤里改值，完成后点「继续」。",
            );
            return;
          }
          if (event.type === "run.resumed") {
            setPhase("running");
            setStatusText("运行中…");
            return;
          }
          if (event.type === "run.intervening") {
            setFailure(event.request);
            setExtractValue("");
            setPhase("intervening");
            setStatusText(
              `节点失败：${event.request.name ?? event.request.nodeId}。可在目标页手动补全这一步，再选择继续、重试、重试本组或跳过。`,
            );
            return;
          }
          if (event.type !== "run.finished") return;
          setFailure(null);
          setPhase(
            event.status === "finished"
              ? "finished"
              : event.status === "canceled"
                ? "idle"
                : "failed",
          );
          setStatusText(
            event.status === "finished"
              ? `完成 · ${event.passed}/${event.total} 节点通过`
              : `${event.status === "canceled" ? "已取消" : "失败"} · ${event.error ?? "未知错误"}`,
          );
        },
      });
      controllerRef.current = controller;
      const result = await controller.start();
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
      // 不在这里 dispose：提交接口的响应常在最后一个节点结束后才回来，
      // 保留宿主与轮询，等响应回填状态；关闭弹窗或下次运行时再统一释放。
      runtimeValuesRef.current = null;
    }
  };

  const active =
    phase === "running" || phase === "loading" || phase === "paused" || phase === "intervening";
  const phaseVariant: BadgeVariant =
    phase === "finished"
      ? "moss"
      : phase === "failed" || phase === "intervening"
        ? "destructive"
        : phase === "login" || phase === "paused"
          ? "amber"
          : phase === "running" || phase === "loading"
            ? "running"
            : "secondary";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="w-[95vw] max-w-[95vw] overflow-hidden">
        <DialogHeader className="pb-2.5 pt-3">
          <DialogTitle className="flex items-center gap-2">
            <Play className="size-4 text-accent" />
            运行流程 · {flow.name}
          </DialogTitle>
          <DialogDescription>
            按画布顺序执行操作记录与取值节点；取值节点产出的环境变量会注入下一条记录的筛选值。
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="min-h-0 flex-1 overflow-hidden p-0">
          <div className="flex h-[calc(100vh-152px)] min-h-[460px] flex-col lg:flex-row">
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

            <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto overflow-x-hidden border-t border-line bg-paper/70 p-3 lg:min-h-0 lg:w-[460px] lg:border-l lg:border-t-0">
              <RunStatusOverview
                phaseLabel={PHASE_LABEL[phase]}
                phaseVariant={phaseVariant}
                statusText={statusText}
                summary={runSummary}
                vars={vars}
                filter={stepFilter}
                onFilterChange={setStepFilter}
              />

              {phase === "intervening" && failure ? (
                <div className="shrink-0 rounded-2xl border border-danger/20 bg-danger-soft p-3.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold text-danger">
                    <TriangleAlert className="size-3.5" />
                    节点失败：{failure.name ?? failure.nodeId}
                    <Badge variant="destructive">{FAILURE_KIND_LABEL[failure.failureKind]}</Badge>
                    {failure.mayHaveSideEffect ? (
                      <Badge variant="amber">可能已提交</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 break-words font-mono text-[10.5px] leading-4 text-danger/80">
                    {failure.message}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-[10px] leading-4 text-muted">
                    <span>
                      第 {failure.attempt} 次尝试
                      {failure.maxAttempts > 1 ? ` / 上限 ${failure.maxAttempts} 次` : ""}
                    </span>
                    {failure.retryExhausted ? <Badge variant="secondary">自动重试已用完</Badge> : null}
                  </p>
                  {failure.attempts.length > 0 ? (
                    <ol className="mt-2 grid gap-1 border-t border-danger/15 pt-2">
                      {failure.attempts.map((attempt) => (
                        <li
                          key={`${attempt.attempt}-${attempt.startedAt}`}
                          className="flex items-start gap-1.5 text-[10px] leading-4"
                        >
                          <span className="w-8 shrink-0 font-mono text-muted">#{attempt.attempt}</span>
                          <span
                            className={cn(
                              "w-9 shrink-0 font-medium",
                              attempt.status === "failed" ? "text-danger" : "text-muted",
                            )}
                          >
                            {ATTEMPT_STATUS_LABEL[attempt.status]}
                          </span>
                          <span className="w-12 shrink-0 font-mono text-muted">
                            {attempt.durationMs}ms
                          </span>
                          <span className="min-w-0 flex-1 break-words text-muted/80">
                            {attempt.message ?? "—"}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  <p className="mt-2 text-[11px] leading-4 text-muted">
                    可直接在左侧目标页手动完成这一步，然后点「已补全，继续」。继续不会重复执行该节点
                    {verifyOnContinue ? "，但会重新校验本节点的 expect 条件" : ""}。
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
                  <label className="mt-2 flex items-center gap-1.5 text-[10.5px] text-muted">
                    <input
                      type="checkbox"
                      className="size-3 accent-current"
                      checked={verifyOnContinue}
                      onChange={(event) => setVerifyOnContinue(event.target.checked)}
                    />
                    继续前重新校验 expect（推荐）
                  </label>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Button size="sm" onClick={continueAfterManual}>
                      <Check />
                      已补全，继续
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decideIntervention("retry")}
                    >
                      <RefreshCw />
                      重试本步
                    </Button>
                    {currentFailureGroupId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => decideIntervention("retryGroup")}
                      >
                        <RotateCcw />
                        重试本组
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => decideIntervention("skip")}
                    >
                      <SkipForward />
                      跳过节点
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      onClick={() => decideIntervention("stop")}
                    >
                      <Square />
                      停止运行
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[10px] leading-4 text-muted">
                    重试会再次执行该节点；若已手动提交，可能产生重复操作。
                    {currentFailureGroupId ? "「重试本组」会从该分组入口重新执行。" : ""}
                  </p>
                </div>
              ) : null}

              <RunStepsPanel
                steps={executionSteps}
                itemMap={itemMap}
                activeMicroId={activeMicroId}
                dirtyIds={dirtyIds}
                inputValues={inputTuning}
                pickerValues={pickerTuning}
                extractValues={extractTuning}
                valueOverrides={compiledState.value?.values ?? {}}
                injectionLabels={injectionLabels}
                filter={stepFilter}
                blocked={blockedMode}
                onInputChange={setInputTuningValue}
                onPickerChange={patchPickerTuning}
                onPickerReset={resetPickerTuning}
                onExtractChange={patchExtractTuning}
                registerRef={(microId, element) => {
                  if (element) stepRefs.current.set(microId, element);
                  else stepRefs.current.delete(microId);
                }}
              />

              <Card className="shrink-0">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
                    <FileJson className="size-3.5 text-accent" />
                    接口调用
                  </h3>
                  <Badge variant={apiCalls.length > 0 ? "moss" : "secondary"}>
                    {apiCalls.length}
                  </Badge>
                </div>
                {apiCalls.length > 0 ? (
                  <div className="mt-2">
                    <ApiCallRows entries={apiCalls} />
                  </div>
                ) : (
                  <p className="mt-1 text-[10.5px] leading-4 text-muted">
                    运行时自动捕获提交接口，点击可查看请求参数与返回 JSON。
                  </p>
                )}
              </Card>

              {unreachableCount > 0 ? (
                <div className="rounded-xl bg-amber-soft/70 px-3 py-2 text-[10.5px] leading-4 text-amber">
                  还有 {unreachableCount} 个节点不在执行链上，不会被执行。
                </div>
              ) : null}
            </aside>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 py-2 sm:justify-between">
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <TriangleAlert className="size-3.5" />
            运行会真实写入目标系统数据，重复执行可能产生重复记录。
          </span>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={onClose}>
              <X />
              关闭
            </Button>
            {active ? (
              <>
                {phase === "paused" ? (
                  <Button size="sm" variant="default" onClick={resume}>
                    <Play />
                    继续
                  </Button>
                ) : phase === "intervening" ? null : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={pause}
                      disabled={phase !== "running"}
                      title="当前节点执行完再停下，不会打断已发出的动作"
                    >
                      <Pause />
                      本步后暂停
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={pauseNow}
                      disabled={phase !== "running"}
                      title="立即中止当前等待，交由人工确认后重跑或跳过"
                    >
                      <CirclePause />
                      立即暂停
                    </Button>
                  </>
                )}
                <Button size="sm" variant="destructive" onClick={stop}>
                  <Square />
                  停止
                </Button>
              </>
            ) : (
              <Button size="sm" variant="default" onClick={() => void start()}>
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

interface RunSummary {
  total: number;
  elapsedMs: number;
  tunable: number;
  currentStep: number;
  currentLabel?: string;
  percent: number;
}

function StepFilter({
  filter,
  tunableCount,
  onChange,
}: {
  filter: "all" | "tunable";
  tunableCount: number;
  onChange: (filter: "all" | "tunable") => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-paper p-0.5">
      <button
        type="button"
        className={cn(
          "rounded-md px-2 py-1 text-[10.5px] font-medium transition-colors",
          filter === "all" ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink",
        )}
        onClick={() => onChange("all")}
      >
        全部
      </button>
      <button
        type="button"
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium transition-colors",
          filter === "tunable" ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink",
        )}
        onClick={() => onChange("tunable")}
      >
        <SlidersHorizontal className="size-3" />
        可微调 {tunableCount}
      </button>
    </div>
  );
}

function RunStatusOverview({
  phaseLabel,
  phaseVariant,
  statusText,
  summary,
  vars,
  filter,
  onFilterChange,
}: {
  phaseLabel: string;
  phaseVariant: BadgeVariant;
  statusText: string;
  summary: RunSummary;
  vars: Record<string, unknown>;
  filter: "all" | "tunable";
  onFilterChange: (filter: "all" | "tunable") => void;
}) {
  const varEntries = Object.entries(vars);
  return (
    <Card className="shrink-0">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-[0.12em] text-accent">
          <Activity className="size-3.5 text-accent" />
          运行状态
        </span>
        <StepFilter
          filter={filter}
          tunableCount={summary.tunable}
          onChange={onFilterChange}
        />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[34px] font-bold leading-none tracking-tight text-ink">
            {String(summary.currentStep).padStart(2, "0")}
          </span>
          <span className="text-[12px] text-muted">/ {summary.total} 步</span>
        </div>
        <Badge variant={phaseVariant}>{phaseLabel}</Badge>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
        <div
          className="h-full rounded-full bg-running transition-[width] duration-300"
          style={{ width: `${summary.percent}%` }}
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px]">
        <span className="min-w-0 truncate text-muted">
          {summary.currentLabel ? `当前节点 · ${summary.currentLabel}` : statusText}
        </span>
        <span className="shrink-0 font-mono text-ink">{formatDuration(summary.elapsedMs)}</span>
      </div>
      {summary.currentLabel ? (
        <p className="mt-1 break-words text-[10.5px] leading-4 text-muted">{statusText}</p>
      ) : null}
      {varEntries.length > 0 ? (
        <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line pt-2.5">
          <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] font-semibold tracking-[0.1em] text-muted">
            <Variable className="size-3.5 text-accent" />
            运行变量
          </span>
          {varEntries.map(([name, value]) => (
            <span
              key={name}
              className="min-w-0 max-w-full rounded-lg bg-paper px-2.5 py-1 text-[10.5px] text-ink"
            >
              <span className="font-mono text-muted">{name}</span>
              <span className="mx-1.5 text-muted/40">|</span>
              <span className="break-all">{String(value)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

interface RunStepsPanelProps {
  steps: RunStep[];
  itemMap: Map<string, RunItem>;
  activeMicroId?: string;
  dirtyIds: ReadonlySet<string>;
  inputValues: Record<string, string>;
  pickerValues: Record<string, PickerDraft>;
  extractValues: Record<string, ExtractEditor>;
  valueOverrides: Record<string, unknown>;
  injectionLabels: Map<string, string>;
  filter: "all" | "tunable";
  blocked: boolean;
  onInputChange: (microNodeId: string, value: string) => void;
  onPickerChange: (
    microNodeId: string,
    node: PickerNode,
    patch: Partial<PickerDraft>,
  ) => void;
  onPickerReset: (microNodeId: string) => void;
  onExtractChange: (
    microNodeId: string,
    node: ExtractNode,
    editor: ExtractEditor,
  ) => void;
  registerRef: (microNodeId: string, element: HTMLLIElement | null) => void;
}

function RunStepsPanel({
  steps,
  itemMap,
  activeMicroId,
  dirtyIds,
  inputValues,
  pickerValues,
  extractValues,
  valueOverrides,
  injectionLabels,
  filter,
  blocked,
  onInputChange,
  onPickerChange,
  onPickerReset,
  onExtractChange,
  registerRef,
}: RunStepsPanelProps) {
  const visibleSteps = filter === "tunable" ? steps.filter((step) => step.tunable) : steps;
  const groups: Array<{
    key: string;
    groupId?: string;
    label: string;
    steps: RunStep[];
  }> = [];
  for (const step of visibleSteps) {
    const last = groups[groups.length - 1];
    if (last && last.groupId === step.groupId) last.steps.push(step);
    else
      groups.push({
        key: `${step.groupId ?? "solo"}-${groups.length}`,
        groupId: step.groupId,
        label: step.groupLabel,
        steps: [step],
      });
  }
  const groupTotals = new Map<string, RunStep[]>();
  for (const step of steps) {
    const key = step.groupId ?? "__none__";
    const list = groupTotals.get(key) ?? [];
    list.push(step);
    groupTotals.set(key, list);
  }

  return (
    <Card className="min-h-[220px] min-w-0 flex-1">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <ListOrdered className="size-3.5 text-accent" />
          节点步骤
        </h3>
        <span className="text-[10.5px] text-muted">按执行顺序 · 同组共享容器</span>
      </div>

      {visibleSteps.length === 0 ? (
        <p className="py-6 text-center text-[11.5px] leading-5 text-muted">
          {steps.length === 0 ? "画布没有可执行的节点。" : "没有可微调的节点。"}
        </p>
      ) : (
        <div className="mt-3 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-y-auto overflow-x-hidden pr-1">
          {groups.map((group) => (
            <div key={group.key} className="min-w-0">
              <RunGroupHeader
                label={group.label}
                steps={groupTotals.get(group.groupId ?? "__none__") ?? group.steps}
                itemMap={itemMap}
              />
              <ol className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-1.5">
                {group.steps.map((step) => (
                  <RunStepCard
                    key={step.microId}
                    step={step}
                    item={itemMap.get(step.microId)}
                    active={step.microId === activeMicroId}
                    dirty={dirtyIds.has(step.microId)}
                    inputValues={inputValues}
                    pickerValues={pickerValues}
                    extractValues={extractValues}
                    valueOverrides={valueOverrides}
                    injectionLabels={injectionLabels}
                    blocked={blocked && !itemMap.get(step.microId)}
                    onInputChange={onInputChange}
                    onPickerChange={onPickerChange}
                    onPickerReset={onPickerReset}
                    onExtractChange={onExtractChange}
                    registerRef={registerRef}
                  />
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function RunGroupHeader({
  label,
  steps,
  itemMap,
}: {
  label: string;
  steps: RunStep[];
  itemMap: Map<string, RunItem>;
}) {
  const statuses = steps.map((step) => itemMap.get(step.microId)?.status);
  const running = statuses.some((status) => status === "running");
  const failed = statuses.some((status) => status === "fail");
  const done = statuses.filter(
    (status) => status !== undefined && status !== "running",
  ).length;
  const total = steps.length;
  const tone = failed
    ? "text-danger"
    : running
      ? "text-running"
      : total > 0 && done === total
        ? "text-moss"
        : "text-muted";
  const text = running
    ? "执行中"
    : failed
      ? "有失败"
      : total > 0 && done === total
        ? "已执行"
        : `${done} / ${total} 完成`;
  return (
    <div className="flex items-center justify-between gap-2 px-0.5">
      <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-muted">
        {label}
      </span>
      <span className={cn("shrink-0 font-mono text-[10px]", tone)}>{text}</span>
    </div>
  );
}

function RunStepCard({
  step,
  item,
  active,
  dirty,
  inputValues,
  pickerValues,
  extractValues,
  valueOverrides,
  injectionLabels,
  blocked,
  onInputChange,
  onPickerChange,
  onPickerReset,
  onExtractChange,
  registerRef,
}: {
  step: RunStep;
  item?: RunItem;
  active: boolean;
  dirty: boolean;
  inputValues: Record<string, string>;
  pickerValues: Record<string, PickerDraft>;
  extractValues: Record<string, ExtractEditor>;
  valueOverrides: Record<string, unknown>;
  injectionLabels: Map<string, string>;
  /** 运行提前结束，这一行不会再执行。 */
  blocked: boolean;
  onInputChange: (microNodeId: string, value: string) => void;
  onPickerChange: (
    microNodeId: string,
    node: PickerNode,
    patch: Partial<PickerDraft>,
  ) => void;
  onPickerReset: (microNodeId: string) => void;
  onExtractChange: (
    microNodeId: string,
    node: ExtractNode,
    editor: ExtractEditor,
  ) => void;
  registerRef: (microNodeId: string, element: HTMLLIElement | null) => void;
}) {
  const status: StepStatus = item?.status ?? "pending";
  // 失败行保持可编辑，方便调完值后重试；已执行/执行中的行不再允许修改。
  const disabled =
    status === "running" ||
    status === "pass" ||
    status === "healed" ||
    status === "manual" ||
    status === "skipped";
  const { node, microId } = step;
  const interactNode =
    node.type === "interact" && EDITABLE_INTERACT.has(node.adapter) ? node : null;
  const pickerNode = node.type === "picker" ? node : null;
  const extractNode = node.type === "extract" ? node : null;

  const tone = STEP_TONE[status];
  const retries = item?.retries ?? 0;
  const uncertain = item?.failureKind === "partial" || item?.failureKind === "unknown";

  return (
    <li
      ref={(element) => registerRef(microId, element)}
      className={cn(
        "min-w-0 rounded-lg border px-2.5 py-2 transition-colors",
        // 状态边框直接沿用外框，避免和默认边框叠成双层描边。
        active
          ? status === "fail"
            ? "border-danger/35"
            : "border-running/35"
          : "border-line",
        tone.row,
        status === "skipped" && "opacity-70",
        blocked && "opacity-60",
      )}
    >
      <div className="flex items-start gap-1.5">
        <span
          aria-hidden
          className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone.dot)}
        />
        <span className="mt-0.5 w-5 shrink-0 font-mono text-[9.5px] text-muted">
          {String(step.index).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
              {stepLabel(node)}
              <span className="ml-1.5 font-normal text-muted">· {stepKind(node)}</span>
            </span>
            {dirty ? <Badge variant="amber">已调</Badge> : null}
            <span className={cn("shrink-0 text-[10px] font-medium", tone.text)}>
              {blocked ? "已阻断" : STEP_BADGE[status].label}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {node.enabled === false ? <Badge variant="amber">已禁用</Badge> : null}
            {retries > 0 ? <Badge variant="secondary">重试 {retries} 次</Badge> : null}
            {uncertain ? <Badge variant="amber">可能已提交</Badge> : null}
            {item?.failureKind ? (
              <span className="font-mono text-[9.5px] text-muted">
                {FAILURE_KIND_LABEL[item.failureKind]}
              </span>
            ) : null}
            {item?.durationMs !== undefined ? (
              <span className="font-mono text-[9.5px] text-muted">{item.durationMs}ms</span>
            ) : null}
          </div>
          {item ? (
            <p className="mt-1 break-words text-[10.5px] leading-4 text-muted">
              {item.message}
            </p>
          ) : null}

          {interactNode ? (
            <InteractTuning
              node={interactNode}
              microId={microId}
              value={inputValues[microId]}
              baseline={interactBaseline(interactNode, valueOverrides[microId])}
              injection={injectionLabels.get(`${microId}|input`)}
              disabled={disabled}
              onChange={onInputChange}
            />
          ) : pickerNode ? (
            <PickerTuning
              node={pickerNode}
              microId={microId}
              draft={pickerValues[microId] ?? pickerBaseline(pickerNode, valueOverrides[microId])}
              baseline={pickerBaseline(pickerNode, valueOverrides[microId])}
              injectionOf={(index) => injectionLabels.get(`${microId}|filter|${index}`)}
              disabled={disabled}
              onChange={onPickerChange}
              onReset={onPickerReset}
            />
          ) : extractNode ? (
            <ExtractTuningConfig
              node={extractNode}
              microId={microId}
              editor={
                extractValues[microId] ??
                extractEditorOf(extractNode, valueOverrides[microId])
              }
              baseline={extractEditorOf(extractNode, valueOverrides[microId])}
              dirty={dirty}
              disabled={disabled}
              onChange={onExtractChange}
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function TuningField({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="w-16 shrink-0 truncate text-[10px] text-muted"
        title={title ?? label}
      >
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function InteractTuning({
  node,
  microId,
  value,
  baseline,
  injection,
  disabled,
  onChange,
}: {
  node: InteractNode;
  microId: string;
  value?: string;
  baseline: string;
  injection?: string;
  disabled: boolean;
  onChange: (microNodeId: string, value: string) => void;
}) {
  const isCheck = node.adapter === "check";
  const overridden = value !== undefined;
  const baselineText = isCheck ? (baseline === "true" ? "勾选" : "取消") : baseline;

  return (
    <div className="mt-1.5 grid gap-1 border-t border-line pt-1.5">
      <div className="flex items-center gap-1.5">
        <span className="w-16 shrink-0 text-[10px] text-muted">
          {isCheck ? "勾选状态" : "回放值"}
        </span>
        {isCheck ? (
          <Select
            value={value ?? FOLLOW_CANVAS}
            disabled={disabled}
            onValueChange={(next) =>
              onChange(microId, next === FOLLOW_CANVAS ? "" : next)
            }
          >
            <SelectTrigger size="xs" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FOLLOW_CANVAS}>跟随默认（{baselineText}）</SelectItem>
              <SelectItem value="true">回放时勾选</SelectItem>
              <SelectItem value="false">回放时取消</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Input
            className="h-7 min-w-0 flex-1 text-[11.5px]"
            value={value ?? ""}
            placeholder="留空 = 使用默认值"
            disabled={disabled}
            onChange={(event) => onChange(microId, event.target.value)}
          />
        )}
        {overridden ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-1.5"
            title="恢复默认值"
            aria-label="恢复默认值"
            disabled={disabled}
            onClick={() => onChange(microId, "")}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {injection ? (
        <p
          className={cn(
            "min-w-0 break-words text-[10px] leading-4",
            overridden ? "text-amber" : "text-accent",
          )}
        >
          画布注入：{injection}
          {overridden ? " · 当前被微调覆盖" : ""}
        </p>
      ) : null}
      <p className="truncate text-[10px] leading-4 text-muted" title={baselineText || "空"}>
        默认：{baselineText === "" ? "空" : baselineText}
      </p>
    </div>
  );
}

function ExtractTuningConfig({
  node,
  microId,
  editor,
  baseline,
  dirty,
  disabled,
  onChange,
}: {
  node: ExtractNode;
  microId: string;
  editor: ExtractEditor;
  baseline: ExtractEditor;
  dirty: boolean;
  disabled: boolean;
  onChange: (
    microNodeId: string,
    node: ExtractNode,
    editor: ExtractEditor,
  ) => void;
}) {
  const sourceLabel =
    editor.source === "response"
      ? "接口"
      : editor.source === "js"
        ? "脚本"
        : editor.source === "const"
          ? "手动"
          : editor.locate === "cell"
            ? "表格"
            : "页面";
  return (
    <div className="mt-1.5 grid gap-1 border-t border-line pt-1.5">
      <div className="flex items-center justify-between gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-muted">
          变量 {node.varName || "未命名"} · {sourceLabel}
        </span>
        {dirty ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-1.5 text-[10px]"
            title="恢复默认值"
            aria-label="恢复默认值"
            disabled={disabled}
            onClick={() => onChange(microId, node, baseline)}
          >
            <RotateCcw className="size-3" />
            恢复默认
          </Button>
        ) : null}
      </div>
      <fieldset disabled={disabled} className="min-w-0">
        <ExtractTuningFields
          editor={editor}
          onChange={(next) => onChange(microId, node, next)}
        />
      </fieldset>
    </div>
  );
}

function PickerTuning({
  node,
  microId,
  draft,
  baseline,
  injectionOf,
  disabled,
  onChange,
  onReset,
}: {
  node: PickerNode;
  microId: string;
  draft: PickerDraft;
  baseline: PickerDraft;
  injectionOf: (index: number) => string | undefined;
  disabled: boolean;
  onChange: (
    microNodeId: string,
    node: PickerNode,
    patch: Partial<PickerDraft>,
  ) => void;
  onReset: (microNodeId: string) => void;
}) {
  const dirty = !pickerDraftEquals(draft, baseline);
  const filterSteps = (node.filter?.steps ?? [])
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.adapter === "input" || step.adapter === "nativeSelect");
  const patch = (next: Partial<PickerDraft>): void => onChange(microId, node, next);
  const changeStrategy = (strategy: PickerStrategy): void => {
    const next: Partial<PickerDraft> = { strategy };
    if (strategy === "byIndex" && draft.indexes.length === 0) {
      next.indexes =
        baseline.strategy === "byIndex"
          ? baseline.indexes
          : draft.picks.length > 0
            ? draft.picks.map((_, index) => String(index + 1))
            : ["1"];
    }
    if ((strategy === "byText" || strategy === "byRow") && draft.picks.length === 0) {
      next.picks = baseline.strategy === strategy ? baseline.picks : [""];
    }
    patch(next);
  };

  return (
    <div className="mt-1.5 grid gap-1 border-t border-line pt-1.5">
      <TuningField label="定位方式">
        <Select
          value={draft.strategy}
          disabled={disabled}
          onValueChange={(next) => changeStrategy(next as PickerStrategy)}
        >
          <SelectTrigger size="xs" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PICKER_STRATEGY_LABEL) as PickerStrategy[]).map((strategy) => (
              <SelectItem key={strategy} value={strategy}>
                {PICKER_STRATEGY_LABEL[strategy]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TuningField>

      {filterSteps.map(({ step, index }) => {
        const injection = injectionOf(index);
        const value = draft.filters[index] ?? "";
        return (
          <div key={`filter-${index}`} className="grid gap-0.5">
            <TuningField
              label="筛选值"
              title={`${step.target.label ?? step.adapter} · 默认：${literalText(step.value) || "空"}`}
            >
              <Input
                className="h-7 text-[11.5px]"
                value={value}
                placeholder="留空 = 使用默认值"
                disabled={disabled}
                onChange={(event) => {
                  const filters = [...draft.filters];
                  while (filters.length <= index) filters.push("");
                  filters[index] = event.target.value;
                  patch({ filters });
                }}
              />
            </TuningField>
            <p className="min-w-0 break-words pl-[68px] text-[9.5px] leading-4 text-muted">
              字段：{step.target.label ?? step.adapter} · 默认：{literalText(step.value) || "空"}
            </p>
            {injection ? (
              <p
                className={cn(
                  "min-w-0 break-words pl-[68px] text-[9.5px] leading-4",
                  value ? "text-amber" : "text-accent",
                )}
              >
                画布注入：{injection}
                {value ? " · 当前被微调覆盖" : ""}
              </p>
            ) : null}
          </div>
        );
      })}

      {draft.strategy === "byIndex" ? (
        <>
          {draft.indexes.map((indexValue, index) => (
            <TuningField key={`index-${index}`} label={`位置 ${index + 1}`}>
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
            </TuningField>
          ))}
          <TuningField label="点击目标">
            <Select
              value={draft.on}
              disabled={disabled}
              onValueChange={(next) => patch({ on: next as "item" | "row" })}
            >
              <SelectTrigger size="xs" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="item">选项本身</SelectItem>
                <SelectItem value="row">表格行</SelectItem>
              </SelectContent>
            </Select>
          </TuningField>
        </>
      ) : draft.strategy === "firstVisible" ? (
        <>
          <TuningField label="选择结果">
            <span className="text-[10px] text-moss">自动选第一条可见结果</span>
          </TuningField>
          <TuningField label="点击目标">
            <Select
              value={draft.on}
              disabled={disabled}
              onValueChange={(next) => patch({ on: next as "item" | "row" })}
            >
              <SelectTrigger size="xs" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="item">选项本身</SelectItem>
                <SelectItem value="row">表格行</SelectItem>
              </SelectContent>
            </Select>
          </TuningField>
        </>
      ) : (
        draft.picks.map((pick, index) => (
          <TuningField key={`pick-${index}`} label={`选项 ${index + 1}`}>
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
          </TuningField>
        ))
      )}

      <div className="mt-0.5 flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted">
          {node.pick.multi ? "多选" : "单选"} · {PICKER_STRATEGY_LABEL[draft.strategy]}
        </span>
        {dirty ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-1.5 text-[10px]"
            title="恢复默认值"
            aria-label="恢复默认值"
            disabled={disabled}
            onClick={() => onReset(microId)}
          >
            <RotateCcw className="size-3" />
            恢复默认
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function pickHint(node: PickerNode, index: number): string {
  const recorded = node.pick.values?.[index]?.value;
  if (recorded) return `录制值 ${recorded}`;
  const raw = node.pick.byText?.value ?? node.pick.byRow?.keyValue;
  if (Array.isArray(raw)) return valueHint(raw[index] as ValueLike);
  return valueHint(raw);
}

