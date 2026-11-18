// Centralised status → color/label semantics, reused across the whole app.
// Spec §8.3: Intent / Coverage / Task / Severity each have a consistent color set.

export type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "rose" | "violet" | "slate";

export const toneClasses: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground border-transparent",
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
  green: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20",
  red: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20",
  // rose Used as ”serious” - solid high emphasis,A soft red stroke that is visually significantly higher than ”high risk”。
  rose: "bg-rose-600 text-white border-rose-600 dark:bg-rose-600 dark:text-white",
  violet: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/20",
  slate: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/20",
};

export const toneDot: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  rose: "bg-white",
  violet: "bg-violet-500",
  slate: "bg-slate-500",
};

interface StatusMeta {
  label: string;
  tone: Tone;
}

const intent: Record<string, StatusMeta> = {
  open: { label: "To be collected", tone: "slate" },
  running: { label: "Executing", tone: "blue" },
  paused: { label: "Paused", tone: "amber" },
  done: { label: "Completed", tone: "green" },
  // blocked = Model/API/The network failure retry is exhausted, and this intention is basically not detected (non-target interception）。
  blocked: { label: "Execution error", tone: "red" },
  // exhausted = Step count reached/The time budget is cut off midway and only partial results are written back (non-directions have been explored)）。
  exhausted: { label: "Budget exhausted", tone: "violet" },
  // stopped = Historical soft delete status (retained,Historical data）。
  stopped: { label: "Stopped", tone: "slate" },
  // deleted = The user deleted the intention (retaining the node and blood relationship, see the reason for deletion) delete_reason Field）。
  deleted: { label: "Deleted", tone: "slate" },
};

const task: Record<string, StatusMeta> = {
  created: { label: "Created", tone: "slate" },
  queued: { label: "Queuing", tone: "amber" },
  running: { label: "Running", tone: "blue" },
  paused: { label: "Paused", tone: "amber" },
  done: { label: "Completed", tone: "green" },
  failed: { label: "Failure", tone: "red" },
  timeout: { label: "Timed out", tone: "amber" },
};

const severity: Record<string, StatusMeta> = {
  critical: { label: "Critical", tone: "rose" },
  high: { label: "High", tone: "red" },
  medium: { label: "Medium", tone: "amber" },
  low: { label: "Low", tone: "slate" },
};

const finding: Record<string, StatusMeta> = {
  pending: { label: "Pending", tone: "amber" },
  in_progress: { label: "Processing", tone: "blue" },
  confirmed: { label: "Confirmed", tone: "red" },
  resolved: { label: "Processed", tone: "green" },
  fixed: { label: "Fixed", tone: "green" },
  false_positive: { label: "False positive", tone: "slate" },
  ignored: { label: "Ignore", tone: "neutral" },
  duplicate: { label: "Repeat", tone: "neutral" },
  risk_accepted: { label: "Risk Acceptance", tone: "violet" },
};

const engine: Record<string, StatusMeta> = {
  exploring: { label: "Exploring", tone: "blue" },
  paused: { label: "Paused", tone: "amber" },
  stalled: { label: "Stagnation", tone: "red" },
  idle: { label: "Idle", tone: "neutral" },
};

const goal: Record<string, StatusMeta> = {
  open: { label: "In progress", tone: "blue" },
  met: { label: "Achieved", tone: "green" },
  abandoned: { label: "Abandoned", tone: "slate" },
};

const audit: Record<string, StatusMeta> = {
  allow: { label: "Release", tone: "green" },
  block: { label: "Interception", tone: "red" },
};

const node: Record<string, StatusMeta> = {
  observed: { label: "Observation", tone: "slate" },
  confirmed: { label: "Confirm", tone: "green" },
  tombstoned: { label: "Abandoned", tone: "neutral" },
};

// Push delivery status。sending Use blue instead of amber：It’s not ”problematic”」，
// But ”has been received and is being sent”, which is the same as pending The wait semantics of。
const delivery: Record<string, StatusMeta> = {
  pending: { label: "To be sent", tone: "amber" },
  sending: { label: "Sending", tone: "blue" },
  sent: { label: "Delivered", tone: "green" },
  failed: { label: "Failure", tone: "red" },
  skipped: { label: "Skipped", tone: "neutral" },
};

const maps = {
  intent,
  task,
  severity,
  finding,
  engine,
  goal,
  audit,
  node,
  delivery,
} as const;

export type StatusDomain = keyof typeof maps;

export function statusMeta(domain: StatusDomain, key: string): StatusMeta {
  return maps[domain][key] ?? { label: key, tone: "neutral" };
}
