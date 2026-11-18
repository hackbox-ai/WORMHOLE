"use client";
import { HelpButton } from "@/components/user-guide";
import {NetworkModePicker,type NetworkChoice} from "@/components/network-mode";

import * as React from "react";

import Link from "next/link";

import { LayersIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { toast } from "sonner";

import { TaskLLMProfileChain } from "@/components/task-llm-profile-chain";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api, http } from "@/lib/api";
import type { LLMProfile } from "@/lib/types";

type Preview = {
  items: { line: number; target: string }[];
  errors: { line: number; error: string }[];
  duplicates: { line: number }[];
};
type Batch = {
  id: string;
  name: string;
  total: number;
  waiting: number;
  running: number;
  paused_tasks: number;
  done: number;
  failed: number;
  paused: boolean;
};
type Child = {
  id: number;
  target_input: string;
  batch_position: number;
  status: string;
  queued: boolean;
  paused: boolean;
  findings: number;
  stopped_reason: string;
};
type Detail = { batch: Batch; tasks: Child[] };
const actions = [
  ["pause_queue", "Pause queuing"],
  ["pause_all", "Pause all"],
  ["resume", "Continue batch"],
  ["cancel_waiting", "Cancel waiting"],
  ["stop_all", "Stop all"],
] as const;
const childStatus = (t: Child) =>
  ({ done: "Completed", failed: "Stopped", timeout: "Timed out" })[t.status] ??
  (t.paused ? "Paused" : t.queued ? "Queuing" : "Running");

