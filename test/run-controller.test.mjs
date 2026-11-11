import test from "node:test";
import assert from "node:assert/strict";

import { RunController } from "../src/replay/run-controller.ts";

function dsl(nodes, edges, entry) {
  return {
    dslVersion: "1.0",
    meta: { name: "controller" },
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

function failingInteract(id) {
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

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待状态超时");
}

test("RunController：失败后发送跳过命令，运行继续完成", async () => {
  const controller = new RunController({
    dsl: dsl(
      [failingInteract("n1"), waitNode("n2")],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost(),
  });

  const running = controller.start();
  await waitFor(() => controller.getSnapshot().status === "intervening");
  assert.equal(controller.getSnapshot().pending?.nodeId, "n1");
  controller.send({ action: "skip" });
  const result = await running;

  assert.equal(result.status, "finished");
  assert.deepEqual(
    result.nodes.map((node) => node.status),
    ["skipped", "pass"],
  );
  assert.equal(controller.getSnapshot().status, "finished");
});

test("RunController：执行完当前步暂停，恢复后继续", async () => {
  const events = [];
  const controller = new RunController({
    dsl: dsl(
      [waitNode("n1"), waitNode("n2"), waitNode("n3")],
      [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
      "n1",
    ),
    host: fakeHost(),
    onEvent: (event) => events.push(event.type),
  });

  controller.subscribe((snapshot) => {
    // 第一个节点完成后请求「执行完本步暂停」。
    if (snapshot.results.length === 1 && controller.getSnapshot().status === "running") {
      controller.send({ action: "pause", mode: "after-step" });
    }
  });

  const running = controller.start();
  await waitFor(() => controller.getSnapshot().status === "paused");
  assert.deepEqual(
    controller.getSnapshot().results.map((node) => node.nodeId),
    ["n1"],
  );
  assert.equal(controller.getSnapshot().cursor?.nodeId, "n2");

  controller.send({ action: "resume" });
  const result = await running;

  assert.equal(result.status, "finished");
  assert.equal(result.nodes.length, 3);
  assert.ok(events.includes("run.paused"));
  assert.ok(events.includes("run.resumed"));
});

test("RunController：立即暂停后恢复会重跑被中断的节点", async () => {
  let url = "http://localhost:3000/";
  const controller = new RunController({
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
  });

  const running = controller.start();
  controller.send({ action: "pause", mode: "immediate" });
  await waitFor(() => Boolean(controller.getSnapshot().pending));
  assert.equal(controller.getSnapshot().status, "paused");
  assert.equal(controller.getSnapshot().pending?.failureKind, "interrupted");

  url = "http://localhost:3000/ready";
  controller.send({ action: "resume" });
  const result = await running;

  assert.equal(result.status, "finished");
  assert.equal(result.nodes[0].status, "pass");
});

test("RunController：停止后运行取消，不再继续", async () => {
  let url = "http://localhost:3000/";
  const controller = new RunController({
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
  });

  const running = controller.start();
  await waitFor(() => controller.getSnapshot().status === "running");
  controller.send({ action: "stop" });
  const result = await running;
  url = "http://localhost:3000/ready";

  assert.equal(result.status, "canceled");
  assert.equal(controller.getSnapshot().status, "canceled");
});

test("RunController：快照包含结果与变量，且同一实例不能重复启动", async () => {
  const controller = new RunController({
    dsl: dsl(
      [
        waitNode("n1"),
        { id: "n2", type: "extract", source: "const", varName: "code", value: "C-001" },
      ],
      [{ from: "n1", to: "n2" }],
      "n1",
    ),
    host: fakeHost(),
  });

  const result = await controller.start();
  assert.equal(result.status, "finished");
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, "finished");
  assert.equal(snapshot.env.code, "C-001");
  assert.deepEqual(
    snapshot.results.map((node) => node.nodeId),
    ["n1", "n2"],
  );
  await assert.rejects(() => controller.start(), /只能启动一次/);
});
