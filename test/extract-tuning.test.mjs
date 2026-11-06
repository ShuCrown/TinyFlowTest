import test from "node:test";
import assert from "node:assert/strict";

import { runFlow } from "../src/replay/engine.ts";
import { readExtractTuning } from "../src/flow/extract-tuning.ts";

function dsl(nodes, edges = [], entry = nodes[0]?.id) {
  return {
    dslVersion: "1.0",
    meta: { name: "extract-tuning" },
    systems: [{ id: "sys", name: "系统", baseUrl: "http://localhost:3000" }],
    nodes,
    edges,
    entry,
  };
}

function waitNode(id) {
  return { id, type: "wait", condition: "page-ready" };
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

function response(body) {
  return {
    method: "POST",
    url: "http://localhost:3000/api/save",
    status: 200,
    responseBody: body,
    capturedAt: 1,
  };
}

test("接口取值的覆盖替换 JSON 路径与正则，且不写回 DSL", async () => {
  const node = {
    id: "n1",
    type: "extract",
    source: "response",
    varName: "code",
    response: { urlContains: "/api/save", path: "data.code" },
    pattern: "T-\\d+",
  };
  const result = await runFlow({
    dsl: dsl(
      [node, waitNode("n2")],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost({
      async waitForResponse() {
        return response(JSON.stringify({ data: { code: "T-111", other: "X-9" } }));
      },
    }),
    values: {
      n1: { response: { path: "data.other" }, pattern: "[A-Z]-\\d+" },
    },
  });

  assert.equal(result.status, "finished");
  assert.equal(result.vars.code, "X-9");
  assert.equal(node.response.path, "data.code");
  assert.equal(node.pattern, "T-\\d+");
});

test("JS 取值的覆盖替换表达式，且不写回 DSL", async () => {
  let expression = "";
  const node = {
    id: "n1",
    type: "extract",
    source: "js",
    varName: "code",
    js: "window.old",
  };
  const result = await runFlow({
    dsl: dsl([node]),
    host: fakeHost({
      evaluate(source) {
        expression = source;
        return "J-1";
      },
    }),
    values: { n1: { js: "window.next" } },
  });

  assert.equal(result.status, "finished");
  assert.equal(expression, "window.next");
  assert.equal(result.vars.code, "J-1");
  assert.equal(node.js, "window.old");
});

test("覆盖只对当前节点生效，其他取值节点使用录制配置", async () => {
  const first = {
    id: "n1",
    type: "extract",
    source: "response",
    varName: "first",
    response: { urlContains: "/api/save", path: "data.code" },
  };
  const second = {
    id: "n2",
    type: "extract",
    source: "response",
    varName: "second",
    response: { urlContains: "/api/save", path: "data.code" },
  };
  const result = await runFlow({
    dsl: dsl([first, second], [{ from: "n1", to: "n2" }], "n1"),
    host: fakeHost({
      async waitForResponse() {
        return response(JSON.stringify({ data: { code: "C-1", other: "C-2" } }));
      },
    }),
    values: { n1: { response: { path: "data.other" } } },
  });

  assert.equal(result.status, "finished");
  assert.equal(result.vars.first, "C-2");
  assert.equal(result.vars.second, "C-1");
});

test("覆盖形状不合法时当作没改", () => {
  assert.equal(readExtractTuning(null), null);
  assert.equal(readExtractTuning("path"), null);
  assert.equal(readExtractTuning([]), null);
  assert.equal(readExtractTuning({ unknown: 1 }), null);
  assert.deepEqual(readExtractTuning({ cell: { mode: "rowIndex", rowIndex: 2 } }), {
    cell: { mode: "rowIndex", rowIndex: 2 },
  });
});
