import type { Edge, TaskNode } from "@/lib/types";

/** Preserve path membership after digest contraction, including merged edges
 * whose first representative was an ordinary, unhighlighted edge. */
export function projectFindingPaths(nodes: TaskNode[], edges: Edge[], viewNodes: TaskNode[], viewEdges: Edge[]) {
  const active = new Set(nodes.filter((n) => n.type === "digest" && n.state === "active").map((n) => n.id));
  const members = new Map(edges.filter((e) => e.rel === "covers" && active.has(e.src)).map((e) => [e.dst, e.src]));
  const remap = (id: string) => members.get(id) ?? id;
  const nodeIds = new Set(nodes.filter((n) => n.finding_path).map((n) => remap(n.id)));
  const key = (e: Edge) => JSON.stringify([remap(e.src), e.rel, remap(e.dst)]);
  const edgeKeys = new Set(edges.filter((e) => e.finding_path && e.rel !== "covers").map(key));
  return {
    viewNodes: viewNodes.map((n) => (nodeIds.has(n.id) ? { ...n, finding_path: true } : n)),
    viewEdges: viewEdges.map((e) => (edgeKeys.has(key(e)) ? { ...e, finding_path: true } : e)),
  };
}

/** Collapse descendants while retaining branches that have another visible parent. */
export function collapseBranches(nodes: TaskNode[], edges: Edge[], roots: Set<string>) {
  const ids = new Set(nodes.map((node) => node.id));
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.src) || !ids.has(edge.dst)) continue;
    next.set(edge.src, [...(next.get(edge.src) ?? []), edge.dst]);
  }
  const branches = new Map<string, Set<string>>();
  const candidates = new Set<string>();
  for (const root of roots) {
    const members = new Set<string>();
    const queue = [...(next.get(root) ?? [])];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (id === root || members.has(id)) continue;
      members.add(id);
      queue.push(...(next.get(id) ?? []));
    }
    branches.set(root, members);
    for (const id of members) if (!roots.has(id)) candidates.add(id);
  }
  const retained = new Set<string>();
  const external = edges
    .filter((edge) => candidates.has(edge.dst) && !roots.has(edge.src) && !candidates.has(edge.src))
    .map((edge) => edge.dst);
  for (let i = 0; i < external.length; i++) {
    const id = external[i];
    if (!candidates.has(id) || retained.has(id)) continue;
    retained.add(id);
    external.push(...(next.get(id) ?? []));
  }
  const hidden = new Set([...candidates].filter((id) => !retained.has(id)));
  const counts = new Map(
    [...branches].map(([id, members]) => [id, [...members].filter((member) => hidden.has(member)).length]),
  );
  return {
    nodes: nodes.filter((node) => !hidden.has(node.id)),
    edges: edges.filter((edge) => !hidden.has(edge.src) && !hidden.has(edge.dst)),
    counts,
    hiddenCount: hidden.size,
  };
}

export function runningNeighborhood(nodes: TaskNode[], edges: Edge[]) {
  const visible = new Set(
    nodes
      .filter((node) => node.type === "intent" && node.state === "running" && !node.inherited)
      .map((node) => node.id),
  );
  if (!visible.size) return { nodes, edges };
  for (let depth = 0; depth < 2; depth++) {
    const layer = new Set(visible);
    for (const edge of edges)
      if (layer.has(edge.src) || layer.has(edge.dst)) {
        visible.add(edge.src);
        visible.add(edge.dst);
      }
  }
  return {
    nodes: nodes.filter((node) => visible.has(node.id)),
    edges: edges.filter((edge) => visible.has(edge.src) && visible.has(edge.dst)),
  };
}
