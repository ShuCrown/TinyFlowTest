import test from "node:test";
import assert from "node:assert/strict";

import { runFlow } from "../src/replay/engine.ts";

/**
 * 开面板手势回退。
 *
 * 录制无法判定是哪个手势打开的面板：antd 悬停触发有 0.1s 延迟，hover→click 连击时
 * 两条事件落盘的 popupOpen 都是 false，click 展开与 hover 展开产出同样的字节。
 * 引擎因此不能只赌一种手势——赌错就是「面板未在 Nms 内打开」，
 * 而前导点击恰好把面板留着时又侥幸通过，表现为「有时成功有时失败」。
 *
 * 桩只建模一件事：这个组件对哪个手势有反应。其余 DOM 表面按引擎实际调用补齐。
 */

class FakeHTMLElement {
  constructor(tag, { classes = [], text = "", parent = null, attrs = {} } = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.classes = classes;
    this.attrs = attrs;
    this.textContent = text;
    this.parentElement = parent;
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  get ownerDocument() {
    return this.doc;
  }
  get children() {
    const kids = allElements(this.doc).filter((el) => el.parentElement === this);
    return { length: kids.length, item: (i) => kids[i] ?? null };
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  hasAttribute(name) {
    return name in this.attrs;
  }
  matches(selector) {
    return matchesSelector(this, selector);
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    return allElements(this.doc).filter((el) => el !== this && this.contains(el) && matchesSelector(el, selector));
  }
  getClientRects() {
    return this.visible() ? [{}] : [];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 20 };
  }
  scrollIntoView() {}
  focus() {}
  click() {
    this.dispatchEvent({ type: "click" });
  }
  visible() {
    return true;
  }
  dispatchEvent(event) {
    this.doc.log.push(`${this.tagName.toLowerCase()}.${event.type}`);
    this.doc.onEvent(this, event.type);
    return true;
  }
}

class FakeEvent {
  constructor(type) {
    this.type = type;
  }
}

/** 支持 *、.class、tag、[attr]、[attr="v"]、tag[attr="v"] 与逗号列表。 */
function matchesSelector(el, selector) {
  return String(selector).split(",").some((raw) => {
    const sel = raw.trim();
    if (!sel) return false;
    if (sel === "*") return true;
    const m = /^([a-z0-9]*)((?:\.[\w-]+|\[[^\]]+\])*)$/i.exec(sel);
    if (!m) return false;
    if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    for (const part of m[2].match(/\.[\w-]+|\[[^\]]+\]/g) ?? []) {
      if (part.startsWith(".")) {
        if (!el.classes.includes(part.slice(1))) return false;
        continue;
      }
      const attr = /^\[([^\]=~*^$]+)(?:([~*^$]?=)"?([^"\]]*)"?)?\]$/.exec(part);
      if (!attr) return false;
      const value = el.getAttribute(attr[1]);
      if (value === null) return false;
      if (attr[2] === "=" && value !== attr[3]) return false;
      if (attr[2] === "~=" && !value.split(/\s+/).includes(attr[3])) return false;
    }
    return true;
  });
}

function allElements(doc) {
  return doc ? doc.elements : [];
}

