import { ReplayError, type ReplayHost } from "./types.ts";

export interface IframeHost extends ReplayHost {
  dispose(): void;
}

/**
 * 同源 iframe 宿主：navigate 等待 load，getDocument 暴露 iframe 文档。
 * 跨域页面无法读取 contentDocument，会给出明确的“仅支持同源回放”错误。
 */
export function createIframeHost(iframe: HTMLIFrameElement): IframeHost {
  let trackedUrl = "";

  const onLoad = (): void => {
    trackedUrl = currentUrl() ?? iframe.src;
  };
  iframe.addEventListener("load", onLoad);

  const currentUrl = (): string | undefined => {
    try {
      return iframe.contentWindow?.location.href;
    } catch {
      return undefined;
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
          onLoad();
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
      const doc = iframe.contentDocument;
      if (!doc) {
        throw new ReplayError(
          `无法读取回放页面：${iframe.src} 与宿主不同源，浏览器演示只支持同源目标`,
        );
      }
      return doc;
    },
    getUrl(): string {
      return currentUrl() ?? trackedUrl;
    },
    dispose(): void {
      iframe.removeEventListener("load", onLoad);
    },
  };
}
