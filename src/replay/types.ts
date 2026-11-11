import type { FailureKind, FlowDsl, FlowNode, RetryPolicy } from "../dsl/index.ts";

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

/** 一次节点执行的尝试记录；重试时保留历史，不再覆盖失败结果。 */
export interface StepAttemptRecord {
  attempt: number;
  startedAt: number;
  durationMs: number;
  status: "passed" | "healed" | "failed" | "interrupted";
  message?: string;
  strategy?: string;
  failureKind?: FailureKind;
  /** 定位候选链的命中/可见数量，用于失败归因。 */
  attempts?: ReplayAttempt[];
}

export interface ReplayNodeResult {
  nodeId: string;
  name?: string;
  /** 流程画布节点 id；按操作记录 / 取值节点分组时使用。 */
  groupId?: string;
  status: ReplayNodeStatus;
  message: string;
  strategy?: string;
  durationMs: number;
  /** 该节点全部执行尝试（含失败与中断）。 */
  attempts?: StepAttemptRecord[];
  failureKind?: FailureKind;
  /** 人工继续时是否通过了 expect 校验。 */
  verified?: boolean;
}

export interface ReplayResult {
  status: ReplayStatus;
  nodes: ReplayNodeResult[];
  error?: string;
  durationMs: number;
  /** 运行结束时的环境变量快照。 */
  vars: Record<string, unknown>;
}

export type RunStatus =
  | "idle"
  | "running"
  | "paused"
  | "intervening"
  | "finished"
  | "failed"
  | "canceled";

export interface RunCursor {
  /** 当前（或即将执行的）节点。 */
  nodeId: string;
  /** 已执行完成、将要进入的下一个节点。 */
  nextNodeId?: string;
}

/** 恢复到某节点执行前的运行态，重试时先回滚再执行。 */
export interface RunCheckpoint {
  nodeId: string;
  env: Record<string, unknown>;
  /** 已完成的节点 id；回滚后这些节点可以重新执行。 */
  completed: string[];
  /** 已记录的结果条数。 */
  resultCount: number;
}

export interface InterventionRequest {
  nodeId: string;
  name?: string;
  type: FlowNode["type"];
  message: string;
  failureKind: FailureKind;
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  varName?: string;
  /** 是否已经有副作用（点击/输入已发出），继续前建议人工核对。 */
  mayHaveSideEffect: boolean;
  /** 自动重试已耗尽时，提示用户手动决定。 */
  retryExhausted: boolean;
  attempts: StepAttemptRecord[];
}

export type RunCommand =
  | { action: "pause"; mode?: "after-step" | "immediate" }
  | { action: "resume" }
  | { action: "retry"; scope?: "step" | "group" }
  | {
      action: "continue";
      vars?: Record<string, string>;
      /** 是否重新执行该节点的 expect 校验；默认 true。 */
      verify?: boolean;
    }
  | { action: "skip" }
  | { action: "stop" };

export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  cursor?: RunCursor;
  results: ReplayNodeResult[];
  env: Record<string, unknown>;
  pending?: InterventionRequest;
  totalNodes: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export interface ReplayEventMap {
  "run.started": { totalNodes: number };
  "node.started": { nodeId: string; index: number; name?: string; groupId?: string; attempt: number };
  "node.attempt": { nodeId: string; attempt: StepAttemptRecord };
  "node.finished": { node: ReplayNodeResult };
  "var.set": { nodeId: string; name: string; value: string };
  "run.paused": { nodeId?: string; mode: "after-step" | "immediate" };
  "run.resumed": { nodeId?: string };
  "run.intervening": { request: InterventionRequest };
  "run.snapshot": { snapshot: RunSnapshot };
  "run.finished": {
    status: ReplayStatus;
    durationMs: number;
    passed: number;
    total: number;
    error?: string;
  };
}

export type ReplayEvent = {
  [K in keyof ReplayEventMap]: { type: K } & ReplayEventMap[K];
}[keyof ReplayEventMap];

/** 失败信息与人工决策请求同构：UI 需要看尝试次数与副作用风险。 */
export type NodeFailureInfo = InterventionRequest;

/**
 * 节点失败后的人工决策：
 * - continue：已在目标页手动补全，不重跑，继续下一节点；
 * - retry：重新执行当前节点（恢复检查点后执行）；
 * - retryGroup：重跑当前节点所在的画布分组；
 * - skip：人工跳过，继续下一节点；
 * - stop：中止本次回放。
 */
export type NodeFailureDecision =
  | {
      action: "continue";
      vars?: Record<string, string>;
      /** 是否重新执行该节点的 expect 校验；默认 true。 */
      verify?: boolean;
    }
  | { action: "retry" }
  | { action: "retryGroup" }
  | { action: "skip" }
  | { action: "stop" };

/** 每个节点执行前的钩子；流程运行弹窗用它实现「本步后暂停」。 */
export type BeforeNodeHook = (nodeId: string) => void | Promise<void>;

export interface ReplayOptions {
  dsl: FlowDsl;
  host: ReplayHost;
  /** 按节点 id 覆盖输入值；未提供时使用录制值。 */
  values?: Record<string, unknown>;
  /** 流程环境变量的初始值；取值节点运行时会继续写入。 */
  vars?: Record<string, unknown>;
  /** 每个节点执行前调用；用于在节点边界暂停。 */
  onBeforeNode?: BeforeNodeHook;
  /** 节点失败后调用；不传时保持「失败即中止」的旧行为。 */
  onNodeError?: (info: NodeFailureInfo) => NodeFailureDecision | Promise<NodeFailureDecision>;
  /** 流程级默认重试策略；节点上的 retry 优先。 */
  retry?: RetryPolicy;
  /** 外部中止信号：用于停止整次运行。 */
  signal?: AbortSignal;
  /** 立即暂停：返回 true 时中止当前尝试的等待，进入人工决策。 */
  shouldPause?: () => boolean;
  onEvent?: (event: ReplayEvent) => void;
  /** 运行态变化时回调，供控制器维护快照。 */
  onSnapshot?: (snapshot: RunSnapshot) => void;
}

export class ReplayError extends Error {
  readonly attempts: ReplayAttempt[];
  /** 显式标注失败阶段；未标注时由引擎按执行进度推断。 */
  readonly failureKind?: FailureKind;

  constructor(message: string, attempts: ReplayAttempt[] = [], failureKind?: FailureKind) {
    super(message);
    this.name = "ReplayError";
    this.attempts = attempts;
    this.failureKind = failureKind;
  }
}
