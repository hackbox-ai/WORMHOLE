"use client";

import * as React from "react";
import { RecordSurface, SurfaceBody } from "@/components/workbench-layout";
import { ExplorationGraph } from "@/components/exploration-graph";
import { api } from "@/lib/api";
import { graphPollInterval, graphRenderSignature } from "@/lib/exploration-runtime";
import type { Edge, TaskNode } from "@/lib/types";

export function GraphTab({ taskId }: { taskId: string }) {
  const [nodes, setNodes] = React.useState<TaskNode[]>([]),
    [edges, setEdges] = React.useState<Edge[]>([]);
  const [loaded, setLoaded] = React.useState(false),
    [error, setError] = React.useState("");
  const [owner, setOwner] = React.useState(taskId);
  const retry = React.useRef<() => void>(() => {});
  React.useEffect(() => {
    let cancelled = false,
      pending = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let lastWorkAt = 0;
    let signature = "",
      latest: TaskNode[] = [];
    setOwner(taskId);
    setNodes([]);
    setEdges([]);
    setLoaded(false);
    setError("");
    const schedule = () => {
      if (cancelled) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => void load(),
        graphPollInterval(
          latest,
          document.visibilityState === "visible",
          lastWorkAt > 0 && Date.now() - lastWorkAt < 12000,
        ),
      );
    };
    const load = async () => {
      if (cancelled || pending) return;
      if (document.visibilityState !== "visible") {
        schedule();
        return;
      }
      pending = true;
      try {
        const graph = await api.explorationGraph(taskId);
        if (cancelled) return;
        const next = graph.nodes ?? [],
          links = graph.edges ?? [],
          sig = graphRenderSignature(next, links);
        if (next.some((n) => !n.inherited && n.type === "intent" && n.state === "running")) lastWorkAt = Date.now();
        latest = next;
        if (sig !== signature) {
          signature = sig;
          setNodes(next);
          setEdges(links);
        }
        setError("");
        setLoaded(true);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Graph data update failed");
          setLoaded(true);
        }
      } finally {
        pending = false;
        schedule();
      }
    };
    const refresh = () => {
      clearTimeout(timer);
      void load();
    };
    retry.current = refresh;
    document.addEventListener("visibilitychange", refresh);
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [taskId]);
  return (
    <RecordSurface className="task-path-panel h-full min-h-0">
      <SurfaceBody className="flex h-full min-h-0 flex-col p-0">
        {owner === taskId && error && (
          <div className="path-sync-notice" role="status">
            <span>{nodes.length ? "Graph data update failed, the last result has been retained." : "Figure data loading failed, please try again."}</span>
            <button type="button" onClick={() => retry.current()} title={error}>

              Try again
            </button>
          </div>
        )}
        <ExplorationGraph
          key={taskId}
          nodes={owner === taskId ? nodes : []}
          edges={owner === taskId ? edges : []}
          className="h-full min-h-[28rem]"
          emptyHint={owner === taskId && loaded ? "No exploration data yet" : "Loading…"}
        />
      </SurfaceBody>
    </RecordSurface>
  );
}
