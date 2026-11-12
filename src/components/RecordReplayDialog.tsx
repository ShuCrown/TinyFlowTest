import { useEffect, useRef, useState } from "react";
import { ListOrdered, Loader2, Play, RotateCcw, Square, TriangleAlert, Video, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ExtractNode, FlowDsl, FlowNode, ValueLike } from "@/dsl/index.ts";
import { getSystemToken } from "@/lib/store";
import {
  activateProxyTarget,
  describeTargetFailure,
  loadProxyConfig,
  resolveTargetUrl,
  type ProxyConfig,
} from "@/lib/proxy";
import { injectSystemToken } from "@/lib/session";
import type { OperationRecord } from "@/lib/types";
import {
  createIframeHost,
  runFlow,
  type IframeHost,
  type ReplayEvent,
  type ReplayNodeStatus,
} from "@/replay/index.ts";

type Phase = "idle" | "loading" | "running" | "login" | "finished" | "failed";

type StepStatus = "running" | ReplayNodeStatus;

interface RunItem {
  nodeId: string;
  status: StepStatus;
  message: string;
  durationMs?: number;
  strategy?: string;
}

const INITIAL_TEXT = "点「开始回放」加载目标页，按录制顺序重走这条记录。";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "待回放",
  loading: "加载中",
  running: "回放中",
  login: "需要登录",
  finished: "已完成",
  failed: "失败",
};

const PHASE_VARIANT: Record<
  Phase,
  "secondary" | "accent" | "moss" | "amber" | "destructive"
> = {
  idle: "secondary",
  loading: "accent",
  running: "accent",
  login: "amber",
  finished: "moss",
  failed: "destructive",
};

const STEP_TYPE_LABEL: Record<FlowNode["type"], string> = {
  navigate: "导航",
  interact: "操作",
  picker: "选择",
  wait: "等待",
  extract: "取值",
};

const READ_LABEL: Record<string, string> = {
  text: "文本",
  value: "表单值",
  attribute: "属性",
};

const PICKER_STRATEGY_LABEL: Record<string, string> = {
  byText: "按文本",
  byRow: "按行",
  byIndex: "按位置",
  firstVisible: "第一条可见",
};

const RUN_BADGE: Record<
  StepStatus,
  { label: string; variant: "secondary" | "moss" | "amber" | "accent" | "destructive" }
> = {
  running: { label: "执行中", variant: "secondary" },
  pass: { label: "通过", variant: "moss" },
  healed: { label: "自愈", variant: "amber" },
  manual: { label: "人工完成", variant: "accent" },
  fail: { label: "失败", variant: "destructive" },
  skipped: { label: "跳过", variant: "secondary" },
};

function valueText(value: ValueLike | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => valueText(item as ValueLike)).join(",");
  if (typeof value === "object" && "kind" in value) {
    const expr = value as { kind?: unknown; value?: unknown; name?: unknown };
    if (expr.kind === "literal") return expr.value == null ? "" : String(expr.value);
    if (expr.kind === "var" && typeof expr.name === "string") return `{{${expr.name}}}`;
  }
  return "";
}

function stepLabel(node: FlowNode): string {
  if (node.type === "navigate") return node.url;
  if (node.type === "picker") return node.name ?? node.trigger.label ?? "复合选择";
  if (node.type === "interact") return node.name ?? node.target.label ?? node.adapter;
  if (node.type === "wait") {
    if (node.name) return node.name;
    const condition = node.condition;
    if (typeof condition === "string") return condition;
    const label = "target" in condition ? condition.target?.label : undefined;
    return label ? `等待「${label}」${condition.kind}` : `等待 ${condition.kind}`;
  }
  return node.name ?? node.varName ?? node.id;
}

