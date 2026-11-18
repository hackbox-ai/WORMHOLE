"use client";

import * as React from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { WorkspaceFile, WorkspaceListing } from "@/lib/types";

export function ConversationFiles({ id }: { id: number }) {
  const root = "sessions/" + id;
  const [open, setOpen] = React.useState(false);
  const [directory, setDirectory] = React.useState(root);
  const [entries, setEntries] = React.useState<WorkspaceListing["entries"]>([]);
  const [selected, setSelected] = React.useState("");
  const [file, setFile] = React.useState<WorkspaceFile | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError("");
    setFile(null);
    const load = async () => {
      try {
        if (selected) {
          const value = await api.workspaceRead(selected);
          if (active) setFile(value);
        } else {
          const value = await api.workspaceList(directory);
          if (active) setEntries(value.entries ?? []);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Failed to read workspace");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [open, directory, selected]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Session File" title="Session File">
          <FolderOpen />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogTitle>Session File</DialogTitle>
        <DialogDescription>{(selected || directory).slice(root.length + 1) || "Working directory"}</DialogDescription>
        {(selected || directory !== root) && (
          <Button variant="ghost" size="sm" className="w-fit" onClick={() => {
            if (selected) setSelected("");
            else setDirectory(directory.slice(0, directory.lastIndexOf("/")));
          }}>Back</Button>
        )}
        <div className="max-h-[50vh] overflow-auto text-sm">
          {loading ? <p>Reading...</p> : error ? <p className="text-muted-foreground">{error}</p> : file ? (
            file.binary || file.too_large
              ? <p className="text-muted-foreground">This file is suitable for downloading and viewing in the workspace.</p>
              : <pre className="whitespace-pre-wrap break-all">{file.content}</pre>
          ) : (
            entries.length ? entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  if (!entry.path.startsWith(root + "/")) return;
                  if (entry.dir) setDirectory(entry.path);
                  else setSelected(entry.path);
                }}
              >{entry.dir ? entry.name + "/" : entry.name}</button>
            )) : <p className="text-muted-foreground">No files yet</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
