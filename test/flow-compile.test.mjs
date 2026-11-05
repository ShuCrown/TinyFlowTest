import test from "node:test";
import assert from "node:assert/strict";

import { compileFlow, FlowCompileError } from "../src/flow/compile.ts";

function dsl(nodes, edges, entry) {
  return {
    dslVersion: "1.0",
    meta: { name: "record" },
    systems: [{ id: "sys", name: "系统", baseUrl: "http://localhost:3000" }],
    nodes,
    edges,
    entry,
  };
}

function interact(id) {
  return {
    id,
    type: "interact",
    system: "sys",
    adapter: "input",
    target: { label: id, strategies: [{ type: "css", value: `.${id}` }] },
    value: "录制值",
  };
}

function picker(id) {
  return {
    id,
    type: "picker",
    system: "sys",
    mode: "inline",
    trigger: { label: "客户", strategies: [{ type: "css", value: ".customer" }] },
    panel: { scope: { type: "dropdown" } },
    filter: {
      steps: [
        {
          adapter: "input",
          target: { label: "编号", strategies: [{ type: "css", value: ".search" }] },
          value: "OLD",
        },
      ],
    },
    pick: {
      strategy: "byText",
      byText: { value: "旧客户" },
      values: [{ value: "旧客户", index: 1 }],
    },
  };
}

function record(id, name, recordDsl, values = {}) {
  return {
    id,
    name,
    systemId: "sys",
    targetUrl: "/customers",
    steps: 1,
    nodes: recordDsl.nodes.length,
    status: "ready",
    dsl: recordDsl,
    values,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function flow(nodes, edges, injections = [], vars = []) {
  return {
    id: "flw-1",
    name: "客户开户 → 下单",
    recordCount: nodes.filter((node) => node.kind === "record").length,
    status: "draft",
    graph: { nodes, edges, injections, vars },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const records = [
  record("rec-a", "新建客户", dsl([interact("a1")], [], "a1")),
  record("rec-b", "新建订单", dsl([picker("b1")], [], "b1"), { b1: { picks: ["旧客户"] } }),
];

test("取值节点产出的变量注入下一条记录的筛选值，并改写选择策略", () => {
  const compiled = compileFlow(
    flow(
      [
        { id: "n1", kind: "record", recordId: "rec-a", x: 0, y: 0 },
        { id: "n2", kind: "extract", varName: "customerCode", selector: "#code", x: 200, y: 0 },
        { id: "n3", kind: "record", recordId: "rec-b", x: 400, y: 0 },
      ],
      [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
      [
        {
          id: "i1",
          recordNodeId: "n3",
          dslNodeId: "b1",
          slot: "filter",
          index: 0,
          source: { kind: "var", name: "customerCode" },
        },
      ],
    ),
    records,
  );

  assert.equal(compiled.dsl.nodes.length, 3);
  assert.equal(compiled.dsl.entry, "n1::a1");
  assert.deepEqual(compiled.extractVars, [{ nodeId: "n2", name: "customerCode" }]);
  assert.deepEqual(
    compiled.dsl.edges.map((edge) => `${edge.from}->${edge.to}`),
    ["n1::a1->n2::extract", "n2::extract->n3::b1"],
  );

  const extract = compiled.dsl.nodes.find((node) => node.type === "extract");
  assert.equal(extract.varName, "customerCode");
  assert.deepEqual(extract.target.strategies, [{ type: "css", value: "#code" }]);

  const next = compiled.dsl.nodes.find((node) => node.id === "n3::b1");
  assert.deepEqual(next.filter.steps[0].value, { kind: "var", name: "customerCode" });
  assert.equal(next.pick.strategy, "byText");
  assert.deepEqual(next.pick.byText.value, { kind: "var", name: "customerCode" });
  assert.equal(next.pick.values, undefined);
  assert.equal(compiled.values["n3::b1"], undefined);
  assert.deepEqual(compiled.groups, { n1: ["n1::a1"], n2: ["n2::extract"], n3: ["n3::b1"] });
});

test("没有筛选选择策略时绑定筛选值会改为选择筛选结果", () => {
  const byIndexRecord = record(
    "rec-c",
    "按位置选择",
    dsl(
      [
        {
          ...picker("c1"),
          pick: { strategy: "byIndex", byIndex: { indexes: [2], on: "row" }, values: [] },
        },
      ],
      [],
      "c1",
    ),
  );
  const compiled = compileFlow(
    flow(
      [
        { id: "n1", kind: "extract", varName: "code", selector: "#code", x: 0, y: 0 },
        { id: "n2", kind: "record", recordId: "rec-c", x: 200, y: 0 },
      ],
      [{ from: "n1", to: "n2" }],
      [
        {
          id: "i1",
          recordNodeId: "n2",
          dslNodeId: "c1",
          slot: "filter",
          index: 0,
          source: { kind: "var", name: "code" },
        },
      ],
    ),
    [...records, byIndexRecord],
  );
  const node = compiled.dsl.nodes.find((item) => item.id === "n2::c1");
  assert.equal(node.pick.strategy, "firstVisible");
  assert.deepEqual(node.pick.firstVisible, { on: "row" });
  assert.equal(node.pick.byIndex, undefined);
});

test("变量在消费之后才产出时编译失败", () => {
  assert.throws(
    () =>
      compileFlow(
        flow(
          [
            { id: "n1", kind: "record", recordId: "rec-b", x: 0, y: 0 },
            { id: "n2", kind: "extract", varName: "customerCode", selector: "#code", x: 200, y: 0 },
          ],
          [{ from: "n1", to: "n2" }],
          [
            {
              id: "i1",
              recordNodeId: "n1",
              dslNodeId: "b1",
              slot: "filter",
              index: 0,
              source: { kind: "var", name: "customerCode" },
            },
          ],
        ),
        records,
      ),
    FlowCompileError,
  );
});

test("引用不存在的操作记录时给出明确错误", () => {
  assert.throws(
    () =>
      compileFlow(
        flow([{ id: "n1", kind: "record", recordId: "missing", x: 0, y: 0 }], []),
        records,
      ),
    /不存在的操作记录/,
  );
});

test("手工环境变量可以在起点注入字面量", () => {
  const compiled = compileFlow(
    flow(
      [{ id: "n1", kind: "record", recordId: "rec-b", x: 0, y: 0 }],
      [],
      [
        {
          id: "i1",
          recordNodeId: "n1",
          dslNodeId: "b1",
          slot: "filter",
          index: 0,
          source: { kind: "var", name: "keyword" },
        },
      ],
      [{ name: "keyword", value: "CUS-001" }],
    ),
    records,
  );
  assert.deepEqual(compiled.vars, { keyword: "CUS-001" });
  const node = compiled.dsl.nodes.find((item) => item.id === "n1::b1");
  assert.deepEqual(node.filter.steps[0].value, { kind: "var", name: "keyword" });
});
