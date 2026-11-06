import test from "node:test";
import assert from "node:assert/strict";

import { compileFlow, FlowCompileError } from "../src/flow/compile.ts";

function flow(extract, vars = []) {
  return {
    id: "flw-extract",
    name: "取值测试",
    recordCount: 0,
    status: "draft",
    graph: { nodes: [extract], edges: [], injections: [], vars },
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
    selector: "",
    x: 0,
    y: 0,
    ...patch,
  };
}

function compiledNode(extract, vars = []) {
  const compiled = compileFlow(flow(extract, vars), []);
  assert.equal(compiled.dsl.nodes.length, 1);
  return compiled.dsl.nodes[0];
}

test("CSS 取值默认走 dom 来源，隐藏元素开关会保留", () => {
  const node = compiledNode(
    extractNode({ selector: " #success-code ", includeHidden: true }),
  );
  assert.equal(node.source, "dom");
  assert.equal(node.varName, "code");
  assert.deepEqual(node.target.strategies, [{ type: "css", value: "#success-code" }]);
  assert.equal(node.includeHidden, true);
});

test("表格取值把 CellRef 原样编译成 cell 策略，行值模板保留到运行期", () => {
  const node = compiledNode(
    extractNode({
      locate: "cell",
      read: "text",
      cell: {
        table: " customer-table ",
        keyHeader: " 客户名称 ",
        rowValue: " {{customerName}} ",
        header: " 备注 ",
        control: "self",
      },
    }),
  );
  assert.deepEqual(node.target.strategies, [
    {
      type: "cell",
      cell: {
        table: "customer-table",
        keyHeader: "客户名称",
        rowValue: "{{customerName}}",
        header: "备注",
        control: "self",
      },
    },
  ]);
});

test("表格取值缺少关键定位字段时编译失败", () => {
  assert.throws(
    () =>
      compileFlow(
        flow(
          extractNode({
            locate: "cell",
            cell: { rowValue: "客户A", header: "备注" },
          }),
        ),
        [],
      ),
    /行值所在列/,
  );
  assert.throws(
    () =>
      compileFlow(
        flow(extractNode({ locate: "cell", cell: { keyHeader: "名称", rowValue: "客户A" } })),
        [],
      ),
    /目标列/,
  );
});

test("表格取值可直接按筛选结果行号定位", () => {
  const node = compiledNode(
    extractNode({ locate: "cell", cell: { header: "备注", rowIndex: 1 } }),
  );
  assert.equal(node.target.strategies[0].cell.rowIndex, 1);
  assert.equal(node.target.strategies[0].cell.rowValue, undefined);
});

test("接口取值编译出 response 来源，方法大写、字段去除空白", () => {
  const node = compiledNode(
    extractNode({
      source: "response",
      response: {
        method: "post",
        urlContains: " /api/customer/save ",
        bodyContains: " saveCustomer ",
        path: " data.code ",
      },
    }),
  );
  assert.equal(node.source, "response");
  assert.deepEqual(node.response, {
    method: "POST",
    urlContains: "/api/customer/save",
    bodyContains: "saveCustomer",
    path: "data.code",
  });
  assert.equal(node.pattern, undefined);
});

test("接口取值缺少 URL 匹配时编译失败", () => {
  assert.throws(
    () =>
      compileFlow(
        flow(extractNode({ source: "response", response: { urlContains: "  " } })),
        [],
      ),
    /缺少接口 URL 匹配/,
  );
});

test("JS 取值编译出 js 来源并保留表达式", () => {
  const node = compiledNode(
    extractNode({ source: "js", js: " window.__DATA__.customer.code " }),
  );
  assert.equal(node.source, "js");
  assert.equal(node.js, "window.__DATA__.customer.code");
});

test("JS 取值缺少表达式时编译失败", () => {
  assert.throws(
    () => compileFlow(flow(extractNode({ source: "js", js: "  " })), []),
    /缺少 JS 表达式/,
  );
});
