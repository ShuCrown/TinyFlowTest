import type { ExtractNode, FlowDsl, SystemConfig } from "../dsl/index.ts";
import {
  importChromeRecorder,
  type ChromeRecorderStep,
} from "../recorder/chrome-recorder.ts";

export interface ExtractRecordingStep {
  id: string;
  varName: string;
  label: string;
  summary: string;
}

export interface ExtractRecordingApplied {
  systemId: string;
  /** 完整录制流程：操作步骤与所有取值步骤按录制顺序保留。 */
  recordedDsl: FlowDsl;
  extracts: ExtractRecordingStep[];
  /** 非取值步骤的数量，用于节点摘要。 */
  preStepCount: number;
}

/**
 * 录制结果 → 取值节点配置。
 * 每次「录制取值」都会成为一个变量，操作和取值按原顺序保留。
 */
export function buildExtractRecording(
  steps: ChromeRecorderStep[],
  system: SystemConfig,
): { value: ExtractRecordingApplied | null; error: string } {
  if (!steps.some((step) => step.type === "extract")) {
    return { value: null, error: "还没有取值目标：请点「录制取值」后再点要读取的字段。" };
  }
  const converted = importChromeRecorder({
    recording: { title: "取值录制", steps },
    system,
  });
  const extracts = converted.dsl.nodes
    .filter((node): node is ExtractNode => node.type === "extract")
    .map((node) => ({
      id: node.id,
      varName: node.varName,
      label:
        node.source === "response" || node.source === "js" || node.source === "const"
          ? (node.name ?? node.varName)
          : (node.target.label ?? node.name ?? node.varName),
      summary: describeExtractNode(node),
    }));
  if (extracts.length === 0) {
    return { value: null, error: "取值步骤转换失败，请重新录制一次。" };
  }
  return {
    value: {
      systemId: system.id,
      recordedDsl: converted.dsl,
      extracts,
      preStepCount: converted.dsl.nodes.length - extracts.length,
    },
    error: "",
  };
}

export function describeExtractNode(node: ExtractNode): string {
  if (node.source === "const") {
    return `手动 · ${node.value || "空值"}`;
  }
  if (node.source === "response") {
    return `接口 · ${node.response.urlContains || "未设置 URL"}`;
  }
  if (node.source === "js") {
    return `JS · ${node.js?.trim().slice(0, 48) || "未设置表达式"}`;
  }
  const cell = node.target.strategies.find((strategy) => strategy.type === "cell");
  if (cell?.type === "cell") {
    const row = cell.cell.rowValue || cell.cell.rowText || "未设置行";
    const column =
      cell.cell.header || (cell.cell.colIndex ? `第${cell.cell.colIndex}列` : "未设置列");
    return `表格 · ${row} / ${column}`;
  }
  const css = node.target.strategies.find((strategy) => strategy.type === "css");
  const label = node.target.label?.trim();
  return `${node.read} · ${label || (css?.type === "css" ? css.value : "未设置选择器")}`;
}
