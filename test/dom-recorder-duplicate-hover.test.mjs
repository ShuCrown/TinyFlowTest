import test from "node:test";
import assert from "node:assert/strict";

import { DomRecorder } from "../src/recorder/dom-recorder.ts";
import { importChromeRecorder } from "../src/recorder/chrome-recorder.ts";

/**
 * 点击展开的 dropdown：鼠标移入先触发一次 mouseover，点开面板后组件重渲染
 * 会在静止的鼠标下再派发一次 mouseover。第二条悬停的 popupOpen=true，
 * 转换时它会挤掉 click 成为 picker 的触发器（triggerAction=hover，回放打不开面板）。
 *
 * 这里用 DOM 桩驱动真实的 onHover/onClick（TS 的 private 在运行时只是普通方法），
 * 断言「面板已展开时的重复悬停不落盘」，并把产出的 steps 喂给转换器验证回放语义。
 */

/** 只支持本用例用到的选择器：.class、[attr]、[attr="v"]、[attr*="v"]、标签、逗号列表。 */
function matchesSelector(el, selector) {
  return selector.split(",").some((raw) => {
    const sel = raw.trim();
    if (!sel) return false;
    if (sel.startsWith(".")) return el.classes.includes(sel.slice(1));
    if (sel === "svg") return el.tagName.toLowerCase() === "svg";
    if (sel.startsWith("[")) {
      const m = /^\[([^\]=~*^$]+)(?:([~*^$]?=)"?([^"\]]*)"?)?\]$/.exec(sel);
      if (!m) return false;
      const value = el.getAttribute(m[1]);
      if (value === null) return false;
      if (!m[2]) return true;
      if (m[2] === "=") return value === m[3];
      if (m[2] === "*=") return value.includes(m[3]);
      return false;
    }
    const m = /^([a-z0-9]+)(.*)$/i.exec(sel);
    if (m && el.tagName.toLowerCase() === m[1].toLowerCase()) {
      const rest = m[2].trim();
      return rest === "" || (rest.startsWith("[") && matchesSelector(el, rest));
    }
    return false;
  });
}

function makeFixture() {
  const state = { open: false };
  const style = { display: "block", visibility: "visible", opacity: "1" };
  const doc = {
    defaultView: { getComputedStyle: () => style },
    activeElement: null,
    documentElement: null,
    body: null,
    querySelectorAll(selector) {
      // hasVisiblePanel 只认规则表里的面板选择器；关闭时返回空。
      return state.open && selector.includes("ant-dropdown") ? [panel] : [];
    },
    querySelector: () => null,
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  };

  function element(tag, { attrs = {}, classes = [], text = "", parent = null } = {}) {
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: "",
      ownerDocument: doc,
      parentElement: parent,
      attrs,
      classes,
      textContent: text,
      isContentEditable: false,
      children: { length: 0, item: () => null },
      getAttribute(name) {
        return this.attrs[name] ?? null;
      },
      hasAttribute(name) {
        return name in this.attrs;
      },
      matches(selector) {
        return matchesSelector(this, selector);
      },
      closest(selector) {
        let node = this;
        while (node) {
          if (matchesSelector(node, selector)) return node;
          node = node.parentElement;
        }
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      getClientRects: () => [{}],
    };
  }

  const html = element("html");
  const body = element("body", { parent: html });
  doc.documentElement = html;
  doc.body = body;
  const panel = element("div", { classes: ["ant-dropdown"], parent: body });
  const trigger = element("button", {
    attrs: { "aria-haspopup": "menu" },
    classes: ["ant-dropdown-trigger"],
    text: "新建工艺卡",
    parent: body,
  });

  return { state, trigger };
}

function recorder() {
  const rec = new DomRecorder({ onChange: () => {} });
  rec.recording = true;
  rec.valueMode = false;
  rec.lastHover = null;
  return rec;
}

function hover(rec, trigger) {
  rec["onHover"]({ target: trigger });
}

function click(rec, trigger) {
  rec["onClick"]({ target: trigger });
}

/** 让转换器能折出 picker 的选项点击；与录制桩无关，值来自真实录制形状。 */
const ITEM_STEP = {
  type: "click",
  selectors: [["text/针刺工艺卡"]],
  semantic: {
    rule: "antd-dropdown",
    zone: "item",
    detection: "class",
    popupOpen: true,
    value: "针刺工艺卡",
  },
};

function convert(steps) {
  return importChromeRecorder({
    recording: { title: "工艺卡新建", steps },
    system: { id: "sys", name: "演示系统", baseUrl: "http://localhost:3000" },
    flowName: "工艺卡新建",
  });
}

test("面板已展开时的重复悬停不再落盘", () => {
  const { state, trigger } = makeFixture();
  const rec = recorder();

  hover(rec, trigger); // 面板未开：这是有效的前导悬停，应保留
  assert.equal(rec.getSteps().filter((s) => s.type === "hover").length, 1);

  click(rec, trigger); // 点击打开面板（onClick 会清空 lastHover）
  state.open = true;

  hover(rec, trigger); // 组件重渲染后静止鼠标再派发的 mouseover：重复悬停

  const hovers = rec.getSteps().filter((s) => s.type === "hover");
  assert.equal(hovers.length, 1, "面板已展开时不应再记录第二条悬停");
  assert.equal(hovers[0].semantic?.popupOpen, false, "保留的应是面板未展开的那条");
});

test("重复悬停被去掉后转换按 click 打开，且没有独立悬停节点", () => {
  const { state, trigger } = makeFixture();
  const rec = recorder();

  hover(rec, trigger);
  click(rec, trigger);
  state.open = true;
  hover(rec, trigger);

  const steps = [...rec.getSteps(), ITEM_STEP];
  const result = convert(steps);
  const picker = result.dsl.nodes.find((node) => node.type === "picker");
  assert.ok(picker, "hover + click + item 应折成一个 picker");
  assert.equal(picker.triggerAction, "click", "点击展开的 dropdown 回放必须发 click");
  assert.equal(
    result.dsl.nodes.some((node) => node.adapter === "hover"),
    false,
    "不应残留独立的悬停交互节点",
  );
  assert.deepEqual(
    result.sources[picker.id].length >= 3,
    true,
    `前导悬停应被折进 picker，sources=${JSON.stringify(result.sources[picker.id])}`,
  );
});

test("面板未展开时的有效悬停仍然记录（防止把守卫写成一律跳过）", () => {
  const { trigger } = makeFixture();
  const rec = recorder();
  hover(rec, trigger);
  const hovers = rec.getSteps().filter((s) => s.type === "hover");
  assert.equal(hovers.length, 1);
  assert.equal(hovers[0].semantic?.zone, "trigger");
  assert.equal(hovers[0].semantic?.popupOpen, false);
});