function extractDetail(node: ExtractNode): string {
  if (node.source === "const") return `手动 · ${node.value || "空值"}`;
  if (node.source === "response") {
    const response = node.response;
    return `接口 · ${response.urlContains || "未设置 URL"}${
      response.path ? ` · ${response.path}` : ""
    }`;
  }
  if (node.source === "js") {
    return `JS · ${node.js?.trim().slice(0, 48) || "未设置表达式"}`;
  }
  const cell = node.target.strategies.find((strategy) => strategy.type === "cell");
  if (cell?.type === "cell") {
    const row = cell.cell.rowValue || cell.cell.rowText || "未设置行";
    const column =
      cell.cell.header || (cell.cell.colIndex ? `第${cell.cell.colIndex}列` : "未设置列");
    return `表格 · ${row} / ${column}`;
  }
  const css = node.target.strategies.find((strategy) => strategy.type === "css");
  const label =
    node.target.label?.trim() || (css?.type === "css" ? css.value : "未设置选择器");
  return `读取${READ_LABEL[node.read] ?? node.read} · ${label}`;
}

function stepDetail(node: FlowNode): string {
  switch (node.type) {
    case "navigate":
      return "打开页面";
    case "interact": {
      if (node.adapter === "check") return node.checked ? "回放时勾选" : "回放时取消";
      const value = valueText(node.value);
      return value ? `${node.adapter} · 值 ${JSON.stringify(value)}` : `${node.adapter} · 无输入值`;
    }
    case "picker": {
      const filters = (node.filter?.steps ?? [])
        .map((step) => valueText(step.value))
        .filter(Boolean);
      const picks = (node.pick.values ?? []).map((item) => item.value ?? "").filter(Boolean);
      const fallback = valueText(node.pick.byText?.value);
      if (picks.length === 0 && fallback) picks.push(fallback);
      const strategy = PICKER_STRATEGY_LABEL[node.pick.strategy] ?? node.pick.strategy;
      const parts: string[] = [];
      if (filters.length > 0) parts.push(`筛选 ${filters.join(" / ")}`);
      if (node.pick.strategy === "byIndex") {
        parts.push(`位置 ${node.pick.byIndex?.indexes.join(", ") ?? "未设置"}`);
      } else if (picks.length > 0) {
        parts.push(`选择 ${picks.join(" / ")}`);
      } else {
        parts.push(strategy);
      }
      return parts.join(" → ");
    }
    case "wait":
      return node.message ?? "等待页面条件满足";
    case "extract":
      return extractDetail(node);
  }
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
}

