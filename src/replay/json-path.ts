/**
 * 最小 JSON 路径：data.customer.code、data.items[0].id；
 * `$` 前缀可选，留空表示根节点。不支持过滤表达式。
 */
export function pickJsonPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const token of tokenize(path)) {
    if (current === null || current === undefined) return undefined;
    if (typeof token === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/** 变量统一用字符串：标量原样，对象/数组转 JSON 文本。 */
export function jsonValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 报错提示：列出当前层可用的键，便于修正路径。 */
export function describeJsonKeys(value: unknown): string {
  if (Array.isArray(value)) return `数组(${value.length})`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "空对象";
    return keys.slice(0, 8).join("、") + (keys.length > 8 ? "…" : "");
  }
  return typeof value;
}

function tokenize(path: string): Array<string | number> {
  const clean = path.trim().replace(/^\$\.?/, "");
  if (!clean) return [];
  const tokens: Array<string | number> = [];
  for (const part of clean.split(".")) {
    if (!part) continue;
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) return [];
    if (match[1]) tokens.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
      tokens.push(Number(index[1]));
    }
  }
  return tokens;
}
