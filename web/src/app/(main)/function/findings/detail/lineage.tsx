"use client";

import * as React from "react";

import { ExplorationGraph } from "@/components/exploration-graph";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { Edge, TaskNode } from "@/lib/types";

// FindingLineageView renders the exploration sub-graph from the task's initial
// node down to this finding's node — the same Attack link diagram canvas as the task graph,
// scoped to just this finding's lineage.
export function FindingLineageView({ findingId }: { findingId: string }) {
  const [nodes, setNodes] = React.useState<TaskNode[]>([]);
  const [edges, setEdges] = React.useState<Edge[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState("");
  const [_retry, setRetry] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setLoaded(false);
    setNodes([]);
    setEdges([]);
    setError("");
    api
      .findingLineage(findingId)
      .then((g) => {
        if (!alive) return;
        setNodes(g.nodes ?? []);
        setEdges(g.edges ?? []);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [findingId, _retry]);

  if (error)
    return (
      <div role="alert" className="flex items-center gap-3 p-6 text-sm">
        <span className="text-destructive">Link loading failed:{error}</span>
        <Button size="sm" variant="outline" onClick={() => setRetry((v) => v + 1)}>

          Try again
        </Button>
      </div>
    );

  if (loaded && nodes.length === 0) {
    return <p className="p-6 text-muted-foreground text-sm">It was found that there is no available exploration node record and the execution path cannot be restored.</p>;
  }

  return (
    <ExplorationGraph
      key={findingId}
      nodes={nodes}
      edges={edges}
      fitInitialView
      className="h-[68vh]"
      emptyHint={loaded ? "No link" : "Loading…"}
    />
  );
}