export function RecordReplayDialog({
  open,
  record,
  onClose,
}: {
  open: boolean;
  record: OperationRecord;
  onClose: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<IframeHost | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusText, setStatusText] = useState(INITIAL_TEXT);
  const [items, setItems] = useState<RunItem[]>([]);
  const [frameUrl, setFrameUrl] = useState("");
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | null>(null);

  const dsl = record.dsl;
  const active = phase === "loading" || phase === "running";

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      hostRef.current?.dispose();
      hostRef.current = null;
    };
  }, []);

  const stop = (): void => {
    abortRef.current?.abort();
    setItems((current) =>
      current.map((item) =>
        item.status === "running"
          ? { ...item, status: "skipped", message: "回放已停止" }
          : item,
      ),
    );
    setPhase("idle");
    setStatusText("已停止回放。");
  };

  const start = async (): Promise<void> => {
    const frame = frameRef.current;
    if (!frame || !dsl || active) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("loading");
    setStatusText("正在加载目标系统…");
    setItems([]);

    try {
      let config = proxyConfig;
      if (!config) {
        try {
          config = await loadProxyConfig();
          setProxyConfig(config);
        } catch {
          config = null;
        }
      }
      if (controller.signal.aborted) return;
      const resolved = resolveTargetUrl(record.targetUrl, config);
      if (!resolved) throw new Error(describeTargetFailure(config, ""));
      if (resolved.viaProxy && resolved.targetUrl) {
        await activateProxyTarget(resolved.targetUrl);
      }

      let doc = await loadFrame(frame, resolved.url.toString());
      if (controller.signal.aborted) return;
      const token = record.systemId ? getSystemToken(record.systemId) : "";
      if (resolved.viaProxy && token.trim()) {
        injectSystemToken(doc, token);
        doc = await loadFrame(frame, resolved.url.toString());
        if (controller.signal.aborted) return;
      }
      if (doc.querySelector('input[type="password"]')) {
        setPhase("login");
        setStatusText("检测到登录页：请先在左侧窗口完成登录，再点「重新回放」。");
        return;
      }
      try {
        setFrameUrl(frame.contentWindow?.location.href ?? "");
      } catch {
        setFrameUrl("");
      }

      const host = createIframeHost(frame);
      hostRef.current = host;
      setPhase("running");
      setStatusText(`回放中 · 0/${dsl.nodes.length} 节点`);

      const patchedDsl: FlowDsl = {
        ...dsl,
        systems: dsl.systems.map((system) => ({
          ...system,
          baseUrl: window.location.origin,
        })),
      };
      await runFlow({
        dsl: patchedDsl,
        host,
        values: record.values ?? {},
        signal: controller.signal,
        onEvent: (event: ReplayEvent) => {
          if (event.type === "run.started") {
            setStatusText(`回放中 · 0/${event.totalNodes} 节点`);
            return;
          }
          if (event.type === "node.started") {
            setItems((current) => [
              ...current,
              {
                nodeId: event.nodeId,
                status: "running",
                message: "执行中…",
              },
            ]);
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
                      strategy: event.node.strategy,
                    }
                  : item,
              ),
            );
            return;
          }
          if (event.type !== "run.finished") return;
          const seconds = (event.durationMs / 1000).toFixed(1);
          if (event.status === "finished") {
            setPhase("finished");
            setStatusText(`完成 · ${event.passed}/${event.total} 节点通过 · ${seconds}s`);
          } else if (event.status === "canceled") {
            setPhase("idle");
            setStatusText("已停止回放。");
          } else {
            setPhase("failed");
            setStatusText(`回放失败 · ${event.error ?? "未知错误"}`);
          }
        },
      });
      try {
        setFrameUrl(frame.contentWindow?.location.href ?? "");
      } catch {
        // 回放后跳出同源时保留上一次地址。
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setPhase("failed");
        setStatusText(`回放失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      hostRef.current?.dispose();
      hostRef.current = null;
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="w-[calc(100vw-16px)] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="size-4 text-accent" />
            回放记录 · {record.name}
          </DialogTitle>
          <DialogDescription>
            查看这条记录包含的执行步骤，并在目标系统里按录制顺序重走一遍。
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="min-h-0 flex-1 overflow-hidden p-0">
          <div className="flex h-[calc(100vh-210px)] min-h-[440px] flex-col lg:flex-row">
            <div className="relative min-h-[300px] flex-1 bg-white">
              <iframe
                ref={frameRef}
                title="记录回放窗口"
                className="h-full min-h-[300px] w-full bg-white"
              />
              {phase === "idle" ? (
                <div className="pointer-events-none absolute inset-0 grid place-items-center bg-paper/75 p-8 text-center backdrop-blur-[2px]">
                  <div className="max-w-[320px]">
                    <div className="mx-auto grid size-11 place-items-center rounded-xl border border-line bg-white text-accent">
                      <Video className="size-5" />
                    </div>
                    <h3 className="mt-3 text-[14px] font-semibold">目标系统尚未加载</h3>
                    <p className="mt-1 text-[12px] leading-5 text-muted">
                      点右侧「开始回放」加载目标页；遇到登录页时先在窗口内登录，再重新回放。
                    </p>
                  </div>
                </div>
              ) : null}
              {phase === "loading" ? (
                <div className="absolute inset-0 grid place-items-center bg-paper/70 backdrop-blur-[2px]">
                  <div className="flex items-center gap-2 rounded-full border border-line bg-white px-4 py-2 text-[12px] text-muted shadow-sm">
                    <Loader2 className="size-4 animate-spin text-accent" />
                    正在加载目标系统…
                  </div>
                </div>
              ) : null}
              {frameUrl ? (
                <div className="absolute bottom-2 left-2 max-w-[70%] truncate rounded-md border border-line bg-white/90 px-2 py-1 font-mono text-[10px] text-muted">
                  {frameUrl}
                </div>
              ) : null}
            </div>

            <aside className="flex w-full shrink-0 flex-col border-t border-line bg-paper/70 p-2 lg:w-[400px] lg:border-l lg:border-t-0">
              <Card className="min-h-0 flex-1 gap-0 p-0">
                <div className="border-b border-line px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold">回放状态</span>
                    <Badge variant={PHASE_VARIANT[phase]}>{PHASE_LABEL[phase]}</Badge>
                  </div>
                  <p className="mt-1 break-words text-[11.5px] leading-5 text-muted">{statusText}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {active ? (
                      <Button size="sm" variant="destructive" onClick={stop}>
                        <Square />
                        停止
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => void start()} disabled={!dsl}>
                        {phase === "finished" || phase === "failed" || phase === "login" ? (
                          <RotateCcw />
                        ) : (
                          <Play />
                        )}
                        {phase === "finished" || phase === "failed" || phase === "login"
                          ? "重新回放"
                          : "开始回放"}
                      </Button>
                    )}
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
                      <ListOrdered className="size-3.5 text-accent" />
                      执行步骤
                    </h3>
                    <Badge variant="secondary">{dsl?.nodes.length ?? 0}</Badge>
                  </div>

                  {!dsl || dsl.nodes.length === 0 ? (
                    <p className="mt-2 text-[11.5px] leading-5 text-muted">
                      这条记录还没有可执行节点，请先在录制页生成 DSL。
                    </p>
                  ) : (
                    <ol className="mt-2 grid gap-1.5">
                      {dsl.nodes.map((step, index) => {
                        const runItem = items.find((item) => item.nodeId === step.id);
                        return (
                          <li
                            key={step.id}
                            className="rounded-lg border border-line px-2.5 py-2"
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[9.5px] text-muted">
                                {String(index + 1).padStart(2, "0")}
                              </span>
                              <Badge variant="outline">{STEP_TYPE_LABEL[step.type]}</Badge>
                              <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                                {stepLabel(step)}
                              </span>
                              {runItem?.durationMs !== undefined ? (
                                <span className="font-mono text-[9.5px] text-muted">
                                  {runItem.durationMs}ms
                                </span>
                              ) : null}
                              {runItem ? (
                                <Badge variant={RUN_BADGE[runItem.status].variant}>
                                  {RUN_BADGE[runItem.status].label}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="mt-0.5 break-words pl-[22px] text-[10.5px] leading-4 text-muted">
                              {stepDetail(step)}
                            </p>
                            {runItem && runItem.status !== "running" ? (
                              <p className="mt-0.5 break-words pl-[22px] text-[10.5px] leading-4 text-muted">
                                {runItem.message}
                                {runItem.strategy ? (
                                  <span className="ml-1 font-mono text-[9.5px] text-accent">
                                    {runItem.strategy}
                                  </span>
                                ) : null}
                              </p>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  )}

                  <p className="mt-3 text-[10.5px] leading-4 text-muted">
                    回放使用这条记录自己的录制值/微调值；流程里的环境变量注入请在画布点「运行流程」。
                  </p>
                </div>
              </Card>
            </aside>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 sm:justify-between">
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <TriangleAlert className="size-3.5" />
            回放会真实操作目标系统，重复执行可能产生重复数据。
          </span>
          <Button variant="outline" onClick={onClose}>
            <X />
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
