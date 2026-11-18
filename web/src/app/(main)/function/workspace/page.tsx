"use client";
import {TaskResourceProducts} from "@/components/task-resource-products";

import * as React from "react";
import { WorkspaceCleanupDialog, workspaceSize } from "@/components/workspace-products";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";

import {
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  HardDriveIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { RecordSurface, SurfaceBody } from "@/components/workbench-layout";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { WorkspaceHeader } from "@/components/workspace-header";
import { api } from "@/lib/api";
import type { WorkspaceEntry, WorkspaceFile, WorkspaceCleanupPlan } from "@/lib/types";
import { cn } from "@/lib/utils";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type EditState = {
  file: WorkspaceFile;
  content: string;
  dirty: boolean;
  saving: boolean;
};

export default function WorkspacePage() {
  const [view, setView] = React.useState("tasks");
  const [revision, setRevision] = React.useState(0);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [plan, setPlan] = React.useState<WorkspaceCleanupPlan | null>(null);
  const [preparing, setPreparing] = React.useState(false),
    [cleaning, setCleaning] = React.useState(false);
  const cleanupRequest = React.useRef(0);
  const [path, setPath] = React.useState("");
  const [entries, setEntries] = React.useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [edit, setEdit] = React.useState<EditState | null>(null);
  const [mkdirOpen, setMkdirOpen] = React.useState(false);
  const [mkdirName, setMkdirName] = React.useState("");
  const uploadRef = React.useRef<HTMLInputElement>(null);

  const fileRequest = React.useRef(0);
  const listRequest = React.useRef(0);
  const [opening, setOpening] = React.useState(false);
  const closePreview = () => {
    if (edit?.saving || (edit?.dirty && !window.confirm("Discard unsaved file modifications?"))) return;
    fileRequest.current++;
    setOpening(false);
    setEdit(null);
  };

  const load = React.useCallback((p: string) => {
    const serial = ++listRequest.current;
    setLoading(true);
    setSelected([]);
    api
      .workspaceList(p)
      .then((r) => {
        if (serial !== listRequest.current) return;
        setEntries(r.entries);
        setPath(r.path);
      })
      .catch((e) => {
        if (serial === listRequest.current) toast.error(`Failed to read directory:${(e as Error).message}`);
      })
      .finally(() => {
        if (serial === listRequest.current) setLoading(false);
      });
  }, []);

  React.useEffect(() => {
    const query = new URLSearchParams(window.location.search),
      requested = query.get("path");
    if (requested) {
      setView("files");
      load(requested);
    } else load("");
  }, [load]);

  const crumbs = React.useMemo(() => {
    const parts = path ? path.split("/") : [];
    const acc: { name: string; path: string }[] = [{ name: "Workspace", path: "" }];
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      acc.push({ name: part, path: cur });
    }
    return acc;
  }, [path]);

  const openFile = (e: WorkspaceEntry) => {
    if (edit?.saving || (edit?.dirty && !window.confirm("Discard unsaved file modifications and open other files?"))) return;
    const request = ++fileRequest.current;
    setOpening(true);
    api
      .workspaceRead(e.path)
      .then((f) => {
        if (request === fileRequest.current)
          setEdit({ file: f, content: f.content ?? "", dirty: false, saving: false });
      })
      .catch((err) => {
        if (request === fileRequest.current) toast.error(`Failed to open file:${(err as Error).message}`);
      })
      .finally(() => {
        if (request === fileRequest.current) setOpening(false);
      });
  };

  const saveFile = () => {
    if (!edit) return;
    setEdit({ ...edit, saving: true });
    api
      .workspaceWrite(edit.file.path, edit.content)
      .then(() => {
        toast.success("Saved");
        setEdit((cur) => (cur ? { ...cur, dirty: false, saving: false } : cur));
        load(path);
      })
      .catch((err) => {
        toast.error(`Saving failed:${(err as Error).message}`);
        setEdit((cur) => (cur ? { ...cur, saving: false } : cur));
      });
  };

  const prepareCleanup = async (paths: string[]) => {
    const request = ++cleanupRequest.current;
    setPreparing(true);
    try {
      const next = await api.workspaceCleanupPreview(paths);
      if (request === cleanupRequest.current) setPlan(next);
    } catch (e) {
      if (request === cleanupRequest.current) toast.error((e as Error).message);
    } finally {
      if (request === cleanupRequest.current) setPreparing(false);
    }
  };
  const executeCleanup = async () => {
    if (!plan) return;
    setCleaning(true);
    try {
      const result = await api.workspaceCleanup(plan.token);
      setPlan(null);
      setEdit(null);
      setRevision((n) => n + 1);
      setSelected([]);
      if (result.failed.length)
        toast.error(`Deleted ${result.removed_files} files, partial failure:${result.failed[0].error}`);
      else toast.success(`Deleted ${result.removed_files} files, released ${workspaceSize(result.released_bytes)}`);
      if (view === "files") {
        const query = new URLSearchParams(window.location.search);
        query.delete("path");
        window.history.replaceState(null, "", window.location.pathname + (query.size ? "?" + query.toString() : ""));
        load("");
      }
    } catch (e) {
      toast.error((e as Error).message);
      setPlan(null);
    } finally {
      setCleaning(false);
    }
  };
  const browse = (target: string) => {
    setView("files");
    setEdit(null);
    load(target);
    const query = new URLSearchParams(window.location.search);
    query.set("path", target);
    window.history.replaceState(null, "", window.location.pathname + "?" + query.toString());
  };
  const del = (e: WorkspaceEntry) => {
    void prepareCleanup([e.path]);
  };

  const doUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    api
      .workspaceUpload(path, Array.from(files))
      .then((r) => {
        toast.success(`Uploaded ${r.uploaded} files`);
        load(path);
      })
      .catch((err) => toast.error(`Upload failed:${(err as Error).message}`))
      .finally(() => {
        if (uploadRef.current) uploadRef.current.value = "";
      });
  };

  const doMkdir = () => {
    const name = mkdirName.trim();
    if (!name) return;
    const target = path ? `${path}/${name}` : name;
    api
      .workspaceMkdir(target)
      .then(() => {
        toast.success("Directory created");
        setMkdirOpen(false);
        setMkdirName("");
        load(path);
      })
      .catch((err) => toast.error(`Creation failed:${(err as Error).message}`));
  };

  return (
    <div className="flex flex-col gap-4">
      <WorkspaceHeader title="Workspace" compact />
      <Tabs value={view} onValueChange={setView}>
        <TabsList>
          <TabsTrigger value="tasks">Task product</TabsTrigger>
          <TabsTrigger value="files">File browsing</TabsTrigger>
        </TabsList>
      </Tabs>
      {preparing && (
        <div role="status" className="text-sm text-muted-foreground">

          Generating cleanup preview...
        </div>
      )}
      {view === "tasks" && (
        <TaskResourceProducts
          revision={revision}
          onBrowse={browse}
        />
      )}
      {view === "files" && (
        <>
          {/* Head: Breadcrumbs + Actions */}
          <div className="workspace-toolbar flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1 text-sm">
              <HardDriveIcon className="text-muted-foreground mr-1 size-4 shrink-0" />
              {crumbs.map((c, i) => (
                <React.Fragment key={c.path}>
                  {i > 0 && <span className="text-muted-foreground">/</span>}
                  <button
                    type="button"
                    onClick={() => load(c.path)}
                    className={cn(
                      "max-w-[160px] truncate rounded px-1.5 py-0.5 hover:bg-accent",
                      i === crumbs.length - 1 ? "text-foreground font-medium" : "text-muted-foreground",
                    )}
                  >
                    {c.name}
                  </button>
                </React.Fragment>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!selected.length || preparing || cleaning}
                onClick={() => prepareCleanup(selected)}
              >
                <Trash2Icon />

                Clear selection{selected.length ? `（${selected.length}）` : ""}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setMkdirOpen(true)}>
                <FolderPlusIcon />  Create new folder
              </Button>
              <Button variant="outline" size="sm" onClick={() => uploadRef.current?.click()}>
                <UploadIcon />  Upload
              </Button>
              <Button variant="ghost" size="icon" className="size-8" onClick={() => load(path)} title="Refresh">
                <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
              </Button>
              <input
                ref={uploadRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => doUpload(e.target.files)}
              />
            </div>
          </div>

          <div className="workspace-file-layout">
            <RecordSurface className="workspace-file-list">
              <SurfaceBody className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          aria-label="Select current directory file"
                          disabled={loading || !entries.length}
                          checked={entries.length > 0 && entries.every((e) => selected.includes(e.path))}
                          onCheckedChange={(checked) => setSelected(checked ? entries.map((e) => e.path) : [])}
                        />
                      </TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="w-28 text-right">Size</TableHead>
                      <TableHead className="w-40">Modification time</TableHead>
                      <TableHead className="w-24 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-muted-foreground py-10 text-center text-sm">
                          {loading ? "Loading…" : "Empty directory"}
                        </TableCell>
                      </TableRow>
                    )}
                    {entries.map((e) => (
                      <TableRow key={e.path} data-selected={edit?.file.path === e.path}>
                        <TableCell>
                          <Checkbox
                            aria-label={`Select ${e.name}`}
                            checked={selected.includes(e.path)}
                            onCheckedChange={(checked) =>
                              setSelected((cur) => (checked ? [...cur, e.path] : cur.filter((p) => p !== e.path)))
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => (e.dir ? load(e.path) : openFile(e))}
                            className="flex items-center gap-2 text-left hover:underline"
                          >
                            {e.dir ? (
                              <FolderIcon className="size-4 shrink-0 text-blue-500" />
                            ) : (
                              <FileIcon className="text-muted-foreground size-4 shrink-0" />
                            )}
                            <span className="truncate font-mono text-sm">{e.name}</span>
                          </button>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right font-mono text-xs">
                          {e.dir ? "—" : fmtSize(e.size)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{fmtTime(e.mtime)}</TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            {!e.dir && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                title="Download"
                                onClick={() =>
                                  api
                                    .workspaceDownload(e.path)
                                    .catch((err) => toast.error(`Download failed:${(err as Error).message}`))
                                }
                              >
                                <DownloadIcon className="size-3.5" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive size-7"
                              title="Preview cleanup"
                              disabled={preparing || cleaning}
                              onClick={() => del(e)}
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </SurfaceBody>
            </RecordSurface>

            {/* File View / Edit */}
            <aside className="workspace-file-preview" aria-label="File preview and editing">
              {opening && <div className="border-b px-4 py-2 text-xs text-muted-foreground">Opening file...</div>}
              {edit ? (
                <>
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
                    <h2 className="flex min-w-0 flex-1 items-center gap-2 truncate font-mono text-sm">
                      <FileIcon className="size-4 shrink-0" />
                      <span className="truncate" title={edit.file.path}>
                        {edit.file.path}
                      </span>
                    </h2>
                    <span className="text-muted-foreground text-xs">{fmtSize(edit.file.size)}</span>
                    <Button size="icon-sm" variant="ghost" aria-label="Turn off file preview" onClick={closePreview}>
                      <XIcon />
                    </Button>
                  </header>

                  {edit.file.binary || edit.file.too_large ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                      <p className="text-muted-foreground text-sm">
                        {edit.file.too_large ? "The file is too large and online preview/editing is not supported." : "Binary files, online preview/editing is not supported."}
                      </p>
                      <Button variant="outline" onClick={() => api.workspaceDownload(edit.file.path)}>
                        <DownloadIcon />  Download file
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="min-h-0 flex-1 p-3">
                        <Textarea
                          disabled={opening || edit.saving}
                          value={edit.content}
                          onChange={(ev) => setEdit({ ...edit, content: ev.target.value, dirty: true })}
                          spellCheck={false}
                          className="h-full min-h-[50vh] resize-none font-mono text-xs leading-relaxed"
                        />
                      </div>
                      <footer className="flex flex-wrap items-center justify-between gap-2 border-t p-3">
                        <span className="text-muted-foreground text-xs">{edit.dirty ? "Unsaved changes" : "Synced"}</span>
                        <div className="flex gap-2">
                          <Button variant="outline" onClick={() => api.workspaceDownload(edit.file.path)}>
                            <DownloadIcon />  Download
                          </Button>
                          <Button onClick={saveFile} disabled={!edit.dirty || edit.saving || opening}>
                            <SaveIcon /> {edit.saving ? "Saving…" : "Save"}
                          </Button>
                        </div>
                      </footer>
                    </>
                  )}
                </>
              ) : (
                <div className="workspace-preview-empty">
                  <FileIcon className="size-7" />
                  <p>Select file to view content</p>
                  <span>Support text editing, uploading and downloading</span>
                </div>
              )}
            </aside>
          </div>
        </>
      )}
      <WorkspaceCleanupDialog
        plan={plan}
        busy={cleaning}
        onClose={() => setPlan(null)}
        onConfirm={() => void executeCleanup()}
      />
      {/* Create new folder */}
      <Dialog open={mkdirOpen} onOpenChange={setMkdirOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create new folder</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doMkdir()}
            placeholder="Folder name"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setMkdirOpen(false)}>

              Cancel
            </Button>
            <Button onClick={doMkdir} disabled={!mkdirName.trim()}>

              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
