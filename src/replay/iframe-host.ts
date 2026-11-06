import {
  ReplayError,
  type CapturedHttpResponse,
  type ReplayHost,
  type ResponseMatcher,
} from "./types.ts";
import { observeNetwork } from "../lib/network-observer.ts";

export interface IframeHost extends ReplayHost {
  dispose(): void;
}

const MAX_CAPTURED_RESPONSES = 30;
const MAX_CAPTURED_BODY_CHARS = 512 * 1024;

interface ResponseWaiter {
  matcher: ResponseMatcher;
  resolve: (value: CapturedHttpResponse) => void;
  reject: (error: unknown) => void;
  timer: number;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * 同源 iframe 宿主：navigate 等待 load，getDocument 暴露 iframe 文档。
 * 跨域页面无法读取 contentDocument，会给出明确的“仅支持同源回放”错误。
 */
export function createIframeHost(iframe: HTMLIFrameElement): IframeHost {
  let trackedUrl = "";
  let captureEnabled = false;
  let captureCleanup: (() => void) | null = null;
  const captured: CapturedHttpResponse[] = [];
  const waiters = new Set<ResponseWaiter>();

  const currentUrl = (): string | undefined => {
    try {
      return iframe.contentWindow?.location.href;
    } catch {
      return undefined;
    }
  };

  const finishWaiter = (waiter: ResponseWaiter, entry: CapturedHttpResponse): void => {
    waiters.delete(waiter);
    window.clearTimeout(waiter.timer);
    detachAbort(waiter);
    waiter.resolve(entry);
  };

  const readDocument = (): Document => {
    const doc = iframe.contentDocument;
    if (!doc) {
      throw new ReplayError(
        `无法读取回放页面：${iframe.src} 与宿主不同源，浏览器演示只支持同源目标`,
      );
    }
    return doc;
  };

  /** 每个新文档重置缓冲并重新挂钩子；首屏 load 期间已发出的请求抓不到。 */
  const installCapture = (doc: Document | null | undefined): void => {
    captureCleanup?.();
    captureCleanup = null;
    captured.length = 0;
    const win = doc?.defaultView;
    if (!win) return;
    captureCleanup = observeNetwork(win, {
      readResponseBody: true,
      maxBodyChars: MAX_CAPTURED_BODY_CHARS,
      shouldReadResponseBody: (contentType) =>
        !contentType || /json|text\/|xml/i.test(contentType),
      onResponse: (response) => {
        if (!response.bodyText) return;
        const entry: CapturedHttpResponse = {
          method: response.method,
          url: response.url,
          status: response.status,
          responseBody: response.bodyText,
          requestBody: requestBodyText(response.body),
          contentType: response.contentType,
          capturedAt: Date.now(),
        };
        captured.push(entry);
        if (captured.length > MAX_CAPTURED_RESPONSES) captured.shift();
        for (const waiter of [...waiters]) {
          if (matchesResponse(entry, waiter.matcher)) finishWaiter(waiter, entry);
        }
      },
    });
  };

  const onLoad = (): void => {
    trackedUrl = currentUrl() ?? iframe.src;
    if (captureEnabled) installCapture(iframe.contentDocument);
  };
  iframe.addEventListener("load", onLoad);

  const startNetworkCapture = (): void => {
    if (captureEnabled) return;
    captureEnabled = true;
    try {
      installCapture(readDocument());
    } catch {
      // 文档还不能读取时，交给下一次 load 安装。
    }
  };

  return {
    async navigate(url: string, timeoutMs: number): Promise<void> {
      const target = new URL(url);
      const loaded = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          iframe.removeEventListener("load", handleLoad);
          reject(new ReplayError(`页面加载超时: ${target.href}`));
        }, timeoutMs);
        const handleLoad = (): void => {
          window.clearTimeout(timer);
          iframe.removeEventListener("load", handleLoad);
          // trackedUrl 与网络钩子由常驻的 onLoad 监听器更新，这里只负责唤醒等待方。
          resolve();
        };
        iframe.addEventListener("load", handleLoad, { once: true });
      });

      const previous = currentUrl();
      try {
        if (previous === target.href && iframe.contentWindow) {
          iframe.contentWindow.location.reload();
        } else {
          iframe.src = target.href;
        }
      } catch {
        iframe.src = target.href;
      }
      await loaded;
      trackedUrl = target.href;
    },
    getDocument(): Document {
      return readDocument();
    },
    getUrl(): string {
      return currentUrl() ?? trackedUrl;
    },
    startNetworkCapture,
    waitForResponse(
      matcher: ResponseMatcher,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<CapturedHttpResponse> {
      startNetworkCapture();
      for (let index = captured.length - 1; index >= 0; index -= 1) {
        const entry = captured[index]!;
        if (matchesResponse(entry, matcher)) return Promise.resolve(entry);
      }
      return new Promise<CapturedHttpResponse>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new ReplayError("回放已取消"));
          return;
        }
        const waiter: ResponseWaiter = {
          matcher,
          resolve,
          reject,
          timer: 0,
        };
        waiter.timer = window.setTimeout(() => {
          waiters.delete(waiter);
          detachAbort(waiter);
          const recent = captured
            .slice(-5)
            .map((entry) => `${entry.method} ${shortUrl(entry.url)} ${entry.status}`)
            .join("；");
          reject(
            new ReplayError(
              `等待接口响应超时: ${matcherLabel(matcher)}${
                recent ? `（最近响应：${recent}）` : "（未捕获到响应）"
              }`,
            ),
          );
        }, Math.max(0, timeoutMs));
        waiter.onAbort = () => {
          waiters.delete(waiter);
          window.clearTimeout(waiter.timer);
          reject(new ReplayError("回放已取消"));
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        waiters.add(waiter);
      });
    },
    evaluate<T = unknown>(expression: string): T {
      const win = readDocument().defaultView;
      if (!win) throw new ReplayError("目标页没有可用 window");
      return win.eval(expression) as T;
    },
    dispose(): void {
      iframe.removeEventListener("load", onLoad);
      captureCleanup?.();
      captureCleanup = null;
      captured.length = 0;
      for (const waiter of [...waiters]) {
        window.clearTimeout(waiter.timer);
        detachAbort(waiter);
        waiter.reject(new ReplayError("回放已取消"));
      }
      waiters.clear();
    },
  };
}

function matchesResponse(entry: CapturedHttpResponse, matcher: ResponseMatcher): boolean {
  if (matcher.method && entry.method !== matcher.method.toUpperCase()) return false;
  if (!entry.url.includes(matcher.urlContains)) return false;
  if (matcher.bodyContains && !(entry.requestBody ?? "").includes(matcher.bodyContains)) {
    return false;
  }
  return true;
}

function detachAbort(waiter: ResponseWaiter): void {
  if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
}

function requestBodyText(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function matcherLabel(matcher: ResponseMatcher): string {
  return `${matcher.method ?? "ANY"} ${matcher.urlContains}`;
}

function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}
