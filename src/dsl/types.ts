/**
 * Flow DSL 的最小类型子集。
 *
 * 只保留「录制步骤 → 流程」演示需要的节点与信号；
 * 完整契约见 FlowTest/packages/dsl/src/schema.ts。
 */

export const PRESET_NAMES = [
  "page-ready",
  "content-stable",
  "list-ready",
  "dialog-ready",
  "option-ready",
  "save-ready",
] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** 表格单元格里的控件：self 表示点击单元格本身（进入编辑态）。 */
export type CellControl = "self" | "input" | "textarea" | "select" | "contenteditable";

/**
 * 单元格地址。行标识优先用「表内取值唯一的列」（没有 data-row-key 时），
 * 列标识优先用表头文本，其次才是列序号。
 */
export interface CellRef {
  /** 表格的 id / aria-label，可选；没有时在全部表格里找。 */
  table?: string;
  /** 行标识列的值。 */
  rowValue?: string;
  /** 行标识列的表头；重名时退回 keyIndex。 */
  keyHeader?: string;
  /** 行标识列的序号（1 基）。 */
  keyIndex?: number;
  /** 没有唯一列时的兜底：整行文本。 */
  rowText?: string;
  /** 目标列的表头；重名时退回 colIndex。 */
  header?: string;
  /** 目标列的序号（1 基，按 cellIndex）。 */
  colIndex?: number;
  control?: CellControl;
}

export type Strategy =
  | { type: "testid"; value: string }
  | { type: "cell"; cell: CellRef }
  | { type: "role"; role: string; name?: string; exact?: boolean }
  | { type: "label"; value: string; exact?: boolean }
  | { type: "placeholder"; value: string }
  | { type: "text"; value: string; exact?: boolean }
  | { type: "name"; value: string }
  | { type: "css"; value: string }
  | { type: "xpath"; value: string };

export type TargetFingerprint = {
  tag?: string;
  role?: string;
  visibleText?: string;
  anchorText?: string;
  testid?: string;
  name?: string;
  placeholder?: string;
};

export interface TargetRef {
  label?: string;
  strategies: Strategy[];
  fingerprint?: TargetFingerprint;
  strict?: boolean;
  nth?: number;
  scope?: TargetRef;
  frame?: { urlContains?: string } | { name?: string };
}

export type ValueExpr =
  | { kind: "literal"; value: unknown }
  | { kind: "var"; name: string }
  | { kind: "template"; template: string }
  | { kind: "dataset"; column: string };

/** 输入允许普通标量；normalize 后统一为 ValueExpr。 */
export type ValueLike = ValueExpr | string | number | boolean | null | unknown[] | { gen: string };

export interface WaitBase {
  timeoutMs?: number;
  optional?: boolean;
}

export type WaitSignal =
  | (WaitBase & {
      kind: "visible" | "hidden" | "attached" | "enabled";
      target: TargetRef;
    })
  | (WaitBase & {
      kind: "count";
      target: TargetRef;
      min?: number;
      max?: number;
      equals?: number;
      stableMs?: number;
    })
  | (WaitBase & {
      kind: "text";
      target: TargetRef;
      equals?: ValueLike;
      contains?: string;
    })
  | (WaitBase & { kind: "url"; matches: string })
  | (WaitBase & { kind: "domStable"; target?: TargetRef; quietMs?: number; maxMs?: number });

export type SignalRef = WaitSignal | PresetName;

export interface SystemConfig {
  id: string;
  name: string;
  baseUrl: string;
  auth?:
    | { kind: "none" }
    | { kind: "storageState"; path?: string; env?: string }
    | { kind: "login"; env?: string };
  allowedOrigins?: string[];
}

export interface FlowMeta {
  name: string;
  description?: string;
  tags?: string[];
}

export interface NodeMeta {
  sourceText?: string;
  needsConfirm?: boolean;
  notes?: string;
  [key: string]: unknown;
}

export interface NodeBase {
  id: string;
  type: string;
  name?: string;
  system?: string;
  enabled?: boolean;
  timeoutMs?: number;
  pre?: SignalRef[];
  expect?: SignalRef[];
  meta?: NodeMeta;
}

