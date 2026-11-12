import test from "node:test";
import assert from "node:assert/strict";

import { clickTargetFor } from "../src/recorder/dom-recorder.ts";

/** 最小 DOM 桩：clickTargetFor 只依赖 closest / tagName / getAttribute。 */
function makeDoc() {
  const doc = {
    body: null,
    documentElement: null,
    defaultView: {
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
        cursor: "auto",
      }),
    },
  };
  const html = element("html", doc);
  const body = element("body", doc);
  body.parentElement = html;
  doc.documentElement = html;
  doc.body = body;
  return doc;
}

function element(tag, doc, { attrs = {}, actionable = false } = {}) {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    ownerDocument: doc,
    parentElement: null,
    actionable,
    attrs,
    isContentEditable: false,
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    hasAttribute(name) {
      return name in this.attrs;
    },
    closest(selector) {
      let node = this;
      while (node) {
        if (selector === "svg") {
          if (node.tagName.toLowerCase() === "svg") return node;
        } else if (node.actionable) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    matches() {
      return false;
    },
  };
}

function fixture() {
  const doc = makeDoc();
  const div = element("div", doc);
  div.parentElement = doc.body;
  const span = element("span", doc);
  span.parentElement = div;
  const input = element("input", doc, { attrs: { type: "text" }, actionable: true });
  input.parentElement = doc.body;
  const button = element("button", doc, { actionable: true });
  button.parentElement = doc.body;
  return { doc, div, span, input, button };
}

test("没有语义祖先的自定义 div 点击也会被记录", () => {
  const { div } = fixture();
  assert.equal(clickTargetFor(div, null), div);
});

test("嵌套 span 落点记录实际被点的元素", () => {
  const { span } = fixture();
  assert.equal(clickTargetFor(span, null), span);
});

test("纯输入控件不生成点击步骤，旁边的 div 仍会记录", () => {
  const { div, input } = fixture();
  assert.equal(clickTargetFor(input, null), null);
  // 正例：同一个断言在同一用例里能失败，证明它确实在约束返回值。
  assert.equal(clickTargetFor(div, null), div);
});

test("原生 button 仍按语义元素记录", () => {
  const { button } = fixture();
  assert.equal(clickTargetFor(button, null), button);
});

test("页面根节点落点不记录", () => {
  const { doc } = fixture();
  assert.equal(clickTargetFor(doc.body, null), null);
  assert.equal(clickTargetFor(doc.documentElement, null), null);
});

test("规则命中的表格行优先返回整行", () => {
  const { div } = fixture();
  const row = element("tr", div.ownerDocument);
  const match = {
    rule: { id: "antd-modal" },
    zone: "row",
    selector: "tr.ant-table-row[data-row-key]",
    detection: "class",
    element: row,
  };
  assert.equal(clickTargetFor(div, match), row);
});
