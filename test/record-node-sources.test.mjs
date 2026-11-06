import test from "node:test";
import assert from "node:assert/strict";

import { importChromeRecorder } from "../src/recorder/chrome-recorder.ts";

const system = { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" };

function convert(steps) {
  return importChromeRecorder({
    recording: { title: "节点映射", steps },
    system,
    flowName: "节点映射",
  });
}

function pickerSteps() {
  return [
    { type: "navigate", url: "http://localhost:3000/list" },
    {
      type: "click",
      selectors: [["css/#status-trigger"]],
      labelText: "状态",
      semantic: {
        rule: "antd-select",
        zone: "trigger",
        detection: "class",
        popupOpen: false,
      },
    },
    {
      type: "change",
      selectors: [["css/#status-filter"]],
      value: "启用",
      tagName: "input",
      labelText: "筛选",
      semantic: {
        rule: "antd-select",
        zone: "panel",
        detection: "class",
        popupOpen: true,
      },
    },
    {
      type: "click",
      selectors: [["aria/启用"]],
      labelText: "启用",
      semantic: {
        rule: "antd-select",
        zone: "item",
        detection: "class",
        popupOpen: true,
        value: "启用",
      },
    },
    {
      type: "click",
      selectors: [["css/#save"]],
      labelText: "保存",
    },
  ];
}

test("picker 节点映射整簇原始步骤", () => {
  const result = convert(pickerSteps());
  const picker = result.dsl.nodes.find((node) => node.type === "picker");
  assert.ok(picker);
  assert.deepEqual(result.sources[picker.id], [1, 2, 3]);
});

test("普通节点只映射自己那一步", () => {
  const result = convert(pickerSteps());
  const navigate = result.dsl.nodes.find((node) => node.type === "navigate");
  const save = result.dsl.nodes.find(
    (node) => node.type === "interact" && node.name === "点击 保存",
  );
  assert.deepEqual(result.sources[navigate.id], [0]);
  assert.deepEqual(result.sources[save.id], [4]);
});

test("连续重复的导航归到同一个节点，删除时不会复活", () => {
  const result = convert([
    { type: "navigate", url: "http://localhost:3000/list" },
    { type: "navigate", url: "http://localhost:3000/list" },
    { type: "click", selectors: [["css/#save"]], labelText: "保存" },
  ]);
  const navigate = result.dsl.nodes.find((node) => node.type === "navigate");
  assert.deepEqual(result.sources[navigate.id], [0, 1]);
});

test("单独输入步骤映射自己的下标", () => {
  const result = convert([
    {
      type: "change",
      selectors: [["css/input[name=keyword]"]],
      value: "华东",
      tagName: "input",
      labelText: "关键词",
    },
  ]);
  const node = result.dsl.nodes[0];
  assert.deepEqual(result.sources[node.id], [0]);
});
