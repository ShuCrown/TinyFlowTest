import test from "node:test";
import assert from "node:assert/strict";

import { compileFlow } from "../src/flow/compile.ts";

const system = { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" };

function preDsl(nodes) {
  return {
    dslVersion: "1.0",
    meta: { name: "取值前置步骤" },
    systems: [system],
    nodes,
    edges: [],
    entry: nodes[0]?.id,
  };
}

function flow(extract) {
  return {
    id: "flw-pre",
    name: "前置步骤测试",
    recordCount: 0,
    status: "draft",
    graph: { nodes: [extract], edges: [], injections: [], vars: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function extractNode(patch = {}) {
  return {
    id: "n1",
    kind: "extract",
    varName: "code",
    read: "text",
    selector: "#code",
    x: 0,
    y: 0,
    ...patch,
  };
}

function inputNode(id, value) {
  return {
    id,
    type: "interact",
    system: "sys",
    adapter: "input",
    target: { label: "关键词", strategies: [{ type: "css", value: "#keyword" }] },
    value,
  };
}

test("取值节点的前置 DSL 展开为微节点并串到取值步骤前面", () => {
  const compiled = compileFlow(
    flow(
      extractNode({
        preDsl: preDsl([inputNode("p1", "华东"), { id: "p2", type: "wait", condition: "page-ready" }]),
        systemId: "sys",
      }),
    ),
    [],
  );

  assert.deepEqual(
    compiled.dsl.nodes.map((node) => node.id),
    ["n1::pre::p1", "n1::pre::p2", "n1::extract"],
  );
  assert.equal(compiled.dsl.entry, "n1::pre::p1");
  assert.deepEqual(compiled.dsl.edges, [
    { from: "n1::pre::p1", to: "n1::pre::p2" },
    { from: "n1::pre::p2", to: "n1::extract" },
  ]);
  assert.deepEqual(compiled.groups.n1, [
    "n1::pre::p1",
    "n1::pre::p2",
    "n1::extract",
  ]);
  assert.equal(compiled.dsl.systems[0].id, "sys");
  assert.deepEqual(compiled.extractVars, [{ nodeId: "n1", name: "code" }]);
  assert.equal(compiled.dsl.nodes[0].meta.flowNodeId, "n1");
});

test("前置 DSL 里的取值步骤不会进入流程", () => {
  const compiled = compileFlow(
    flow(
      extractNode({
        preDsl: preDsl([
          {
            id: "x1",
            type: "extract",
            source: "dom",
            varName: "ignored",
            read: "text",
            target: { label: "旧取值", strategies: [{ type: "css", value: "#old" }] },
          },
          inputNode("p1", "华东"),
        ]),
      }),
    ),
    [],
  );

  assert.deepEqual(
    compiled.dsl.nodes.map((node) => node.id),
    ["n1::pre::p1", "n1::extract"],
  );
  assert.equal(compiled.dsl.entry, "n1::pre::p1");
  assert.deepEqual(compiled.extractVars, [{ nodeId: "n1", name: "code" }]);
});

test("禁用取值节点时前置步骤一起禁用；没有前置步骤时入口仍是取值步骤", () => {
  const disabled = compileFlow(
    flow(
      extractNode({
        enabled: false,
        preDsl: preDsl([inputNode("p1", "华东")]),
      }),
    ),
    [],
  );
  assert.equal(disabled.dsl.nodes[0].enabled, false);
  assert.equal(disabled.dsl.entry, "n1::pre::p1");

  const plain = compileFlow(flow(extractNode()), []);
  assert.deepEqual(
    plain.dsl.nodes.map((node) => node.id),
    ["n1::extract"],
  );
  assert.equal(plain.dsl.entry, "n1::extract");
});
