import type { FlowDsl } from "../dsl/index.ts";
import type { ChromeRecorderRecording, RecordingImportReport } from "../recorder/chrome-recorder.ts";

export interface TargetSystem {
  id: string;
  name: string;
  baseUrl: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OperationRecord {
  id: string;
  name: string;
  systemId: string;
  targetUrl: string;
  description?: string;
  steps: number;
  nodes: number;
  status: "draft" | "ready";
  /** 页面内直接录制得到的原始步骤，保留下来便于重新打开或重新录制。 */
  recording?: ChromeRecorderRecording;
  /** 录制步骤转换后的 DSL 与统计报告。 */
  dsl?: FlowDsl;
  report?: RecordingImportReport;
  createdAt: string;
  updatedAt: string;
}

export interface FlowItem {
  id: string;
  name: string;
  description?: string;
  recordCount: number;
  status: "draft" | "ready";
  createdAt: string;
  updatedAt: string;
}
