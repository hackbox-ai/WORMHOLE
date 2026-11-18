import type { Edge, TaskNode } from "./types";

export type GraphPoint = { x: number; y: number };
export type GraphSize = { width: number; height: number };
export const graphRenderSignature = (nodes: TaskNode[], edges: Edge[]) =>
  JSON.stringify([
    nodes.map((n) => [
      n.id,
      n.type,
      n.state,
      n.priority,
      n.payload,
      n.ts,
      n.origin,
      n.inherited,
      n.source_task_id,
      n.delete_reason,
      n.finding_path,
    ]),
    edges.map((e) => [e.src, e.dst, e.rel, e.finding_path]),
  ]);

/** This is presentation state only: it never creates graph nodes or causal edges. */
export function graphDelta(before: TaskNode[], after: TaskNode[], oldEdges: Edge[] = [], newEdges: Edge[] = []) {
  const prior = new Map(before.map((n) => [n.id, n])),
    current = new Set(after.map((n) => n.id));
  const added: TaskNode[] = [],
    changed: TaskNode[] = [];
  for (const n of after) {
    if (n.inherited) continue;
    const p = prior.get(n.id);
    if (!p) added.push(n);
    else if (
      p.state !== n.state ||
      p.type !== n.type ||
      p.payload !== n.payload ||
      !!p.finding_path !== !!n.finding_path
    )
      changed.push(n);
  }
  const relation = (edges: Edge[]) =>
    edges
      .map((e) => JSON.stringify([e.src, e.dst, e.rel, !!e.finding_path]))
      .sort()
      .join("|");
  return {
    added,
    changed,
    removed: before.filter((n) => !current.has(n.id)),
    relationsChanged: relation(oldEdges) !== relation(newEdges),
  };
}

/** Ancestors and descendants are traversed separately so reaching a shared
 * root does not accidentally pull every sibling into the selected path. */
export function relatedGraphNodes(nodes: TaskNode[], edges: Edge[], selected: string): Set<string> {
  const ids = new Set(nodes.map((n) => n.id));
  if (!ids.has(selected)) return new Set();
  const parents = new Map<string, string[]>(),
    children = new Map<string, string[]>();
  for (const e of edges) {
    if (!ids.has(e.src) || !ids.has(e.dst) || e.rel === "covers") continue;
    const up = parents.get(e.dst) ?? [];
    up.push(e.src);
    parents.set(e.dst, up);
    const down = children.get(e.src) ?? [];
    down.push(e.dst);
    children.set(e.src, down);
  }
  const walk = (map: Map<string, string[]>) => {
    const found = new Set([selected]),
      queue = [selected];
    for (let i = 0; i < queue.length; i++)
      for (const id of map.get(queue[i]) ?? [])
        if (!found.has(id)) {
          found.add(id);
          queue.push(id);
        }
    return found;
  };
  return new Set([...walk(parents), ...walk(children)]);
}

/** Keep existing visible/manual positions intact. Reopened nodes reuse their
 * cached positions; new nodes grow near their actual parents and seek the
 * nearest free slot on either side, rather than always falling to the bottom. */
export function placeGraphNodes(
  nodes: TaskNode[],
  edges: Edge[],
  layout: Map<string, GraphPoint>,
  cache: Map<string, GraphPoint>,
  previous: Map<string, GraphPoint>,
  sizes: Map<string, GraphSize>,
): Map<string, GraphPoint> {
  const fallback = { width: 280, height: 196 },
    placed = new Map<string, GraphPoint>(),
    occupied: { id: string; point: GraphPoint }[] = [];
  const size = (id: string) => sizes.get(id) ?? fallback;
  const add = (id: string, point: GraphPoint) => {
    placed.set(id, { ...point });
    occupied.push({ id, point: { ...point } });
  };
  const free = (id: string, desired: GraphPoint) => {
    const own = size(id);
    const intervals = occupied
      .filter((o) => desired.x < o.point.x + size(o.id).width + 28 && desired.x + own.width + 28 > o.point.x)
      .map((o) => ({ lo: o.point.y - own.height - 30, hi: o.point.y + size(o.id).height + 30 }))
      .sort((a, b) => a.lo - b.lo);
    const merged: { lo: number; hi: number }[] = [];
    for (const range of intervals) {
      const last = merged[merged.length - 1];
      if (last && range.lo <= last.hi) last.hi = Math.max(last.hi, range.hi);
      else merged.push({ ...range });
    }
    const hit = merged.find((r) => desired.y > r.lo && desired.y < r.hi);
    if (!hit) return desired;
    return { ...desired, y: Math.abs(hit.hi - desired.y) <= Math.abs(desired.y - hit.lo) ? hit.hi + 1 : hit.lo - 1 };
  };
  if (!previous.size && !cache.size && nodes.every((n) => layout.has(n.id)))
    return new Map(nodes.map((n) => [n.id, { ...layout.get(n.id)! }]));
  const visible = new Set(nodes.map((n) => n.id));
  for (const [id, p] of previous) if (visible.has(id)) add(id, p);
  const ordered = [...nodes].sort((a, b) => (layout.get(a.id)?.x ?? 0) - (layout.get(b.id)?.x ?? 0));
  const parents = new Map<string, string[]>();
  for (const e of edges)
    if (visible.has(e.src) && visible.has(e.dst) && e.rel !== "covers")
      parents.set(e.dst, [...(parents.get(e.dst) ?? []), e.src]);
  for (const node of ordered) {
    if (placed.has(node.id)) continue;
    const old = cache.get(node.id);
    if (old) {
      add(node.id, free(node.id, old));
      continue;
    }
    const base = layout.get(node.id) ?? { x: 0, y: 0 };
    const anchors = (parents.get(node.id) ?? []).flatMap((id) => {
      const p = placed.get(id);
      return p && p.x < base.x ? [{ y: p.y + size(id).height / 2 }] : [];
    });
    const desired = {
      x: base.x,
      y: anchors.length ? anchors.reduce((n, p) => n + p.y, 0) / anchors.length - size(node.id).height / 2 : base.y,
    };
    add(node.id, free(node.id, desired));
  }
  return placed;
}

export function graphPollInterval(nodes: TaskNode[], visible = true, settling = false) {
  if (!visible) return 30000;
  const active = nodes.some((n) => n.type === "intent" && n.state === "running" && !n.inherited);
  return nodes.length > 1000 ? 15000 : active || settling ? 3000 : 8000;
}
