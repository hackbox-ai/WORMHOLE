"use client";
import { HelpButton } from "@/components/user-guide";

import * as React from "react";

import Link from "next/link";

import { ArrowUpRightIcon, DownloadIcon, Loader2Icon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  RecordSurface,
  SurfaceBody,
  SurfaceDescription,
  SurfaceHeader,
  SurfaceTitle,
} from "@/components/workbench-layout";
import { WorkspaceHeader } from "@/components/workspace-header";
import { api } from "@/lib/api";
import type { BusinessModel, BusinessModelDetail, ModelVersion } from "@/lib/business-models";
import type { Task } from "@/lib/types";

const triggerLabels = { initial: "Test preset", discovery: "New system discovered", manual: "Manually initiated" };
const statusLabels: Record<string, string> = {
  created: "Waiting to run",
  running: "Modeling",
  paused: "Paused",
  done: "Completed",
  failed: "Stopped/Failed",
  timeout: "Timeout",
};
const eventLabels: Record<string, string> = {
  modeling_created: "Create modeling tasks",
  modeling_linked: "Associated test tasks",
  modeling_submitted: "Save model draft",
  modeling_completed: "Release model version",
  modeling_entrance_checked: "Target entrance check passed",
  modeling_failed: "The modeling is not completed and the draft has been retained",
  modeling_timeout: "Modeling timed out, draft retained",
};
function stamp(value: string) {
  return new Date(value).toLocaleString("en-US");
}
function modelStatus(m: BusinessModel) {
  return m.queued ? "Queuing" : (statusLabels[m.status] ?? m.status);
}

