export interface ProxyConfig {
  targetUrl: string;
  appBase: string;
  proxied: boolean;
}

export interface TargetResolution {
  url: URL;
  viaProxy: boolean;
  /** 走代理时真正要转发到的目标 origin，加载前需用它切换开发服务器目标。 */
  targetUrl?: string;
}

/** 读取开发期同源代理配置；静态部署或代理未加载时返回 proxied=false。 */
export async function loadProxyConfig(): Promise<ProxyConfig> {
  const response = await fetch("/__tinyflowtest/config", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("代理配置接口未加载（返回了 HTML）");
  }
  return (await response.json()) as ProxyConfig;
}

/**
 * 把记录里的目标地址解析成 iframe 可加载的同源地址。
 * 同源地址直接使用；其余 http(s) 地址交给开发期代理，按 path 加载并切换转发目标。
 */
export function resolveTargetUrl(
  raw: string,
  config: ProxyConfig | null,
): TargetResolution | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin === window.location.origin) {
    return { url, viaProxy: false };
  }
  if (config?.proxied) {
    return {
      url: new URL(`${url.pathname}${url.search}${url.hash}`, window.location.origin),
      viaProxy: true,
      targetUrl: url.origin,
    };
  }
  return null;
}

/** 把开发期代理的转发目标切到指定系统；同一标签页并发录制多个系统时以最后一次为准。 */
export async function activateProxyTarget(targetUrl: string): Promise<void> {
  const response = await fetch("/__tinyflowtest/target", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tinyflowtest": "1" },
    body: JSON.stringify({ targetUrl }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`切换代理目标失败（HTTP ${response.status}）`);
  }
}

export function describeTargetFailure(config: ProxyConfig | null, error: string): string {
  if (error) return `同源代理未加载：${error}`;
  if (config?.proxied) {
    return "目标地址需要是完整的 http(s) 网址，或以 / 开头的同源路径。";
  }
  return "同源代理未启用，只能录制与当前页面同源的目标页。";
}
