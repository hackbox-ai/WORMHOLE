/**
 * B05 Task life cycle and allowed state transitions。
 * Task observable state：created/running/paused/done/failed/timeout；paused Projection by independent boolean bits。
 * Intent：open/running/blocked/exhausted/stopped/done/failed。
 */
export type TaskStatus = "created" | "running" | "paused" | "done" | "failed" | "timeout";
export type IntentStatus =
  | "open"
  | "running"
  | "blocked"
  | "exhausted"
  | "stopped"
  | "done"
  | "failed";

/** WORMHOLE Observable transfer: from → Arrival allowed */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  created: ["running", "paused", "done", "failed"], // Failed to create/Second completion is also legal（launchTask Failed path）
  running: ["paused", "done", "failed", "timeout"],
  paused: ["running", "done", "failed", "timeout"], // Resume or pause state final (timeout still takes effect）
  done: [],
  failed: ["running"], // rerun（Single and batch rerun）
  timeout: ["running"], // rerun
};

export const INTENT_TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  open: ["running", "stopped", "blocked", "exhausted"],
  running: ["open", "done", "failed", "blocked", "exhausted", "stopped"],
  blocked: ["open", "stopped"],
  exhausted: ["open", "stopped"],
  stopped: [],
  done: [],
  failed: ["open", "stopped"], // model_error Retry: Failure open（attempts Count）
};

export class TransitionError extends Error {
  constructor(
    public readonly entity: "task" | "intent",
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`${entity} Not allowed ${from} → ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].includes(to)) throw new TransitionError("task", from, to);
}

export function assertIntentTransition(from: IntentStatus, to: IntentStatus): void {
  if (!INTENT_TRANSITIONS[from].includes(to)) throw new TransitionError("intent", from, to);
}

/** WORMHOLE normalizeHeartbeat：Application layer lower limit 600 seconds（schema Default 300 Only DDL Convenience value） */
export function normalizeHeartbeat(seconds: number | undefined | null): number {
  const n = Number(seconds ?? 600);
  if (!Number.isFinite(n) || n <= 0) return 600;
  return Math.max(600,n);
}
