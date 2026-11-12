import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { location: { origin: "http://localhost:5274" } };

const { resolveTargetUrl, describeTargetFailure } = await import("../src/lib/proxy.ts");

const proxied = { targetUrl: "http://dev.lthbzw.com:30105", appBase: "/tf/", proxied: true };

test("代理启用时任意 http(s) 地址都改写成同源路径，并带上真实目标", () => {
  const cases = [
    "http://dev.lthbzw.com:30105/login",
    "https://www.naiveui.com/en-US/components/form?tab=api#props",
    "http://192.168.1.5:30105/",
  ];
  for (const raw of cases) {
    const resolved = resolveTargetUrl(raw, proxied);
    assert.ok(resolved, raw);
    const expected = new URL(raw);
    assert.equal(resolved.url.origin, "http://localhost:5274", raw);
    assert.equal(resolved.url.pathname, expected.pathname, raw);
    assert.equal(resolved.url.search, expected.search, raw);
    assert.equal(resolved.url.hash, expected.hash, raw);
    assert.equal(resolved.viaProxy, true, raw);
    assert.equal(resolved.targetUrl, expected.origin, raw);
  }
});

test("同源绝对地址与相对路径不再走代理", () => {
  for (const raw of ["http://localhost:5274/tf/demo/customers.html", "/tf/demo/customers.html"]) {
    const resolved = resolveTargetUrl(raw, proxied);
    assert.ok(resolved, raw);
    assert.equal(resolved.url.origin, "http://localhost:5274", raw);
    assert.equal(resolved.viaProxy, false, raw);
    assert.equal(resolved.targetUrl, undefined, raw);
  }
});

test("非 http(s) 或空地址返回 null", () => {
  assert.equal(resolveTargetUrl("javascript:alert(1)", proxied), null);
  assert.equal(resolveTargetUrl("   ", proxied), null);
});

test("代理未启用时跨域地址返回 null，并给出可读原因", () => {
  const config = { targetUrl: "http://dev.lthbzw.com:30105", appBase: "/tf/", proxied: false };
  assert.equal(resolveTargetUrl("https://www.naiveui.com/en-US/components/form", config), null);
  assert.match(describeTargetFailure(config, ""), /同源代理未启用/);
  assert.match(describeTargetFailure(proxied, ""), /http\(s\)/);
  assert.match(describeTargetFailure(null, "HTTP 404"), /同源代理未加载/);
});
