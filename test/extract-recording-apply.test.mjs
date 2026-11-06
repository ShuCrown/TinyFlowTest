import test from "node:test";
import assert from "node:assert/strict";

import { buildExtractRecording } from "../src/flow/extract-recording.ts";

const system = { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" };

function inputStep(patch = {}) {
  return {
    type: "change",
    selectors: [['css/input[name="keyword"]']],
    value: "华东",
    tagName: "input",
    labelText: "关键词",
    ...patch,
  };
}

function extractStep(patch = {}) {
  return {
    type: "extract",
    selectors: [["css/#customer-code"]],
    labelText: "编号",
    readMode: "text",
    value: "C-0001",
    ...patch,
  };
}

test("录制保留所有取值步骤，一个取值对应一个变量", () => {
  const built = buildExtractRecording(
    [
      inputStep(),
      extractStep({ varName: "code", selectors: [["css/#customer-code"]] }),
      inputStep({ value: "第二次筛选" }),
      extractStep({
        varName: "name",
        selectors: [["css/#customer-name"]],
        labelText: "名称",
      }),
    ],
    system,
  );

  assert.equal(built.error, "");
  assert.equal(built.value.systemId, "sys");
  assert.deepEqual(
    built.value.extracts.map((item) => item.varName),
    ["code", "name"],
  );
  assert.equal(built.value.extracts.length, 2);
  assert.equal(built.value.preStepCount, 2);
  assert.deepEqual(
    built.value.recordedDsl.nodes.map((node) => node.type),
    ["interact", "extract", "interact", "extract"],
  );
  assert.equal(built.value.extracts[0].summary, "text · 编号");
  assert.equal(built.value.extracts[1].summary, "text · 名称");
  assert.equal(
    built.value.recordedDsl.nodes.find((node) => node.type === "extract")?.meta
      ?.sampleValue,
    "C-0001",
  );
});

test("表格取值生成表格摘要", () => {
  const built = buildExtractRecording(
    [
      extractStep({
        varName: "remark",
        semantic: {
          cell: {
            table: "customer-table",
            keyHeader: "客户名称",
            rowValue: "华东示例客户",
            header: "编号",
            control: "self",
          },
        },
      }),
    ],
    system,
  );

  assert.equal(built.value.extracts[0].summary, "表格 · 华东示例客户 / 编号");
  assert.equal(built.value.preStepCount, 0);
});

test("没有取值步骤时提示先录制取值目标", () => {
  const built = buildExtractRecording([inputStep()], system);

  assert.equal(built.value, null);
  assert.match(built.error, /录制取值/);
});