/** opensOn: "click" | "hover" | "none" —— 目标组件只对这一种手势有反应。 */
function dropdownDoc(opensOn) {
  const state = { open: false, picked: "" };
  const win = {
    HTMLElement: FakeHTMLElement,
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    getComputedStyle: (el) => ({
      display: el.visible() ? "block" : "none",
      visibility: "visible",
      opacity: "1",
      overflowY: "visible",
    }),
  };
  const doc = {
    nodeType: 9,
    defaultView: win,
    elements: [],
    log: [],
    state,
    onEvent(el, type) {
      if (el === trigger) {
        if (type === "click" && opensOn === "click") state.open = !state.open;
        if (type === "mouseover" && opensOn === "hover") state.open = true;
        return;
      }
      if (el === item && type === "click") {
        state.picked = el.textContent;
        state.open = false; // antd 选完自动收起
      }
    },
    querySelectorAll(selector) {
      return doc.elements.filter((el) => el !== body && matchesSelector(el, selector));
    },
    querySelector(selector) {
      return doc.querySelectorAll(selector)[0] ?? null;
    },
    getElementById: () => null,
  };

  const make = (tag, opts) => {
    const el = new FakeHTMLElement(tag, opts);
    el.doc = doc;
    doc.elements.push(el);
    return el;
  };
  const body = make("body");
  const trigger = make("button", {
    classes: ["ant-dropdown-trigger"],
    text: "新建工艺卡",
    parent: body,
    attrs: { "aria-haspopup": "menu" },
  });
  const panel = make("div", { classes: ["ant-dropdown"], parent: body });
  panel.visible = () => state.open;
  const item = make("li", { classes: ["ant-dropdown-menu-item"], text: "针刺工艺卡", parent: panel });
  item.visible = () => state.open;
  return doc;
}

function pickerDsl(triggerAction, openMs = 600) {
  return {
    dslVersion: "1.0",
    meta: { name: "dropdown" },
    systems: [{ id: "sys", name: "系统", baseUrl: "http://localhost:3000" }],
    entry: "picker",
    edges: [],
    nodes: [
      {
        id: "picker",
        type: "picker",
        system: "sys",
        name: "选择 新建工艺卡",
        mode: "inline",
        triggerAction,
        trigger: { label: "新建工艺卡", strategies: [{ type: "css", value: ".ant-dropdown-trigger" }] },
        panel: {
          scope: {
            type: "dropdown",
            target: { label: "面板", strategies: [{ type: "css", value: ".ant-dropdown" }] },
          },
          binding: "temporal",
          popupId: null,
        },
        pick: {
          strategy: "byText",
          byText: { value: { kind: "literal", value: "针刺工艺卡" }, match: "exact" },
          multi: false,
          values: [{ role: null, value: "针刺工艺卡" }],
        },
        stageTimeouts: { openMs, pickMs: 400, closeMs: 300 },
        meta: { rule: "antd-dropdown" },
      },
    ],
  };
}

function hostFor(doc) {
  return {
    async navigate() {},
    getDocument: () => doc,
    getUrl: () => "http://localhost:3000/",
  };
}

test("记录说 hover、组件只认 click：换手势后仍然选中", async () => {
  const doc = dropdownDoc("click");
  const result = await runFlow({ dsl: pickerDsl("hover"), host: hostFor(doc) });
  assert.equal(result.status, "finished", result.error);
  assert.equal(result.nodes[0].status, "pass");
  assert.equal(doc.state.picked, "针刺工艺卡");
  assert.ok(doc.log.includes("button.click"), `必须真的补发过点击：${doc.log.join(" ")}`);
});

test("记录说 click、组件只认 hover：换手势后仍然选中", async () => {
  const doc = dropdownDoc("hover");
  const result = await runFlow({ dsl: pickerDsl("click"), host: hostFor(doc) });
  assert.equal(result.status, "finished", result.error);
  assert.equal(result.nodes[0].status, "pass");
  assert.equal(doc.state.picked, "针刺工艺卡");
  assert.ok(doc.log.includes("button.mouseover"), `必须真的补发过悬停：${doc.log.join(" ")}`);
});

test("两种手势都打不开时仍然按超时报错，且手势不会无限重复", async () => {
  const doc = dropdownDoc("none");
  const result = await runFlow({ dsl: pickerDsl("hover", 500), host: hostFor(doc) });
  assert.equal(result.status, "failed");
  assert.match(result.error, /面板未在 500ms 内打开/);
  assert.equal(doc.state.picked, "");
  const clicks = doc.log.filter((entry) => entry === "button.click").length;
  const hovers = doc.log.filter((entry) => entry === "button.mouseover").length;
  assert.ok(clicks <= 2 && hovers <= 2, `手势必须有次数上限：click=${clicks} hover=${hovers}`);
});