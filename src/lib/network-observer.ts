/** 目标页网络观察：包装 fetch / XMLHttpRequest，只读参数与响应，不改变请求行为。 */

export interface ObservedRequest {
  method: string;
  url: string;
  body?: unknown;
  /** 响应回来后回写到请求对象；录制器会直接展示这个状态。 */
  status?: number;
}

export interface ObservedResponse extends ObservedRequest {
  status: number;
  contentType?: string;
  /** 响应体文本；未开启读取或读取失败时为空。 */
  bodyText?: string;
}

export interface ObserveNetworkOptions {
  /** 是否读取响应体；录制通常只需要请求参数和状态。 */
  readResponseBody?: boolean;
  /** 只读取这些 content-type 的响应体；缺省全部读取。 */
  shouldReadResponseBody?: (contentType: string | undefined) => boolean;
  /** 单个响应体保留的最大字符数。 */
  maxBodyChars?: number;
  onRequest?: (request: ObservedRequest) => void;
  onResponse?: (response: ObservedResponse) => void;
}

const DEFAULT_MAX_BODY_CHARS = 512 * 1024;

export function observeNetwork(win: Window, options: ObserveNetworkOptions): () => void {
  const restores: Array<() => void> = [];
  const maxChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const shouldReadBody = (contentType: string | undefined): boolean =>
    options.readResponseBody === true &&
    (options.shouldReadResponseBody ? options.shouldReadResponseBody(contentType) : true);

  const originalFetch = win.fetch;
  if (typeof originalFetch === "function") {
    const wrapped = function (
      this: Window,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const request = captureFetchRequest(input, init, win);
      const promise = originalFetch.call(this, input, init);
      if (request) {
        options.onRequest?.(request);
        promise.then(
          (response) => {
            const contentType = response.headers.get("content-type") ?? undefined;
            const observed = request as ObservedResponse;
            const finish = (bodyText?: string): void => {
              observed.status = response.status;
              observed.contentType = contentType;
              if (bodyText !== undefined) observed.bodyText = bodyText;
              options.onResponse?.(observed);
            };
            if (!shouldReadBody(contentType)) {
              finish();
              return;
            }
            response
              .clone()
              .text()
              .then((text) => finish(truncate(text, maxChars)), () => finish());
          },
          () => {},
        );
      }
      return promise;
    };
    try {
      win.fetch = wrapped as typeof win.fetch;
      restores.push(() => {
        if (win.fetch === (wrapped as typeof win.fetch)) win.fetch = originalFetch;
      });
    } catch {
      // 某些页面冻结了 fetch，放弃 fetch 捕获，XHR 仍然可用。
    }
  }

  const targetWindow = win as Window & typeof globalThis;
  const xhrProto = targetWindow.XMLHttpRequest?.prototype as unknown as
    | {
        open: (...args: unknown[]) => unknown;
        send: (...args: unknown[]) => unknown;
      }
    | undefined;
  if (xhrProto) {
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    const wrappedOpen = function (this: XMLHttpRequest, ...args: unknown[]): unknown {
      const method = String(args[0] ?? "GET").toUpperCase();
      const url = resolveNetworkUrl(String(args[1] ?? ""), win);
      (this as XMLHttpRequest & { __tinyflowRequest?: ObservedRequest }).__tinyflowRequest = {
        method,
        url,
      };
      return originalOpen.apply(this, args);
    };
    const wrappedSend = function (this: XMLHttpRequest, body?: unknown): unknown {
      const xhr = this as XMLHttpRequest & { __tinyflowRequest?: ObservedRequest };
      const request = xhr.__tinyflowRequest;
      if (request) {
        request.body = captureRequestBody(body);
        options.onRequest?.(request);
        this.addEventListener(
          "loadend",
          () => {
            const contentType = this.getResponseHeader("content-type") ?? undefined;
            const observed = request as ObservedResponse;
            const bodyText = shouldReadBody(contentType)
              ? readXhrBody(this, maxChars)
              : undefined;
            observed.status = this.status;
            observed.contentType = contentType;
            if (bodyText !== undefined) observed.bodyText = bodyText;
            options.onResponse?.(observed);
          },
          { once: true },
        );
      }
      return originalSend.apply(this, [body]);
    };
    try {
      xhrProto.open = wrappedOpen;
      xhrProto.send = wrappedSend;
      restores.push(() => {
        if (xhrProto.open === wrappedOpen) xhrProto.open = originalOpen;
        if (xhrProto.send === wrappedSend) xhrProto.send = originalSend;
      });
    } catch {
      // 原型被冻结时跳过 XHR 捕获。
    }
  }

  return () => {
    for (const restore of restores) restore();
  };
}

function readXhrBody(xhr: XMLHttpRequest, maxChars: number): string | undefined {
  try {
    if (xhr.responseType === "" || xhr.responseType === "text") {
      return truncate(xhr.responseText, maxChars);
    }
    if (xhr.responseType === "json") {
      return truncate(JSON.stringify(xhr.response), maxChars);
    }
  } catch {
    // 二进制响应或跨域受限时跳过。
  }
  return undefined;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function captureFetchRequest(
  input: unknown,
  init: RequestInit | undefined,
  win: Window,
): ObservedRequest | null {
  let url = "";
  let method = init?.method;
  if (typeof input === "string") {
    url = input;
  } else if (input && typeof input === "object") {
    const request = input as { url?: unknown; method?: unknown };
    if (typeof request.url === "string") url = request.url;
    if (method === undefined && typeof request.method === "string") method = request.method;
  }
  if (!url) return null;
  const body = captureRequestBody(init?.body);
  return {
    method: String(method ?? "GET").toUpperCase(),
    url: resolveNetworkUrl(url, win),
    ...(body === undefined ? {} : { body }),
  };
}

/** 只保留可读参数：JSON 对象、表单字段、URLSearchParams；二进制只记类型/大小。 */
function captureRequestBody(body: unknown): unknown {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") {
    const text = body.trim();
    if (!text) return undefined;
    try {
      return limitSerialized(JSON.parse(text));
    } catch {
      return text.slice(0, 3000);
    }
  }
  const tag = Object.prototype.toString.call(body);
  if (tag === "[object URLSearchParams]") {
    return limitSerialized(Object.fromEntries((body as URLSearchParams).entries()));
  }
  if (tag === "[object FormData]") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of (body as FormData).entries()) {
      result[key] =
        typeof value === "string"
          ? value
          : {
              fileName: String((value as File).name ?? ""),
              size: Number((value as Blob).size ?? 0),
              type: String((value as Blob).type ?? ""),
            };
    }
    return limitSerialized(result);
  }
  if (tag === "[object Blob]") {
    return `<Blob ${String((body as Blob).type || "binary")} ${Number((body as Blob).size)} bytes>`;
  }
  if (tag === "[object ArrayBuffer]" || ArrayBuffer.isView(body)) {
    return "<binary body>";
  }
  if (typeof body === "object") {
    try {
      return limitSerialized(JSON.parse(JSON.stringify(body)));
    } catch {
      return "<不可序列化 body>";
    }
  }
  return String(body).slice(0, 3000);
}

function limitSerialized(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return String(value);
    return text.length > 3000 ? `${text.slice(0, 3000)}…` : value;
  } catch {
    return "<不可序列化 body>";
  }
}

function resolveNetworkUrl(raw: string, win: Window): string {
  try {
    return new (win as Window & typeof globalThis).URL(raw, win.location.href).href;
  } catch {
    return raw;
  }
}
