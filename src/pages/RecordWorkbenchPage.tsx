import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  Crosshair,
  FileJson,
  Loader2,
  MonitorDot,
  Play,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Square,
  Trash2,
  TriangleAlert,
  Video,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ApiCallRows, ApiRequestDialog, type ApiCallEntry } from "@/components/ApiCallLog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NodeTuningDialog } from "@/components/NodeTuningDialog";
import { cn } from "@/lib/utils";
import { getRecord, getSystemToken, listSystems, saveRecord, saveSystemToken } from "@/lib/store";
import {
  describeTargetFailure,
  loadProxyConfig,
  resolveTargetUrl,
  type ProxyConfig,
} from "@/lib/proxy";
import { injectSystemToken } from "@/lib/session";
import type { CellRef, FlowDsl, FlowNode } from "@/dsl/index.ts";
import { DomRecorder } from "@/recorder/dom-recorder.ts";
import {
  importChromeRecorder,
  parseSelectorGroups,
  type ChromeRecorderRecording,
  type ChromeRecorderStep,
  type RecordingImportResult,
} from "@/recorder/chrome-recorder.ts";
import {
  createIframeHost,
  runFlow,
  type CapturedHttpResponse,
  type ReplayEvent,
  type ReplayNodeStatus,
} from "@/replay/index.ts";
import type { OperationRecord } from "@/lib/types";

type Phase = "idle" | "opening" | "login" | "recording" | "finished" | "empty" | "failed" | "saved";

type RunStatus = "running" | ReplayNodeStatus;

interface RunItem {
  nodeId: string;
  index: number;
  name?: string;
  status: RunStatus;
  message: string;
  durationMs?: number;
  strategy?: string;
}

const PHASE_BADGE: Record<Phase, { label: string; variant: "secondary" | "accent" | "moss" | "amber" | "destructive" }> = {
  idle: { label: "待录制", variant: "secondary" },
  opening: { label: "加载中", variant: "accent" },
  login: { label: "需要登录", variant: "amber" },
  recording: { label: "录制中", variant: "destructive" },
  finished: { label: "待保存", variant: "accent" },
  empty: { label: "未捕获", variant: "amber" },
  failed: { label: "失败", variant: "destructive" },
  saved: { label: "已保存", variant: "moss" },
};

const PHASE_BOX: Record<Phase, string> = {
  idle: "border-line bg-white text-muted",
  opening: "border-accent/20 bg-accent-soft text-accent",
  login: "border-amber/20 bg-amber-soft text-amber",
  recording: "border-danger/20 bg-[#fdf3f0] text-danger",
  finished: "border-accent/20 bg-accent-soft text-accent",
  empty: "border-amber/20 bg-amber-soft text-amber",
  failed: "border-danger/20 bg-[#fdf3f0] text-danger",
  saved: "border-moss/20 bg-moss-soft text-moss",
};

const RECORD_TYPE_LABEL: Record<string, string> = {
  navigate: "导航",
  click: "点击",
  doubleClick: "双击",
  change: "输入",
  hover: "悬停",
  keydown: "按键",
  extract: "取值",
};

const NODE_TYPE_LABEL: Record<FlowNode["type"], string> = {
  navigate: "导航",
  interact: "交互",
  picker: "选择器",
  wait: "等待",
  extract: "取值",
};

const RUN_BADGE: Record<
  RunStatus,
  { label: string; variant: "secondary" | "moss" | "accent" | "amber" | "destructive" }
> = {
  running: { label: "执行中", variant: "secondary" },
  pass: { label: "通过", variant: "moss" },
  healed: { label: "自愈", variant: "amber" },
  manual: { label: "人工完成", variant: "accent" },
  fail: { label: "失败", variant: "destructive" },
  skipped: { label: "跳过", variant: "secondary" },
};

function recordedStepLabel(step: ChromeRecorderStep): string {
  if (step.labelText) return step.labelText;
  if (step.type === "navigate") return step.url ?? "导航";
  if (step.type === "change") {
    const value = step.value === undefined ? "" : ` = ${JSON.stringify(step.value)}`;
    return `${step.tagName ?? "change"}${value}`;
  }
  if (step.type === "keydown") return `按键 ${step.key ?? ""}`;
  const tokens = parseSelectorGroups(step.selectors);
  return tokens.aria ?? tokens.text ?? tokens.css ?? tokens.xpath ?? "(未定位)";
}

function cellSummaryLabel(cell: CellRef): string {
  const row =
    cell.rowIndex !== undefined
      ? `筛选后第 ${cell.rowIndex} 行`
      : cell.rowValue ?? cell.rowText ?? "";
  const column = cell.header ?? (cell.colIndex ? `第 ${cell.colIndex} 列` : "");
  return [row, column].filter(Boolean).join(" · ");
}

function nodeLabel(node: FlowNode): string {
  if (node.type === "navigate") return node.url;
  if (node.type === "picker") return node.name ?? node.trigger.label ?? "复合选择";
  if (node.type === "interact") return node.name ?? node.target.label ?? node.adapter;
  return node.name ?? node.id;
}

