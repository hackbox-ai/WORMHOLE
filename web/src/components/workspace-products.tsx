"use client";

import * as React from "react";
import { FolderOpenIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { WorkspaceTaskUsage, WorkspaceCleanupPlan, WorkspaceCleanupHistory } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RecordSurface, SurfaceBody } from "@/components/workbench-layout";

export function workspaceSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
const statusNames: Record<string, string> = {
  created: "To be started",
  running: "Running",
  paused: "Paused",
  done: "Completed",
  failed: "Stopped/Failed",
  timeout: "Timed out",
  cancelled: "Canceled",
  stopped: "Stopped",
  unknown: "No associated tasks",
};

export function WorkspaceProducts({
  onBrowse,
  onClean,
  revision,
}: {
  onBrowse: (path: string) => void;
  onClean: (paths: string[]) => void;
  revision: number;
}) {
  const [data, setData] = React.useState<{
    tasks: WorkspaceTaskUsage[];
    disk_bytes: number;
    file_count: number;
    scanned_at: number;
  } | null>(null);
  const [loading, setLoading] = React.useState(true),
    [error, setError] = React.useState("");
  const [search, setSearch] = React.useState(""),
    [status, setStatus] = React.useState("all"),
    [sort, setSort] = React.useState("size");
  const [selected, setSelected] = React.useState<string[]>([]),
    [history, setHistory] = React.useState<WorkspaceCleanupHistory[] | null>(null);
  const request = React.useRef(0);
  const load = React.useCallback(() => {
    const serial = ++request.current;
    setLoading(true);
    setError("");
    api
      .workspaceTasks()
      .then((r) => {
        if (serial !== request.current) return;
        setData(r);
        setSelected([]);
      })
      .catch((e) => {
        if (serial === request.current) setError((e as Error).message);
      })
      .finally(() => {
        if (serial === request.current) setLoading(false);
      });
  }, []);
  React.useEffect(() => {
    load();
    return () => {
      request.current++;
    };
  }, [load, revision]);
  const rows = React.useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^#/, "");
    return (data?.tasks ?? [])
      .filter(
        (t) =>
          (!q || t.name.toLowerCase().includes(q) || String(t.task_id).includes(q)) &&
          (status === "all" ||
            (status === "ended"
              ? ["done", "failed", "timeout", "cancelled", "stopped"].includes(t.status)
              : t.status === status)),
      )
      .sort((a, b) =>
        sort === "files"
          ? b.file_count - a.file_count
          : sort === "time"
            ? b.mtime - a.mtime
            : b.disk_bytes - a.disk_bytes,
      );
  }, [data, search, status, sort]);
  const eligible = rows.filter((t) => t.cleanable && t.file_count > 0).map((t) => t.path);
  const picked = (data?.tasks ?? []).filter((t) => selected.includes(t.path) && t.cleanable);
  const historyLoad = async () => {
    try {
      setHistory((await api.workspaceCleanupHistory()).items);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <>
      <RecordSurface>
        <SurfaceBody className="flex flex-wrap items-center gap-x-10 gap-y-3 py-4">
          <div>
            <div className="text-xs text-muted-foreground">Task file occupied</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{data ? workspaceSize(data.disk_bytes) : "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Task Directory</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{data?.tasks.length ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Number of files</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{data?.file_count.toLocaleString() ?? "—"}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={historyLoad}>

              Clear records
            </Button>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCwIcon className={loading ? "animate-spin" : ""} />
              {loading ? "Statistical..." : "Refresh statistics"}
            </Button>
          </div>
        </SurfaceBody>
      </RecordSurface>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search task name or number"
          aria-label="Search task products"
          className="h-9 max-w-xs"
        />
        <select
          aria-label="Task status"
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">All status</option>
          <option value="ended">Ended</option>
          <option value="running">Running</option>
          <option value="paused">Paused</option>
        </select>
        <select
          aria-label="Sort by"
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="size">Occupied from large to small</option>
          <option value="files">Number of files from most to least</option>
          <option value="time">Recently modified</option>
        </select>
        <Button
          className="ml-auto"
          variant="outline"
          size="sm"
          disabled={!picked.length || loading}
          onClick={() => onClean(picked.map((t) => t.path))}
        >
          <Trash2Icon />

          Clear selection{picked.length ? `（${picked.length}）` : ""}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">

        Count the disk usage of files in the task directory, excluding original traffic and shared storage.
        {data && ` Updated on ${new Date(data.scanned_at).toLocaleTimeString("en-US")}`}
      </p>
      {error && (
        <div role="alert" className="text-sm text-destructive">

          Statistics failed:{error}{" "}
          <Button variant="link" size="sm" onClick={load}>

            Try again
          </Button>
        </div>
      )}
      <RecordSurface>
        <SurfaceBody className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select current list to clear tasks"
                    disabled={!eligible.length || loading}
                    checked={eligible.length > 0 && eligible.every((p) => selected.includes(p))}
                    onCheckedChange={(checked) =>
                      setSelected((cur) =>
                        checked ? [...new Set([...cur, ...eligible])] : cur.filter((p) => !eligible.includes(p)),
                      )
                    }
                  />
                </TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Space occupied</TableHead>
                <TableHead className="text-right">Number of files</TableHead>
                <TableHead>Last modified</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                    {loading ? "Counting task files..." : error ? "Temporarily unable to read" : "There is no task product yet"}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((t) => (
                <TableRow key={t.path}>
                  <TableCell>
                    <Checkbox
                      aria-label={`Select task ${t.task_id}`}
                      checked={selected.includes(t.path)}
                      disabled={!t.cleanable || !t.file_count || loading}
                      onCheckedChange={(checked) =>
                        setSelected((cur) => (checked ? [...cur, t.path] : cur.filter((p) => p !== t.path)))
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="max-w-sm truncate text-left text-sm hover:underline"
                      onClick={() => onBrowse(t.path)}
                    >
                      {t.name}
                    </button>
                    <div className="text-xs text-muted-foreground">#{t.task_id}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{statusNames[t.status] ?? t.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs" title={`File content size ${workspaceSize(t.bytes)}`}>
                    {workspaceSize(t.disk_bytes)}
                    {t.incomplete && <span title="Some files cannot be counted"> *</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{t.file_count.toLocaleString()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.mtime
                      ? new Date(t.mtime).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => onBrowse(t.path)}>
                        <FolderOpenIcon />

                        File
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!t.cleanable || !t.file_count || loading}
                        title={t.blocked_reason || "Preview cleanup list"}
                        onClick={() => onClean([t.path])}
                      >
                        <Trash2Icon />

                        Cleanup
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SurfaceBody>
      </RecordSurface>
      <Dialog
        open={history !== null}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Clear records</DialogTitle>
            <DialogDescription>Document the scope and results of manual cleanup.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Operator</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!history?.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">

                      No cleanup record yet
                    </TableCell>
                  </TableRow>
                )}
                {history?.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(h.ts).toLocaleString("en-US")}
                    </TableCell>
                    <TableCell className="max-w-sm break-all font-mono text-xs">
                      {h.payload.paths?.join("、")}
                    </TableCell>
                    <TableCell className="text-xs">{h.actor}</TableCell>
                    <TableCell className="text-xs" title={h.error}>
                      {!["completed", "partial"].includes(h.state)
                        ? ({ running: "Cleaning up", failed: "Failure", interrupted: "Interrupted" }[h.state] ?? h.state)
                        : `Deleted ${h.payload.removed_files ?? 0} files, released ${workspaceSize(h.payload.released_bytes ?? 0)}${h.payload.failed?.length ? ", partial failure" : ""}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function WorkspaceCleanupDialog({
  plan,
  busy,
  onClose,
  onConfirm,
}: {
  plan: WorkspaceCleanupPlan | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [filter, setFilter] = React.useState("");
  React.useEffect(() => setFilter(""), [plan?.token]);
  const files = plan?.items.filter((i) => i.kind !== "directory") ?? [];
  const matches = files.filter((i) => i.path.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Dialog
      open={!!plan}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Clean preview</DialogTitle>
          <DialogDescription>

            Delete ordinary files in the selected range, retaining attachments and identified evidence. Please manually check unregistered files; they cannot be recovered after deletion.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <span>

            To be deleted <strong>{plan?.removable_files ?? 0}</strong>  files
          </span>
          <span>

            Expected release <strong>{workspaceSize(plan?.removable_disk_bytes ?? 0)}</strong>
          </span>
          <span>

            Reserved <strong>{plan?.protected_files ?? 0}</strong>  protected files
          </span>
        </div>
        <Input
          aria-label="Filter preview files"
          placeholder="Filter file paths"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="max-h-[45vh] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Processing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matches.slice(0, 500).map((i) => (
                <TableRow key={i.path}>
                  <TableCell className="max-w-xl break-all whitespace-normal font-mono text-xs">{i.path}</TableCell>
                  <TableCell className="text-right whitespace-nowrap text-xs">{workspaceSize(i.bytes)}</TableCell>
                  <TableCell
                    className={i.protected_reason ? "text-xs text-muted-foreground" : "text-xs text-destructive"}
                  >
                    {i.protected_reason ? `Reserved:${i.protected_reason}` : "Delete"}
                  </TableCell>
                </TableRow>
              ))}
              {!matches.length && (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">

                    No matching files
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {matches.length > 500 && (
          <p className="text-xs text-muted-foreground">Display first 500 items, total {matches.length}  item; you can filter and view by path.</p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>

            Cancel
          </Button>
          <Button variant="destructive" disabled={busy || !plan?.removable_files} onClick={onConfirm}>
            {busy ? "Cleaning up..." : "Confirm deletion"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
