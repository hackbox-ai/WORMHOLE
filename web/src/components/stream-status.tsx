"use client";

import * as React from "react";
import type { Activity } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Reflect persisted activity; elapsed time is not a fabricated progress value. */
export function StreamStatus({
  activity = [],
  compact = false,
  className,
}: {
  activity?: Activity[];
  compact?: boolean;
  className?: string;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const started = React.useRef(Date.now()),
    last = activity.at(-1);
  const recorded = last?.ts ? new Date(last.ts).getTime() : NaN;
  const elapsed = Math.max(0, Math.floor((now - (Number.isFinite(recorded) ? recorded : started.current)) / 1000));
  const pending = new Map<string, string>();
  for (const step of activity) {
    if (["user", "result", "error"].includes(step.kind)) pending.clear();
    if (step.kind === "tool_use" && step.tool_use_id) pending.set(step.tool_use_id, step.tool ?? "Tool");
    if (step.kind === "tool_result" && step.tool_use_id) pending.delete(step.tool_use_id);
  }
  const tool = [...pending.values()].at(-1);
  const label = tool
    ? `Executing ${tool}`
    : last?.kind === "thinking"
      ? "Reasoning"
      : last?.kind === "text" && elapsed < 8
        ? "Generating"
        : "Waiting for model response";
  return (
    <div
      className={cn("stream-status", compact && "stream-status-compact", className)}
      role="status"
      aria-label={compact ? "Session is running" : label}
    >
      <span className="stream-status-track" aria-hidden="true">
        <span />
      </span>
      <span className="stream-status-label">{compact ? "Running" : label}</span>
      {!compact && elapsed >= 8 && (
        <span className="stream-status-elapsed" aria-hidden="true">
          {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
        </span>
      )}
    </div>
  );
}
