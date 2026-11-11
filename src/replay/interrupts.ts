/** 回放中止原因：暂停与停止必须区分，暂停后还能继续，停止不能。 */
export class ReplayInterruptedError extends Error {
  readonly interrupt: "pause" | "stop";

  constructor(interrupt: "pause" | "stop", message?: string) {
    super(message ?? (interrupt === "pause" ? "回放已暂停" : "回放已停止"));
    this.name = "ReplayInterruptedError";
    this.interrupt = interrupt;
  }
}

export function isInterruptError(error: unknown): error is ReplayInterruptedError {
  return error instanceof ReplayInterruptedError;
}

/** 把外部 signal 与本次尝试的 signal 合成一个；任一中止都会立即唤醒等待。 */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);

  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of active) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

/** 统一把中止原因翻译成可识别的回放中断。 */
export function interruptOf(reason: unknown): ReplayInterruptedError {
  if (reason instanceof ReplayInterruptedError) return reason;
  if (reason && typeof reason === "object" && "interrupt" in reason) {
    const interrupt = (reason as { interrupt?: unknown }).interrupt;
    if (interrupt === "pause" || interrupt === "stop") {
      return new ReplayInterruptedError(interrupt);
    }
  }
  return new ReplayInterruptedError("stop");
}

/** 统一把中止翻译成可识别的回放中断。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw interruptOf(signal.reason);
}

/** 可中止的 sleep；中止时立即 reject，而不是等定时器到期。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(interruptOf(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(interruptOf(signal!.reason));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
