import test from "node:test";
import assert from "node:assert/strict";

import { runFlow } from "../src/replay/engine.ts";

function dsl(nodes, edges, entry) {
  return {
    dslVersion: "1.0",
    meta: { name: "retry" },
    systems: [{ id: "sys", name: "系统", baseUrl: "http://localhost:3000" }],
    nodes,
    edges,
    entry,
  };
}

function waitNode(id, extra = {}) {
  return { id, type: "wait", condition: "page-ready", ...extra };
}

function failingTarget(label = "字段", timeoutMs = 15) {
  // 空策略 + 极短超时：不依赖 DOM 就能稳定失败在「还没执行动作」阶段。
  return {
    id: "target",
    type: "interact",
    system: "sys",
    adapter: "input",
    target: { label, strategies: [] },
    value: "x",
    timeoutMs,
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

test("自动重试：未执行动作的失败按策略重试，成功后只保留通过结果", async () => {
  let calls = 0;
  const started = [];
  const result = await runFlow({
    dsl: dsl(
      [
        { id: "n1", type: "navigate", system: "sys", url: "/next", retry: { maxAttempts: 2 } },
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
    onEvent: (event) => {
      if (event.type === "node.started") started.push(`${event.nodeId}#${event.attempt}`);
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.status, "finished");
  assert.deepEqual(
    result.nodes.map((node) => node.status),
    ["pass", "pass"],
  );
  assert.deepEqual(started, ["n1#1", "n1#2", "n2#1"]);
  assert.equal(result.nodes[0].attempts.length, 2);
  assert.equal(result.nodes[0].attempts[0].status, "failed");
  assert.equal(result.nodes[0].attempts[1].status, "passed");
});

test("自动重试耗尽后升级为人工决策", async () => {
  let calls = 0;
  const attempts = [];
  const result = await runFlow({
    dsl: dsl(
      [{ ...failingTarget(), id: "n1", retry: { maxAttempts: 2, delayMs: 0 } }],
      [],
      "n1",
    ),
    host: fakeHost(),
    onNodeError: async (info) => {
      calls += 1;
      attempts.push(info.attempt);
      assert.equal(info.retryExhausted, true);
      return { action: "skip" };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(attempts, [2]);
  assert.equal(result.status, "finished");
  assert.equal(result.nodes[0].status, "skipped");
});

test("重试前回滚检查点：失败节点写入的变量不会泄漏到下一次尝试", async () => {
  const seen = [];
  let pending = null;
  const result = await runFlow({
    dsl: dsl(
      [
        {
          id: "n1",
          type: "extract",
          source: "const",
          varName: "code",
          value: "C-001",
          expect: [{ kind: "url", matches: "never", timeoutMs: 10 }],
          retry: { maxAttempts: 2 },
        },
      ],
      [],
      "n1",
    ),
    host: fakeHost(),
    onNodeError: async () => ({ action: "stop" }),
    onEvent: (event) => {
      if (event.type !== "node.started") return;
      seen.push({ attempt: event.attempt, code: undefined });
      pending = seen.length - 1;
    },
    onSnapshot: (snapshot) => {
      if (pending === null || seen[pending].code !== undefined) return;
      seen[pending].code = snapshot.env.code;
      pending = null;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].code, undefined);
  // 第一次尝试失败前写入了 code；回滚后第二次尝试开始时变量已移除。
  assert.equal(seen[1].code, undefined);
});

test("节点边界：每个节点执行前都会调用一次钩子", async () => {
  const calls = [];
  await runFlow({
    dsl: dsl(
      [waitNode("n1"), waitNode("n2"), waitNode("n3")],
      [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
      "n1",
    ),
    host: fakeHost(),
    onBeforeNode: (nodeId) => {
      calls.push(nodeId);
    },
  });

  assert.deepEqual(calls, ["n1", "n2", "n3"]);
});

test("立即暂停：中断当前尝试并按人工决策重跑该节点", async () => {
  let pause = true;
  let url = "http://localhost:3000/";
  const result = await runFlow({
    dsl: dsl(
      [{ id: "n1", type: "wait", condition: { kind: "url", matches: "/ready", timeoutMs: 5000 } }],
      [],
      "n1",
    ),
    host: fakeHost({
      getUrl() {
        return url;
      },
    }),
    shouldPause: () => pause,
    onNodeError: async (info) => {
      assert.equal(info.failureKind, "interrupted");
      pause = false;
      url = "http://localhost:3000/ready";
      return { action: "retry" };
    },
  });

  assert.equal(result.status, "finished");
  assert.equal(result.nodes[0].status, "pass");
  assert.equal(result.nodes[0].attempts[0].status, "interrupted");
});

test("人工继续：expect 校验未通过时重新收集决策", async () => {
  const messages = [];
  const result = await runFlow({
    dsl: dsl(
      [
        {
          id: "n1",
          type: "navigate",
          system: "sys",
          url: "/next",
          expect: [{ kind: "url", matches: "/never", timeoutMs: 10 }],
        },
      ],
      [],
      "n1",
    ),
    host: fakeHost({
      async navigate() {
        throw new Error("导航失败");
      },
    }),
    onNodeError: async (info) => {
      messages.push(info.message);
      return messages.length === 1 ? { action: "continue" } : { action: "skip" };
    },
  });

  assert.equal(messages.length, 2);
  assert.match(messages[1], /^人工继续后校验未通过/);
  assert.equal(result.status, "finished");
  assert.equal(result.nodes[0].status, "skipped");
});

test("分组重试：分组内节点失败后从分组入口重跑", async () => {
  let attempts = 0;
  const started = [];
  const result = await runFlow({
    dsl: dsl(
      [
        { ...waitNode("g1a"), meta: { flowNodeId: "g1" } },
        {
          id: "g1b",
          type: "navigate",
          system: "sys",
          url: "/next",
          timeoutMs: 15,
          meta: { flowNodeId: "g1" },
        },
        { ...waitNode("g2"), meta: { flowNodeId: "g2" } },
      ],
      [
        { from: "g1a", to: "g1b" },
        { from: "g1b", to: "g2" },
      ],
      "g1a",
    ),
    host: fakeHost({
      async navigate() {
        attempts += 1;
        if (attempts === 1) throw new Error("提交失败");
      },
    }),
    onNodeError: async (info) => {
      assert.equal(info.nodeId, "g1b");
      return { action: "retryGroup" };
    },
    onEvent: (event) => {
      if (event.type === "node.started") started.push(event.nodeId);
    },
  });

  assert.equal(result.status, "finished");
  assert.deepEqual(started, ["g1a", "g1b", "g1a", "g1b", "g2"]);
  assert.deepEqual(
    result.nodes.map((node) => `${node.nodeId}:${node.status}`),
    ["g1a:pass", "g1b:pass", "g2:pass"],
  );
});
