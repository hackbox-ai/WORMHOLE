import { projectFindingPaths } from "./exploration-view";
import type { Edge, TaskNode } from "./types";
import assert from "node:assert/strict";
import { test } from "node:test";

const node = (id: string, type: TaskNode["type"] = "fact", finding_path = false): TaskNode => ({
  id,
  type,
  state: type === "digest" ? "active" : "confirmed",
  priority: 0,
  origin: "fixture",
  ts: "2026-10-21T00:00:00Z",
  finding_path,
});
test("digest contraction preserves path nodes and parallel merged path edges without coloring unrelated members", () => {
  const nodes = [
    node("root"),
    node("digest", "digest"),
    node("hit", "intent", true),
    node("miss", "intent"),
    node("finding", "finding", true),
    node("other"),
  ];
  const edges: Edge[] = [
    { src: "digest", dst: "hit", rel: "covers" },
    { src: "digest", dst: "miss", rel: "covers" },
    { src: "root", dst: "miss", rel: "derived_from" },
    { src: "root", dst: "hit", rel: "derived_from", finding_path: true },
    { src: "hit", dst: "finding", rel: "yields", finding_path: true },
    { src: "miss", dst: "other", rel: "yields" },
  ];
  const view = projectFindingPaths(
    nodes,
    edges,
    [nodes[0], nodes[1], nodes[4], nodes[5]],
    [
      { src: "root", dst: "digest", rel: "derived_from" },
      { src: "digest", dst: "finding", rel: "yields" },
      { src: "digest", dst: "other", rel: "yields" },
    ],
  );
  assert.ok(view.viewNodes.find((n) => n.id === "digest")?.finding_path);
  assert.ok(view.viewEdges[0].finding_path);
  assert.ok(view.viewEdges[1].finding_path);
  assert.ok(!view.viewEdges[2].finding_path);
  assert.ok(!view.viewNodes.find((n) => n.id === "other")?.finding_path);
  assert.equal(nodes[1].finding_path, false);
  assert.equal(edges[2].finding_path, undefined);
});
