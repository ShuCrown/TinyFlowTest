import test from "node:test";
import assert from "node:assert/strict";

import { PANEL_RULES } from "../src/dsl/panel-rules.ts";
import { pickScopes } from "../src/replay/panel.ts";

const cascader = PANEL_RULES.find((rule) => rule.id === "antd-cascader");
const select = PANEL_RULES.find((rule) => rule.id === "antd-select");

function fakeElement() {
  return {
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      },
    },
    getClientRects: () => [{ width: 10, height: 10 }],
  };
}

function fakePanel(columns) {
  return {
    querySelectorAll: (selector) => (selector === ".ant-cascader-menu" ? columns : []),
  };
}

test("known column stays on that column even when later columns are open", () => {
  const first = fakeElement();
  const second = fakeElement();
  const panel = fakePanel([first, second]);
  assert.deepEqual(pickScopes(panel, cascader, 1), [first]);
  assert.deepEqual(pickScopes(panel, cascader, 2), [second]);
});

test("a recorded column that is not rendered yet yields no scope", () => {
  const panel = fakePanel([fakeElement()]);
  assert.deepEqual(pickScopes(panel, cascader, 2), []);
});

test("legacy recording without a column falls back from the deepest column", () => {
  const first = fakeElement();
  const second = fakeElement();
  const panel = fakePanel([first, second]);
  assert.deepEqual(pickScopes(panel, cascader), [second, first]);
});

test("non-cascader panels keep a single scope", () => {
  const panel = fakeElement();
  assert.deepEqual(pickScopes(panel, select), [panel]);
});
