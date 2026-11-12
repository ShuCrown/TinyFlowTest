import http from "node:http";
import https from "node:https";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const APP_BASE = "/tf/";
const TARGET_URL = process.env.TINYFLOWTEST_TARGET_URL ?? "http://dev.lthbzw.com:30105";
const target = new URL(TARGET_URL);
/** 运行期切换代理目标：录制任意系统时先 POST 目标 origin，后续根路径请求按 cookie 转发。 */
const TARGET_ENDPOINT = "/__tinyflowtest/target";
const TARGET_COOKIE = "tinyflowtest_target";
const MAX_TARGET_BODY = 4096;

function parseTarget(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return new URL(url.origin);
  } catch {
    return null;
  }
}

function readTargetCookie(header: string | undefined): URL | null {
  if (!header) return null;
  for (const chunk of header.split(";")) {
    const index = chunk.indexOf("=");
    if (index < 0) continue;
    if (chunk.slice(0, index).trim() !== TARGET_COOKIE) continue;
    try {
      return parseTarget(
        Buffer.from(chunk.slice(index + 1).trim(), "base64url").toString("utf8"),
      );
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 把目标系统的重定向拉回同源代理。
 *
 * 登录跳转常用换协议 / 丢端口的写法，只按 origin 精确匹配容易让 iframe 跳出同源；
 * 这里按 hostname 匹配，统一改写成同源 path。
 */
export function rewriteLocation(location: string, targetUrl: URL): string {
  try {
    const next = new URL(location, targetUrl.origin);
    if (next.hostname === targetUrl.hostname) {
      return `${next.pathname}${next.search}${next.hash}`;
    }
  } catch {
    // 非法 Location 保持原样，交给浏览器处理。
  }
  return location;
}

/** 代理目标系统：应用挂 /tf/，其它根路径转发给目标系统，iframe 才能同源读取 DOM。 */
function targetProxy(): Plugin {
  const middleware = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (err?: unknown) => void,
  ) => {
    const url = req.url ?? "/";
    if (req.headers.upgrade === "websocket") {
      next();
      return;
    }
    if ((url === "/" || url === "") && req.headers["sec-fetch-dest"] !== "iframe") {
      res.writeHead(302, { location: APP_BASE });
      res.end();
      return;
    }
    if (url === TARGET_ENDPOINT) {
      // 自定义请求头迫使跨站请求走预检；开发期代理不接受网页表单/图片这类简单请求切换目标。
      if (req.headers["x-tinyflowtest"] !== "1") {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "缺少 x-tinyflowtest 请求头" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "仅支持 POST" }));
        return;
      }
      let body = "";
      let tooLarge = false;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        if (tooLarge) return;
        body += chunk;
        if (body.length > MAX_TARGET_BODY) tooLarge = true;
      });
      req.on("end", () => {
        if (tooLarge) {
          res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "请求体过大" }));
          return;
        }
        let next: URL | null = null;
        try {
          next = parseTarget((JSON.parse(body) as { targetUrl?: unknown }).targetUrl);
        } catch {
          next = null;
        }
        if (!next) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "targetUrl 需要是 http(s) 网址" }));
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": `${TARGET_COOKIE}=${Buffer.from(next.origin).toString("base64url")}; Path=/; SameSite=Lax`,
        });
        res.end(JSON.stringify({ targetUrl: next.origin }));
      });
      return;
    }
    if (url === "/__tinyflowtest/config") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ targetUrl: target.origin, appBase: APP_BASE, proxied: true }));
      return;
    }
    if (
      url.startsWith(APP_BASE) ||
      url.startsWith("/@vite") ||
      url.startsWith("/@id") ||
      url.startsWith("/@fs") ||
      url.startsWith("/node_modules") ||
      url.startsWith("/src") ||
      url.startsWith("/__tinyflowtest") ||
      url === "/favicon.ico"
    ) {
      next();
      return;
    }

    const active = readTargetCookie(req.headers.cookie) ?? target;
    const client = active.protocol === "https:" ? https : http;
    const proxyReq = client.request(
      {
        protocol: active.protocol,
        hostname: active.hostname,
        port: active.port || undefined,
        path: url,
        method: req.method,
        headers: {
          ...req.headers,
          host: active.host,
          origin: active.origin,
          referer: `${active.origin}/`,
        },
      },
      (proxyRes) => {
        const headers = { ...proxyRes.headers };
        const cookies = headers["set-cookie"];
        if (cookies) {
          headers["set-cookie"] = cookies.map((cookie) =>
            cookie.replace(/;\s*Domain=[^;]+/gi, ""),
          );
        }
        if (headers.location) {
          headers.location = rewriteLocation(String(headers.location), active);
        }
        // 同源代理是开发期能力：去掉禁止 iframe 的头，避免目标系统拒绝被嵌入。
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];
        res.writeHead(proxyRes.statusCode ?? 502, headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.setTimeout(30000, () => {
      proxyReq.destroy(new Error("target timeout"));
    });
    proxyReq.on("error", (error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<h1>目标系统代理失败</h1><p>${String(error.message)}</p><p>检查 TINYFLOWTEST_TARGET_URL 与网络连通性。</p>`,
      );
    });
    req.pipe(proxyReq);
  };

  return {
    name: "tinyflowtest-target-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  base: APP_BASE,
  plugins: [react(), tailwindcss(), targetProxy()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // 5274 避开 TinyFlow(5173) 与 FlowTest(5273)；strictPort 让端口冲突直接报错。
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.WEB_PORT ?? 5274),
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