function convertRecording(
  record: OperationRecord,
  systemName: string,
  steps: ChromeRecorderStep[],
): RecordingImportResult {
  return importChromeRecorder({
    recording: { title: record.name, steps },
    system: {
      id: record.systemId || "local",
      name: systemName,
      baseUrl: window.location.origin,
    },
    flowName: record.name,
  });
}

export function RecordWorkbenchPage() {
  const { recordId } = useParams<{ recordId: string }>();
  const navigate = useNavigate();
  const record = useMemo<OperationRecord | undefined>(
    () => (recordId ? getRecord(recordId) : undefined),
    [recordId],
  );
  const systems = useMemo(() => listSystems(), []);
  const currentSystem = record?.systemId
    ? systems.find((system) => system.id === record.systemId)
    : undefined;
  const systemName = record?.systemId
    ? (currentSystem?.name ?? "系统已删除")
    : "未绑定系统";

  // 配置统一在「记录管理」和「系统管理」维护，工作台只读取，不再重复展示。
  const targetUrl = record?.targetUrl ?? "";
  const token = record?.systemId ? getSystemToken(record.systemId) : "";
  const [steps, setSteps] = useState<ChromeRecorderStep[]>(record?.recording?.steps ?? []);
  const [result, setResult] = useState<RecordingImportResult | null>(
    record?.dsl && record.report ? { dsl: record.dsl, report: record.report } : null,
  );
  const [overrides, setOverrides] = useState<Record<string, unknown>>(record?.values ?? {});
  const [tuningOpen, setTuningOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>(record?.dsl ? "saved" : "idle");
  // 已载入历史记录时保持安静，不额外占用一行提示；只有实际操作后才显示状态。
  const [statusText, setStatusText] = useState(
    record?.dsl ? "" : "点右上角「开始录制」加载目标页并开始捕获操作。",
  );
  const [recording, setRecording] = useState(false);
  const [valueMode, setValueMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameUrl, setFrameUrl] = useState("");
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | null>(null);
  const [proxyError, setProxyError] = useState("");
  const [replaying, setReplaying] = useState(false);
  const [runItems, setRunItems] = useState<RunItem[]>([]);
  const [replayText, setReplayText] = useState(
    record?.dsl
      ? "已载入上次录制，可点「开始回放」重走一遍。"
      : "生成节点后可在右侧目标系统回放校验。",
  );
  const [deletingNode, setDeletingNode] = useState<{
    node: FlowNode;
    indices: number[];
  } | null>(null);
  const [requestView, setRequestView] = useState<ApiCallEntry | null>(null);
  const [replayRequests, setReplayRequests] = useState<CapturedHttpResponse[]>([]);
  const replayApiCalls = useMemo<ApiCallEntry[]>(
    () =>
      replayRequests.map((entry) => ({
        method: entry.method,
        url: entry.url,
        status: entry.status || undefined,
        contentType: entry.contentType,
        params: entry.requestBody,
        response: entry.responseBody || undefined,
      })),
    [replayRequests],
  );

  // 已保存的旧记录没有 sources，按当前步骤现场转换一份用于删除映射。
  const nodeSources = useMemo<Record<string, number[]> | null>(() => {
    if (result?.sources) return result.sources;
    if (!record || recording || steps.length === 0) return null;
    try {
      return convertRecording(record, systemName, steps).sources ?? null;
    } catch {
      return null;
    }
  }, [result, record, recording, steps, systemName]);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const recorderRef = useRef<DomRecorder | null>(null);

  const getRecorder = (): DomRecorder => {
    if (!recorderRef.current) {
      recorderRef.current = new DomRecorder({
        onChange: (next) => setSteps(next),
        onValueModeChange: (armed, reason) => {
          setValueMode(armed);
          if (armed) {
            setStatusText("取值模式：点击右侧目标页要读取的字段，Esc 取消。");
          } else if (reason === "captured") {
            setStatusText("已记录取值步骤，可在左侧修改变量名；继续操作或停止生成。");
          } else {
            setStatusText("已取消取值模式。");
          }
        },
      });
    }
    return recorderRef.current;
  };

  useEffect(() => {
    let alive = true;
    loadProxyConfig()
      .then((config) => {
        if (alive) setProxyConfig(config);
      })
      .catch((error: unknown) => {
        if (alive) setProxyError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
      recorderRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame || !recording) return;

    const handleLoad = (): void => {
      const doc = frame.contentDocument;
      if (!doc) {
        setPhase("failed");
        setStatusText("目标页跳出了同源范围，录制无法读取 DOM。请改用同源代理地址。");
        return;
      }
      const recorder = getRecorder();
      recorder.attach(doc);
      try {
        const url = frame.contentWindow?.location.href ?? "";
        if (url) {
          recorder.recordNavigation(url);
          setFrameUrl(url);
        }
      } catch {
        // contentWindow 不可读时由上面的错误分支处理。
      }
      setFrameLoaded(true);
    };

    frame.addEventListener("load", handleLoad);
    return () => frame.removeEventListener("load", handleLoad);
  }, [recording]);

  if (!record) {
    return (
      <Card className="mt-8 items-center p-0 px-6 py-12 text-center">
        <h1 className="text-[16px] font-semibold">记录不存在</h1>
        <p className="mt-1 text-[12.5px] text-muted">可能已被删除，返回记录列表重新选择。</p>
        <Button className="mt-5" onClick={() => navigate("/records")}>
          <ArrowLeft />
          返回记录列表
        </Button>
      </Card>
    );
  }

  const loadFrame = (source: string): Promise<Document> => {
    const frame = iframeRef.current;
    if (!frame) return Promise.reject(new Error("目标容器尚未就绪"));
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
          finish(() =>
            reject(new Error("目标页与当前页面不同源，无法读取 DOM。请配置同源代理。")),
          );
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
  };

  const convert = (
    captured: ChromeRecorderStep[],
    note = "录制完成",
  ): RecordingImportResult | null => {
    try {
      const converted = convertRecording(record, systemName, captured);
      setResult(converted);
      setPhase("finished");
      setStatusText(`${note} · ${captured.length} 步 → ${converted.dsl.nodes.length} 个节点`);
      setRunItems([]);
      setReplayText("节点已生成，可点「开始回放」校验录制结果。");
      return converted;
    } catch (error) {
      setResult(null);
      setPhase("failed");
      setStatusText(`转换失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const requestRemoveNode = (node: FlowNode): void => {
    if (recording || busy || replaying) return;
    const indices = nodeSources?.[node.id] ?? [];
    if (indices.length === 0) {
      setStatusText("这个节点没有对应的录制事件，无法按组件删除；请重新录制后再试。");
      return;
    }
    setDeletingNode({ node, indices });
  };

  const confirmRemoveNode = (): void => {
    if (!deletingNode) return;
    const { node, indices } = deletingNode;
    setDeletingNode(null);
    const drop = new Set(indices);
    const next = steps.filter((_, index) => !drop.has(index));
    const hadTuning = Object.keys(overrides).length > 0;
    setOverrides({});
    setSteps(next);
    setRunItems([]);
    if (next.length === 0) {
      setResult(null);
      setPhase("empty");
      setStatusText(`已删除节点「${nodeLabel(node)}」，录制事件已清空。`);
      setReplayText("生成节点后可在右侧目标系统回放校验。");
      return;
    }
    const converted = convert(
      next,
      `已删除节点「${nodeLabel(node)}」${hadTuning ? "（微调值已重置）" : ""}`,
    );
    if (!converted) setPhase("empty");
  };

  const stopRecording = (): void => {
    const recorder = recorderRef.current;
    const captured = recorder ? recorder.stop() : [];
    setRecording(false);
    setValueMode(false);
    setSteps(captured);
    if (captured.length === 0) {
      setPhase("empty");
      setStatusText("没有捕获到可转换的操作，请在目标页完成一次表单操作后重试。");
      return;
    }
    convert(captured);
  };

  const toggleValueMode = (): void => {
    const recorder = recorderRef.current;
    if (!recorder || !recording) return;
    if (valueMode) {
      recorder.cancelValueCapture("canceled");
      return;
    }
    recorder.armValueCapture();
  };

  /** 改取值步骤的变量名/读取方式时，同步更新录制 JSON 与已生成的 DSL。 */
  const patchExtractStep = (
    index: number,
    patch: {
      varName?: string;
      readMode?: "text" | "value" | "attribute";
      attributeName?: string;
      cell?: Partial<CellRef>;
    },
  ): void => {
    const { cell, ...rest } = patch;
    setSteps((current) =>
      current.map((step, stepIndex) => {
        if (stepIndex !== index) return step;
        if (!cell) return { ...step, ...rest };
        return {
          ...step,
          ...rest,
          semantic: step.semantic
            ? { ...step.semantic, cell: { ...step.semantic.cell, ...cell } }
            : step.semantic,
        };
      }),
    );
    setResult((prev) => {
      if (!prev) return prev;
      let changed = false;
      const nodes = prev.dsl.nodes.map((node) => {
        if (node.type !== "extract" || node.meta?.sourceIndex !== index) return node;
        if (
          node.source === "response" ||
          node.source === "js" ||
          node.source === "const"
        ) {
          return node;
        }
        changed = true;
        const strategies = cell
          ? node.target.strategies.map((strategy) =>
              strategy.type === "cell"
                ? { ...strategy, cell: { ...strategy.cell, ...cell } }
                : strategy,
            )
          : node.target.strategies;
        const cellStrategy = strategies.find((strategy) => strategy.type === "cell");
        const label =
          cellStrategy && cellStrategy.type === "cell"
            ? cellSummaryLabel(cellStrategy.cell)
            : "";
        return {
          ...node,
          ...(rest.varName !== undefined ? { varName: rest.varName } : {}),
          ...(rest.readMode !== undefined ? { read: rest.readMode } : {}),
          ...(rest.readMode !== undefined && rest.readMode !== "attribute"
            ? { attribute: undefined }
            : {}),
          ...(rest.attributeName !== undefined
            ? { attribute: rest.attributeName.trim() || undefined }
            : {}),
          ...(cell
            ? {
                ...(label ? { name: `取值 ${label}` } : {}),
                target: {
                  ...node.target,
                  ...(label ? { label } : {}),
                  strategies,
                },
              }
            : {}),
        };
      });
      return changed ? { ...prev, dsl: { ...prev.dsl, nodes } } : prev;
    });
  };

  const prepareTarget = async (): Promise<Document> => {
    let config = proxyConfig;
    if (!config && !proxyError) {
      try {
        config = await loadProxyConfig();
        setProxyConfig(config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setProxyError(message);
        throw new Error(describeTargetFailure(null, message));
      }
    }
    const resolved = resolveTargetUrl(targetUrl, config);
    if (!resolved) {
      throw new Error(describeTargetFailure(config, proxyError));
    }
    let doc = await loadFrame(resolved.url.toString());
    if (resolved.viaProxy && token.trim()) {
      injectSystemToken(doc, token);
      doc = await loadFrame(resolved.url.toString());
    }
    setFrameLoaded(true);
    return doc;
  };

  const startRecording = async (): Promise<void> => {
    if (busy || recording || replaying) return;
    setBusy(true);
    setResult(null);
    setSteps([]);
    setOverrides({});
    setTuningOpen(false);
    setRunItems([]);
    setReplayText("生成节点后可在右侧目标系统回放校验。");
    setPhase("opening");
    setStatusText("正在加载目标系统…");
    setFrameLoaded(false);
    try {
      const doc = await prepareTarget();
      if (doc.querySelector('input[type="password"]')) {
        setPhase("login");
        setStatusText("检测到登录页：请先在右侧完成登录，然后重新点「开始录制」。");
        return;
      }
      const recorder = getRecorder();
      recorder.start();
      recorder.attach(doc);
      try {
        const url = iframeRef.current?.contentWindow?.location.href ?? "";
        if (url) {
          recorder.recordNavigation(url);
          setFrameUrl(url);
        }
      } catch {
        setFrameUrl("");
      }
      setRecording(true);
      setPhase("recording");
      setStatusText("录制中 · 在右侧目标页操作，完成后点「停止并生成」。");
      if (record.systemId) saveSystemToken(record.systemId, token);
    } catch (error) {
      setPhase("failed");
      setStatusText(`打开目标系统失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    if (!result || steps.length === 0 || recording || replaying) return;
    const now = new Date().toISOString();
    const recordingJson: ChromeRecorderRecording = { title: record.name, steps };
    const next: OperationRecord = {
      ...record,
      recording: recordingJson,
      dsl: result.dsl,
      report: result.report,
      values: overrides,
      steps: steps.length,
      nodes: result.dsl.nodes.length,
      status: "ready",
      updatedAt: now,
    };
    try {
      saveRecord(next);
      if (record.systemId) saveSystemToken(record.systemId, token);
      setPhase("saved");
      setStatusText(`已保存「${record.name}」· ${steps.length} 步 / ${result.dsl.nodes.length} 节点`);
    } catch (error) {
      setPhase("failed");
      setStatusText(
        `保存失败：${error instanceof Error ? error.message : String(error)}（localStorage 可能已满）`,
      );
    }
  };

  const applyTuning = (next: { dsl: FlowDsl; values: Record<string, unknown> }): void => {
    setResult((prev) => (prev ? { ...prev, dsl: next.dsl } : prev));
    setOverrides(next.values);
    setTuningOpen(false);
    setReplayText("微调值已更新，可点「开始回放」校验。");
  };

  const replay = async (): Promise<void> => {
    const frame = iframeRef.current;
    if (!frame || !result || recording || replaying || busy) return;
    setReplaying(true);
    setRunItems([]);
    setReplayRequests([]);
    setReplayText("回放中 · 准备导航…");
    setFrameLoaded(true);
    if (token.trim()) {
      try {
        const doc = frame.contentDocument;
        if (doc) injectSystemToken(doc, token);
        if (record.systemId) saveSystemToken(record.systemId, token);
      } catch {
        // 目标跨域时无法注入，回放会在定位节点上给出明确失败信息。
      }
    }
    const host = createIframeHost(frame);
    // 回放校验始终开启网络抓取，便于查看提交参数与返回结构。
    host.startNetworkCapture?.();
    const syncRequests = (): void => setReplayRequests(host.getCapturedResponses());
    const requestTimer = window.setInterval(syncRequests, 400);
    try {
      const dsl = {
        ...result.dsl,
        systems: result.dsl.systems.map((system) => ({
          ...system,
          baseUrl: window.location.origin,
        })),
      };
      await runFlow({
        dsl,
        host,
        values: overrides,
        onEvent: (event: ReplayEvent) => {
          if (event.type === "run.started") {
            setReplayText(`回放中 · 0/${event.totalNodes} 节点`);
            return;
          }
          if (event.type === "node.started") {
            setRunItems((items) => [
              ...items,
              {
                nodeId: event.nodeId,
                index: event.index,
                name: event.name,
                status: "running",
                message: "执行中…",
              },
            ]);
            return;
          }
          if (event.type === "node.finished") {
            const node = event.node;
            setRunItems((items) =>
              items.map((item) =>
                item.nodeId === node.nodeId
                  ? {
                      ...item,
                      status: node.status,
                      message: node.message,
                      durationMs: node.durationMs,
                      strategy: node.strategy,
                    }
                  : item,
              ),
            );
            return;
          }
          if (event.type === "var.set") return;
          const seconds = (event.durationMs / 1000).toFixed(1);
          setReplayText(
            event.status === "finished"
              ? `完成 · ${event.passed}/${event.total} 节点通过 · ${seconds}s`
              : `${event.status === "canceled" ? "已取消" : "失败"} · ${event.error ?? "未知错误"}`,
          );
        },
      });
      try {
        setFrameUrl(iframeRef.current?.contentWindow?.location.href ?? frameUrl);
      } catch {
        // 回放后跳出同源时保留上一次地址。
      }
    } catch (error) {
      setReplayText(`回放失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      window.clearInterval(requestTimer);
      syncRequests();
      host.dispose();
      setReplaying(false);
    }
  };

  const frameBadge = replaying ? "回放中" : recording ? "录制中" : frameLoaded ? "已加载" : "未加载";
  const phaseBadge = PHASE_BADGE[phase];
  const needsConfirm = result?.report.needsConfirm ?? 0;
  const hasDraft = steps.length > 0 || Boolean(result);
  const overrideCount = Object.keys(overrides).length;

  const extractSteps = steps.filter((step) => step.type === "extract");
  const extractNameCounts = new Map<string, number>();
  let missingExtractName = false;
  for (const step of extractSteps) {
    const name = String(step.varName ?? "").trim();
    if (!name) missingExtractName = true;
    else extractNameCounts.set(name, (extractNameCounts.get(name) ?? 0) + 1);
  }
  const duplicateExtractNames = [...extractNameCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);

  return (
    <div className="flex flex-col pb-10 xl:h-[calc(100vh-48px)] xl:overflow-hidden xl:pb-0">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => navigate("/records")}>
            <ArrowLeft />
            返回记录列表
          </Button>
          <span className="tf-kicker">REC / WORKBENCH</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={phaseBadge.variant}>{phaseBadge.label}</Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={save}
            disabled={!result || steps.length === 0 || recording || busy || replaying}
          >
            <Save />
            保存记录
          </Button>
          {recording ? (
            <>
              <Button
                size="sm"
                variant={valueMode ? "default" : "outline"}
                onClick={toggleValueMode}
              >
                <Crosshair />
                {valueMode ? "取消取值" : "录制取值"}
              </Button>
              <Button size="sm" variant="destructive" onClick={stopRecording}>
                <Square />
                停止并生成
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => void startRecording()}
              disabled={busy || replaying}
            >
              {busy ? <Loader2 className="animate-spin" /> : hasDraft ? <RefreshCw /> : <MonitorDot />}
              {busy ? "加载中…" : hasDraft ? "重新录制" : "开始录制"}
            </Button>
          )}
        </div>
      </header>

      {statusText ? (
        <div
          className={cn(
            "mt-3 flex shrink-0 flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-[12px] leading-5",
            PHASE_BOX[phase],
          )}
        >
          {recording ? (
            <span className="mt-[7px] size-1.5 shrink-0 animate-pulse rounded-full bg-danger" />
          ) : null}
          <span className="min-w-0 flex-1 break-words">{statusText}</span>
          <span className="shrink-0 font-mono text-[10px] opacity-70">
            EVENTS {steps.length} · NODES {result?.dsl.nodes.length ?? 0} · CONFIRM {needsConfirm}
          </span>
        </div>
      ) : null}

      <div className="mt-4 flex min-h-0 flex-col gap-3 xl:flex-1 xl:flex-row xl:items-stretch">
        <div className="flex w-full min-w-0 shrink-0 flex-col gap-2.5 xl:min-h-0 xl:w-[380px] xl:overflow-y-auto xl:pr-1">
          <Card className="shrink-0 gap-0 overflow-hidden p-0">
            <CardHeader className="flex flex-row items-center justify-between border-b border-line px-4 pb-2.5 pt-3">
              <CardTitle>所属系统</CardTitle>
              <Badge variant={currentSystem ? "moss" : "secondary"}>
                {currentSystem
                  ? "已绑定"
                  : record.systemId
                    ? "系统已删除"
                    : "未绑定"}
              </Badge>
            </CardHeader>
            <CardContent className="grid gap-1.5 px-4 pb-3 pt-2.5">
              {currentSystem ? (
                <>
                  <span className="min-w-0 truncate text-[12.5px] font-medium">
                    {currentSystem.name}
                  </span>
                  {currentSystem.description ? (
                    <p className="line-clamp-2 text-[11px] leading-4 text-muted">
                      {currentSystem.description}
                    </p>
                  ) : null}
                  <p
                    className="truncate font-mono text-[10.5px] text-muted"
                    title={currentSystem.baseUrl}
                  >
                    {currentSystem.baseUrl}
                  </p>
                </>
              ) : (
                <p className="text-[11px] leading-4 text-muted">
                  {record.systemId ? (
                    "这条记录绑定的系统已被删除，请到「系统管理」重新维护。"
                  ) : (
                    <>
                      还没有绑定系统，可先到
                      <Link
                        className="mx-1 text-accent underline underline-offset-2"
                        to="/systems"
                      >
                        系统管理
                      </Link>
                      添加。
                    </>
                  )}
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="shrink-0 gap-0 overflow-hidden p-0">
            <CardHeader className="flex flex-row items-center justify-between border-b border-line px-4 pb-2.5 pt-3">
              <CardTitle>录制事件</CardTitle>
              <Badge variant="secondary">{steps.length} 步</Badge>
            </CardHeader>
            <CardContent className="p-0">
              {steps.length === 0 ? (
                <p className="px-4 py-5 text-center text-[11.5px] leading-4 text-muted">
                  还没有录制事件。开始录制后完成点击、输入、下拉等操作；点「录制取值」再点字段，可把值带入后续记录。
                </p>
              ) : (
                <>
                  <ol className="max-h-[240px] divide-y divide-line overflow-y-auto">
                    {steps.map((step, index) => (
                    <li key={`${step.type ?? "step"}-${index}`} className="flex items-start gap-2.5 px-4 py-2">
                      <span className="pt-0.5 font-mono text-[10px] text-muted">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">
                            {RECORD_TYPE_LABEL[step.type ?? ""] ?? step.type ?? "步骤"}
                          </Badge>
                          <span className="min-w-0 truncate text-[12px] font-medium">
                            {recordedStepLabel(step)}
                          </span>
                        </div>
                        {(step.type === "change" || step.type === "extract") &&
                        step.value !== undefined ? (
                          <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted">
                            值 {JSON.stringify(step.value)}
                          </p>
                        ) : null}
                        {step.type === "extract" ? (
                          <>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] text-muted">变量</span>
                            <Input
                              className={cn(
                                "h-6 w-[112px] font-mono text-[10.5px]",
                                !String(step.varName ?? "").trim() && "border-danger",
                              )}
                              value={step.varName ?? ""}
                              disabled={recording}
                              onChange={(event) =>
                                patchExtractStep(index, { varName: event.target.value })
                              }
                            />
                            <Select
                              value={step.readMode ?? "text"}
                              disabled={recording}
                              onValueChange={(next) =>
                                patchExtractStep(index, {
                                  readMode: next as "text" | "value" | "attribute",
                                })
                              }
                            >
                              <SelectTrigger
                                size="xs"
                                className="h-6 w-auto text-[10.5px]"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="text">文本</SelectItem>
                                <SelectItem value="value">表单值</SelectItem>
                                <SelectItem value="attribute">属性</SelectItem>
                              </SelectContent>
                            </Select>
                            {step.readMode === "attribute" ? (
                              <Input
                                className="h-6 w-[96px] font-mono text-[10.5px]"
                                value={step.attributeName ?? ""}
                                placeholder="属性名"
                                disabled={recording}
                                onChange={(event) =>
                                  patchExtractStep(index, {
                                    attributeName: event.target.value,
                                  })
                                }
                              />
                            ) : null}
                            <span className="text-[10px] text-muted">执行后带入后续记录</span>
                          </div>
                          {step.semantic?.cell ? (
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <span className="text-[10px] text-muted">行匹配</span>
                              <Select
                                value={
                                  step.semantic.cell.rowIndex !== undefined ? "first" : "value"
                                }
                                disabled={recording}
                                onValueChange={(next) =>
                                  patchExtractStep(index, {
                                    cell:
                                      next === "first"
                                        ? { rowIndex: 1 }
                                        : { rowIndex: undefined },
                                  })
                                }
                              >
                                <SelectTrigger
                                  size="xs"
                                  className="h-6 w-auto text-[10.5px]"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="value">按行值</SelectItem>
                                  <SelectItem value="first">筛选后第一行</SelectItem>
                                </SelectContent>
                              </Select>
                              {step.semantic.cell.rowIndex === undefined ? (
                                <Input
                                  className="h-6 min-w-[110px] flex-1 font-mono text-[10.5px]"
                                  value={
                                    step.semantic.cell.rowValue ??
                                    step.semantic.cell.rowText ??
                                    ""
                                  }
                                  placeholder="行值或 {{变量}}"
                                  disabled={recording}
                                  onChange={(event) => {
                                    const cell = step.semantic?.cell;
                                    if (!cell) return;
                                    patchExtractStep(index, {
                                      cell:
                                        cell.rowValue !== undefined ||
                                        cell.rowText === undefined
                                          ? {
                                              rowValue: event.target.value,
                                              rowIndex: undefined,
                                            }
                                          : {
                                              rowText: event.target.value,
                                              rowIndex: undefined,
                                            },
                                    });
                                  }}
                                />
                              ) : (
                                <span className="text-[10px] text-muted">
                                  取筛选结果第 1 行
                                </span>
                              )}
                            </div>
                          ) : null}
                          </>
                        ) : null}
                        {step.requests?.length ? (
                          <div className="mt-1 flex flex-col gap-0.5">
                            {step.requests.map((request, requestIndex) => (
                              <button
                                key={`${request.method}-${request.url}-${requestIndex}`}
                                type="button"
                                title="查看接口信息与 JSON"
                                onClick={() =>
                                  setRequestView({
                                    method: request.method,
                                    url: request.url,
                                    status: request.status,
                                    contentType: request.contentType,
                                    params: request.body,
                                    response: request.responseText,
                                  })
                                }
                                className="group flex w-full min-w-0 items-center gap-1.5 rounded-md border border-transparent px-1 py-0.5 text-left transition-colors hover:border-line hover:bg-white"
                              >
                                <Badge
                                  variant="secondary"
                                  className="shrink-0 px-1.5 py-0 font-mono text-[9px]"
                                >
                                  {request.method}
                                </Badge>
                                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
                                  {request.url}
                                </span>
                                {request.status !== undefined ? (
                                  <Badge
                                    variant={
                                      request.status >= 200 && request.status < 300
                                        ? "moss"
                                        : "destructive"
                                    }
                                    className="shrink-0 px-1.5 py-0 text-[9px]"
                                  >
                                    {request.status}
                                  </Badge>
                                ) : null}
                                <FileJson className="size-3 shrink-0 text-muted group-hover:text-accent" />
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                  </ol>
                  {missingExtractName || duplicateExtractNames.length > 0 ? (
                    <div className="border-t border-amber/20 bg-amber-soft/60 px-4 py-2 text-[10.5px] leading-4 text-amber">
                      {missingExtractName ? (
                        <p>有取值步骤缺少变量名，保存后无法在流程中引用。</p>
                      ) : null}
                      {duplicateExtractNames.length > 0 ? (
                        <p>
                          取值变量重名：{duplicateExtractNames.join("、")}
                          ，后一个会覆盖前一个。
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="flex flex-col gap-0 overflow-hidden p-0 xl:min-h-[320px] xl:flex-1">
            <CardHeader className="flex shrink-0 flex-row items-center justify-between gap-2 border-b border-line px-4 pb-2.5 pt-3">
              <CardTitle>转换结果</CardTitle>
              {result ? (
                <div className="flex items-center gap-1.5">
                  <Badge variant="moss">{result.dsl.nodes.length} 节点</Badge>
                  {overrideCount > 0 ? (
                    <Badge variant="amber">{overrideCount} 项微调</Badge>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setTuningOpen(true)}
                    disabled={replaying || busy}
                  >
                    <SlidersHorizontal />
                    微调
                  </Button>
                </div>
              ) : null}
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5 px-4 pb-3 pt-2.5 xl:min-h-0 xl:flex-1">
              {!result ? (
                <p className="text-[12px] leading-5 text-muted">
                  停止录制后自动把原始步骤转换成可执行节点，并给出跳过与待确认项。
                </p>
              ) : (
                <>
                  {result.report.needsConfirm > 0 || result.report.skipped.length > 0 ? (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11.5px] text-muted">
                      {result.report.needsConfirm > 0 ? (
                        <Badge variant="amber">{result.report.needsConfirm} 待确认</Badge>
                      ) : null}
                      {result.report.skipped.length > 0 ? (
                        <span className="font-mono text-[10.5px]">
                          跳过 {result.report.skipped.map((item) => `${item.type}×${item.count}`).join(" / ")}
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  {result.report.warnings.length > 0 ? (
                    <div className="shrink-0 rounded-lg border border-amber/20 bg-amber-soft/60 px-2.5 py-2">
                      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-amber">
                        <TriangleAlert className="size-3.5 shrink-0" />
                        转换提示
                      </div>
                      <ul className="mt-1 grid gap-1 pl-5 text-[11px] leading-4 text-amber/90">
                        {result.report.warnings.map((warning, index) => (
                          <li key={index} className="list-disc break-words">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="overflow-hidden rounded-lg border border-line bg-white xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
                    <div className="max-h-[220px] divide-y divide-line overflow-y-auto xl:max-h-none xl:min-h-0 xl:flex-1">
                      {result.dsl.nodes.map((node, index) => {
                        const sourceCount = nodeSources?.[node.id]?.length ?? 0;
                        const canDelete = sourceCount > 0 && !recording && !busy && !replaying;
                        return (
                          <div key={node.id} className="flex items-center gap-2 px-2.5 py-1.5">
                            <span className="font-mono text-[9.5px] text-muted">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <Badge variant="outline" className="w-[52px] shrink-0">
                              {NODE_TYPE_LABEL[node.type]}
                            </Badge>
                            <span className="min-w-0 flex-1 truncate text-[11.5px]">
                              {nodeLabel(node)}
                            </span>
                            {node.meta?.needsConfirm ? (
                              <TriangleAlert className="size-3 shrink-0 text-amber" />
                            ) : null}
                            <button
                              type="button"
                              className="grid size-6 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-[#fdf3f0] hover:text-danger disabled:pointer-events-none disabled:opacity-35"
                              title={
                                canDelete
                                  ? `删除节点（连带 ${sourceCount} 条录制事件）`
                                  : "没有对应的录制事件，无法删除"
                              }
                              aria-label={`删除节点 ${nodeLabel(node)}`}
                              disabled={!canDelete}
                              onClick={() => requestRemoveNode(node)}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="shrink-0 rounded-xl border border-line bg-white/70 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[11.5px] font-medium">
                        <Play className="size-3.5 text-accent" />
                        回放校验
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void replay()}
                        disabled={recording || busy || replaying}
                      >
                        {replaying ? <Loader2 className="animate-spin" /> : <Play />}
                        {replaying ? "回放中…" : "开始回放"}
                      </Button>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-muted">{replayText}</p>
                    <p className="mt-1 text-[10.5px] leading-4 text-muted">
                      单条记录回放使用录制值/微调值；流程里的环境变量注入请在流程画布点「运行流程」。
                    </p>

                    {runItems.length > 0 ? (
                      <ol className="mt-2 max-h-[190px] divide-y divide-line overflow-y-auto rounded-lg border border-line bg-white">
                        {runItems.map((item) => (
                          <li key={item.nodeId} className="px-2.5 py-1.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[9.5px] text-muted">
                                {String(item.index + 1).padStart(2, "0")}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[11.5px]">
                                {item.name ?? item.message}
                              </span>
                              {item.durationMs !== undefined ? (
                                <span className="font-mono text-[9.5px] text-muted">
                                  {item.durationMs}ms
                                </span>
                              ) : null}
                              <Badge variant={RUN_BADGE[item.status].variant}>
                                {RUN_BADGE[item.status].label}
                              </Badge>
                            </div>
                            {item.status !== "running" ? (
                              <p className="mt-0.5 break-words pl-[22px] text-[10.5px] leading-4 text-muted">
                                {item.message}
                                {item.strategy ? (
                                  <span className="ml-1 font-mono text-[9.5px] text-accent">
                                    {item.strategy}
                                  </span>
                                ) : null}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}

                    {replayApiCalls.length > 0 ? (
                      <div className="mt-2">
                        <p className="mb-1 flex items-center gap-1.5 text-[10.5px] font-medium text-muted">
                          <FileJson className="size-3" />
                          接口调用 {replayApiCalls.length}
                        </p>
                        <ApiCallRows entries={replayApiCalls} />
                      </div>
                    ) : null}
                  </div>

                  <p className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted">
                    <CheckCircle2 className="size-3 text-moss" />
                    原始步骤与 DSL 会和记录一起存入 localStorage
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="flex w-full min-w-0 flex-col gap-0 overflow-hidden p-0 xl:min-h-0 xl:flex-1">
          <CardHeader className="flex shrink-0 flex-row items-center justify-between gap-2 space-y-0 border-b border-line px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle>目标系统</CardTitle>
              <Badge variant={replaying || recording ? "accent" : "secondary"}>{frameBadge}</Badge>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              {frameUrl ? (
                <span className="hidden max-w-[360px] truncate font-mono text-[10.5px] text-muted lg:inline">
                  {frameUrl}
                </span>
              ) : null}
            </div>
          </CardHeader>
          <div className="relative min-h-[540px] flex-1 xl:min-h-0">
            <iframe
              ref={iframeRef}
              title="目标系统录制窗口"
              className="h-full min-h-[540px] w-full bg-white xl:min-h-0"
            />
            {!frameLoaded && !busy ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center bg-paper/75 p-8 text-center backdrop-blur-[2px]">
                <div className="max-w-[380px]">
                  <div className="mx-auto grid size-11 place-items-center rounded-xl border border-line bg-white text-accent">
                    <Video className="size-5" />
                  </div>
                  <h2 className="mt-3 text-[14px] font-semibold">目标系统尚未加载</h2>
                  <p className="mt-1 text-[12px] leading-5 text-muted">
                    点右上角「开始录制」加载目标页并开始捕获操作；遇到登录页时先在窗口内完成登录，再重新开始。
                  </p>
                  {record.systemId ? (
                    <p className="mt-2 font-mono text-[10.5px] text-muted">
                      系统地址可在 <Link className="text-accent underline underline-offset-2" to="/systems">系统管理</Link> 维护
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
            {busy ? (
              <div className="absolute inset-0 grid place-items-center bg-paper/70 backdrop-blur-[2px]">
                <div className="flex items-center gap-2 rounded-full border border-line bg-white px-4 py-2 text-[12px] text-muted shadow-sm">
                  <Loader2 className="size-4 animate-spin text-accent" />
                  正在加载目标系统…
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      {result ? (
        <NodeTuningDialog
          open={tuningOpen}
          dsl={result.dsl}
          values={overrides}
          onOpenChange={setTuningOpen}
          onApply={applyTuning}
        />
      ) : null}

      <ApiRequestDialog
        value={requestView}
        onOpenChange={(open) => {
          if (!open) setRequestView(null);
        }}
      />

      <AlertDialog
        open={Boolean(deletingNode)}
        onOpenChange={(open) => {
          if (!open) setDeletingNode(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个节点？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deletingNode ? nodeLabel(deletingNode.node) : ""}」会连同它对应的{" "}
              {deletingNode?.indices.length ?? 0} 条录制事件一起删除，剩余步骤会重新生成节点；
              已调整的微调值会重置，保存记录后生效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <X />
              取消
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoveNode}>
              <Trash2 />
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
