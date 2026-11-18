"use client";

import * as React from "react";
import type { Task } from "@/lib/types";

export function TaskProgressStatus({ task }: { task: Task }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (["done", "failed", "timeout"].includes(task.status)) return null;
  const paused = task.paused || task.status === "paused",
    queued = task.queued,
    waiting = task.progress?.phase === "planning_retry_wait";
  const message = paused
    ? "Task paused"
    : queued
      ? "The task has been accepted and is waiting for execution conditions"
      : task.progress?.message || "The task has been started and is being prepared for execution";
  const updated = task.progress?.updated_at ? new Date(task.progress.updated_at).getTime() : NaN;
  const elapsed = Number.isFinite(updated) ? Math.max(0, Math.floor((now - updated) / 1000)) : 0;
  const nextAttempt = task.progress?.next_attempt_at ? new Date(task.progress.next_attempt_at).getTime() : NaN;
  const remaining = Number.isFinite(nextAttempt) ? Math.max(0, Math.ceil((nextAttempt - now) / 1000)) : null;
  return (
    <div
      className="task-progress-status"
      role="status"
      data-phase={paused ? "paused" : queued ? "queued" : (task.progress?.phase ?? "starting")}
    >
      <span className={`stream-status-track ${paused || queued || waiting ? "stream-status-track-idle" : ""}`} aria-hidden="true">
        <span />
      </span>
      <span className="min-w-0 break-words">{message}</span>
      {!paused && !queued && (waiting || elapsed >= 5) && (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground" aria-hidden="true">
          {waiting && remaining !== null
            ? remaining > 0 ? `Next round of review ${remaining}s` : "The next round of review is about to begin"
            : `Current stage ${elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}`}
        </span>
      )}
    </div>
  );
}
