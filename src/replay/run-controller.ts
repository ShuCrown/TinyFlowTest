import { runFlow } from "./engine.ts";
import type {
  InterventionRequest,
  NodeFailureDecision,
  ReplayEvent,
  ReplayOptions,
  ReplayResult,
  RunCommand,
  RunSnapshot,
  RunStatus,
} from "./types.ts";

export interface RunControllerOptions extends Omit<
  ReplayOptions,
  "onBeforeNode" | "onNodeError" | "onEvent" | "onSnapshot" | "shouldPause"
> {
  onEvent?: (event: ReplayEvent) => void;
  onSnapshot?: (snapshot: RunSnapshot) => void;
}

/**
 * 运行控制器：把「暂停 / 继续 / 重试单步 / 重试分组 / 人工补全 / 跳过 / 停止」
 * 收敛成命令队列，引擎只负责执行节点，UI 只发命令和读快照。
 *
 * 立即暂停靠中止当前尝试实现，暂停后必须由人工给出决策；
 * 执行完当前步暂停则只阻塞在节点边界，不会打断已经发出的动作。
 */
export class RunController {
  private readonly options: RunControllerOptions;
  private status: RunStatus = "idle";
  private snapshot: RunSnapshot;
  private pending?: InterventionRequest;
  private pauseImmediate = false;
  private pauseAfterStep = false;
  private resumeWaiter: (() => void) | null = null;
  private decisionWaiter: ((decision: NodeFailureDecision) => void) | null = null;
  private abort = new AbortController();
  private result: ReplayResult | null = null;
  private started = false;
  private listeners = new Set<(snapshot: RunSnapshot) => void>();

  constructor(options: RunControllerOptions) {
    this.options = options;
    this.snapshot = {
      runId: `run-${Date.now()}`,
      status: "idle",
      results: [],
      env: {},
      totalNodes: options.dsl.nodes.length,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  getSnapshot(): RunSnapshot {
    return this.snapshot;
  }

  getResult(): ReplayResult | null {
    return this.result;
  }

  subscribe(listener: (snapshot: RunSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 启动一次运行；同一实例只运行一次，复用请新建实例。 */
  async start(): Promise<ReplayResult> {
    if (this.started) throw new Error("RunController 只能启动一次，请新建实例");
    this.started = true;
    this.setStatus("running");
    try {
      const result = await runFlow({
        ...this.options,
        signal: this.abort.signal,
        shouldPause: () => this.pauseImmediate,
        onBeforeNode: async (nodeId) => {
          // 暂停发生在节点边界，不打断已发出的动作。
          if (!this.pauseAfterStep) return;
          this.pauseAfterStep = false;
          this.emit({ type: "run.paused", nodeId, mode: "after-step" });
          this.setStatus("paused");
          await new Promise<void>((resolve) => {
            this.resumeWaiter = resolve;
          });
          this.resumeWaiter = null;
          this.emit({ type: "run.resumed", nodeId });
          this.setStatus("running");
        },
        onNodeError: async (info) => {
          const interrupted = info.failureKind === "interrupted";
          this.pending = info;
          this.setStatus(interrupted ? "paused" : "intervening");
          const decision = await new Promise<NodeFailureDecision>((resolve) => {
            this.decisionWaiter = resolve;
          });
          this.decisionWaiter = null;
          this.pending = undefined;
          this.pauseImmediate = false;
          this.setStatus("running");
          return decision;
        },
        onEvent: (event) => {
          if (event.type === "run.finished") {
            this.setStatus(
              event.status === "finished"
                ? "finished"
                : event.status === "canceled"
                  ? "canceled"
                  : "failed",
            );
          }
          this.options.onEvent?.(event);
        },
        onSnapshot: (snapshot) => {
          this.snapshot = { ...snapshot, status: this.status, pending: this.pending };
          this.notify();
        },
      });
      this.result = result;
      return result;
    } catch (error) {
      this.setStatus("failed");
      throw error;
    }
  }

  /** 下发干预命令；与当前状态不匹配的命令会被忽略。 */
  send(command: RunCommand): void {
    switch (command.action) {
      case "pause":
        this.pause(command.mode ?? "after-step");
        return;
      case "resume":
        this.resume();
        return;
      case "retry":
        this.decide({ action: command.scope === "group" ? "retryGroup" : "retry" });
        return;
      case "continue":
        this.decide({ action: "continue", vars: command.vars, verify: command.verify });
        return;
      case "skip":
        this.decide({ action: "skip" });
        return;
      case "stop":
        this.stop();
        return;
    }
  }

  pause(mode: "after-step" | "immediate" = "after-step"): void {
    if (this.status !== "running") return;
    if (mode === "immediate") {
      // 立即暂停：让引擎中止当前尝试，进人工决策；恢复时默认重跑该节点。
      this.pauseImmediate = true;
      this.setStatus("paused");
      return;
    }
    this.pauseAfterStep = true;
  }

  resume(): void {
    if (this.resumeWaiter) {
      this.resumeWaiter();
      return;
    }
    if (this.status !== "paused" || !this.pending) return;
    this.pauseImmediate = false;
    const pending = this.pending;
    this.pending = undefined;
    this.decide(
      pending.failureKind === "interrupted"
        ? { action: "retry" }
        : { action: "continue", verify: true },
    );
  }

  /** 中止整次运行；与暂停不同，停止后不能再继续。 */
  stop(): void {
    if (this.decisionWaiter) {
      const resolve = this.decisionWaiter;
      this.decisionWaiter = null;
      resolve({ action: "stop" });
    }
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    this.abort.abort();
  }

  private decide(decision: NodeFailureDecision): void {
    const resolve = this.decisionWaiter;
    if (!resolve) return;
    this.decisionWaiter = null;
    resolve(decision);
  }

  private emit(event: ReplayEvent): void {
    this.options.onEvent?.(event);
  }

  private setStatus(status: RunStatus): void {
    this.status = status;
    this.snapshot = {
      ...this.snapshot,
      status,
      pending: this.pending,
      updatedAt: Date.now(),
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
    this.options.onSnapshot?.(this.snapshot);
  }
}
