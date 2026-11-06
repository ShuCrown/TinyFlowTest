import type { FlowDsl, FlowNode } from "../dsl/index.ts";

/** 回放宿主：浏览器演示用同源 iframe，后续可替换成 Playwright 适配器。 */
export interface ReplayHost {
  navigate(url: string, timeoutMs: number): Promise<void>;
  getDocument(): Document;
  getUrl(): string;
  /** 开始观察目标页网络；不实现时接口取值节点会给出明确错误。 */
  startNetworkCapture?(): void;
  /** 等待最近一次（或下一条）匹配的接口响应。 */
  waitForResponse?(
    matcher: ResponseMatcher,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CapturedHttpResponse>;
  /** 在目标页上下文求值；不支持时 JS 取值节点会失败。 */
  evaluate?<T = unknown>(expression: string): T | Promise<T>;
}

export interface ResponseMatcher {
  /** 不填表示任意方法。 */
  method?: string;
  urlContains: string;
  bodyContains?: string;
}

export interface CapturedHttpResponse {
  method: string;
  url: string;
  status: number;
  responseBody: string;
  requestBody?: string;
  contentType?: string;
  capturedAt: number;
}

export type ReplayStatus = "finished" | "failed" | "canceled";
/** manual：节点执行失败后由人工在目标页补全，未重新执行。 */
export type ReplayNodeStatus = "pass" | "healed" | "manual" | "fail" | "skipped";

export interface ReplayNodeResult {
  nodeId: string;
  name?: string;
  /** 流程画布节点 id；按操作记录 / 取值节点分组时使用。 */
  groupId?: string;
  status: ReplayNodeStatus;
  message: string;
  strategy?: string;
  durationMs: number;
}

export interface ReplayAttempt {
  strategy: string;
  count: number;
  visibleCount: number;
}

export type ReplayEvent =
  | { type: "run.started"; totalNodes: number }
  | { type: "node.started"; nodeId: string; index: number; name?: string; groupId?: string }
  | { type: "node.finished"; node: ReplayNodeResult }
  | { type: "var.set"; nodeId: string; name: string; value: string }
  | {
      type: "run.finished";
      status: ReplayStatus;
      durationMs: number;
      passed: number;
      total: number;
      error?: string;
    };

export interface NodeFailureInfo {
  nodeId: string;
  name?: string;
  type: FlowNode["type"];
  message: string;
  /** 第几次执行该节点，1 表示首次。 */
  attempt: number;
  durationMs: number;
  /** 取值节点失败时，人工补写变量的输入框用它做标签。 */
  varName?: string;
}

/**
 * 节点失败后的人工决策：
 * - continue：已在目标页手动补全，不重跑，继续下一节点；
 * - retry：重新执行当前节点；
 * - skip：人工跳过，继续下一节点；
 * - stop：中止本次回放。
 */
export type NodeFailureDecision =
  | { action: "continue"; vars?: Record<string, string> }
  | { action: "retry" }
  | { action: "skip" }
  | { action: "stop" };

export interface ReplayOptions {
  dsl: FlowDsl;
  host: ReplayHost;
  /** 按节点 id 覆盖输入值；未提供时使用录制值。 */
  values?: Record<string, unknown>;
  /** 流程环境变量的初始值；取值节点运行时会继续写入。 */
  vars?: Record<string, unknown>;
  /** 每个节点执行前调用；流程运行弹窗用它实现暂停/继续。 */
  onBeforeNode?: (nodeId: string) => void | Promise<void>;
  /** 节点失败后调用；不传时保持「失败即中止」的旧行为。 */
  onNodeError?: (info: NodeFailureInfo) => NodeFailureDecision | Promise<NodeFailureDecision>;
  signal?: AbortSignal;
  onEvent?: (event: ReplayEvent) => void;
}

export interface ReplayResult {
  status: ReplayStatus;
  nodes: ReplayNodeResult[];
  error?: string;
  durationMs: number;
  /** 运行结束时的环境变量快照。 */
  vars: Record<string, unknown>;
}

export class ReplayError extends Error {
  readonly attempts: ReplayAttempt[];

  constructor(message: string, attempts: ReplayAttempt[] = []) {
    super(message);
    this.name = "ReplayError";
    this.attempts = attempts;
  }
}
