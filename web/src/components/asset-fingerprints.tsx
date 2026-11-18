"use client";
import { HelpButton } from "@/components/user-guide";
import { useState } from "react";

import { Fingerprint, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { http } from "@/lib/api";

type Observation = {
  id: string;
  product: string;
  version: string;
  family: string;
  rule_id: string;
  url: string;
  method: string;
  observed_at: string;
  evidence: string;
  locations: string[];
  material_id: string;
  response_sha256: string;
  favicon_sha256?: string;
};
type Results = {
  enabled: boolean;
  orchestration?: { bootstrap_state: string; revision: string; planner_revision: string; settlement_outcome: string };
  observations: Observation[];
  jobs: { state: string; count: number; missing_count: number }[];
};
export function AssetFingerprints({ taskId, assetId }: { taskId: number; assetId: number }) {
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Results | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      setData(await http<Results>(`/fingerprints/observations?task_id=${taskId}&asset_id=${assetId}`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 h-6 px-0 text-muted-foreground text-xs"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <Fingerprint className="size-3" />

        Fingerprint basis
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="settings-detail-sheet overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>Asset fingerprint basis</SheetTitle>
            <SheetDescription className="sr-only">Operation and parameter description</SheetDescription><HelpButton topic="fingerprints" />
          </SheetHeader>
          <div className="space-y-4 p-4">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
              <RefreshCw className="size-3" />

              Refresh results
            </Button>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            {data && !data.enabled && (
              <p className="text-muted-foreground text-sm">Automatic recognition is currently turned off, and historical evidence can still be viewed.</p>
            )}
            {data?.orchestration && (
              <div className="space-y-1 rounded-lg border p-3 text-muted-foreground text-xs">
                <p>

                  Entrance collection:
                  {(
                    {
                      pending: "Waiting to start",
                      running: "Collecting",
                      done: "Completed",
                      partial: "Partially incomplete",
                      disabled: "Closed",
                    } as Record<string, string>
                  )[data.orchestration.bootstrap_state] ?? data.orchestration.bootstrap_state}
                </p>
                <p>

                  Fingerprint revision {data.orchestration.revision}  · The plan has been reviewed to {data.orchestration.planner_revision ?? "0"}
                </p>
                {data.orchestration.settlement_outcome === "timed_out" && (
                  <p>The finishing wait has reached the upper limit, and there are still unprocessed materials or unreviewed results. Please check the gap with the task record.</p>
                )}
              </div>
            )}
            {data?.jobs.some((j) => j.state === "pending" || j.state === "running") && (
              <p className="text-muted-foreground text-sm">The identification is queued or processed.</p>
            )}
            {data?.jobs.some((j) => j.missing_count > 0) && (
              <p className="text-muted-foreground text-sm">Some rules lack icon materials and cannot be judged yet.</p>
            )}
            {data?.jobs.some((j) => j.state === "failed") && (
              <p className="text-destructive text-sm">Partial recognition is not completed, please check the fingerprint service and try again.</p>
            )}
            {data && !data.observations.length && (
              <p className="rounded-lg border p-4 text-muted-foreground text-sm">

                No fingerprint hits yet. The task needs to obtain the entry response first; a miss does not mean that the relevant product does not exist.
              </p>
            )}
            {data?.observations.map((item) => (
              <div key={item.id} className="space-y-2 border-b py-4">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {item.product}
                  {item.version && <span>{item.version}</span>}
                  <Badge variant="secondary">{item.family}</Badge>
                </div>
                <p className="break-all font-mono text-xs">
                  {item.method} {item.url}
                </p>
                <p className="text-muted-foreground text-xs">
                  {new Date(item.observed_at).toLocaleString()} · {item.locations.join("、")}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEvidenceId(evidenceId === item.id ? null : item.id)}
                >
                  {evidenceId === item.id ? "Close evidence" : "View evidence"}
                </Button>
                {evidenceId === item.id && (
                  <div className="mt-2 space-y-2 break-all text-muted-foreground">
                    <p>Rules:{item.rule_id}</p>
                    <p>Response SHA256:{item.response_sha256}</p>
                    {item.favicon_sha256 && <p>Icon SHA256:{item.favicon_sha256}</p>}
                    <p>Materials:{item.material_id}</p>
                    <p>{item.evidence}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
