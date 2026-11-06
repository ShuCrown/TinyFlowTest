import test from "node:test";
import assert from "node:assert/strict";

import { runFlow } from "../src/replay/engine.ts";

function dsl(nodes, edges, entry) {
  return {
    dslVersion: "1.0",
    meta: { name: "extract" },
    systems: [{ id: "sys", name: "系统", baseUrl: "http://localhost:3000" }],
    nodes,
    edges,
    entry,
  };
}

function waitNode(id) {
  return { id, type: "wait", condition: "page-ready" };
}

function responseNode(response, patch = {}) {
  return {
    id: "n1",
    type: "extract",
    source: "response",
    varName: "code",
    response,
    ...patch,
  };
}

function jsNode(expression, patch = {}) {
  return {
    id: "n1",
    type: "extract",
    source: "js",
    varName: "code",
    js: expression,
    ...patch,
  };
}

function fakeHost(overrides = {}) {
  return {
    async navigate() {},
    getDocument() {
      throw new Error("no dom");
    },
    getUrl() {
      return "http://localhost:3000/";
    },
    ...overrides,
  };
}

function response(body, patch = {}) {
  return {
    method: "POST",
    url: "http://localhost:3000/api/save",
    status: 200,
    responseBody: body,
    capturedAt: 1,
    ...patch,
  };
}

test("接口取值按方法/URL/请求体匹配，并用 JSON 路径写入变量", async () => {
  const events = [];
  let started = 0;
  let seen;
  const result = await runFlow({
    dsl: dsl(
      [
        responseNode({
          method: "post",
          urlContains: "/api/customers/{{id}}",
          bodyContains: "saveCustomer",
          path: "data.customer.code",
        }),
        waitNode("n2"),
      ],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost({
      startNetworkCapture() {
        started += 1;
      },
      async waitForResponse(matcher) {
        seen = matcher;
        return response(JSON.stringify({ data: { customer: { code: "C-9" } } }), {
          url: "http://localhost:3000/api/customers/42",
        });
      },
    }),
    vars: { id: "42" },
    onEvent: (event) => events.push(event),
  });

  assert.equal(started, 1);
  assert.deepEqual(seen, {
    method: "POST",
    urlContains: "/api/customers/42",
    bodyContains: "saveCustomer",
  });
  assert.equal(result.status, "finished");
  assert.equal(result.vars.code, "C-9");
  const set = events.find((event) => event.type === "var.set");
  assert.equal(set.value, "C-9");
});

test("接口取值未配置 JSON 路径时读取整段响应并应用清洗正则", async () => {
  const result = await runFlow({
    dsl: dsl(
      [responseNode({ urlContains: "/api/token" }, { pattern: "T-[A-Z0-9]+" }), waitNode("n2")],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost({
      async waitForResponse() {
        return response("token=T-7788; expires=3600", { method: "GET" });
      },
    }),
  });

  assert.equal(result.status, "finished");
  assert.equal(result.vars.code, "T-7788");
});

test("接口响应不是 JSON 时给出明确失败", async () => {
  const result = await runFlow({
    dsl: dsl(
      [responseNode({ urlContains: "/api/save", path: "data.code" })],
      [],
      "n1",
    ),
    host: fakeHost({
      async waitForResponse() {
        return response("<html>ok</html>");
      },
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /不是合法 JSON/);
});

test("JSON 路径不存在时列出可用字段", async () => {
  const result = await runFlow({
    dsl: dsl(
      [responseNode({ urlContains: "/api/save", path: "data.missing" })],
      [],
      "n1",
    ),
    host: fakeHost({
      async waitForResponse() {
        return response(JSON.stringify({ data: { code: "C-1" }, message: "ok" }));
      },
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /缺少字段 data\.missing/);
  assert.match(result.error, /data、message/);
});

test("宿主不支持接口取值时直接失败", async () => {
  const result = await runFlow({
    dsl: dsl([responseNode({ urlContains: "/api/save" })], [], "n1"),
    host: fakeHost(),
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /不支持接口取值/);
});

test("JS 表达式取值写入变量，对象转为 JSON 文本", async () => {
  let expression = "";
  const result = await runFlow({
    dsl: dsl([jsNode("window.__DATA__.customer"), waitNode("n2")], [{ from: "n1", to: "n2" }], "n1"),
    host: fakeHost({
      evaluate(source) {
        expression = source;
        return { code: "J-1" };
      },
    }),
  });

  assert.equal(expression, "window.__DATA__.customer");
  assert.equal(result.status, "finished");
  assert.equal(result.vars.code, '{"code":"J-1"}');
});

test("宿主不支持 JS 取值时直接失败", async () => {
  const result = await runFlow({
    dsl: dsl([jsNode("window.__DATA__.code")], [], "n1"),
    host: fakeHost(),
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /不支持 JS 取值/);
});
