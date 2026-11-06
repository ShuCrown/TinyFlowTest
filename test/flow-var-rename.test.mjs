import test from "node:test";
import assert from "node:assert/strict";

import { compileFlow } from "../src/flow/compile.ts";
import {
  hasExtractSteps,
  renameExtractVar,
  uniqueVarName,
} from "../src/flow/vars.ts";

const system = { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" };

function recordDsl(nodes, entry) {
  return {
    dslVersion: "1.0",
    meta: { name: "record" },
    systems: [system],
    nodes,
    edges: [],
    entry,
  };
}

function record(id, name, dsl) {
  return {
    id,
    name,
    systemId: "sys",
    targetUrl: "/customers",
    steps: 1,
    nodes: dsl.nodes.length,
    status: "ready",
    dsl,
    values: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function flow(nodes, edges = [], extra = {}) {
  return {
    id: "flw-rename",
    name: "改名测试",
    recordCount: nodes.length,
    status: "draft",
    graph: { nodes, edges, injections: [], vars: [], ...extra },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function cellTarget(rowValue, header = "备注") {
  return {
    label: header,
    strategies: [
      { type: "cell", cell: { keyHeader: "客户名称", rowValue, header } },
    ],
  };
}

function interactNode(id, rowValue) {
  return {
    id,
    type: "interact",
    system: "sys",
    adapter: "input",
    target: cellTarget(rowValue),
    value: "录制值",
  };
}

function recordExtractNode(id, varName) {
  return {
    id,
    type: "extract",
    source: "dom",
    varName,
    target: {
      label: "编号",
      strategies: [
        {
          type: "cell",
          cell: { keyHeader: "客户名称", rowValue: "客户A", header: "编号" },
        },
      ],
    },
    read: "text",
  };
}

function canvasExtract(id, varName) {
  return { id, kind: "extract", varName, read: "text", selector: "#code", x: 0, y: 0 };
}

test("画布取值改名后编译使用别名，并重写记录里的 {{旧名}} 模板", () => {
  const consumer = record(
    "rec-b",
    "填写备注",
    recordDsl([interactNode("b1", "{{code}}")], "b1"),
  );
  const compiled = compileFlow(
    flow(
      [
        canvasExtract("n1", "code"),
        { id: "n2", kind: "record", recordId: "rec-b", x: 300, y: 0 },
      ],
      [{ from: "n1", to: "n2" }],
      { varAliases: { n1: "customerCode" } },
    ),
    [consumer],
  );

  assert.deepEqual(compiled.extractVars, [{ nodeId: "n1", name: "customerCode" }]);
  const extract = compiled.dsl.nodes.find((node) => node.id === "n1::extract");
  assert.equal(extract.varName, "customerCode");
  const interact = compiled.dsl.nodes.find((node) => node.id === "n2::b1");
  assert.equal(interact.target.strategies[0].cell.rowValue, "{{customerCode}}");
});

test("记录内取值改名：别名生效、模板重写、注入引用同步", () => {
  const producer = record(
    "rec-a",
    "搜索并取值",
    recordDsl(
      [recordExtractNode("a1", "extracted1"), interactNode("a2", "{{extracted1}}")],
      "a1",
    ),
  );
  const consumer = record(
    "rec-b",
    "填写备注",
    recordDsl([interactNode("b1", "录制值")], "b1"),
  );
  let current = flow(
    [
      { id: "n1", kind: "record", recordId: "rec-a", x: 0, y: 0 },
      { id: "n2", kind: "record", recordId: "rec-b", x: 300, y: 0 },
    ],
    [{ from: "n1", to: "n2" }],
    {
      injections: [
        {
          id: "i1",
          recordNodeId: "n2",
          dslNodeId: "b1",
          slot: "input",
          source: { kind: "var", name: "extracted1" },
        },
      ],
    },
  );
  current = {
    ...current,
    graph: renameExtractVar(
      current.graph,
      "n1::a1",
      "extracted1",
      "extracted1",
      "customerCode",
    ),
  };
  assert.deepEqual(current.graph.varAliases, { "n1::a1": "customerCode" });
  assert.equal(current.graph.injections[0].source.name, "customerCode");

  const compiled = compileFlow(current, [producer, consumer]);
  assert.deepEqual(compiled.extractVars, [
    { nodeId: "n1::a1", name: "customerCode", recordNodeId: "n1" },
  ]);
  assert.equal(
    compiled.dsl.nodes.find((node) => node.id === "n1::a1").varName,
    "customerCode",
  );
  assert.equal(
    compiled.dsl.nodes.find((node) => node.id === "n1::a2").target.strategies[0].cell
      .rowValue,
    "{{customerCode}}",
  );
  assert.deepEqual(
    compiled.dsl.nodes.find((node) => node.id === "n2::b1").value,
    { kind: "var", name: "customerCode" },
  );
});

test("改回录制名会删除流程别名", () => {
  const current = flow([canvasExtract("n1", "code")], [], {
    varAliases: { n1: "customerCode" },
  });
  const next = renameExtractVar(
    current.graph,
    "n1",
    "code",
    "customerCode",
    "code",
  );
  assert.equal(next.varAliases.n1, undefined);
});

test("同一旧名有多个产出时不自动重写模板，并给出警告", () => {
  const producerA = record(
    "rec-a",
    "记录 A",
    recordDsl([recordExtractNode("a1", "same")], "a1"),
  );
  const producerB = record(
    "rec-c",
    "记录 C",
    recordDsl([recordExtractNode("c1", "same")], "c1"),
  );
  const consumer = record(
    "rec-b",
    "填写备注",
    recordDsl([interactNode("b1", "{{same}}")], "b1"),
  );
  const compiled = compileFlow(
    flow(
      [
        { id: "n1", kind: "record", recordId: "rec-a", x: 0, y: 0 },
        { id: "n2", kind: "record", recordId: "rec-c", x: 300, y: 0 },
        { id: "n3", kind: "record", recordId: "rec-b", x: 600, y: 0 },
      ],
      [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
      { varAliases: { "n1::a1": "firstCode" } },
    ),
    [producerA, producerB, consumer],
  );

  assert.equal(
    compiled.dsl.nodes.find((node) => node.id === "n1::a1").varName,
    "firstCode",
  );
  assert.equal(
    compiled.dsl.nodes.find((node) => node.id === "n3::b1").target.strategies[0].cell
      .rowValue,
    "{{same}}",
  );
  assert.ok(compiled.warnings.some((warning) => warning.includes("多个产出")));
});

test("没有录制或手工配置的取值节点不产出变量", () => {
  const empty = {
    id: "n1",
    kind: "extract",
    varName: "code1",
    read: "text",
    selector: "",
    x: 0,
    y: 0,
  };
  assert.equal(hasExtractSteps(empty), false);
  assert.equal(hasExtractSteps({ ...empty, selector: "#code" }), true);
  assert.equal(
    hasExtractSteps({
      ...empty,
      recordedDsl: { nodes: [{ id: "e1", type: "extract" }] },
    }),
    true,
  );
  assert.equal(
    hasExtractSteps({
      ...empty,
      manualVars: [{ id: "m1", varName: "manual1", value: "值" }],
    }),
    true,
  );
});

test("变量名冲突时生成画布内唯一的名字", () => {
  const used = new Set(["code", "code2", "extracted1"]);
  assert.equal(uniqueVarName("code", used), "code3");
  assert.equal(uniqueVarName("extracted1", used), "extracted2");
  assert.equal(uniqueVarName("newName", used), "newName");
  assert.equal(uniqueVarName("  ", used), "extracted");
});

test("别名造成重名时编译失败", () => {
  const current = flow(
    [canvasExtract("n1", "code"), canvasExtract("n2", "other")],
    [{ from: "n1", to: "n2" }],
    { varAliases: { n2: "code" } },
  );
  assert.throws(() => compileFlow(current, []), /重复产出/);
});
