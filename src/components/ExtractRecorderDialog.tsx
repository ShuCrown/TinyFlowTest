import { useEffect, useRef, useState } from "react";
import {
  Check,
  Crosshair,
  Loader2,
  MonitorDot,
  RefreshCw,
  TriangleAlert,
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
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui";
import { cn } from "@/lib/utils";
import { getSystemToken } from "@/lib/store";
import {
  describeTargetFailure,
  loadProxyConfig,
  resolveTargetUrl,
  type ProxyConfig,
} from "@/lib/proxy";
import { injectSystemToken } from "@/lib/session";
import type { TargetSystem } from "@/lib/types";
import { DomRecorder } from "@/recorder/dom-recorder.ts";
import type { ChromeRecorderStep } from "@/recorder/chrome-recorder.ts";
import {
  buildExtractRecording,
  type ExtractRecordingApplied,
} from "@/flow/extract-recording.ts";

const STEP_LABEL: Record<string, string> = {
  navigate: "导航",
  click: "点击",
  doubleClick: "双击",
  change: "输入",
  input: "输入",
  extract: "取值",
  keydown: "按键",
  waitForElement: "等待元素",
  hover: "悬停",
};

function stepLabel(step: ChromeRecorderStep): string {
  if (step.type === "navigate") return String(step.url ?? "");
  return String(step.labelText ?? step.value ?? step.type ?? "步骤");
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

const ExtractRecorderDialog = ({
  open,
  systems,
  initialSystemId,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  systems: TargetSystem[];
  initialSystemId?: string;
  onOpenChange: (open: boolean) => void;
  onApply: (result: ExtractRecordingApplied) => void;
}) => {
  const [step, setStep] = useState<"select" | "record">("select");
  const [systemId, setSystemId] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | null>(null);
  const [recording, setRecording] = useState(false);
  const [valueMode, setValueMode] = useState(false);
  const [steps, setSteps] = useState<ChromeRecorderStep[]>([]);
  const [frameUrl, setFrameUrl] = useState("");
  const [autoStart, setAutoStart] = useState(false);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const recorderRef = useRef<DomRecorder | null>(null);

  const getRecorder = (): DomRecorder => {
    if (!recorderRef.current) {
      recorderRef.current = new DomRecorder({
        onChange: (next) => setSteps(next),
        onValueModeChange: (armed) => setValueMode(armed),
      });
    }
    return recorderRef.current;
  };

  const stopRecorder = (): void => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
    setValueMode(false);
  };

  useEffect(() => {
    if (!open) {
      stopRecorder();
      const frame = frameRef.current;
      if (frame) frame.src = "about:blank";
      return;
    }
    const system = systems.find((item) => item.id === initialSystemId) ?? systems[0];
    setStep("select");
    setSystemId(system?.id ?? "");
    setTargetUrl(system?.baseUrl ?? "");
    setBusy(false);
    setError("");
    setRecording(false);
    setValueMode(false);
    setSteps([]);
    setFrameUrl("");
    setAutoStart(false);
  }, [open, initialSystemId, systems]);

  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
      recorderRef.current = null;
      const frame = frameRef.current;
      if (frame) frame.src = "about:blank";
    };
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !recording) return;
    const handleLoad = (): void => {
      const doc = frame.contentDocument;
      if (!doc) {
        setError("目标页跳出同源范围，无法继续录制。请改用同源代理地址。");
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
        setFrameUrl("");
      }
    };
    frame.addEventListener("load", handleLoad);
    return () => frame.removeEventListener("load", handleLoad);
  }, [recording]);

  const startRecording = async (): Promise<void> => {
    const system = systems.find((item) => item.id === systemId);
    if (!system) {
      setError("请选择目标系统。");
      return;
    }
    const frame = frameRef.current;
    if (!frame) {
      setError("录制窗口尚未就绪。");
      return;
    }
    setBusy(true);
    setError("");
    stopRecorder();
    setSteps([]);
    try {
      const config = proxyConfig ?? (await loadProxyConfig());
      setProxyConfig(config);
      const resolved = resolveTargetUrl(targetUrl || system.baseUrl, config);
      if (!resolved) throw new Error(describeTargetFailure(config, ""));
      frame.src = "about:blank";
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      let doc = await loadFrame(frame, resolved.url.toString());
      const token = getSystemToken(system.id);
      if (resolved.viaProxy && token.trim()) {
        injectSystemToken(doc, token);
        doc = await loadFrame(frame, resolved.url.toString());
      }
      if (doc.querySelector('input[type="password"]')) {
        setError("检测到登录页：请先在窗口内完成登录，再点「重新录制」。");
        setBusy(false);
        return;
      }
      const recorder = new DomRecorder({
        onChange: (next) => setSteps(next),
        onValueModeChange: (armed) => setValueMode(armed),
      });
      recorderRef.current = recorder;
      recorder.start();
      recorder.attach(doc);
      try {
        const url = frame.contentWindow?.location.href ?? "";
        if (url) {
          recorder.recordNavigation(url);
          setFrameUrl(url);
        }
      } catch {
        setFrameUrl("");
      }
      setRecording(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (step !== "record" || !autoStart) return;
    setAutoStart(false);
    void startRecording();
  }, [step, autoStart]);

  const begin = (): void => {
    if (!systemId) {
      setError("请选择目标系统。");
      return;
    }
    setError("");
    setAutoStart(true);
    setStep("record");
  };

  const toggleValueMode = (): void => {
    const recorder = recorderRef.current;
    if (!recorder || !recording) return;
    if (valueMode) recorder.cancelValueCapture("canceled");
    else recorder.armValueCapture();
  };

  const finish = (): void => {
    const recorder = recorderRef.current;
    const system = systems.find((item) => item.id === systemId);
    if (!recorder || !system) {
      setError("录制尚未开始。");
      return;
    }
    const current = recorder.getSteps();
    if (!current.some((item) => item.type === "extract")) {
      setError("还没有取值目标：请点「录制取值」后再点要读取的字段。");
      return;
    }
    const captured = recorder.stop();
    setRecording(false);
    setValueMode(false);
    const built = buildExtractRecording(captured, {
      id: system.id,
      name: system.name,
      // 录制发生在同源代理页里，导航地址按当前应用 origin 归一化。
      baseUrl: window.location.origin,
    });
    if (!built.value) {
      setError(built.error);
      return;
    }
    onApply(built.value);
    onOpenChange(false);
  };

  const backToSelect = (): void => {
    stopRecorder();
    setSteps([]);
    setError("");
    setStep("select");
  };

  const close = (): void => {
    stopRecorder();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="w-[min(1240px,calc(100vw-24px))] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorDot className="size-4 text-accent" />
            录制取值步骤
          </DialogTitle>
          <DialogDescription>
            先选择目标系统，在弹窗里完成真实操作；点「录制取值」再点要读取的字段，可以录多个取值。完成后操作和取值步骤会保存到当前取值节点。
          </DialogDescription>
        </DialogHeader>

        {step === "select" ? (
          <DialogBody className="grid gap-3 py-6">
            {systems.length === 0 ? (
              <p className="rounded-lg border border-amber/20 bg-amber-soft px-3 py-2 text-[12px] leading-5 text-amber">
                还没有系统，请先到「系统管理」添加目标系统。
              </p>
            ) : (
              <>
                <Field label="目标系统">
                  <Select
                    value={systemId}
                    onValueChange={(nextId) => {
                      setSystemId(nextId);
                      const system = systems.find((item) => item.id === nextId);
                      setTargetUrl(system?.baseUrl ?? "");
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择目标系统" />
                    </SelectTrigger>
                    <SelectContent>
                      {systems.map((system) => (
                        <SelectItem key={system.id} value={system.id}>
                          {system.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="目标地址" hint="默认使用系统的入口地址，可改成具体页面。">
                  <Input
                    className="h-9 font-mono text-[11.5px]"
                    value={targetUrl}
                    spellCheck={false}
                    onChange={(event) => setTargetUrl(event.target.value)}
                    placeholder={systems[0]?.baseUrl ?? "https://..."}
                  />
                </Field>
              </>
            )}
            {error ? (
              <p className="flex items-start gap-2 rounded-lg border border-danger/20 bg-[#fdf3f0] px-3 py-2 text-[12px] leading-5 text-danger">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="outline" onClick={close}>
                <X />
                取消
              </Button>
              <Button onClick={begin} disabled={busy || !systemId || systems.length === 0}>
                {busy ? <Loader2 className="animate-spin" /> : <MonitorDot />}
                开始录制
              </Button>
            </div>
          </DialogBody>
        ) : (
          <>
            <DialogBody className="min-h-0 flex-1 overflow-hidden p-0">
              <div className="flex h-[calc(100vh-230px)] min-h-[460px] flex-col lg:flex-row">
                <div className="flex min-h-[320px] min-w-0 flex-1 flex-col bg-white">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                    <Badge variant={recording ? "accent" : busy ? "amber" : "secondary"}>
                      {busy ? "加载中" : recording ? "录制中" : "待录制"}
                    </Badge>
                    <span className="min-w-0 truncate font-mono text-[10px] text-muted">
                      {frameUrl || targetUrl}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {recording ? (
                        <Button
                          size="sm"
                          variant={valueMode ? "default" : "outline"}
                          onClick={toggleValueMode}
                        >
                          <Crosshair />
                          {valueMode ? "取消取值" : "录制取值"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void startRecording()}
                      >
                        {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        {recording ? "重新录制" : "开始录制"}
                      </Button>
                    </div>
                  </div>
                  <div className="relative min-h-0 flex-1 bg-panel">
                    <iframe
                      ref={frameRef}
                      title="取值录制窗口"
                      className="h-full min-h-[320px] w-full bg-white"
                    />
                    {!recording && !busy ? (
                      <div className="pointer-events-none absolute inset-0 grid place-items-center bg-paper/75 p-6 text-center backdrop-blur-[2px]">
                        <div className="max-w-[300px]">
                          <div className="mx-auto grid size-10 place-items-center rounded-xl border border-line bg-white text-accent">
                            <MonitorDot className="size-4" />
                          </div>
                          <p className="mt-2 text-[12px] leading-5 text-muted">
                            点「开始录制」加载目标页。遇到登录页时先在窗口内完成登录，再重新开始。
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {error ? (
                    <p className="m-2 flex items-start gap-2 rounded-lg border border-danger/20 bg-[#fdf3f0] px-3 py-2 text-[12px] leading-5 text-danger">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                      <span>{error}</span>
                    </p>
                  ) : null}
                </div>

                <aside className="flex w-full shrink-0 flex-col border-t border-line bg-panel lg:w-[280px] lg:border-l lg:border-t-0">
                  <div className="flex items-center justify-between border-b border-line px-3 py-2">
                    <span className="text-[11.5px] font-medium">录制步骤</span>
                    <Badge variant="secondary">{steps.length}</Badge>
                  </div>
                  <ol className="min-h-0 flex-1 overflow-y-auto p-2">
                    {steps.length === 0 ? (
                      <li className="px-1.5 py-3 text-[11px] leading-5 text-muted">
                        还没有步骤。先在目标页完成操作，再点「录制取值」选中要读取的字段。
                      </li>
                    ) : (
                      steps.map((item, index) => (
                        <li
                          key={`${item.type ?? "step"}-${index}`}
                          className={cn(
                            "flex items-start gap-1.5 rounded-md px-1.5 py-1.5 text-[10.5px]",
                            item.type === "extract" && "bg-moss/10",
                          )}
                        >
                          <span className="pt-0.5 font-mono text-[9px] text-muted">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {STEP_LABEL[item.type ?? ""] ?? item.type ?? "步骤"}
                            </span>
                            <span className="block truncate text-[9.5px] text-muted">
                              {stepLabel(item)}
                            </span>
                          </span>
                        </li>
                      ))
                    )}
                  </ol>
                  <p className="border-t border-line px-3 py-2 text-[10px] leading-4 text-muted">
                    每个「取值」步骤都会成为一个变量；操作和取值按录制顺序保留。
                  </p>
                </aside>
              </div>
            </DialogBody>

            <DialogFooter className="shrink-0 sm:justify-between">
              <Button size="sm" variant="ghost" onClick={backToSelect}>
                返回选择系统
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={close}>
                  <X />
                  取消
                </Button>
                <Button onClick={finish} disabled={!recording && steps.length === 0}>
                  <Check />
                  完成并应用
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export { ExtractRecorderDialog };
