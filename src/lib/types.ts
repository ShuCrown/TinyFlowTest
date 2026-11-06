import type { CellRef, FlowDsl } from "../dsl/index.ts";
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
  /** 回放前微调值，按 nodeId 存；picker 使用 { picks, filters }。 */
  values?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FlowRecordNode {
  id: string;
  kind: "record";
  recordId: string;
  enabled?: boolean;
  x: number;
  y: number;
}

export type ExtractRead = "text" | "value" | "attribute";

/** 取值来源：页面 DOM / 接口响应 / 页面 JS 表达式。 */
export type ExtractSourceKind = "dom" | "response" | "js";

export interface ExtractResponseConfig {
  /** 不填表示任意方法。 */
  method?: string;
  urlContains: string;
  bodyContains?: string;
  /** JSON 路径；留空表示整段响应文本。 */
  path?: string;
}

export interface FlowExtractNode {
  id: string;
  kind: "extract";
  varName: string;
  /** 缺省 dom。 */
  source?: ExtractSourceKind;
  read: ExtractRead;
  /** read=attribute 时读取的属性名。 */
  attribute?: string;
  /** 可选清洗正则，捕获组优先。 */
  pattern?: string;
  /** DOM 来源：v1 用 CSS 选择器定位当前页面的编号元素。 */
  selector: string;
  /** DOM 来源的定位方式；缺省 css。 */
  locate?: "css" | "cell";
  /** locate=cell 时的表格地址；行值支持 {{变量名}}。 */
  cell?: CellRef;
  /** 目标不可见时仍读取（隐藏输入、JSON script 等）。 */
  includeHidden?: boolean;
  /** source=response 时的接口匹配与取值配置。 */
  response?: ExtractResponseConfig;
  /** source=js 时在目标页上下文执行的表达式。 */
  js?: string;
  enabled?: boolean;
  x: number;
  y: number;
}

export type FlowCanvasNode = FlowRecordNode | FlowExtractNode;

export interface FlowEdge {
  from: string;
  to: string;
}

export type FlowSlot = "input" | "filter";

/** 流程内对操作记录某个微调槽位的值注入。 */
export interface FlowInjection {
  id: string;
  recordNodeId: string;
  dslNodeId: string;
  slot: FlowSlot;
  /** picker 筛选步骤的下标；input 槽位忽略。 */
  index?: number;
  source:
    | { kind: "literal"; value: string }
    | { kind: "var"; name: string };
}

export interface FlowEnvVar {
  name: string;
  value?: string;
  note?: string;
}

export interface FlowGraph {
  nodes: FlowCanvasNode[];
  edges: FlowEdge[];
  injections: FlowInjection[];
  vars: FlowEnvVar[];
}

export interface FlowItem {
  id: string;
  name: string;
  description?: string;
  recordCount: number;
  status: "draft" | "ready";
  graph?: FlowGraph;
  createdAt: string;
  updatedAt: string;
}
