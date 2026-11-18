"use client";

import { useEffect, useState } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { http } from "@/lib/api";

type Detail = {
  title: string;
  native_id: string;
  source_key: string;
  products: string[];
  cves: string[];
  kind: string;
  severity: string;
  description: string;
  conditions: string;
  remediation: string;
  refs: string[];
  requirements: string[];
  diagnostics: string[];
  raw: string;
  next_offset: number;
  done: boolean;
  override?: { enabled: boolean; version_range: string; notes: string };
  candidate?: { reason: string };
  provenance?: { origin?: string; license?: string };
};
export function PocDetails({
  entryId,
  taskId,
  candidateId,
}: {
  entryId: string;
  taskId?: number;
  candidateId?: number;
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [raw, setRaw] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [range, setRange] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const query = taskId ? `&task_id=${taskId}${candidateId ? `&candidate_id=${candidateId}` : ""}` : "";
  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    setRaw("");
    void http<Detail>(`/pocs/entries/${entryId}?offset=0${query}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        setRaw(d.raw);
        setEnabled(d.override?.enabled ?? true);
        setRange(d.override?.version_range ?? "");
        setNotes(d.override?.notes ?? "");
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [entryId, query]);
  if (error) return <p className="text-destructive">{error}</p>;
  if (!data) return <p>Loading entries…</p>;
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h3 className="font-semibold">{data.title}</h3>
        <p className="break-all text-muted-foreground">{data.native_id}</p>
      </div>
      <p>
        {data.products.join("、") || "No product specified"}
        {data.cves.length ? ` · ${data.cves.join("、")}` : ""} ·{" "}
        {(
          { vulnerability: "Vulnerability Verification", technology: "Technology Identification", workflow: "Workflow", unparsed: "Parsing exception" } as Record<
            string,
            string
          >
        )[data.kind] ?? data.kind}
      </p>
      <Tabs defaultValue="overview">
        <TabsList className="settings-detail-tabs">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="raw">Original text</TabsTrigger>
          {!taskId && <TabsTrigger value="settings">Settings</TabsTrigger>}
          <TabsTrigger value="source">Source</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-4 pt-3">
          {data.candidate?.reason && (
            <div>
              <h4 className="font-medium">Association basis</h4>
              <p className="text-muted-foreground">{data.candidate.reason}</p>
            </div>
          )}
          <div>
            <h4 className="font-medium">Description</h4>
            <p className="whitespace-pre-wrap break-words">{data.description || "Source no description provided"}</p>
          </div>
          <div>
            <h4 className="font-medium">Applicable conditions</h4>
            <p className="whitespace-pre-wrap break-words">{data.conditions || "No version range provided"}</p>
          </div>
          {data.remediation && (
            <div>
              <h4 className="font-medium">Repair suggestions</h4>
              <p className="whitespace-pre-wrap break-words">{data.remediation}</p>
            </div>
          )}
          <p>

            Format/Dependencies:{data.requirements.map((v) => (v === "python-legacy" ? "Python" : v)).join("、") || "Not declared"}
          </p>
          {data.kind === "unparsed" && (
            <p role="alert" className="text-destructive">
              {data.diagnostics.join("；")}
            </p>
          )}
          {data.refs.length > 0 && (
            <div>
              <h4 className="font-medium">Original reference</h4>
              <pre className="whitespace-pre-wrap break-all text-xs">{data.refs.join("\n")}</pre>
            </div>
          )}
          {taskId ? (
            <p className="text-muted-foreground">Task version conditions:{data.override?.version_range || "Not specified"}</p>
          ) : null}
        </TabsContent>
        {!taskId && (
          <TabsContent value="settings" className="space-y-4 pt-3">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable entry" />
                <span>Enable entry</span>
              </div>
              <Label htmlFor="poc-version-range">Applicable version range</Label>
              <Input
                id="poc-version-range"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                placeholder="&gt;=1.0 &lt;2.0 or 5.x (optional)"
              />
              <Label htmlFor="poc-condition-notes">Condition remarks</Label>
              <Textarea id="poc-condition-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />

              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void http(`/pocs/entries/${entryId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled, version_range: range, notes }),
                  })
                    .then(() => toast.success("Settings saved"))
                    .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
                    .finally(() => setBusy(false));
                }}
              >

                Save
              </Button>
            </div>
          </TabsContent>
        )}
        <TabsContent value="raw" className="space-y-3 pt-3">
          <div>
            <h4 className="mb-2 font-medium">Original code/template</h4>
            <pre className="max-h-[32rem] overflow-auto rounded border bg-muted p-3 text-xs">{raw}</pre>
          </div>
          {!data.done && (
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => {
                setBusy(true);
                void http<Detail>(`/pocs/entries/${entryId}?offset=${data.next_offset}${query}`)
                  .then((d) => {
                    setData(d);
                    setRaw((v) => v + d.raw);
                  })
                  .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(false));
              }}
            >

              Continue reading text
            </Button>
          )}
        </TabsContent>
        <TabsContent value="source" className="space-y-4 pt-3">
          <div>
            <h4 className="font-medium">Source</h4>
            <p className="break-all text-muted-foreground">
              {data.provenance?.origin === "user" ? "Add manually" : data.provenance?.origin || "Import file"}
            </p>
          </div>
          {data.provenance?.license && (
            <div>
              <h4 className="font-medium">License</h4>
              <pre className="whitespace-pre-wrap break-words text-xs">{data.provenance.license}</pre>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
