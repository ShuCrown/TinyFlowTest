import test from "node:test";
import assert from "node:assert/strict";

import { compileFlow } from "../src/flow/compile.ts";

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

function extractNode(id, varName, rowValue = "华东示例客户") {
  return {
    id,
    type: "extract",
    source: "dom",
    varName,
    target: {
      label: "备注",
      strategies: [
        {
          type: "cell",
          cell: { keyHeader: "客户名称", rowValue, header: "备注", control: "self" },
        },
      ],
    },
    read: "text",
  };
}

function inputNode(id, label = "备注") {
  return {
    id,
    type: "interact",
    system: "sys",
    adapter: "input",
    target: { label, strategies: [{ type: "css", value: "#remark" }] },
    value: "录制值",
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

function flow(nodes, edges, injections = []) {
  return {
    id: "flw-record-extract",
    name: "搜索取值 → 后续操作",
    recordCount: nodes.length,
    status: "draft",
    graph: { nodes, edges, injections, vars: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const extractRecord = record(
  "rec-a",
  "搜索并取值",
  recordDsl([extractNode("a1", "customerRemark")], "a1"),
);
const inputRecord = record("rec-b", "填写备注", recordDsl([inputNode("b1")], "b1"));

test("记录内取值作为流程变量产出，并可注入后续记录", () => {
  const compiled = compileFlow(
    flow(
      [
        { id: "n1", kind: "record", recordId: "rec-a", x: 0, y: 0 },
        { id: "n2", kind: "record", recordId: "rec-b", x: 200, y: 0 },
      ],
      [{ from: "n1", to: "n2" }],
      [
        {
          id: "i1",
          recordNodeId: "n2",
          dslNodeId: "b1",
          slot: "input",
          source: { kind: "var", name: "customerRemark" },
        },
      ],
    ),
    [extractRecord, inputRecord],
  );

  assert.deepEqual(compiled.extractVars, [
    { nodeId: "n1::a1", name: "customerRemark", recordNodeId: "n1" },
  ]);
  const extract = compiled.dsl.nodes.find((node) => node.id === "n1::a1");
  assert.equal(extract.type, "extract");
  assert.equal(extract.varName, "customerRemark");
  const input = compiled.dsl.nodes.find((node) => node.id === "n2::b1");
  assert.deepEqual(input.value, { kind: "var", name: "customerRemark" });
});

test("记录内取值在消费节点之后时才产出，编译失败", () => {
  assert.throws(
    () =>
      compileFlow(
        flow(
          [
            { id: "n1", kind: "record", recordId: "rec-b", x: 0, y: 0 },
            { id: "n2", kind: "record", recordId: "rec-a", x: 200, y: 0 },
          ],
          [{ from: "n1", to: "n2" }],
          [
            {
              id: "i1",
              recordNodeId: "n1",
              dslNodeId: "b1",
              slot: "input",
              source: { kind: "var", name: "customerRemark" },
            },
          ],
        ),
        [extractRecord, inputRecord],
      ),
    /之后才产出/,
  );
});

test("两条记录产出同名变量时编译失败", () => {
  const anotherExtract = record(
    "rec-c",
    "再次取值",
    recordDsl([extractNode("c1", "customerRemark")], "c1"),
  );
  assert.throws(
    () =>
      compileFlow(
        flow(
          [
            { id: "n1", kind: "record", recordId: "rec-a", x: 0, y: 0 },
            { id: "n2", kind: "record", recordId: "rec-c", x: 200, y: 0 },
          ],
          [{ from: "n1", to: "n2" }],
        ),
        [extractRecord, anotherExtract],
      ),
    /重复产出/,
  );
});

test("禁用的记录节点不产出变量，引用时编译失败", () => {
  assert.throws(
    () =>
      compileFlow(
        flow(
          [
            { id: "n1", kind: "record", recordId: "rec-a", enabled: false, x: 0, y: 0 },
            { id: "n2", kind: "record", recordId: "rec-b", x: 200, y: 0 },
          ],
          [{ from: "n1", to: "n2" }],
          [
            {
              id: "i1",
              recordNodeId: "n2",
              dslNodeId: "b1",
              slot: "input",
              source: { kind: "var", name: "customerRemark" },
            },
          ],
        ),
        [extractRecord, inputRecord],
      ),
    /没有任何节点产出/,
  );
});
