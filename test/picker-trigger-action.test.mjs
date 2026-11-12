import test from "node:test";
import assert from "node:assert/strict";

import { importChromeRecorder } from "../src/recorder/chrome-recorder.ts";

const system = { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" };

function convert(steps) {
  return importChromeRecorder({
    recording: { title: "dropdown", steps },
    system,
    flowName: "dropdown",
  });
}

const navigate = { type: "navigate", url: "http://localhost:3000/list" };

const triggerHover = {
  type: "hover",
  selectors: [["text/新建工艺卡"]],
  semantic: {
    rule: "antd-dropdown",
    zone: "trigger",
    detection: "class",
    popupOpen: false,
  },
};

const triggerClick = {
  type: "click",
  selectors: [["text/新建工艺卡"]],
  semantic: {
    rule: "antd-dropdown",
    zone: "trigger",
    detection: "class",
    popupOpen: false,
  },
};

const itemClick = {
  type: "click",
  selectors: [["text/工艺卡A"]],
  semantic: {
    rule: "antd-dropdown",
    zone: "item",
    detection: "class",
    popupOpen: true,
    value: "工艺卡A",
  },
};

test("点击展开的 dropdown：picker 用 click 打开，前导 hover 被折叠", () => {
  const result = convert([navigate, triggerHover, triggerClick, itemClick]);
  const picker = result.dsl.nodes.find((node) => node.type === "picker");
  assert.ok(picker);
  assert.equal(picker.triggerAction, "click");
  // hover 折进 picker 簇，不再生成独立的悬停节点。
  assert.equal(result.dsl.nodes.some((node) => node.adapter === "hover"), false);
  assert.deepEqual(result.sources[picker.id], [1, 2, 3]);
  assert.equal(picker.pick.values[0].value, "工艺卡A");
});

test("悬停展开的 dropdown：picker 仍用 hover，hover 就是触发器", () => {
  const result = convert([navigate, triggerHover, itemClick]);
  const picker = result.dsl.nodes.find((node) => node.type === "picker");
  assert.ok(picker);
  assert.equal(picker.triggerAction, "hover");
  assert.equal(result.dsl.nodes.some((node) => node.adapter === "hover"), false);
  assert.deepEqual(result.sources[picker.id], [1, 2]);
});

test("点击前面板已展开时不折叠 hover，picker 仍按 click 重放", () => {
  const result = convert([
    navigate,
    triggerHover,
    { ...triggerClick, semantic: { ...triggerClick.semantic, popupOpen: true } },
    itemClick,
  ]);
  const picker = result.dsl.nodes.find((node) => node.type === "picker");
  assert.ok(picker);
  assert.equal(picker.triggerAction, "click");
  // 这条负向断言有正例对照：hover 展开面板时，悬停节点仍然保留。
  assert.equal(result.dsl.nodes.some((node) => node.adapter === "hover"), true);
  assert.deepEqual(result.sources[picker.id], [2, 3]);
});