export function BatchTasks({ onChanged }: { onChanged: () => unknown }) {
  const [open, setOpen] = React.useState(false),
    [manage, setManage] = React.useState(false);
  const [targets, setTargets] = React.useState(""),
    [requirements, setRequirements] = React.useState(""),
    [minutes, setMinutes] = React.useState("30");
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]),
    [chain, setChain] = React.useState<string[]>([]);
  const [preview, setPreview] = React.useState<Preview | null>(null),
    [previewError, setPreviewError] = React.useState(""),
    [loading, setLoading] = React.useState(false),
    [saving, setSaving] = React.useState(false);
  const [batches, setBatches] = React.useState<Batch[]>([]),
    [selected, setSelected] = React.useState(""),
    [detail, setDetail] = React.useState<Detail | null>(null),
    [listError, setListError] = React.useState(""),
    [busy, setBusy] = React.useState(""),
    [confirm, setConfirm] = React.useState("");
  const [network,setNetwork]=React.useState<NetworkChoice>({});
  const id = React.useRef({ key: "", value: "" }),
    form = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    Promise.all([http<{ timeout_seconds: number }>("/task-batches/options"), api.llmProfiles()])
      .then(([options, all]) => {
        if (live) {
          setMinutes(String(options.timeout_seconds / 60));
          setProfiles(all);
        }
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open]);
  React.useEffect(() => {
    setPreview(null);
    setPreviewError("");
    if (!open || !targets.trim()) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      http<Preview>("/task-batches/preview", {
        method: "POST",
        body: JSON.stringify({ targets }),
        signal: abort.signal,
      })
        .then(setPreview)
        .catch((e) => {
          if (!abort.signal.aborted) setPreviewError((e as Error).message);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [targets, open]);
  const refresh = React.useCallback(
    async (signal?: AbortSignal) => {
      try {
        const list = await http<{ items: Batch[] }>("/task-batches", { signal });
        setBatches(list.items);
        if (selected) setDetail(await http<Detail>(`/task-batches/${selected}`, { signal }));
        setListError("");
      } catch (e) {
        if (!signal?.aborted) setListError((e as Error).message);
      }
    },
    [selected],
  );
  React.useEffect(() => {
    if (!manage) return;
    const abort = new AbortController();
    void refresh(abort.signal);
    const timer = setInterval(() => void refresh(abort.signal), 4000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [manage, refresh]);
  async function create() {
    const seconds = Number(minutes) * 60;
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400) {
      toast.error("Single task timeout is 1–1440 minutes, accurate to the second");
      return;
    }
    if (!preview?.items.length || preview.errors.length) return;
    const formKey = JSON.stringify({ targets, requirements, minutes, chain, network });
    if (id.current.key !== formKey) id.current = { key: formKey, value: crypto.randomUUID() };
    setSaving(true);
    try {
      const result = await http<{ id: string; total: number }>("/task-batches", {
        method: "POST",
        body: JSON.stringify({
          targets,
          ...network,
          requirements,
          timeout_seconds: seconds,
          llm_profile_ids: chain.map(Number),
          idempotency_key: id.current.value,
        }),
      });
      toast.success(`Joined ${result.total} tasks`);
      id.current={key:'',value:''};
      setOpen(false);
      setTargets("");
      setRequirements("");
      setSelected(result.id);
      setManage(true);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function control(action: string) {
    setBusy(action);
    try {
      const result = await http<{ items: { ok: boolean; error?: string }[] }>(`/task-batches/${selected}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      const errors = result.items.filter((i) => !i.ok);
      if (errors.length) toast.error(`${errors.length} tasks were not updated:${errors[0].error ?? "Status changed"}`);
      else toast.success("Batch updated");
      await refresh();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setManage(true)}>
        <LayersIcon />

        Batch
      </Button>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <PlusIcon />

        Batch new
      </Button>
      <Sheet
        open={open}
        onOpenChange={(v) => {
          if (!saving) setOpen(v);
        }}
      >
        <SheetContent className="flex h-full w-full! max-w-none! flex-col gap-0 overflow-hidden p-0 sm:w-[48rem]! sm:max-w-[48rem]!" ref={form}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>Batch new tasks</SheetTitle>
            <SheetDescription className="sr-only">Operation and parameter description</SheetDescription><HelpButton topic="tasks" />
          </SheetHeader>
          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-4">
            <div className="grid gap-2">
              <Label htmlFor="batch-targets">Target</Label>
              <Textarea
                id="batch-targets"
                className="min-h-52 font-mono text-sm"
                placeholder={"example.com\n192.0.2.10\nhttps://example.net/app"}
                value={targets}
                maxLength={1024 * 1024}
                disabled={saving}
                onChange={(e) => setTargets(e.target.value)}
              />
              <div role="status" className="text-muted-foreground text-sm">
                {preview
                  ? `${preview.items.length} valid targets · ${preview.duplicates.length} duplicates · ${preview.errors.length} invalid`
                  : targets.trim()
                    ? "Verifying..."
                    : "Supports domain names, IPs, and HTTP/HTTPS URLs."}
                {previewError && <span className="text-destructive">{previewError}</span>}
              </div>
              {!!preview?.errors.length && (
                <div className="max-h-32 overflow-y-auto rounded-md border border-destructive/30 p-3 text-destructive text-sm">
                  {preview.errors.map((e) => (
                    <p key={e.line}>

                      No. {e.line}  Line:{e.error}
                    </p>
                  ))}
                </div>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="batch-timeout">Single task timeout (minutes)</Label>
              <Input
                id="batch-timeout"
                className="w-40"
                type="number"
                min={1}
                max={1440}
                step="any"
                value={minutes}
                disabled={loading || saving}
                onChange={(e) => setMinutes(e.target.value)}
              />

            </div>
            <div className="grid gap-3">
              <Label htmlFor="batch-model">Model configuration</Label>
              <NetworkModePicker value={network} onChange={setNetwork}/>
              <TaskLLMProfileChain
                profiles={profiles}
                value={chain}
                onValueChange={setChain}
                inputId="batch-model"
                disabled={loading || saving}
                portalContainer={form}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="batch-requirements">Supplementary requirements (optional)</Label>
              <Textarea
                id="batch-requirements"
                maxLength={8000}
                value={requirements}
                disabled={saving}
                onChange={(e) => setRequirements(e.target.value)}
                placeholder="Test requirements common to all tasks"
              />
            </div>
            <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-6">
              <p className="font-medium">Continuous mining · 1 Worker per task</p>

            </div>
          </div>
          <SheetFooter className="border-t sm:flex-row">
            <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>

              Cancel
            </Button>
            <Button disabled={saving || loading || !preview?.items.length || !!preview.errors.length} onClick={create}>
              {saving && <Loader2Icon className="animate-spin" />}Create {preview?.items.length ?? 0}  tasks
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <Sheet open={manage} onOpenChange={setManage}>
        <SheetContent className="flex h-full w-full! max-w-none! flex-col gap-0 overflow-hidden p-0 sm:w-[48rem]! sm:max-w-[48rem]!">
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>Task batch</SheetTitle>
            <SheetDescription className="sr-only">Operation and parameter description</SheetDescription><HelpButton topic="tasks" />
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {listError && (
              <p role="alert" className="mb-4 text-destructive text-sm">
                {listError}
              </p>
            )}
            {!selected ? (
              <div className="grid gap-3">
                {!batches.length && <p className="py-12 text-center text-muted-foreground text-sm">No batch yet</p>}
                {batches.map((b) => (
                  <button
                    type="button"
                    key={b.id}
                    className="rounded-lg border p-4 text-left hover:bg-muted/40"
                    onClick={() => {
                      setDetail(null);
                      setSelected(b.id);
                    }}
                  >
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">{b.name}</span>
                      {b.paused && <Badge variant="secondary">Distribution has been suspended</Badge>}
                    </div>
                    <p className="mt-2 text-muted-foreground text-sm">

                      Total {b.total}  · Run {b.running}  · Waiting {b.waiting}  · Pause {b.paused_tasks}  · Completed {b.done}  ·
                      Stop/Timeout {b.failed}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-3"
                  onClick={() => {
                    setSelected("");
                    setDetail(null);
                  }}
                >

                  Return to batch list
                </Button>
                {detail ? (
                  <>
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <h3 className="font-medium">{detail.batch.name}</h3>
                      {detail.batch.paused && <Badge variant="secondary">Distribution has been suspended</Badge>}
                    </div>
                    <div className="mb-4 flex flex-wrap gap-2">
                      {actions.map(([action, label]) => (
                        <Button
                          key={action}
                          size="sm"
                          variant="outline"
                          disabled={!!busy}
                          onClick={() => {
                            if (action === "stop_all" || action === "cancel_waiting") setConfirm(action);
                            else void control(action);
                          }}
                        >
                          {busy === action && <Loader2Icon className="animate-spin" />}
                          {label}
                        </Button>
                      ))}
                    </div>
                    <div className="overflow-hidden rounded-lg border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/40 text-muted-foreground">
                          <tr>
                            <th className="p-3 text-left">Target</th>
                            <th className="p-3 text-left">Status</th>
                            <th className="p-3 text-right">Discovery</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.tasks.map((t) => (
                            <tr key={t.id} className="border-t">
                              <td className="max-w-80 break-all p-3">
                                <span className="mr-2 text-muted-foreground tabular-nums">{t.batch_position}</span>
                                <Link className="hover:underline" href={`/function/tasks/detail?id=${t.id}`}>
                                  {t.target_input}
                                </Link>
                              </td>
                              <td className="whitespace-nowrap p-3" title={t.stopped_reason}>
                                {childStatus(t)}
                              </td>
                              <td className="p-3 text-right tabular-nums">{t.findings}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <p className="py-8 text-center text-muted-foreground">Loading…</p>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v) setConfirm("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "stop_all" ? "Stop the entire batch?" : "Cancel pending tasks?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "stop_all"
                ? "Stopping a running task and unqueuing it, saved findings and evidence are retained."
                : "Cancel tasks that have not yet started, and continue running tasks."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void control(confirm);
                setConfirm("");
              }}
            >

              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
