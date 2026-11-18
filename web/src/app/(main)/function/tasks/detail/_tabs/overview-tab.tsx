"use client";

import * as React from "react";
import Link from "next/link";

import {
  ActivityIcon,
  AlertTriangleIcon,
  BugIcon,
  CheckIcon,
  ClockIcon,
  CoinsIcon,
  ListChecksIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TargetIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { ReportStatusBadge, TaskReportBackfillButton } from "@/components/finding-report-panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { MetricStrip, RecordSurface, SurfaceBody, SurfaceDescription, SurfaceHeader, SurfaceTitle } from "@/components/workbench-layout";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import type {
  AssetInterceptKind,
  AssetInterceptRule,
  Finding,
  ModelTokenStat,
  Stats,
  Task,
  TaskConstraint,
  TaskGoal,
  TaskNode,
  TaskScopeRow,
} from "@/lib/types";

// Compact formatting token Number（12345 → 12.3k，2000000 → 2M）。
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

// Cache hit rate = Cache read / Input（InputTokens Included cache_read subset, so the ratio is 0–100%）。
function cacheHitRate(cacheRead: number, input: number): string {
  if (input <= 0) return "—";
  return Math.round((cacheRead / input) * 100) + "%";
}

// The display value of one item in the test range: domain name / Network segment / Company。
function scopeValue(row: TaskScopeRow): string {
  if (row.value) return row.value;
  if (row.domain) return row.domain;
  if (row.net) return row.net;
  if (row.company_id) return row.company_name?.trim() ? row.company_name : `Enterprise #${row.company_id}`;
  return "—";
}

const SCOPE_KIND_LABELS: Record<TaskScopeRow["kind"], string> = {
  company: "Company",
  root_domain: "Root domain name",
  subdomain: "Subdomain name",
  ip: "IP",
  cidr: "Network segment",
  icp: "ICP",
  keyword: "Keywords",
};

const SCOPE_SOURCE_LABELS: Record<TaskScopeRow["source"], string> = {
  auto: "Automatic",
  agent: "Agent",
  manual: "Manual",
};

function intentSummary(node: TaskNode): string {
  try {
    const data = JSON.parse(node.payload || "{}");
    return [data.summary, data.description, data.goal, data.name].find(value => typeof value === "string" && value.trim()) || `Execution Intent #${node.id}`;
  } catch { return node.payload || `Execution Intent #${node.id}`; }
}