export function BusinessModelingPanel({ taskId, initialId }: { taskId?: string; initialId?: string }) {
  const [models, setModels] = React.useState<BusinessModel[] | null>(null);
  const [selected, setSelected] = React.useState(initialId ?? "");
  const [detail, setDetail] = React.useState<BusinessModelDetail | null>(null);
  const [version, setVersion] = React.useState<ModelVersion | null>(null);
  const [error, setError] = React.useState("");
  const [detailError, setDetailError] = React.useState("");
  const [refresh, setRefresh] = React.useState(0);
  const [creating, setCreating] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [target, setTarget] = React.useState("");
  const [name, setName] = React.useState("");
  const [environment, setEnvironment] = React.useState("default");
  const [auth, setAuth] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [sourceTask, setSourceTask] = React.useState(taskId ?? "");
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState("interfaces");
  const reload = () => setRefresh((v) => v + 1);
  React.useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const rows = await api.businessModels(taskId);
        if (disposed) return;
        setModels(rows);
        setError("");
        setSelected((current) =>
          rows.some((r) => String(r.task_id) === current) ? current : String(rows[0]?.task_id ?? ""),
        );
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 3000);
      }
    }
    void refresh;
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [taskId, refresh]);
  React.useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const row = await api.businessModel(selected);
        if (!disposed) {
          setDetail(row);
          setDetailError("");
        }
      } catch (e) {
        if (!disposed) setDetailError((e as Error).message);
      } finally {
        if (!disposed) timer = setTimeout(() => void load(), 3000);
      }
    }
    setDetail(null);
    setVersion(null);
    void refresh;
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selected, refresh]);
  React.useEffect(() => {
    if (!createOpen || taskId) return;
    let live = true;
    void api
      .tasks()
      .then((r) => {
        if (live) setTasks(r.tasks.filter((t) => t.kind !== "modeling"));
      })
      .catch((e) => toast.error((e as Error).message));
    return () => {
      live = false;
    };
  }, [createOpen, taskId]);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      const r = await api.createBusinessModel({
        target,
        name,
        environment,
        auth_context: auth,
        reason,
        ...(sourceTask ? { task_id: Number(sourceTask) } : {}),
      });
      setSelected(String(r.task_id));
      setCreateOpen(false);
      setTarget("");
      setName("");
      setReason("");
      reload();
      toast.success(r.created ? "Business modeling task created" : "A running modeling task has been associated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }
  async function control(action: "run" | "pause" | "resume" | "stop" | "retry") {
    setBusy(true);
    try {
      const r = await api.controlBusinessModel(selected, action, taskId);
      if (r.task_id) setSelected(String(r.task_id));
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download(format: "json" | "yaml") {
    try {
      const text = await api.exportBusinessModel(selected, format, version ? String(version.id) : undefined),
        url = URL.createObjectURL(
          new Blob([text], { type: format === "json" ? "application/json" : "application/yaml" }),
        );
      const a = window.document.createElement("a");
      a.href = url;
      a.download = `business-model-${selected}${version ? `-v${version.id}` : ""}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function readVersion(id: string) {
    if (!id) {
      setVersion(null);
      return;
    }
    setBusy(true);
    try {
      setVersion(await api.businessModelVersion(id));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const shown = version ?? detail;
  const document = shown?.document ?? {};
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
  const entities = shown?.entities ?? [];
  const endpoints = Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => ["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method))
      .map(([method, operation]) => ({ path, method, operation: operation as Record<string, unknown> })),
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!taskId && <WorkspaceHeader title="Business Modeling" compact actions={<>          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCwIcon />

            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon />

            New modeling
          </Button>
</>} />}
      {taskId && <div className="workspace-toolbar flex justify-end gap-2"><>          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCwIcon />

            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon />

            New modeling
          </Button>
</></div>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(18rem,25rem)_minmax(0,1fr)]">
        <RecordSurface>
          <SurfaceHeader>
            <SurfaceTitle>
              {taskId ? "Business modeling for this task" : "Modeling Task"}
              {models ? ` · ${models.length}` : ""}
            </SurfaceTitle>

          </SurfaceHeader>
          <SurfaceBody className="flex max-h-[45rem] flex-col gap-2 overflow-y-auto">
            {!models && !error && <p className="p-3 text-muted-foreground text-sm">Loading…</p>}
            {models?.length === 0 && (
              <p className="p-3 text-muted-foreground text-sm">

                There are no modeling tasks yet. It can be initiated individually or the target system can be specified in the test task.
              </p>
            )}
            {models?.map((m) => (
              <button
                type="button"
                key={String(m.task_id)}
                onClick={() => setSelected(String(m.task_id))}
                className={`min-w-0 rounded-lg border p-3 text-left transition-colors hover:bg-muted/60 ${selected === String(m.task_id) ? "border-primary bg-muted/50" : "border-border"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{m.name}</span>
                  <Badge variant={m.status === "failed" || m.status === "timeout" ? "destructive" : "secondary"}>
                    {modelStatus(m)}
                  </Badge>
                </div>
                <p className="mt-1 break-all text-muted-foreground text-xs">{m.target}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-muted-foreground text-xs">
                  <span>{triggerLabels[m.trigger_kind]}</span>
                  <span>{m.path_count ?? 0}  Path</span>
                  <span>{m.entity_count ?? 0}  Entity</span>
                  <span>{m.environment}</span>
                </div>
                <p className="mt-2 text-muted-foreground text-xs">
                  #{m.task_id} · {stamp(m.updated_at)}
                </p>
              </button>
            ))}
          </SurfaceBody>
        </RecordSurface>
        <div className="min-w-0">
          {detailError && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{detailError}</AlertDescription>
            </Alert>
          )}
          {!detail && selected && !detailError && (
            <RecordSurface>
              <SurfaceBody className="py-12 text-center text-muted-foreground">Reading modeling results...</SurfaceBody>
            </RecordSurface>
          )}
          {!selected && (
            <RecordSurface>
              <SurfaceBody className="py-16 text-center text-muted-foreground">

                Select the modeling task on the left, or create a new one.
              </SurfaceBody>
            </RecordSurface>
          )}
          {detail && (
            <RecordSurface className="min-w-0">
              <SurfaceHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <SurfaceTitle className="break-words">{detail.name}</SurfaceTitle>
                    <p className="mt-2 break-all text-muted-foreground text-sm">{detail.target}</p>
                  </div>
                  <Badge variant="secondary">{modelStatus(detail)}</Badge>
                </div>
                <div className="flex flex-wrap gap-2 text-muted-foreground text-xs">
                  <span>Environment:{detail.environment}</span>
                  <span>Identity:{detail.auth_context || "Not specified"}</span>
                  <span>Submit {detail.submissions}  times</span>
                  <span>Baseline version:{detail.base_version_id ? `#${detail.base_version_id}` : "None"}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail.status === "created" && (
                    <Button size="sm" disabled={busy} onClick={() => void control("run")}>

                      Run
                    </Button>
                  )}
                  {detail.status === "running" && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void control("pause")}>

                      Pause
                    </Button>
                  )}
                  {detail.status === "paused" && (
                    <Button size="sm" disabled={busy} onClick={() => void control("resume")}>

                      Continue
                    </Button>
                  )}
                  {["created", "running", "paused"].includes(detail.status) && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void control("stop")}>

                      Stop
                    </Button>
                  )}
                  {["done", "failed", "timeout"].includes(detail.status) && (
                    <Button size="sm" disabled={busy} onClick={() => void control("retry")}>

                      Incremental modeling
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => void download("json")}>
                    <DownloadIcon />
                    JSON
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void download("yaml")}>
                    <DownloadIcon />
                    YAML
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/function/tasks/detail?id=${detail.task_id}&tab=sessions`}>

                      Execution process
                      <ArrowUpRightIcon />
                    </Link>
                  </Button>
                </div>
                {(detail.linked_tasks ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-2 text-sm">

                    Association test:
                    {detail.linked_tasks?.map((t) => (
                      <Link
                        className="text-primary underline underline-offset-4"
                        key={String(t.task_id ?? t.id)}
                        href={`/function/tasks/detail?id=${t.task_id ?? t.id}&tab=modeling`}
                      >
                        {t.name} {t.version_id ? `· Using version #${t.version_id}` : "· Waiting for results"}
                      </Link>
                    ))}
                  </div>
                )}
              </SurfaceHeader>
              <SurfaceBody className="min-w-0">
                {detail.status !== "done" && (
                  <Alert className="mb-4">
                    <AlertDescription>
                      {detail.status === "failed" || detail.status === "timeout"
                        ? `This time it is not completed and the submitted draft is retained.${detail.stopped_reason}`
                        : "Currently showing a modeling draft; results will not be available to test tasks that depend on it until this run is successfully delivered."}
                    </AlertDescription>
                  </Alert>
                )}
                <Tabs value={tab} onValueChange={setTab} className="min-w-0">
                  <TabsList className="mb-4 flex h-auto flex-wrap">
                    <TabsTrigger value="interfaces">Interface {endpoints.length}</TabsTrigger>
                    <TabsTrigger value="entities">Business Entity {entities.length}</TabsTrigger>
                    <TabsTrigger value="coverage">Coverage and History</TabsTrigger>
                    <TabsTrigger value="events">Timeline</TabsTrigger>
                    <TabsTrigger value="document">Original document</TabsTrigger>
                  </TabsList>
                  <TabsContent value="interfaces" className="min-w-0 space-y-2">
                    {version && (
                      <p className="mb-3 text-muted-foreground text-sm">

                        Viewing historical versions #{version.id}，
                        <button type="button" className="text-primary underline" onClick={() => setVersion(null)}>

                          Return to current draft
                        </button>
                      </p>
                    )}
                    {!endpoints.length && (
                      <p className="py-8 text-center text-muted-foreground text-sm">The interface has not been committed yet.</p>
                    )}
                    {endpoints.map((e) => (
                      <details key={`${e.method}:${e.path}`} className="min-w-0 rounded-md border">
                        <summary className="cursor-pointer break-all px-3 py-3 text-sm">
                          <span className="mr-3 font-mono font-semibold text-primary uppercase">{e.method}</span>
                          <span className="font-mono">{e.path}</span>
                          <span className="ml-3 text-muted-foreground">{String(e.operation.summary ?? "")}</span>
                        </summary>
                        <div className="min-w-0 border-t p-3">
                          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                            {JSON.stringify(e.operation, null, 2)}
                          </pre>
                        </div>
                      </details>
                    ))}
                  </TabsContent>
                  <TabsContent value="entities" className="space-y-3">
                    {!entities.length && (
                      <p className="py-8 text-center text-muted-foreground text-sm">Business entities have not been organized yet.</p>
                    )}
                    {entities.map((e) => (
                      <div key={e.name} className="rounded-lg border p-4">
                        <h3 className="font-medium">{e.name}</h3>
                        <p className="mt-1 text-muted-foreground text-sm">{e.description}</p>
                        {e.fields?.map((f) => (
                          <p key={f.name} className="mt-2 break-words text-sm">
                            <code>{f.name}</code>{" "}
                            <span className="text-muted-foreground">
                              {f.type} {f.description}
                            </span>
                          </p>
                        ))}
                        {e.relations?.map((r) => (
                          <p key={`${r.target}-${r.kind ?? ""}-${r.description ?? ""}`} className="mt-2 text-sm">
                            → {r.target} · {r.kind} {r.description}
                          </p>
                        ))}
                      </div>
                    ))}
                  </TabsContent>
                  <TabsContent value="coverage" className="space-y-4">
                    <div className="whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm">
                      {shown?.summary || "Agent completes delivery with description of coverage, uncovered modules, and inferred content."}
                    </div>
                    <Label htmlFor={`model-history-${taskId ?? "all"}`}>View historical versions</Label>
                    <select
                      id={`model-history-${taskId ?? "all"}`}
                      className="w-full rounded-md border bg-background p-2 text-sm"
                      disabled={busy}
                      value={version ? String(version.id) : ""}
                      onChange={(e) => void readVersion(e.target.value)}
                    >
                      <option value="">Current modeling draft</option>
                      {detail.versions.map((v) => (
                        <option key={String(v.id)} value={String(v.id)}>

                          Version #{v.id} · {v.path_count}  path / {v.operation_count}  Operation · {stamp(v.created_at)}
                        </option>
                      ))}
                    </select>
                  </TabsContent>
                  <TabsContent value="events" className="space-y-3">
                    {detail.events.map((e) => (
                      <div key={String(e.seq)} className="rounded-lg border p-3">
                        <div className="flex flex-wrap justify-between gap-2 text-sm">
                          <span>{eventLabels[e.event_type] ?? e.event_type}</span>
                          <span className="text-muted-foreground text-xs">{stamp(e.created_at)}</span>
                        </div>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-muted-foreground text-xs">
                          {JSON.stringify(e.payload, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </TabsContent>
                  <TabsContent value="document">
                    <pre className="max-h-[40rem] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 text-xs">
                      {JSON.stringify(document, null, 2)}
                    </pre>
                  </TabsContent>
                </Tabs>
              </SurfaceBody>
            </RecordSurface>
          )}
        </div>
      </div>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle>New business modeling</DialogTitle>
            <DialogDescription className="sr-only">Operation and parameter description</DialogDescription><HelpButton topic="modeling" />
          </DialogHeader>
          <form onSubmit={(event) => void create(event)} className="grid min-w-0 gap-4 [&>div]:min-w-0">
            <div className="grid gap-2">
              <Label htmlFor="model-target">Target system address</Label>
              <Input
                id="model-target"
                required
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="https://example.com/admin"
                maxLength={2048}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="model-name">System name</Label>
              <Input
                id="model-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="For example: Mall management background"
                maxLength={120}
              />
            </div>
            {!taskId && (
              <div className="grid gap-2">
                <Label htmlFor="model-source">Associated test tasks (optional)</Label>
                <select
                  id="model-source"
                  className="w-full min-w-0 max-w-full rounded-md border bg-background p-2 text-sm"
                  value={sourceTask}
                  onChange={(e) => setSourceTask(e.target.value)}
                >
                  <option value="">Independent modeling</option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.id} {t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="model-env">Environment</Label>
                <Input
                  id="model-env"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                  placeholder="default"
                  maxLength={100}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="model-auth">Identity tag</Label>
                <Input
                  id="model-auth"
                  value={auth}
                  onChange={(e) => setAuth(e.target.value)}
                  placeholder="Anonymous/Normal User/Administrator"
                  maxLength={200}
                />
              </div>
            </div>
            <p className="text-muted-foreground text-xs">The identity tag is used to distinguish models. Please do not fill in Cookie, Token or password.</p>
            <div className="grid gap-2">
              <Label htmlFor="model-reason">Modeling instructions</Label>
              <Textarea
                id="model-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Which modules need to be covered, existing materials, the basis for discovering this system, or the content that needs to be completed this time"
                maxLength={8000}
              />
            </div>
            <Button type="submit" disabled={creating || !target.trim()}>
              {creating ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}Create modeling tasks
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
