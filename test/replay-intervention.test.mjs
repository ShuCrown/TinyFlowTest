import test from "node:test";
import assert from "node:assert/strict";

import { runFlow } from "../src/replay/engine.ts";

function dsl(nodes, edges, entry) {
  return {
    dslVersion: "1.0",
    meta: { name: "intervention" },
    systems: [{ id: "sys", name: "系统", baseUrl: "http://localhost:3000" }],
    nodes,
    edges,
    entry,
  };
}

function waitNode(id) {
  return { id, type: "wait", condition: "page-ready" };
}

function failingInteract(id) {
  // 空策略 + 极短超时：不依赖 DOM 就能稳定失败。
  return {
    id,
    type: "interact",
    system: "sys",
    adapter: "input",
    target: { label: "字段", strategies: [] },
    value: "x",
    timeoutMs: 15,
  };
}

function failingExtract(id, varName) {
  return {
    id,
    type: "extract",
    system: "sys",
    target: { label: varName, strategies: [] },
    read: "text",
    varName,
    timeoutMs: 15,
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

test("人工补全后继续：失败节点记为 manual，后续节点照常执行", async () => {
  const events = [];
  const result = await runFlow({
    dsl: dsl(
      [failingInteract("n1"), waitNode("n2")],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost(),
    onNodeError: async (info) => {
      assert.equal(info.nodeId, "n1");
      assert.equal(info.attempt, 1);
      return { action: "continue" };
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "finished");
  assert.deepEqual(
    result.nodes.map((node) => node.status),
    ["manual", "pass"],
  );
  assert.match(result.nodes[0].message, /^人工补全：/);
  const finished = events.filter((event) => event.type === "node.finished");
  assert.equal(finished.length, 3);
  assert.equal(finished[0].node.status, "fail");
  assert.equal(finished[1].node.status, "manual");
});

test("重试节点：失败一次后重新执行，只保留最终结果", async () => {
  let calls = 0;
  const started = [];
  const result = await runFlow({
    dsl: dsl(
      [
        { id: "n1", type: "navigate", system: "sys", url: "/next" },
        waitNode("n2"),
      ],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost({
      async navigate() {
        calls += 1;
        if (calls === 1) throw new Error("网络抖动");
      },
    }),
    onNodeError: async (info) => {
      assert.equal(info.attempt, 1);
      return { action: "retry" };
    },
    onEvent: (event) => {
      if (event.type === "node.started") started.push(event.nodeId);
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.status, "finished");
  assert.deepEqual(
    result.nodes.map((node) => node.status),
    ["pass", "pass"],
  );
  assert.deepEqual(started, ["n1", "n1", "n2"]);
});

test("跳过节点：失败节点记为 skipped，运行仍算完成", async () => {
  const result = await runFlow({
    dsl: dsl(
      [failingInteract("n1"), waitNode("n2")],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost(),
    onNodeError: async () => ({ action: "skip" }),
  });

  assert.equal(result.status, "finished");
  assert.deepEqual(
    result.nodes.map((node) => node.status),
    ["skipped", "pass"],
  );
  assert.match(result.nodes[0].message, /^人工跳过：/);
});

test("停止：保留失败结果，不再执行后续节点", async () => {
  const result = await runFlow({
    dsl: dsl(
      [failingInteract("n1"), waitNode("n2")],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost(),
    onNodeError: async () => ({ action: "stop" }),
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.nodes.map((node) => node.status),
    ["fail"],
  );
});

test("未提供 onNodeError 时保持失败即中止", async () => {
  const result = await runFlow({
    dsl: dsl(
      [failingInteract("n1"), waitNode("n2")],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost(),
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.nodes.map((node) => node.status),
    ["fail"],
  );
});

test("取值节点失败时可人工补写变量，继续后注入运行环境", async () => {
  const events = [];
  const result = await runFlow({
    dsl: dsl(
      [failingExtract("n1", "code"), waitNode("n2")],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost(),
    onNodeError: async (info) => {
      assert.equal(info.varName, "code");
      return { action: "continue", vars: { code: "C-001" } };
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.status, "finished");
  assert.equal(result.vars.code, "C-001");
  const set = events.find((event) => event.type === "var.set");
  assert.deepEqual(
    { nodeId: set.nodeId, name: set.name, value: set.value },
    { nodeId: "n1", name: "code", value: "C-001" },
  );
});
