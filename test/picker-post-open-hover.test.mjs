import test from "node:test";
import assert from "node:assert/strict";

import { importChromeRecorder } from "../src/recorder/chrome-recorder.ts";

/**
 * 存量记录「工艺卡新建」的真实形状：hover(未开) → click(未开) → hover(已开) → 选项。
 * 第三条悬停是点击展开后组件重渲染在静止鼠标下补发的 mouseover，不是打开动作。
 * 它一旦收簇，真正开面板的 click 就被挤成独立节点，picker 以悬停为触发器
 * （triggerAction=hover）；回放对 click 展开的 antd Dropdown 发悬停永远打不开面板，
 * 只有前导 click 恰好把面板留着时才侥幸通过 —— 这就是「有时成功有时 15s 超时」的来源。
 */

const system = { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" };

const TRIGGER_SELECTORS = [
  [
    "text/新建工艺卡",
    "css/div > div:nth-of-type(3) > div > div:nth-of-type(2) > div:nth-of-type(2) > button:nth-of-type(1)",
  ],
];

const navigate = { type: "navigate", url: "http://localhost:3000/list" };
const viewClick = {
  type: "click",
  selectors: [
    ["text/查看", "css/tr:nth-of-type(9) > td:nth-of-type(26) > span > div > div:nth-of-type(1) > div"],
  ],
};
const itemClick = {
  type: "click",
  selectors: [["text/针刺工艺卡", "css/html > body > div:nth-of-type(3) > div > ul > li"]],
  semantic: {
    rule: "antd-dropdown",
    zone: "item",
    detection: "class",
    popupOpen: true,
    value: "针刺工艺卡",
  },
};

function triggerEvent(type, popupOpen, selectors = TRIGGER_SELECTORS) {
  return {
    type,
    selectors,
    semantic: { rule: "antd-dropdown", zone: "trigger", detection: "class", popupOpen },
  };
}

function convert(steps) {
  return importChromeRecorder({
    recording: { title: "工艺卡新建", steps },
    system,
    flowName: "工艺卡新建",
  });
}

test("存量记录：面板已开后补发的悬停不当触发器，picker 按 click 打开", () => {
  const result = convert([
    navigate,
    viewClick,
    triggerEvent("hover", false),
    triggerEvent("click", false),
    triggerEvent("hover", true),
    itemClick,
  ]);
  const picker = result.dsl.nodes.find((node) => node.type === "picker");
  assert.ok(picker, "六步记录必须折出一个 picker");
  assert.equal(picker.triggerAction, "click", "开面板的是 click，不是面板已开后的悬停");
  assert.equal(picker.pick.values[0].value, "针刺工艺卡");
  // 触发器上的三条事件全部折进簇：回放不再多一次悬停 + 一次点击。
  assert.deepEqual(result.sources[picker.id], [2, 3, 4, 5]);
  assert.deepEqual(
    result.dsl.nodes.map((node) => node.type + ":" + (node.adapter ?? node.triggerAction ?? "")),
    ["navigate:", "interact:click", "picker:click"],
  );
});

test("正例对照：真的靠悬停展开时，picker 仍然按 hover 打开", () => {
  const result = convert([navigate, triggerEvent("hover", false), itemClick]);
  const picker = result.dsl.nodes.find((node) => node.type === "picker");
  assert.ok(picker);
  assert.equal(picker.triggerAction, "hover", "断言不是「一律 click」：悬停展开的记录必须保持 hover");
  assert.deepEqual(result.sources[picker.id], [1, 2]);
});

test("只吸收同一触发器的补发悬停：另一个触发器的悬停仍然切簇", () => {
  const other = [["text/导出工艺卡"]];
  const result = convert([
    navigate,
    triggerEvent("click", false),
    triggerEvent("hover", true, other),
    { ...itemClick, selectors: [["text/热轧工艺卡"]], semantic: { ...itemClick.semantic, value: "热轧工艺卡" } },
  ]);
  const picker = result.dsl.nodes.find((node) => node.type === "picker");
  assert.ok(picker);
  assert.deepEqual(result.sources[picker.id], [2, 3], "第二个触发器的悬停不能被前一个簇吞掉");
  assert.equal(picker.trigger.label, "导出工艺卡");
  assert.equal(
    result.dsl.nodes.some((node) => node.type === "interact" && node.adapter === "click"),
    true,
    "第一个触发器的点击退化为独立节点，而不是被误折进 picker",
  );
});