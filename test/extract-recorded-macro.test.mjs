import test from "node:test";
import assert from "node:assert/strict";

import { compileFlow } from "../src/flow/compile.ts";

const system = { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" };

function recordedDsl() {
  return {
    dslVersion: "1.0",
    meta: { name: "录制取值" },
    systems: [system],
    nodes: [
      {
        id: "p1",
        type: "interact",
        system: "sys",
        adapter: "input",
        target: { label: "关键词", strategies: [{ type: "css", value: "#keyword" }] },
        value: "华东",
      },
      {
        id: "e1",
        type: "extract",
        source: "dom",
        varName: "customerCode",
        read: "text",
        target: { label: "编号", strategies: [{ type: "css", value: "#code" }] },
      },
      {
        id: "e2",
        type: "extract",
        source: "dom",
        varName: "customerName",
        read: "text",
        target: { label: "名称", strategies: [{ type: "css", value: "#name" }] },
      },
    ],
    edges: [
      { from: "p1", to: "e1" },
      { from: "e1", to: "e2" },
    ],
    entry: "p1",
  };
}

function flow(node, varAliases) {
  return {
    id: "flw-recorded",
    name: "录制取值宏",
    recordCount: 0,
    status: "draft",
    graph: {
      nodes: [node],
      edges: [],
      injections: [],
      vars: [],
      ...(varAliases ? { varAliases } : {}),
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function extractNode(patch = {}) {
  return {
    id: "n1",
    kind: "extract",
    varName: "",
    read: "text",
    selector: "",
    x: 0,
    y: 0,
    recordedDsl: recordedDsl(),
    ...patch,
  };
}

test("录制 DSL 展开为微节点，多个取值分别产出变量", () => {
  const compiled = compileFlow(flow(extractNode()), []);

  assert.deepEqual(
    compiled.dsl.nodes.map((node) => node.id),
    ["n1::rec::p1", "n1::rec::e1", "n1::rec::e2"],
  );
  assert.deepEqual(compiled.dsl.edges, [
    { from: "n1::rec::p1", to: "n1::rec::e1" },
    { from: "n1::rec::e1", to: "n1::rec::e2" },
  ]);
  assert.equal(compiled.dsl.entry, "n1::rec::p1");
  assert.deepEqual(compiled.extractVars, [
    { nodeId: "n1", name: "customerCode" },
    { nodeId: "n1", name: "customerName" },
  ]);
  assert.deepEqual(compiled.groups.n1, [
    "n1::rec::p1",
    "n1::rec::e1",
    "n1::rec::e2",
  ]);
  assert.equal(compiled.dsl.systems[0].id, "sys");
});

test("流程别名作用于录制里的取值步骤", () => {
  const compiled = compileFlow(
    flow(extractNode(), { "n1::e1": "code" }),
    [],
  );

  assert.equal(
    compiled.dsl.nodes.find((node) => node.id === "n1::rec::e1").varName,
    "code",
  );
  assert.deepEqual(compiled.extractVars, [
    { nodeId: "n1", name: "code" },
    { nodeId: "n1", name: "customerName" },
  ]);
});

test("录制里的取值变量重名时编译失败", () => {
  const dsl = recordedDsl();
  dsl.nodes[2].varName = "customerCode";
  assert.throws(
    () => compileFlow(flow(extractNode({ recordedDsl: dsl })), []),
    /重复产出/,
  );
});

test("禁用取值节点时录制出的微节点全部禁用", () => {
  const compiled = compileFlow(flow(extractNode({ enabled: false })), []);
  assert.ok(compiled.dsl.nodes.every((node) => node.enabled === false));
});
