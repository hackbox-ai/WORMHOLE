"use client";
import { HelpButton } from "@/components/user-guide";

import { useEffect, useState } from "react";

import { BookOpen } from "lucide-react";

import { PocDetails } from "@/components/poc-details";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { http } from "@/lib/api";

type Candidate = {
  id: number;
  entry_id: string;
  title: string;
  source_key: string;
  native_id: string;
  product: string;
  version: string;
  url: string;
  applicability: string;
  reason: string;
  active: boolean;
  observation_ids: number[];
  linked_intents: number;
  linked_facts: number;
};
type Results = {
  items: Candidate[];
  total: number;
  state: {
    snapshot_id: string;
    revision: number;
    planner_revision: number;
    gaps: object;
    settlement_outcome: string;
  } | null;
};
export function TaskPocs({ taskId }: { taskId: number }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Results | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [error, setError] = useState("");
  const [showStatus, setShowStatus] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => {
      void http<Results>(`/pocs/candidates?task_id=${taskId}&q=${encodeURIComponent(query)}&offset=${offset}`)
        .then((d) => {
          if (alive) {
            setData(d);
            setError("");
          }
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    };
    const timeout = setTimeout(load, 250),
      timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearTimeout(timeout);
      clearInterval(timer);
    };
  }, [open, taskId, query, offset]);
  const emptyStateText = data ? "The PoC library snapshot has not been pinned for the current task, or knowledge feeding is not enabled." : "Loading candidate and task snapshots...";
  return (
    <div>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <BookOpen />

        PoC candidates and adoption basis
      </Button>
      <Sheet
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setSelected(null);
        }}
      >
        <SheetContent className="settings-detail-sheet overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>Task PoC</SheetTitle>
            <SheetDescription className="sr-only">Operation and parameter description</SheetDescription><HelpButton topic="pocs" />
          </SheetHeader>
          <div className="space-y-4 p-5">
            {selected ? (
              <>
                <Button variant="outline" onClick={() => setSelected(null)}>

                  Return candidates
                </Button>
                <PocDetails entryId={selected.entry_id} taskId={taskId} candidateId={selected.id} />
              </>
            ) : (
              <>
                {error && (
                  <p role="alert" className="text-destructive">
                    {error}
                  </p>
                )}
                <Input
                  aria-label="Search task PoC candidates"
                  placeholder="Name, CVE, Product"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setOffset(0);
                  }}
                />
                {data?.state ? (
                  <div className="space-y-1 text-muted-foreground text-xs">
                    <p>

                      Library Snapshot {data.state.snapshot_id.slice(0, 16)}  · Candidate revisions {data.state.revision}  ·Plan reviewed{" "}
                      {data.state.planner_revision}
                    </p>
                    <Button variant="ghost" size="sm" onClick={() => setShowStatus((v) => !v)}>
                      {showStatus ? "Closed status" : "View match status"}
                    </Button>
                    {showStatus && (
                      <pre className="whitespace-pre-wrap break-all">
                        {JSON.stringify({ gaps: data.state.gaps, settlement: data.state.settlement_outcome }, null, 2)}
                      </pre>
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">{emptyStateText}</p>
                )}
                {data?.items.map((c) => (
                  <div key={c.id} className="space-y-2 border-b py-4 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <Button
                        variant="link"
                        className="h-auto whitespace-normal px-0 text-left"
                        onClick={() => setSelected(c)}
                      >
                        {c.title}
                      </Button>
                      <Badge variant="outline">
                        {({ matched: "The version conditions are met", excluded: "Version condition exclusion" } as Record<string, string>)[
                          c.applicability
                        ] ?? "Conditions to be verified"}
                      </Badge>
                    </div>
                    <p className="break-all text-xs">
                      {c.product} {c.version || "Unknown version"} · {c.url}
                    </p>
                    <p className="text-xs">

                      Candidate #{c.id}  · Fingerprint {c.observation_ids.join(", ")}  · Relevant intent {c.linked_intents}  · Relevant facts{" "}
                      {c.linked_facts}
                    </p>
                  </div>
                ))}
                {data?.state && !data.total && <p className="text-muted-foreground text-sm">There are no associated candidates yet</p>}
                <div className="flex items-center gap-3 text-xs">
                  <span>Total {data?.total ?? 0}  item</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!offset}
                    onClick={() => setOffset(Math.max(0, offset - 20))}
                  >

                    Previous page
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={offset + 20 >= (data?.total ?? 0)}
                    onClick={() => setOffset(offset + 20)}
                  >

                    Next page
                  </Button>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
