import test from "node:test";
import assert from "node:assert/strict";

import { compileFlow } from "../src/flow/compile.ts";
import { runFlow } from "../src/replay/engine.ts";

const system = { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" };

function recordedDsl() {
  return {
    dslVersion: "1.0",
    meta: { name: "录制取值" },
    systems: [system],
    nodes: [
      {
        id: "r1",
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
        varName: "code",
        read: "text",
        target: { label: "编号", strategies: [{ type: "css", value: "#code" }] },
      },
    ],
    edges: [{ from: "r1", to: "e1" }],
    entry: "r1",
  };
}

function flow(node, varAliases) {
  return {
    id: "flw-manual",
    name: "手动取值行",
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
    ...patch,
  };
}

test("手动取值行排在录制步骤之后，编译成 const 节点", () => {
  const compiled = compileFlow(
    flow(
      extractNode({
        recordedDsl: recordedDsl(),
        manualVars: [
          { id: "m1", varName: "flag", value: "固定值" },
          { id: "m2", varName: "empty", value: "" },
        ],
      }),
    ),
    [],
  );

  assert.deepEqual(
    compiled.dsl.nodes.map((node) => node.id),
    ["n1::rec::r1", "n1::rec::e1", "n1::manual::m1", "n1::manual::m2"],
  );
  assert.deepEqual(compiled.dsl.edges, [
    { from: "n1::rec::r1", to: "n1::rec::e1" },
    { from: "n1::manual::m1", to: "n1::manual::m2" },
    { from: "n1::rec::e1", to: "n1::manual::m1" },
  ]);
  assert.equal(compiled.dsl.entry, "n1::rec::r1");
  const const1 = compiled.dsl.nodes.find((node) => node.id === "n1::manual::m1");
  assert.equal(const1.source, "const");
  assert.equal(const1.value, "固定值");
  assert.deepEqual(
    compiled.extractVars.map((item) => item.name),
    ["code", "flag", "empty"],
  );
});

test("只有手动取值行的节点也能编译", () => {
  const compiled = compileFlow(
    flow(
      extractNode({
        manualVars: [{ id: "m1", varName: "flag", value: "固定值" }],
      }),
    ),
    [],
  );

  assert.deepEqual(
    compiled.dsl.nodes.map((node) => node.id),
    ["n1::manual::m1"],
  );
  assert.equal(compiled.dsl.entry, "n1::manual::m1");
  assert.equal(compiled.dsl.nodes[0].source, "const");
  assert.deepEqual(compiled.extractVars, [{ nodeId: "n1", name: "flag" }]);
});

test("手动取值行支持流程别名", () => {
  const compiled = compileFlow(
    flow(
      extractNode({
        manualVars: [{ id: "m1", varName: "flag", value: "固定值" }],
      }),
      { "n1::manual::m1": "manualFlag" },
    ),
    [],
  );

  assert.equal(compiled.dsl.nodes[0].varName, "manualFlag");
  assert.deepEqual(compiled.extractVars, [{ nodeId: "n1", name: "manualFlag" }]);
});

test("手动取值行和录制变量重名时编译失败", () => {
  assert.throws(
    () =>
      compileFlow(
        flow(
          extractNode({
            recordedDsl: recordedDsl(),
            manualVars: [{ id: "m1", varName: "code", value: "重复" }],
          }),
        ),
        [],
      ),
    /重复产出/,
  );
});

test("const 取值节点直接写入变量，空值也允许", async () => {
  const dsl = {
    dslVersion: "1.0",
    meta: { name: "const" },
    systems: [],
    nodes: [
      {
        id: "n1",
        type: "extract",
        source: "const",
        varName: "flag",
        value: "固定值",
      },
      {
        id: "n2",
        type: "extract",
        source: "const",
        varName: "empty",
        value: "",
      },
    ],
    edges: [{ from: "n1", to: "n2" }],
    entry: "n1",
  };
  const result = await runFlow({
    dsl,
    host: {
      async navigate() {},
      getDocument() {
        throw new Error("no dom");
      },
      getUrl() {
        return "http://localhost:3000/";
      },
    },
  });

  assert.equal(result.status, "finished");
  assert.equal(result.vars.flag, "固定值");
  assert.equal(result.vars.empty, "");
});
