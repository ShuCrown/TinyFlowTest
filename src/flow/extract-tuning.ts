import type { ExtractTuning } from "../lib/types.ts";

/** values[nodeId] 里的取值覆盖来自微调面板；形状不对就当没改。 */
export function readExtractTuning(value: unknown): ExtractTuning | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const tuning: ExtractTuning = {};
  if (record.read === "text" || record.read === "value" || record.read === "attribute") {
    tuning.read = record.read;
  }
  if (typeof record.attribute === "string") tuning.attribute = record.attribute;
  if (typeof record.pattern === "string") tuning.pattern = record.pattern;
  if (typeof record.js === "string") tuning.js = record.js;
  const cell = record.cell;
  if (cell && typeof cell === "object" && !Array.isArray(cell)) {
    const item = cell as Record<string, unknown>;
    if (item.mode === "rowIndex" && typeof item.rowIndex === "number") {
      tuning.cell = { mode: "rowIndex", rowIndex: item.rowIndex };
    } else if (item.mode === "rowText" && typeof item.rowText === "string") {
      tuning.cell = { mode: "rowText", rowText: item.rowText };
    } else if (item.mode === "rowValue" && typeof item.rowValue === "string") {
      tuning.cell = { mode: "rowValue", rowValue: item.rowValue };
    }
  }
  const response = record.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const item = response as Record<string, unknown>;
    tuning.response = {
      ...(typeof item.urlContains === "string" ? { urlContains: item.urlContains } : {}),
      ...(typeof item.bodyContains === "string" ? { bodyContains: item.bodyContains } : {}),
      ...(typeof item.path === "string" ? { path: item.path } : {}),
    };
  }
  return Object.keys(tuning).length > 0 ? tuning : null;
}