export interface NavigateNode extends NodeBase {
  type: "navigate";
  system: string;
  url: string;
  waitUntil?: "commit" | "domcontentloaded" | "load";
  readySignal?: SignalRef;
}

export type InteractAdapter =
  | "input"
  | "click"
  | "check"
  | "select"
  | "press"
  | "upload"
  | "hover"
  | "nativeSelect";

export interface InteractNode extends NodeBase {
  type: "interact";
  system: string;
  adapter: InteractAdapter;
  target: TargetRef;
  value?: ValueLike;
  checked?: boolean;
  key?: string;
  /** 输入完成后失焦提交（单元格编辑常见）。 */
  blurAfter?: boolean;
  verify?: "readBack" | "none";
}

export interface WaitNode extends NodeBase {
  type: "wait";
  condition: SignalRef;
  message?: string;
}

/** 复合选择器：一次意图 = 打开面板 + 可选筛选 + 选项/行 + 可选提交。 */
export type PickerMode = "inline" | "dialog";

export interface PickerPanel {
  scope: { type: "dropdown" | "dialog"; name?: string; target?: TargetRef };
  /** 扩展：绑定档位。contract = aria 契约，structural = 结构，temporal = 时序，dialog = 弹窗。 */
  binding?: "contract" | "structural" | "temporal" | "dialog";
  /** 扩展：录制时 aria-controls 指向的 id（antd 指向 0x0 镜像，仅作线索）。 */
  popupId?: string | null;
}

export interface PickerFilterStep {
  adapter: "input" | "click" | "check" | "nativeSelect";
  target: TargetRef;
  value?: ValueLike;
  checked?: boolean;
}

export interface PickerPickValue {
  role?: string | null;
  value?: string;
  /** 录制时该选项在可见列表中的位置（1 基）；外部 JSON 没有。 */
  index?: number;
  /** 录制时选项所在的列序号（1 基）；级联靠它回点已展开面板里的父级项。 */
  column?: number;
}

export interface PickerPick {
  strategy: "byText" | "byRow" | "byIndex";
  /** 按值逐个点击。级联的多级路径也放在这里；multi 只表示多选，不表示路径。 */
  byText?: { value?: ValueLike; match?: "exact" | "contains" };
  byRow?: { keyColumn?: string; keyValue?: ValueLike; clickTarget?: TargetRef };
  /**
   * 按位置选择。on 记录原来的目标类型，切回文本/行时据此还原；
   * indexes 与 values 一一对应，按点击顺序排列。
   */
  byIndex?: { indexes: number[]; on?: "item" | "row" };
  multi?: boolean;
  /** 扩展：录制到的每个选项，顺序与点击顺序一致。 */
  values?: PickerPickValue[];
}

export interface PickerNode extends NodeBase {
  type: "picker";
  system: string;
  mode: PickerMode;
  trigger: TargetRef;
  /** 扩展：FlowTest 隐含 click，这里显式记录（hover 菜单需要）。 */
  triggerAction?: "click" | "hover";
  panel: PickerPanel;
  filter?: { steps: PickerFilterStep[] };
  pick: PickerPick;
  commit?: { adapter: "click"; target: TargetRef; waitHidden?: boolean };
  stageTimeouts?: { openMs?: number; filterMs?: number; pickMs?: number; closeMs?: number };
}

export type FlowNode = NavigateNode | InteractNode | PickerNode | WaitNode;

export interface FlowEdge {
  from: string;
  to: string;
  when?: "then" | "else";
}

export interface FlowDefaults {
  nodeTimeoutMs?: number;
  pickerTimeoutMs?: number;
  screenshot?: "onFailure" | "always" | "never";
  resourcePolicy?: "balanced" | "fast" | "accurate";
  trace?: boolean;
}

export interface FlowDsl {
  dslVersion: "1.0";
  meta: FlowMeta;
  systems: SystemConfig[];
  defaults?: FlowDefaults;
  vars?: Record<string, ValueLike>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  entry: string;
}
