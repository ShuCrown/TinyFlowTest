import test from "node:test";
import assert from "node:assert/strict";

import { importChromeRecorder } from "../src/recorder/chrome-recorder.ts";

const system = { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" };

function convert(steps) {
  return importChromeRecorder({
    recording: { title: "取值录制", steps },
    system,
    flowName: "取值录制",
  });
}

function extractStep(patch = {}) {
  return {
    type: "extract",
    selectors: [["css/#row-1"]],
    labelText: "备注",
    varName: "customerRemark",
    readMode: "text",
    value: "录制的初始数据",
    ...patch,
  };
}

test("取值步骤转换为 dom extract 节点，表格地址保留为 cell 策略", () => {
  const result = convert([
    {
      type: "change",
      selectors: [['css/input[name="keyword"]']],
      value: "华东",
      tagName: "input",
      labelText: "关键词",
    },
    extractStep({
      semantic: {
        cell: {
          table: "customer-table",
          keyHeader: "客户名称",
          rowValue: "华东示例客户",
          header: "备注",
          colIndex: 3,
          control: "self",
        },
      },
    }),
  ]);

  assert.deepEqual(
    result.dsl.nodes.map((node) => node.type),
    ["interact", "extract"],
  );
  const node = result.dsl.nodes[1];
  assert.equal(node.source, "dom");
  assert.equal(node.varName, "customerRemark");
  assert.equal(node.read, "text");
  assert.equal(node.meta.sourceIndex, 1);
  assert.equal(node.target.strategies[0].type, "cell");
  assert.deepEqual(node.target.strategies[0].cell, {
    table: "customer-table",
    keyHeader: "客户名称",
    rowValue: "华东示例客户",
    header: "备注",
    control: "self",
  });
  assert.deepEqual(
    result.dsl.edges.map((edge) => `${edge.from}->${edge.to}`),
    [`${result.dsl.nodes[0].id}->${node.id}`],
  );
});

test("属性读取会带上属性名", () => {
  const result = convert([
    extractStep({
      varName: "code",
      readMode: "attribute",
      attributeName: " data-code ",
    }),
  ]);
  const node = result.dsl.nodes[0];
  assert.equal(node.type, "extract");
  assert.equal(node.read, "attribute");
  assert.equal(node.attribute, "data-code");
});

test("取值步骤缺少变量名时自动生成变量并给出提示", () => {
  const result = convert([extractStep({ varName: "" })]);
  const node = result.dsl.nodes[0];
  assert.equal(node.type, "extract");
  assert.equal(node.varName, "extracted1");
  assert.match(result.report.warnings.join("\n"), /缺少变量名/);
});

test("取值变量重名时给出覆盖提示", () => {
  const result = convert([
    extractStep({ varName: "same" }),
    extractStep({ varName: "same", selectors: [["css/#row-2"]] }),
  ]);
  assert.match(result.report.warnings.join("\n"), /重复/);
});

test("筛选后第一行用 rowIndex 定位，不要求行值", () => {
  const result = convert([
    extractStep({
      varName: "firstRemark",
      semantic: { cell: { table: "customer-table", header: "备注", rowIndex: 1, control: "self" } },
    }),
  ]);
  const node = result.dsl.nodes[0];
  assert.equal(node.type, "extract");
  assert.equal(node.target.strategies[0].cell.rowIndex, 1);
  assert.equal(node.target.strategies[0].cell.rowValue, undefined);
  assert.match(node.name, /筛选后第 1 行/);
});
