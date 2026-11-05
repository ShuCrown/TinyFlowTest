export interface ProxyConfig {
  targetUrl: string;
  appBase: string;
  proxied: boolean;
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
 * 同源地址直接使用；目标系统与代理目标一致时改写成代理根路径。
 */
export function resolveTargetUrl(
  raw: string,
  config: ProxyConfig | null,
): { url: URL; viaProxy: boolean } | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin === window.location.origin) {
    return { url, viaProxy: false };
  }
  if (config?.proxied && config.targetUrl) {
    const target = new URL(config.targetUrl);
    if (url.origin === target.origin) {
      return {
        url: new URL(`${url.pathname}${url.search}${url.hash}`, window.location.origin),
        viaProxy: true,
      };
    }
  }
  return null;
}

export function describeTargetFailure(config: ProxyConfig | null, error: string): string {
  if (error) return `同源代理未加载：${error}`;
  if (config?.proxied) {
    return `目标地址与代理目标 ${config.targetUrl} 不一致，跨域页面无法读取 DOM。请改成代理目标下的地址，或填写同源地址。`;
  }
  return "同源代理未启用，只能录制与当前页面同源的目标页。";
}