export function OverviewTab({ taskId }: { taskId: string }) {
  const [task, setTask] = React.useState<Task | null>(null);
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [intents, setIntents] = React.useState<TaskNode[]>([]);
  const [findings, setFindings] = React.useState<Finding[]>([]);
  const [coverage, setCoverage] = React.useState<{
    enabled: boolean;
    scope_rows: number;
    denominator: number;
    tested: number;
    pct: number | null;
    by_type: { type: string; total: number; tested: number }[];
  } | null>(null);
  // Intention to run again id（Including "__all__" means batch), used to disable the button + Turn in circles。
  const [rerunning, setRerunning] = React.useState<Set<string>>(new Set());
  // Test scope list + Add form status。
  const [scope, setScope] = React.useState<TaskScopeRow[]>([]);
  const [scopeKind, setScopeKind] = React.useState<TaskScopeRow["kind"]>("root_domain");
  const [scopeValueInput, setScopeValueInput] = React.useState("");
  const [scopeBusy, setScopeBusy] = React.useState(false);
  const [scopeErr, setScopeErr] = React.useState("");
  // By model token Dosage (from normally open llm_usage Measurement ledger, accurate every time）。
  const [modelTokens, setModelTokens] = React.useState<ModelTokenStat[]>([]);
  // Goal Management: Goal List + Add new form + Inline editing status。
  const [goals, setGoals] = React.useState<TaskGoal[]>([]);
  const [goalText, setGoalText] = React.useState("");
  const [goalVuln, setGoalVuln] = React.useState("");
  const [goalBusy, setGoalBusy] = React.useState(false);
  const [goalErr, setGoalErr] = React.useState("");
  const [editingGoalId, setEditingGoalId] = React.useState<string | null>(null);
  const [editText, setEditText] = React.useState("");
  const [editVuln, setEditVuln] = React.useState("");
  // Constraint Management: Constraint List + Add new form + Inline editing status。
  const [constraints, setConstraints] = React.useState<TaskConstraint[]>([]);
  const [conText, setConText] = React.useState("");
  const [conKind, setConKind] = React.useState<TaskConstraint["kind"]>("deny");
  const [conBusy, setConBusy] = React.useState(false);
  const [conErr, setConErr] = React.useState("");
  const [editingConId, setEditingConId] = React.useState<string | null>(null);
  const [editConText, setEditConText] = React.useState("");
  const [editConKind, setEditConKind] = React.useState<TaskConstraint["kind"]>("deny");

  const loadTokens = React.useCallback(async () => {
    try {
      const resp = await api.tokensByModel(taskId);
      setModelTokens(resp.models);
    } catch {
      // Ignore: None PG When the interface reports an error, the card is naturally empty.
    }
  }, [taskId]);

  const loadScope = React.useCallback(async () => {
    try {
      const resp = await api.taskScope(taskId);
      setScope(resp.scope);
    } catch {
      // Ignore: None asset store Time interface 503，The range card is naturally empty
    }
  }, [taskId]);

  const loadGoals = React.useCallback(async () => {
    try {
      const resp = await api.taskGoals(taskId);
      setGoals(resp.goals);
    } catch {
      // Ignore: Transient error, try again next poll
    }
  }, [taskId]);

  const addGoal = async () => {
    const text = goalText.trim();
    if (!text) return;
    setGoalBusy(true);
    setGoalErr("");
    try {
      await api.addGoal(taskId, text, goalVuln.trim() || undefined);
      setGoalText("");
      setGoalVuln("");
      await loadGoals();
    } catch (e) {
      setGoalErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setGoalBusy(false);
    }
  };

  const startEditGoal = (g: TaskGoal) => {
    setEditingGoalId(g.id);
    setEditText(g.text);
    setEditVuln(g.vulnclass ?? "");
  };

  const cancelEditGoal = () => {
    setEditingGoalId(null);
    setEditText("");
    setEditVuln("");
  };

  const saveEditGoal = async (g: TaskGoal) => {
    const text = editText.trim();
    if (!text) return;
    setGoalBusy(true);
    setGoalErr("");
    try {
      await api.updateGoal(taskId, g.id, text, editVuln.trim() || undefined);
      cancelEditGoal();
      await loadGoals();
    } catch (e) {
      setGoalErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setGoalBusy(false);
    }
  };

  const removeGoal = async (g: TaskGoal) => {
    setGoals((prev) => prev.filter((x) => x.id !== g.id));
    try {
      await api.deleteGoal(taskId, g.id);
    } catch {
      await loadGoals(); // Delete failed: Pull to restore again
    }
  };

  const loadConstraints = React.useCallback(async () => {
    try {
      const resp = await api.taskConstraints(taskId);
      setConstraints(resp.constraints);
    } catch {
      // Ignore: Transient error, try again next poll
    }
  }, [taskId]);

  const addConstraint = async () => {
    const text = conText.trim();
    if (!text) return;
    setConBusy(true);
    setConErr("");
    try {
      await api.addConstraint(taskId, text, conKind);
      setConText("");
      await loadConstraints();
    } catch (e) {
      setConErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setConBusy(false);
    }
  };

  const startEditConstraint = (c: TaskConstraint) => {
    setEditingConId(c.id);
    setEditConText(c.text);
    setEditConKind(c.kind);
  };

  const cancelEditConstraint = () => {
    setEditingConId(null);
    setEditConText("");
    setEditConKind("deny");
  };

  const saveEditConstraint = async (c: TaskConstraint) => {
    const text = editConText.trim();
    if (!text) return;
    setConBusy(true);
    setConErr("");
    try {
      await api.updateConstraint(taskId, c.id, text, editConKind);
      cancelEditConstraint();
      await loadConstraints();
    } catch (e) {
      setConErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setConBusy(false);
    }
  };

  const removeConstraint = async (c: TaskConstraint) => {
    setConstraints((prev) => prev.filter((x) => x.id !== c.id));
    try {
      await api.deleteConstraint(taskId, c.id);
    } catch {
      await loadConstraints(); // Delete failed: Pull to restore again
    }
  };

  const addScope = async () => {
    const value = scopeValueInput.trim();
    if (!value) return;
    setScopeBusy(true);
    setScopeErr("");
    try {
      await api.addTaskScope(taskId, scopeKind, value);
      setScopeValueInput("");
      await loadScope();
    } catch (e) {
      setScopeErr(e instanceof Error ? e.message : "Add failed");
    } finally {
      setScopeBusy(false);
    }
  };

  const removeScope = async (row: TaskScopeRow) => {
    setScope((prev) => prev.filter((s) => s.id !== row.id));
    try {
      await api.deleteTaskScope(taskId, row.id);
    } catch {
      await loadScope(); // Delete failed: Pull to restore again
    }
  };

  const markRerun = (key: string, on: boolean) =>
    setRerunning((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  // Rerun single line: reset open（Optimistic update local state，3s Polling for details），worker Will claim again and run again from the beginning。
  const rerunOne = async (id: string) => {
    markRerun(id, true);
    try {
      await api.rerunIntent(taskId, id);
      setIntents((prev) => prev.map((i) => (i.id === id ? { ...i, state: "open" } : i)));
    } catch {
      // Failure ignored: still displayed next time polling blocked，User can click again
    } finally {
      markRerun(id, false);
    }
  };

  // Rerun all tasks in batches blocked。
  const rerunAll = async () => {
    markRerun("__all__", true);
    try {
      await api.rerunBlocked(taskId);
      setIntents((prev) => prev.map((i) => (i.state === "blocked" ? { ...i, state: "open" } : i)));
    } catch {
      // ignore
    } finally {
      markRerun("__all__", false);
    }
  };

  React.useEffect(() => {
    let cancelled = false;
    let loading = false;

    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const [taskResp, statsResp, intentsResp, findingsResp] = await Promise.all([
          api.task(taskId),
          api.stats(taskId),
          api.intents(taskId),
          api.findings(taskId),
        ]);
        if (cancelled) return;
        const activeTask = statsResp.active_task;
        setTask(
          activeTask
            ? {
                ...taskResp,
                in_flight: activeTask.in_flight,
                goals_total: activeTask.goals_total,
                goals_met: activeTask.goals_met,
                engine_mode: statsResp.engine_mode ?? activeTask.engine_mode,
                paused: activeTask.paused,
              }
            : taskResp,
        );
        setStats(statsResp);
        setIntents(intentsResp);
        setFindings(findingsResp);
        // coverage is independent + may 503 when no asset store — fetch separately so
        // its failure never blocks the others.
        api
          .taskCoverage(taskId)
          .then((c) => {
            if (!cancelled) setCoverage(c);
          })
          .catch(() => {
            // A transient coverage failure is retried by the next poll.
          });
      } catch {
        // transient errors are ignored; the next poll will retry
      } finally {
        loading = false;
      }
    };

    void load();
    void loadScope();
    void loadTokens();
    void loadGoals();
    void loadConstraints();
    const timer = setInterval(() => {
      void load();
      void loadTokens();
      void loadGoals();
      void loadConstraints();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [taskId, loadScope, loadTokens, loadGoals, loadConstraints]);

  const [goalAdd,setGoalAdd]=React.useState(false),[scopeAdd,setScopeAdd]=React.useState(false),[conAdd,setConAdd]=React.useState(false),[rulesOpen,setRulesOpen]=React.useState(false),[tokensOpen,setTokensOpen]=React.useState(false),[briefOpen,setBriefOpen]=React.useState(false);
  const running = intents.filter((i) => i.state === "running");
  const open = intents.filter((i) => i.state === "open");
  const blocked = intents.filter((i) => i.state === "blocked");
  const taskFindings = findings.filter((f) => f.task_id === taskId);
  const goalsPct = task?.goals_total ? Math.round(((task.goals_met ?? 0) / task.goals_total) * 100) : 0;
  // token Total (across all models) for card header overview。
  const tokenTotals = modelTokens.reduce(
    (acc, m) => {
      acc.input += m.input_tokens;
      acc.output += m.output_tokens;
      acc.cacheRead += m.cache_read_tokens;
      acc.cacheWrite += m.cache_write_tokens;
      acc.calls += m.calls;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
  );

  return (
    <div className="task-overview-workspace overview-grid">
<section className="overview-summary">
 <div className="flex flex-wrap items-center gap-3 text-sm"><StatusBadge domain="task" value={task?.paused?"paused":task?.queued?"queued":task?.status??"created"} dot/><span className="text-muted-foreground">Run time {task?.first_run_at?Math.max(0,Math.round(((task.completed_unix?task.completed_unix*1000:Date.now())-new Date(task.first_run_at).getTime())/60000))+" minutes":"—"}</span><span className="text-muted-foreground">Recent activities {task?.last_activity?new Date(task.last_activity).toLocaleTimeString("en-US"):"—"}</span></div>
 <MetricStrip className="overview-metrics" items={[
 {label:"Goal accomplished",value:(task?.goals_met??0)+" / "+(task?.goals_total??0),detail:<Progress value={goalsPct} className="mt-2 h-1"/>},
 {label:"Active Worker",value:running.length,detail:open.length+" To be collected"},
 {label:"Discovery",value:taskFindings.length,detail:"Registration of this task"},
 {label:"Report completed",value:taskFindings.filter(f=>f.report_status==="completed").length,detail:taskFindings.filter(f=>f.report_status!=="completed").length+" Article to be improved"},
 {label:"Need attention",value:blocked.length,detail:"Blocked or wrong intention"}]}/>
 </section>
<div className={"overview-live-grid "+(!running.length?"overview-live-idle":"")}><RecordSurface className="visual-panel overview-active">
          <SurfaceHeader>
            <SurfaceTitle className="flex items-center gap-2 text-sm">
              <TargetIcon className="size-4" />  Current execution
            </SurfaceTitle>
          </SurfaceHeader>
          <SurfaceBody className="flex flex-col gap-2">
            {running.slice(0, 6).map((i) => (
              <div key={i.id} className="flex items-center gap-2 text-sm">
                <StatusBadge domain="intent" value={i.state} />
                <div className="min-w-0 flex-1"><Link href={"/function/tasks/detail?id="+taskId+"&tab=sessions&intent="+i.id} className="line-clamp-2 leading-relaxed hover:underline">{intentSummary(i)}</Link><span className="text-xs text-muted-foreground">Intent #{i.id}</span></div>
              </div>
            ))}
            {running.length === 0 && <p className="text-sm text-muted-foreground">{task?.status==="done"?"This test execution has ended":task?.paused?"Test paused":"There are currently no executing intents"}</p>}
          </SurfaceBody>
        </RecordSurface><RecordSurface className="visual-panel overview-recent">
          <SurfaceHeader>
            <SurfaceTitle className="flex items-center gap-2 text-sm">
              <BugIcon className="size-4 text-red-500" />  Recently discovered<span className="ml-auto"><TaskReportBackfillButton findings={taskFindings}/></span>
            </SurfaceTitle>
          </SurfaceHeader>
          <SurfaceBody className="flex flex-col gap-2">
            {taskFindings.slice(0, 6).map((f) => (
              <div key={f.id} className="flex items-center gap-2 text-sm">
                <StatusBadge domain="severity" value={f.severity} dot />
                <Link className="min-w-0 flex-1 truncate hover:underline" href={`/function/findings/detail?id=${encodeURIComponent(f.finding_id||f.id)}&context_task=${encodeURIComponent(taskId)}`}>{f.name || f.summary}</Link><ReportStatusBadge status={f.report_status}/>
              </div>
            ))}
            {taskFindings.length === 0 && <p className="text-sm text-muted-foreground">No discovery yet</p>}
          </SurfaceBody>
        </RecordSurface></div>
{blocked.length > 0 && (
        <RecordSurface className="visual-panel overview-blocked border-destructive/25">
          <SurfaceHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <SurfaceTitle className="flex items-center gap-2 text-sm">
              <AlertTriangleIcon className="size-4 text-red-500" />  Blocked/Error Intent
              <span className="text-xs font-normal text-muted-foreground">(Total {blocked.length}  , can be rerun)</span>
            </SurfaceTitle>
            <Button size="sm" variant="outline" disabled={rerunning.has("__all__")} onClick={() => void rerunAll()}>
              <RefreshCwIcon className={`size-3.5 ${rerunning.has("__all__") ? "animate-spin" : ""}`} />

              Rerun all
            </Button>
          </SurfaceHeader>
          <SurfaceBody className="flex flex-col gap-2">
            {blocked.slice(0, 20).map((i) => (
              <div key={i.id} className="flex items-center gap-2 text-sm">
                <StatusBadge domain="intent" value={i.state} />
                <span className="min-w-0 flex-1 truncate">{intentSummary(i)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={rerunning.has(i.id)}
                  onClick={() => void rerunOne(i.id)}
                >
                  <RefreshCwIcon className={`size-3 ${rerunning.has(i.id) ? "animate-spin" : ""}`} />

                  Rerun
                </Button>
              </div>
            ))}
            {blocked.length > 20 && (
              <p className="text-xs text-muted-foreground">

                Only the first 20 entries are displayed, click &quot;Rerun All&quot; to process the remaining {blocked.length - 20}  Article.
              </p>
            )}
</SurfaceBody></RecordSurface>
)}
<RecordSurface className="visual-panel overview-goals">
        <SurfaceHeader>
          <SurfaceTitle className="flex items-center gap-2 text-base">
            <ListChecksIcon className="size-4 text-primary" />  Goals and Progress
            <span className="text-muted-foreground text-xs font-normal">
              {goals.length}  Project target
            </span>
          </SurfaceTitle>
          <SurfaceDescription>Adding or modifying goals will trigger planning and resume completed tasks.</SurfaceDescription>
        </SurfaceHeader>
        <SurfaceBody className="flex flex-col gap-3">
          <div className="overview-add"><Button size="sm" variant="outline" onClick={()=>setGoalAdd(v=>!v)}><PlusIcon className="size-3.5"/>{goalAdd?"Cancel":"Add target"}</Button>{goalAdd&&<div className="pt-3">{/* Add new form */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-7 min-w-56 flex-1 text-sm"
              placeholder="Add new goals, such as &quot;obtain unauthorized access to the administrator account&quot;"
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addGoal();
              }}
              disabled={goalBusy}
            />
            <Input
              className="h-7 w-32 text-sm"
              placeholder="Vulnerability class (optional)"
              value={goalVuln}
              onChange={(e) => setGoalVuln(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addGoal();
              }}
              disabled={goalBusy}
            />
            <Button size="sm" variant="outline" disabled={goalBusy || !goalText.trim()} onClick={() => void addGoal()}>
              <PlusIcon className="size-3.5" />  Add
            </Button>
            {goalErr && <span className="text-xs text-red-500">{goalErr}</span>}
          </div></div>}</div>
          {/* Target list */}
          {goals.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {goals.map((g) =>
                editingGoalId === g.id ? (
                  <div key={g.id} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5">
                    <Input
                      className="h-7 min-w-56 flex-1 text-sm"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveEditGoal(g);
                        if (e.key === "Escape") cancelEditGoal();
                      }}
                      disabled={goalBusy}
                      autoFocus
                    />
                    <Input
                      className="h-7 w-32 text-sm"
                      placeholder="Vulnerability class (optional)"
                      value={editVuln}
                      onChange={(e) => setEditVuln(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveEditGoal(g);
                        if (e.key === "Escape") cancelEditGoal();
                      }}
                      disabled={goalBusy}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5"
                      disabled={goalBusy || !editText.trim()}
                      onClick={() => void saveEditGoal(g)}
                    >
                      <CheckIcon className="size-3.5 text-emerald-500" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5"
                      disabled={goalBusy}
                      onClick={cancelEditGoal}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </div>
                ) : (
                  <div key={g.id} className="overview-editable-row flex items-center gap-2 border-b border-border/70 py-2.5 text-sm">
                    {g.resolution ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground" title={g.resolution.reason}>{g.resolution.outcome === "blocked" ? "Insufficient conditions" : "Tested but not found"}</span> : <StatusBadge domain="goal" value={g.state} />}
                    <span className="min-w-0 flex-1 break-words">{g.text}</span>
                    {g.vulnclass && (
                      <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-xs">
                        {g.vulnclass}
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5"
                      disabled={goalBusy}
                      onClick={() => startEditGoal(g)}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5"
                      disabled={goalBusy}
                      onClick={() => void removeGoal(g)}
                    >
                      <Trash2Icon className="size-3.5 text-red-500" />
                    </Button>
                  </div>
                ),
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No target yet</p>
          )}
        </SurfaceBody>
      </RecordSurface>
<RecordSurface className="visual-panel overview-brief">
        <SurfaceHeader className="flex-row items-center justify-between"><Button size="sm" variant="ghost" onClick={()=>setBriefOpen(v=>!v)}>{briefOpen?"Close the full text":"View full text"}</Button>
          <SurfaceTitle className="flex items-center gap-2 text-base">
            <TargetIcon className="size-4 text-primary" />  Mission Description
          </SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium text-muted-foreground">Description</div>
            <p className={"text-sm whitespace-pre-wrap break-words "+(briefOpen?"":"line-clamp-3")}>{task?.description?.trim() || "—"}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium text-muted-foreground">Target</div>
            <p className={"text-sm whitespace-pre-wrap break-words "+(briefOpen?"":"line-clamp-3")}>{task?.goal?.trim() || "—"}</p>
          </div>
        </SurfaceBody>
      </RecordSurface>
<section className="overview-boundaries"><h2 className="text-sm font-semibold">Scope and Constraints</h2><RecordSurface className="visual-panel overview-scope">
        <SurfaceHeader>
          <SurfaceTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon className="size-4 text-emerald-500" />  Test range
            <span className="text-muted-foreground text-xs font-normal">

              (Coverage denominator + authorization boundary, total {scope.length}  Article)
            </span>
          </SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody className="flex flex-col gap-3">
          <div className="overview-add"><Button size="sm" variant="outline" onClick={()=>setScopeAdd(v=>!v)}><PlusIcon className="size-3.5"/>{scopeAdd?"Cancel":"Add range"}</Button>{scopeAdd&&<div className="pt-3">{/* Add new form */}
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              size="sm"
              value={scopeKind}
              onChange={(e) => setScopeKind(e.target.value as TaskScopeRow["kind"])}
            >
              <NativeSelectOption value="root_domain">Root domain name</NativeSelectOption>
              <NativeSelectOption value="subdomain">Subdomain name</NativeSelectOption>
              <NativeSelectOption value="ip">IP</NativeSelectOption>
              <NativeSelectOption value="cidr">Network segment</NativeSelectOption>
              <NativeSelectOption value="icp">ICP</NativeSelectOption>
              <NativeSelectOption value="keyword">Keywords</NativeSelectOption>
              <NativeSelectOption value="company">Company</NativeSelectOption>
            </NativeSelect>
            <Input
              className="h-7 w-56 text-sm"
              placeholder={
                scopeKind === "company"
                  ? "Company name or id"
                  : scopeKind === "ip" || scopeKind === "cidr"
                    ? "Such as 10.0.0.1 or 10.0.0.0/24"
                    : scopeKind === "icp"
                      ? "Such as Beijing ICP No. 12345678-1"
                      : scopeKind === "keyword"
                        ? "Such as company name keywords"
                        : "Such as example.com"
              }
              value={scopeValueInput}
              onChange={(e) => setScopeValueInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addScope();
              }}
              disabled={scopeBusy}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={scopeBusy || !scopeValueInput.trim()}
              onClick={() => void addScope()}
            >
              <PlusIcon className="size-3.5" />  Add
            </Button>
            {scopeErr && <span className="text-xs text-red-500">{scopeErr}</span>}
          </div></div>}</div>
          {/* Range List */}
          {scope.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {scope.map((row) => (
                <div key={row.id} className="overview-editable-row flex items-center gap-2 border-b border-border/70 py-2.5 text-sm">
                  <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-xs">
                    {SCOPE_KIND_LABELS[row.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{scopeValue(row)}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">{SCOPE_SOURCE_LABELS[row.source]}</span>
                  {row.task_id.toString() === taskId ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5"
                      onClick={() => void removeScope(row)}
                    >
                      <Trash2Icon className="size-3.5 text-red-500" />
                    </Button>
                  ) : (
                    <span className="text-muted-foreground shrink-0 text-xs">Inheritance</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">No test scope yet</p>
          )}
        </SurfaceBody>
      </RecordSurface><RecordSurface className="visual-panel overview-constraints">
        <SurfaceHeader>
          <SurfaceTitle className="flex items-center gap-2 text-base">
            <ShieldAlertIcon className="size-4 text-amber-500" />  Operational Constraints
            <span className="text-muted-foreground text-xs font-normal">

              (Frame the exploration boundary of planner/worker, total
Article {constraints.length}  ; changes to the next round of planning will take effect)
            </span>
          </SurfaceTitle>
        </SurfaceHeader>
        <SurfaceBody className="flex flex-col gap-3">
          <div className="overview-add"><Button size="sm" variant="outline" onClick={()=>setConAdd(v=>!v)}><PlusIcon className="size-3.5"/>{conAdd?"Cancel":"Add constraints"}</Button>{conAdd&&<div className="pt-3">{/* Add new form */}
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              size="sm"
              value={conKind}
              onChange={(e) => setConKind(e.target.value as TaskConstraint["kind"])}
            >
              <NativeSelectOption value="deny">Prohibited</NativeSelectOption>
              <NativeSelectOption value="allow">Allow</NativeSelectOption>
            </NativeSelect>
            <Input
              className="h-7 min-w-56 flex-1 text-sm"
              placeholder="An operation constraint, such as &quot;only test the current port, do not scan other ports&quot;"
              value={conText}
              onChange={(e) => setConText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addConstraint();
              }}
              disabled={conBusy}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={conBusy || !conText.trim()}
              onClick={() => void addConstraint()}
            >
              <PlusIcon className="size-3.5" />  Add
            </Button>
            {conErr && <span className="text-xs text-red-500">{conErr}</span>}
          </div></div>}</div>
          {/* Constraint list */}
          {constraints.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {constraints.map((c) =>
                editingConId === c.id ? (
                  <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5">
                    <NativeSelect
                      size="sm"
                      value={editConKind}
                      onChange={(e) => setEditConKind(e.target.value as TaskConstraint["kind"])}
                    >
                      <NativeSelectOption value="deny">Prohibited</NativeSelectOption>
                      <NativeSelectOption value="allow">Allow</NativeSelectOption>
                    </NativeSelect>
                    <Input
                      className="h-7 min-w-56 flex-1 text-sm"
                      value={editConText}
                      onChange={(e) => setEditConText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveEditConstraint(c);
                        if (e.key === "Escape") cancelEditConstraint();
                      }}
                      disabled={conBusy}
                      autoFocus
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5"
                      disabled={conBusy || !editConText.trim()}
                      onClick={() => void saveEditConstraint(c)}
                    >
                      <CheckIcon className="size-3.5 text-emerald-500" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5"
                      disabled={conBusy}
                      onClick={cancelEditConstraint}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </div>
                ) : (
                  <div key={c.id} className="overview-editable-row flex items-center gap-2 border-b border-border/70 py-2.5 text-sm">
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                        c.kind === "allow"
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : "bg-red-500/15 text-red-600 dark:text-red-400"
                      }`}
                    >
                      {c.kind === "allow" ? "Allow" : "Prohibited"}
                    </span>
                    <span className="min-w-0 flex-1 break-words">{c.text}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5"
                      disabled={conBusy}
                      onClick={() => startEditConstraint(c)}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5"
                      disabled={conBusy}
                      onClick={() => void removeConstraint(c)}
                    >
                      <Trash2Icon className="size-3.5 text-red-500" />
                    </Button>
                  </div>
                ),
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">

              No operational constraints yet
            </p>
          )}
        </SurfaceBody>
      </RecordSurface></section>
{coverage && coverage.enabled && coverage.scope_rows > 0 && (
        <RecordSurface className="visual-panel overview-coverage">
          <SurfaceHeader>
            <SurfaceTitle className="flex items-center gap-2 text-base">
              <TargetIcon className="size-4 text-emerald-500" />  Asset Test Coverage
              <span className="text-muted-foreground text-xs font-normal">(rough estimate, for reference only)</span>
            </SurfaceTitle>
          </SurfaceHeader>
          <SurfaceBody className="flex flex-col gap-3">
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-semibold tabular-nums">
                {coverage.pct != null ? Math.round(coverage.pct * 100) + "%" : "—"}
              </span>
              <span className="text-muted-foreground text-sm">

                Tested {coverage.tested}  / within range {coverage.denominator}
              </span>
            </div>
            {coverage.pct != null && <Progress value={Math.round(coverage.pct * 100)} />}
            {coverage.by_type.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                {coverage.by_type.map((b) => (
                  <span key={b.type} className="bg-muted rounded px-1.5 py-0.5">
                    <span className="text-muted-foreground">{b.type}</span>{" "}
                    <span className="tabular-nums font-medium">
                      {b.tested}/{b.total}
                    </span>
                  </span>
                ))}
              </div>
            )}
</SurfaceBody></RecordSurface>
)}
<RecordSurface className="visual-panel overview-usage">
        <SurfaceHeader>
          <SurfaceTitle className="flex items-center gap-2 text-base">
            <CoinsIcon className="size-4 text-amber-500" />  Model dosage
            <span className="text-muted-foreground text-xs font-normal">

              (Statistics by model{tokenTotals.calls > 0 ? `, total ${tokenTotals.calls} calls` : ""}）
            </span>
          </SurfaceTitle>
        <Button size="sm" variant="ghost" onClick={()=>setTokensOpen(v=>!v)}>{tokensOpen?"Collapse details":"Model details"}</Button></SurfaceHeader>
        <SurfaceBody className="flex flex-col gap-3">
          {modelTokens.length > 0 ? (
            <>
              {/* Total Overview */}
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                <span className="tabular-nums">
                  <span className="text-muted-foreground">Input </span>
                  <span className="font-semibold">{fmtTokens(tokenTotals.input)}</span>
                </span>
                <span className="tabular-nums">
                  <span className="text-muted-foreground">Output </span>
                  <span className="font-semibold">{fmtTokens(tokenTotals.output)}</span>
                </span>
                <span className="tabular-nums">
                  <span className="text-muted-foreground">Cache read </span>
                  <span className="font-semibold">{fmtTokens(tokenTotals.cacheRead)}</span>
                </span>
                <span className="tabular-nums">
                  <span className="text-muted-foreground">Cache hit rate </span>
                  <span className="font-semibold text-emerald-500">
                    {cacheHitRate(tokenTotals.cacheRead, tokenTotals.input)}
                  </span>
                </span>
              </div>
              {/* By model schedule */}
              {tokensOpen&&<div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground border-b text-left text-xs">
                      <th className="py-1.5 pr-3 font-medium">Model</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Call</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Input</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Output</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Cache read</th>
                      <th className="py-1.5 text-right font-medium">Hit rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelTokens.map((m) => (
                      <tr key={m.model} className="border-b last:border-0">
                        <td className="max-w-[16rem] truncate py-1.5 pr-3 font-mono text-xs" title={m.model}>
                          {m.model}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{m.calls}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtTokens(m.input_tokens)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtTokens(m.output_tokens)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtTokens(m.cache_read_tokens)}</td>
                        <td className="py-1.5 text-right tabular-nums text-emerald-500">
                          {cacheHitRate(m.cache_read_tokens, m.input_tokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">No LLM usage yet (the task has not yet generated a call, or records are still being written).</p>
          )}
        </SurfaceBody>
      </RecordSurface>
<div className="overview-advanced"><Button variant="ghost" size="sm" onClick={()=>setRulesOpen(v=>!v)}>{rulesOpen?"Collapse Asset Rules":"Manage Task Level Asset Rules"}</Button>{rulesOpen&&<div className="pt-4"><TaskInterceptRulesCard taskId={taskId}/></div>}</div>
</div>
  );
}

const TASK_RULE_KIND_OPTIONS: { value: AssetInterceptKind; label: string; placeholder: string }[] = [
  { value: "exact_domain", label: "Domain name (congruent)", placeholder: "example.gov.cn" },
  { value: "exact_ip", label: "IP (congruent)", placeholder: "203.0.113.10" },
  { value: "exact_url", label: "URL (congruent)", placeholder: "https://example.com/login" },
  { value: "fuzzy_domain", label: "Domain name (fuzzy)", placeholder: ".gov.cn" },
  { value: "fuzzy_ip", label: "IP (blurred)", placeholder: "203.0.113." },
  { value: "fuzzy_url", label: "URL (blurred)", placeholder: "/admin" },
  { value: "cidr", label: "CIDR segment", placeholder: "192.168.0.0/16" },
];

const TASK_RULE_KIND_LABEL: Record<AssetInterceptKind, string> = Object.fromEntries(
  TASK_RULE_KIND_OPTIONS.map((o) => [o.value, o.label]),
) as Record<AssetInterceptKind, string>;

// TaskInterceptRulesCard Manage ”task-level asset interception” in the task details overview / Allow rules」：
// List + New + Inline editing + Delete + Enable switch. The rule only takes effect for this task and does not enter the global table.。
function TaskInterceptRulesCard({ taskId }: { taskId: string }) {
  const [rules, setRules] = React.useState<AssetInterceptRule[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [newAction, setNewAction] = React.useState<"block" | "allow">("block");
  const [newKind, setNewKind] = React.useState<AssetInterceptKind>("fuzzy_domain");
  const [newPattern, setNewPattern] = React.useState("");
  const [newNote, setNewNote] = React.useState("");
  const [editId, setEditId] = React.useState<number | null>(null);
  const [editAction, setEditAction] = React.useState<"block" | "allow">("block");
  const [editKind, setEditKind] = React.useState<AssetInterceptKind>("fuzzy_domain");
  const [editPattern, setEditPattern] = React.useState("");
  const [editNote, setEditNote] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      setRules(await api.taskInterceptRules(taskId));
    } catch {
      // Ignore transient errors
    }
  }, [taskId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!newPattern.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await api.createTaskInterceptRule(taskId, {
        action: newAction,
        kind: newKind,
        pattern: newPattern.trim(),
        note: newNote.trim(),
        enabled: true,
      });
      setNewPattern("");
      setNewNote("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(r: AssetInterceptRule) {
    setEditId(r.id);
    setEditAction(r.action ?? "block");
    setEditKind(r.kind);
    setEditPattern(r.pattern);
    setEditNote(r.note);
    setErr("");
  }

  async function saveEdit(r: AssetInterceptRule) {
    if (!editPattern.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await api.updateTaskInterceptRule(taskId, r.id, {
        action: editAction,
        kind: editKind,
        pattern: editPattern.trim(),
        note: editNote.trim(),
        enabled: r.enabled,
      });
      setEditId(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: AssetInterceptRule) {
    setRules((prev) => prev.filter((x) => x.id !== r.id));
    try {
      await api.deleteTaskInterceptRule(taskId, r.id);
    } catch {
      await load();
    }
  }

  async function toggle(r: AssetInterceptRule) {
    setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await api.toggleTaskInterceptRule(taskId, r.id, !r.enabled);
    } catch {
      await load();
    }
  }

  const placeholder = TASK_RULE_KIND_OPTIONS.find((o) => o.value === newKind)?.placeholder ?? "";

  return (
    <RecordSurface>
      <SurfaceHeader>
        <SurfaceTitle className="flex items-center gap-2 text-base">
          <ShieldCheckIcon className="size-4 text-sky-500" />  Task Level Asset Block/Allow
          <span className="text-muted-foreground text-xs font-normal">

            (Only this task takes effect and does not enter the global situation; intercept first and then allow, total {rules.length}  Article)
          </span>
        </SurfaceTitle>
      </SurfaceHeader>
      <SurfaceBody className="flex flex-col gap-3">
        {/* Add new form */}
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect size="sm" value={newAction} onChange={(e) => setNewAction(e.target.value as "block" | "allow")}>
            <NativeSelectOption value="block">Interception</NativeSelectOption>
            <NativeSelectOption value="allow">Allow</NativeSelectOption>
          </NativeSelect>
          <NativeSelect size="sm" value={newKind} onChange={(e) => setNewKind(e.target.value as AssetInterceptKind)}>
            {TASK_RULE_KIND_OPTIONS.map((o) => (
              <NativeSelectOption key={o.value} value={o.value}>
                {o.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            className="h-7 min-w-56 flex-1 text-sm"
            placeholder={placeholder}
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            disabled={busy}
          />
          <Input
            className="h-7 w-36 text-sm"
            placeholder="Remarks (optional)"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            disabled={busy}
          />
          <Button size="sm" variant="outline" disabled={busy || !newPattern.trim()} onClick={() => void add()}>
            <PlusIcon className="size-3.5" />  Add
          </Button>
          {err && <span className="text-xs text-red-500">{err}</span>}
        </div>
        {/* Rule list */}
        {rules.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {rules.map((r) =>
              editId === r.id ? (
                <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5">
                  <NativeSelect
                    size="sm"
                    value={editAction}
                    onChange={(e) => setEditAction(e.target.value as "block" | "allow")}
                  >
                    <NativeSelectOption value="block">Interception</NativeSelectOption>
                    <NativeSelectOption value="allow">Allow</NativeSelectOption>
                  </NativeSelect>
                  <NativeSelect
                    size="sm"
                    value={editKind}
                    onChange={(e) => setEditKind(e.target.value as AssetInterceptKind)}
                  >
                    {TASK_RULE_KIND_OPTIONS.map((o) => (
                      <NativeSelectOption key={o.value} value={o.value}>
                        {o.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Input
                    className="h-7 min-w-56 flex-1 text-sm"
                    value={editPattern}
                    onChange={(e) => setEditPattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveEdit(r);
                      if (e.key === "Escape") setEditId(null);
                    }}
                    disabled={busy}
                    autoFocus
                  />
                  <Input
                    className="h-7 w-36 text-sm"
                    placeholder="Remarks (optional)"
                    value={editNote}
                    onChange={(e) => setEditNote(e.target.value)}
                    disabled={busy}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-1.5"
                    disabled={busy || !editPattern.trim()}
                    onClick={() => void saveEdit(r)}
                  >
                    <CheckIcon className="size-3.5 text-emerald-500" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-1.5"
                    disabled={busy}
                    onClick={() => setEditId(null)}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              ) : (
                <div key={r.id} className="overview-editable-row flex items-center gap-2 border-b border-border/70 py-2.5 text-sm">
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                      r.action === "allow"
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-red-500/15 text-red-600 dark:text-red-400"
                    }`}
                  >
                    {r.action === "allow" ? "Allow" : "Interception"}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">{TASK_RULE_KIND_LABEL[r.kind]}</span>
                  <code className="bg-muted min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-xs">{r.pattern}</code>
                  {r.note && (
                    <span className="text-muted-foreground max-w-[120px] shrink-0 truncate text-xs">{r.note}</span>
                  )}
                  <Switch checked={r.enabled} onCheckedChange={() => void toggle(r)} />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-1.5"
                    disabled={busy}
                    onClick={() => startEdit(r)}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-1.5"
                    disabled={busy}
                    onClick={() => void remove(r)}
                  >
                    <Trash2Icon className="size-3.5 text-red-500" />
                  </Button>
                </div>
              ),
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">

            No task-level rules yet
          </p>
        )}
      </SurfaceBody>
    </RecordSurface>
  );
}
