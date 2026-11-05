import type { FlowDsl } from "../dsl/index.ts";

/** 回放宿主：浏览器演示用同源 iframe，后续可替换成 Playwright 适配器。 */
export interface ReplayHost {
  navigate(url: string, timeoutMs: number): Promise<void>;
  getDocument(): Document;
  getUrl(): string;
}

export type ReplayStatus = "finished" | "failed" | "canceled";
export type ReplayNodeStatus = "pass" | "healed" | "fail" | "skipped";

export interface ReplayNodeResult {
  nodeId: string;
  name?: string;
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
  | { type: "node.started"; nodeId: string; index: number; name?: string }
  | { type: "node.finished"; node: ReplayNodeResult }
  | {
      type: "run.finished";
      status: ReplayStatus;
      durationMs: number;
      passed: number;
      total: number;
      error?: string;
    };

export interface ReplayOptions {
  dsl: FlowDsl;
  host: ReplayHost;
  /** 按节点 id 覆盖输入值；未提供时使用录制值。 */
  values?: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent?: (event: ReplayEvent) => void;
}

export interface ReplayResult {
  status: ReplayStatus;
  nodes: ReplayNodeResult[];
  error?: string;
  durationMs: number;
}

export class ReplayError extends Error {
  readonly attempts: ReplayAttempt[];

  constructor(message: string, attempts: ReplayAttempt[] = []) {
    super(message);
    this.name = "ReplayError";
    this.attempts = attempts;
  }
}
