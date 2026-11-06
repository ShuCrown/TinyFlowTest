import test from "node:test";
import assert from "node:assert/strict";

import {
  describeJsonKeys,
  jsonValueText,
  pickJsonPath,
} from "../src/replay/json-path.ts";

const body = {
  data: {
    customer: { code: "C-9", region: "华东" },
    items: [
      { id: 1, name: "甲" },
      { id: 2, name: "乙" },
    ],
  },
};

test("按点号读取嵌套字段，$ 前缀可选", () => {
  assert.equal(pickJsonPath(body, "data.customer.code"), "C-9");
  assert.equal(pickJsonPath(body, "$.data.customer.code"), "C-9");
  assert.equal(pickJsonPath(body, "$"), body);
});

test("支持数组下标与后续字段", () => {
  assert.equal(pickJsonPath(body, "data.items[1].name"), "乙");
  assert.deepEqual(pickJsonPath(body, "data.items[0]"), { id: 1, name: "甲" });
});

test("路径不存在或类型不匹配时返回 undefined", () => {
  assert.equal(pickJsonPath(body, "data.customer.missing"), undefined);
  assert.equal(pickJsonPath(body, "data.items.name"), undefined);
  assert.equal(pickJsonPath(body, "data.customer.code[0]"), undefined);
  assert.equal(pickJsonPath(undefined, "a.b"), undefined);
});

test("变量值统一转字符串，对象转 JSON 文本", () => {
  assert.equal(jsonValueText("C-9"), "C-9");
  assert.equal(jsonValueText(42), "42");
  assert.equal(jsonValueText(false), "false");
  assert.equal(jsonValueText(null), "");
  assert.equal(jsonValueText({ a: 1 }), '{"a":1}');
});

test("错误提示列出可用键", () => {
  assert.equal(describeJsonKeys({ a: 1, b: 2 }), "a、b");
  assert.equal(describeJsonKeys([1, 2]), "数组(2)");
});
