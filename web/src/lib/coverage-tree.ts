import type { CoverageGraphEdge, CoverageGraphNode } from "./types";

const ranks: Record<CoverageGraphNode["kind"], number> = {
  company: 0,
  root_domain: 1,
  subdomain: 2,
  ip: 3,
  service: 4,
  app: 5,
  endpoint: 6,
};
const labelOrder = new Intl.Collator("en-US", { numeric: true }).compare;
const compare = (a: CoverageGraphNode, b: CoverageGraphNode) =>
  ranks[a.kind] - ranks[b.kind] || labelOrder(a.label, b.label) || a.key.localeCompare(b.key);

// A canonical spanning forest is only a view. Every valid original relationship
// remains in links, including alternate parents and cycles, for the detail drawer.
export function buildCoverageForest(nodes: CoverageGraphNode[], edges: CoverageGraphEdge[]) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const links: CoverageGraphEdge[] = [],
    seen = new Set<string>(),
    incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byKey.has(edge.src) || !byKey.has(edge.dst)) continue;
    const key = JSON.stringify([edge.src, edge.dst]);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(edge);
    if (edge.src !== edge.dst) {
      const list = incoming.get(edge.dst) ?? [];
      list.push(edge.src);
      incoming.set(edge.dst, list);
    }
  }
  const parent = new Map<string, string>(),
    children = new Map<string, string[]>();
  const ordered = [...byKey.values()].sort(compare);
  for (const node of ordered) {
    const candidates = (incoming.get(node.key) ?? [])
      .map((key) => byKey.get(key)!)
      .sort((a, b) => {
        const aBefore = ranks[a.kind] < ranks[node.kind],
          bBefore = ranks[b.kind] < ranks[node.kind];
        return (
          Number(bBefore) - Number(aBefore) || (aBefore && bBefore ? ranks[b.kind] - ranks[a.kind] : 0) || compare(a, b)
        );
      });
    for (const candidate of candidates) {
      let cursor: string | undefined = candidate.key,
        cycle = false;
      while (cursor) {
        if (cursor === node.key) {
          cycle = true;
          break;
        }
        cursor = parent.get(cursor);
      }
      if (!cycle) {
        parent.set(node.key, candidate.key);
        break;
      }
    }
  }
  for (const node of ordered) {
    const p = parent.get(node.key);
    if (p) {
      const list = children.get(p) ?? [];
      list.push(node.key);
      children.set(p, list);
    }
  }
  for (const list of children.values()) list.sort((a, b) => compare(byKey.get(a)!, byKey.get(b)!));
  return {
    byKey,
    links,
    parent,
    children,
    roots: ordered.filter((node) => !parent.has(node.key)).map((node) => node.key),
  };
}

export type CoverageTreeItem = {
  id: string;
  node?: CoverageGraphNode;
  scope?: boolean;
  moreFor?: string;
  hidden?: number;
  childCount: number;
  open: boolean;
  depth: number;
  x: number;
  y: number;
};

export function projectCoverageTree(
  nodes: CoverageGraphNode[],
  edges: CoverageGraphEdge[],
  options: {
    query?: string;
    onlyUntested?: boolean;
    expanded?: Map<string, boolean>;
    limits?: Map<string, number>;
  } = {},
) {
  const forest = buildCoverageForest(nodes, edges),
    query = (options.query ?? "").trim().toLocaleLowerCase();
  const filtered = Boolean(query || options.onlyUntested),
    matches = new Set<string>();
  for (const node of forest.byKey.values()) {
    const text = [node.label, node.domain, node.root_domain, node.ip, node.url, node.app_name, node.page_title]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    if ((!query || text.includes(query)) && (!options.onlyUntested || (node.in_scope && !node.tested)))
      matches.add(node.key);
  }
  const included = new Set(matches);
  if (filtered)
    for (const key of matches) {
      let p = forest.parent.get(key);
      while (p) {
        included.add(p);
        p = forest.parent.get(p);
      }
    }
  else for (const key of forest.byKey.keys()) included.add(key);
  let rootId = "__wormhole_coverage_scope__";
  while (forest.byKey.has(rootId)) rootId += "_";
  const items: CoverageTreeItem[] = [],
    treeEdges: CoverageGraphEdge[] = [];
  let row = 0;
  const visit = (id: string, depth: number, parentId?: string): number => {
    const children = (id === rootId ? forest.roots : (forest.children.get(id) ?? [])).filter((key) =>
      included.has(key),
    );
    const open = filtered || (options.expanded?.get(id) ?? depth < 2);
    const item: CoverageTreeItem = {
      id,
      node: forest.byKey.get(id),
      scope: id === rootId,
      depth,
      childCount: children.length,
      open,
      x: depth * 350,
      y: 0,
    };
    items.push(item);
    if (parentId) treeEdges.push({ src: parentId, dst: id });
    if (open && children.length) {
      const limit = options.limits?.get(id) ?? 20,
        visible = children.slice(0, limit);
      const centers = visible.map((key) => visit(key, depth + 1, id));
      if (children.length > limit) {
        const foldId = `${rootId}:more:${id}`;
        const y = row++ * 126;
        items.push({
          id: foldId,
          depth: depth + 1,
          moreFor: id,
          hidden: children.length - limit,
          childCount: 0,
          open: false,
          x: (depth + 1) * 350,
          y,
        });
        treeEdges.push({ src: id, dst: foldId });
        centers.push(y);
      }
      item.y = (centers[0] + centers[centers.length - 1]) / 2;
    } else item.y = row++ * 126;
    return item.y;
  };
  visit(rootId, 0);
  return { ...forest, items, treeEdges, rootId, matchedCount: matches.size, filtered };
}
