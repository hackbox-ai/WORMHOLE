"use client";
"use no memo";

import * as React from "react";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge as RFEdge,
  type Node as RFNode,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./exploration-graph.css";

import {
  Activity,
  Navigation,
  Play,
  ChevronDown,
  ChevronRight,
  Crosshair,
  ListFilter,
  Maximize2,
  Search,
  X,
} from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PathEdge } from "@/components/path-edge";
import {
  graphDelta,
  placeGraphNodes,
  relatedGraphNodes,
  type GraphPoint,
  type GraphSize,
} from "@/lib/exploration-runtime";
import { explorationAppearance } from "@/lib/exploration-appearance";
import { collapseBranches, projectFindingPaths, runningNeighborhood } from "@/lib/exploration-view";
import type { Edge, ExploreKind, TaskNode } from "@/lib/types";
import { cn } from "@/lib/utils";

export const relLabel: Record<string, string> = {
  spawns: "Derived",
  derived_from: "Intent chain",
  yields: "Output",
  proves: "Proof",
};

export const relColor: Record<string, string> = {
  spawns: "#94a3b8",
  derived_from: "#94a3b8",
  yields: "#94a3b8",
  proves: "#64748b",
};

const typeMeta = Object.fromEntries(
  Object.entries(explorationAppearance).map(([key, value]) => [
    key,
    { ...value, iconBg: "bg-slate-100", chip: "bg-slate-100 text-slate-600" },
  ]),
) as { [K in ExploreKind]: (typeof explorationAppearance)[K] & { iconBg: string; chip: string } };

// The task root is an origin fact (kind='fact', state='origin'); render it as "Starting point".
function viewKind(n: TaskNode): ExploreKind {
  return n.type === "fact" && n.state === "origin" ? "begin" : n.type;
}

const summaryFields: Record<ExploreKind, string[]> = {
  task: ["summary", "description", "goal", "name"],
  begin: ["summary", "description", "goal"],
  goal: ["text", "summary", "description", "name"],
  hint: ["text", "hint", "summary", "message"],
  intent: ["summary", "description", "goal", "name"],
  fact: ["summary", "description", "content", "text"],
  finding: ["name", "summary", "title"],
  digest: ["summary", "body", "text"],
};

function nodePayload(node: TaskNode): Record<string, unknown> | null {
  try {
    const value = JSON.parse(node.payload ?? "");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function nodeSummary(node: TaskNode): string {
  const object = nodePayload(node);
  if (object) {
    for (const field of summaryFields[viewKind(node)] ?? []) {
      if (typeof object[field] === "string" && (object[field] as string).trim()) return object[field] as string;
    }
    return `${typeMeta[viewKind(node)]?.label ?? "Node"} · ${Object.keys(object).length} item information`;
  }
  const raw = (node.payload ?? "").trim();
  // Arrays or broken/truncated JSON belong in raw details, not node titles.
  return /^[{[]/.test(raw) ? (typeMeta[viewKind(node)]?.label ?? "Node information") : raw;
}
function nodeFields(node: TaskNode): Array<{ label: string; value: string }> {
  const object = nodePayload(node);
  if (!object) return node.origin ? [{ label: "Source", value: node.origin }] : [];
  const fields: Array<{ label: string; value: string }> = [];
  const pick = (label: string, keys: string[]) => {
    for (const key of keys) {
      const value = object[key];
      if ((typeof value === "string" && value.trim()) || typeof value === "number") {
        fields.push({ label, value: String(value) });
        return;
      }
    }
  };
  pick("Target", ["url", "target", "domain", "ip", "endpoint", "path"]);
  pick("Executor", ["worker", "owner", "agent"]);
  pick("Conclusion", ["conclusion", "result", "reason"]);
  if (Array.isArray(object.asset_ids) && object.asset_ids.length)
    fields.push({ label: "Related assets", value: `${object.asset_ids.length} item` });
  if (Array.isArray(object.steps) && object.steps.length)
    fields.push({ label: "Steps", value: `${object.steps.length} item` });
  if (!fields.length && node.origin) fields.push({ label: "Source", value: node.origin });
  return fields;
}

// digestMemberIds reads the fact/intent ids a digest folds from its payload
// (member_ids.{facts,intents}); ids are numbers in JSON, node ids are strings.
function digestMemberIds(n: TaskNode): string[] {
  if (n.type !== "digest" || !n.payload) return [];
  try {
    const p = JSON.parse(n.payload) as {
      member_ids?: { facts?: Array<string | number>; intents?: Array<string | number> };
    };
    return [...(p.member_ids?.facts ?? []), ...(p.member_ids?.intents ?? [])].map(String);
  } catch {
    return [];
  }
}

// collapseDigestGraph contracts each active digest's covered members into the
// digest super-node: the members are dropped from the rendered set and every
// edge touching a member is rewired onto its digest (member→member internal
// edges collapse to a self-loop and are dropped; the resulting edges are
// deduped by src+rel+dst). covers edges are structural and never drawn.
// Superseded digests (no covers edges) are dropped entirely. A graph with no
// active digest passes through unchanged. The full node list is kept by the
// caller so the detail drawer can still resolve a folded member by id.
function collapseDigestGraph(nodes: TaskNode[], edges: Edge[]): { viewNodes: TaskNode[]; viewEdges: Edge[] } {
  const activeDigests = new Set(nodes.filter((n) => n.type === "digest" && n.state === "active").map((n) => n.id));
  const memberToDigest = new Map<string, string>();
  for (const e of edges) {
    if (e.rel === "covers" && activeDigests.has(e.src)) memberToDigest.set(e.dst, e.src);
  }
  const viewNodes = nodes.filter((n) => (n.type === "digest" ? n.state === "active" : !memberToDigest.has(n.id)));
  const remap = (id: string) => memberToDigest.get(id) ?? id;
  const seen = new Set<string>();
  const rewired: Edge[] = [];
  // src+dst of every rewired yields edge, so the inverse derived_from can be dropped.
  const produced = new Set<string>();
  for (const e of edges) {
    if (e.rel === "covers") continue;
    const src = remap(e.src);
    const dst = remap(e.dst);
    if (src === dst) continue;
    const key = `${src}\u0000${e.rel}\u0000${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.rel === "yields") produced.add(`${src} ${dst}`);
    rewired.push(src === e.src && dst === e.dst ? e : { ...e, src, dst });
  }
  // yields(A→B) and derived_from(B→A) are inverse relations: a finding is
  // yielded by one intent but derived_from other intents, so the raw graph has
  // no 2-cycle. Folding those distinct intents into one digest collapses both
  // onto the digest↔member pair, leaving a redundant reverse edge the layered
  // layout draws as an overlapping back-edge. Drop each derived_from whose
  // reverse yields exists, keeping the production direction (→member).
  const viewEdges = rewired.filter((e) => !(e.rel === "derived_from" && produced.has(`${e.dst} ${e.src}`)));
  return projectFindingPaths(nodes, edges, viewNodes, viewEdges);
}

const COL_W = 430;
const ROW_H = 238;

type ExploreNodeData = {
  node: TaskNode;
  pulse?: "new" | "updated";
  size: GraphSize;
  collapsed: boolean;
  hiddenCount: number;
  hasChildren: boolean;
  onToggle: (id: string) => void;
};
type ExploreRFNode = RFNode<ExploreNodeData, "explore">;

function pushMap(m: Map<string, string[]>, k: string, v: string) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

// computeLayout auto-layers nodes by longest path along edges (cycle-safe DFS
// break + barycenter ordering), so origin → … → finding reads left-to-right.
function computeLayout(nodes: TaskNode[], edges: Edge[]): Map<string, { x: number; y: number }> {
  const order = nodes.map((n) => n.id);
  const idset = new Set(order);
  const valid = edges.filter((e) => idset.has(e.src) && idset.has(e.dst));
  const key = (s: string, d: string) => `${s}->${d}`;

  const out = new Map<string, string[]>();
  for (const e of valid) pushMap(out, e.src, e.dst);

  const seen = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  for (const root of order) {
    if ((seen.get(root) ?? 0) !== 0) continue;
    const stack: Array<{ u: string; i: number }> = [{ u: root, i: 0 }];
    seen.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nbrs = out.get(top.u) ?? [];
      if (top.i >= nbrs.length) {
        seen.set(top.u, 2);
        stack.pop();
        continue;
      }
      const v = nbrs[top.i++];
      const s = seen.get(v) ?? 0;
      if (s === 1) back.add(key(top.u, v));
      else if (s === 0) {
        seen.set(v, 1);
        stack.push({ u: v, i: 0 });
      }
    }
  }

  const dagSucc = new Map<string, string[]>();
  const indeg = new Map<string, number>(order.map((id) => [id, 0]));
  for (const e of valid) {
    if (back.has(key(e.src, e.dst))) continue;
    pushMap(dagSucc, e.src, e.dst);
    indeg.set(e.dst, (indeg.get(e.dst) ?? 0) + 1);
  }
  const layer = new Map<string, number>(order.map((id) => [id, 0]));
  const queue = order.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of dagSucc.get(u) ?? []) {
      layer.set(v, Math.max(layer.get(v) ?? 0, (layer.get(u) ?? 0) + 1));
      const d = (indeg.get(v) ?? 0) - 1;
      indeg.set(v, d);
      if (d === 0) queue.push(v);
    }
  }

  const maxLayer = Math.max(0, ...layer.values());
  const columns: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of order) columns[layer.get(id) ?? 0].push(id);

  const colIndexOf = new Map<string, number>();
  columns.forEach((ids, c) => {
    ids.forEach((id) => {
      colIndexOf.set(id, c);
    });
  });
  const neighbors = new Map<string, string[]>();
  for (const e of valid) {
    const cs = colIndexOf.get(e.src);
    const cd = colIndexOf.get(e.dst);
    if (cs === undefined || cd === undefined || Math.abs(cs - cd) !== 1) continue;
    pushMap(neighbors, e.src, e.dst);
    pushMap(neighbors, e.dst, e.src);
  }
  const sweep = (dir: 1 | -1) => {
    const start = dir === 1 ? 1 : columns.length - 2;
    const end = dir === 1 ? columns.length : -1;
    for (let c = start; c !== end; c += dir) {
      const ref = c - dir;
      const refIndex = new Map(columns[ref].map((id, i) => [id, i]));
      const scored = columns[c].map((id, i) => {
        const ns = (neighbors.get(id) ?? [])
          .map((nid) => refIndex.get(nid))
          .filter((v): v is number => v !== undefined);
        const bary = ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i;
        return { id, bary, i };
      });
      scored.sort((a, b) => a.bary - b.bary || a.i - b.i);
      columns[c] = scored.map((s) => s.id);
    }
  };
  for (let iter = 0; iter < 4; iter++) {
    sweep(1);
    sweep(-1);
  }

  const maxCount = Math.max(1, ...columns.map((c) => c.length));
  const midline = ((maxCount - 1) * ROW_H) / 2;
  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((ids, c) => {
    const startY = midline - ((ids.length - 1) * ROW_H) / 2;
    ids.forEach((id, i) => {
      pos.set(id, { x: c * COL_W, y: startY + i * ROW_H });
    });
  });
  return pos;
}

function nodeSize(node: TaskNode): GraphSize {
  const kind = viewKind(node),
    width =
      kind === "begin"
        ? 238
        : kind === "finding"
          ? 310
          : kind === "fact"
            ? 246
            : kind === "hint"
              ? 260
              : kind === "intent"
                ? 278
                : 288;
  return { width, height: 120 + nodeFields(node).slice(0, 3).length * 18 + (nodeSummary(node).length > 22 ? 20 : 0) };
}
type RuntimeEvent = { key: string; nodeId: string; label: string; at: number };
const runtimeState: Record<string, string> = {
  running: "Start execution",
  done: "Execution completed",
  failed: "Execution failed",
  blocked: "Wait condition",
  paused: "Paused",
  stopped: "Stopped",
  met: "Goal achieved",
  open: "Waiting for execution",
};

// A neutral, structured card: payload stays in the secondary detail drawer.
function ExploreNode({ data, selected }: NodeProps<ExploreRFNode>) {
  const node = data.node,
    kind = viewKind(node),
    meta = typeMeta[kind] ?? typeMeta.intent,
    Icon = meta.icon;
  const live = !node.inherited && node.type === "intent" && node.state === "running";
  const fields = nodeFields(node).slice(0, 3);
  return (
    <div
      className={cn(
        "path-node",
        selected && "path-node-selected",
        data.pulse === "new" && "path-node-entering",
        data.pulse === "updated" && "path-node-updated",
        live && "path-node-live",
        kind === "finding" && "path-node-finding",
      )}
      style={
        {
          "--path-accent": kind === "finding" ? "var(--path-risk)" : meta.hex,
          width: data.size.width,
          minHeight: data.size.height,
        } as React.CSSProperties
      }
      data-path-node-id={node.id}
      data-kind={kind}
      data-state={node.state}
      data-finding-path={node.finding_path || undefined}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-slate-300 !bg-white" />
      <div className="path-node-meta">
        <Icon className="size-3.5" style={{ color: meta.hex }} />
        <span>{meta.label}</span>
        {data.pulse && <span className="path-node-update-label">{data.pulse === "new" ? "New" : "Update"}</span>}
        <span className="ml-auto font-mono">#{node.id}</span>
      </div>
      <div className="path-node-title" title={nodeSummary(node)}>
        {nodeSummary(node)}
      </div>
      {fields.length > 0 && (
        <dl className="path-node-fields">
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd title={field.value}>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="path-node-footer">
        {data.hasChildren && (
          <button
            type="button"
            className="path-branch-toggle nodrag nopan"
            aria-expanded={!data.collapsed}
            aria-label={`${data.collapsed ? "Expand" : "Fold"}Node ${node.id} branches`}
            onClick={(event) => {
              event.stopPropagation();
              data.onToggle(node.id);
            }}
          >
            {data.collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
            {data.collapsed ? `${data.hiddenCount} Item collapsed` : "Branch"}
          </button>
        )}
        {node.inherited && node.source_task_id ? (
          <span>Source Task #{node.source_task_id}  · Read only</span>
        ) : node.type === "goal" || node.type === "intent" ? (
          <StatusBadge
            domain={node.type === "goal" ? "goal" : "intent"}
            value={node.state}
            dot
            className="path-node-status px-1.5 py-0 text-[10px]"
          />
        ) : (
          <span>{meta.label}</span>
        )}
        {node.priority > 0 && (node.type === "goal" || node.type === "intent") && <span>Priority {node.priority}</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-slate-300 !bg-white" />
    </div>
  );
}

const nodeTypes = { explore: React.memo(ExploreNode) };
const edgeTypes = { path: PathEdge };

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5 text-sm">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-foreground">{children}</span>
    </div>
  );
}

function NodeDetailSheet({
  node,
  nodesById,
  onSelect,
  onOpenChange,
}: {
  node: TaskNode | null;
  nodesById: Map<string, TaskNode>;
  onSelect: (n: TaskNode) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const meta = node ? (typeMeta[viewKind(node)] ?? typeMeta.intent) : null;
  const Icon = meta?.icon;
  const raw = node ? JSON.stringify(node, null, 2) : "";
  const memberIds = node ? digestMemberIds(node) : [];
  const members = memberIds.map((id) => nodesById.get(id)).filter((m): m is TaskNode => !!m);

  const copy = () => {
    void navigator.clipboard?.writeText(raw).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Sheet open={node !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:max-w-md">
        {node && meta && Icon && (
          <>
            <SheetHeader className="border-b p-4">
              <div className="flex items-center gap-2.5 pr-8">
                <span
                  className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg shadow-sm", meta.iconBg)}
                >
                  <Icon className="size-4" style={{ color: meta.hex }} />
                </span>
                <div className="min-w-0">
                  <SheetTitle className="leading-tight">{meta.label}</SheetTitle>
                  <span className="font-mono text-muted-foreground text-xs">{node.id}</span>
                </div>
                {node.inherited && node.source_task_id && (
                  <Badge variant="outline" className="ml-auto shrink-0">

                    Source Task #{node.source_task_id}  · Read only
                  </Badge>
                )}
              </div>
            </SheetHeader>

            <ScrollArea className="min-h-0 flex-1">
              <div className="flex w-full min-w-0 flex-col gap-4 p-4">
                <section>
                  <h4 className="mb-1 font-medium text-muted-foreground text-xs">Properties</h4>
                  <DetailRow label="Type">{meta.label}</DetailRow>
                  <DetailRow label="Status">
                    {node.type === "goal" || node.type === "intent" ? (
                      <StatusBadge
                        domain={node.type === "goal" ? "goal" : "intent"}
                        value={node.state}
                        dot
                        className="px-1.5 py-0 text-[10px]"
                      />
                    ) : (
                      <span className="font-mono text-xs">{node.state}</span>
                    )}
                  </DetailRow>
                  <DetailRow label="Priority">
                    <span className="tabular-nums">{node.priority}</span>
                  </DetailRow>
                  <DetailRow label="Source">
                    <span className="font-mono text-xs">{node.origin}</span>
                  </DetailRow>
                  {node.inherited && node.source_task_id && (
                    <DetailRow label="Source Task">
                      <span className="font-mono text-xs">#{node.source_task_id}(inherited, read-only)</span>
                    </DetailRow>
                  )}
                  <DetailRow label="Time">{new Date(node.ts).toLocaleString("en-US")}</DetailRow>
                </section>

                <section className="border-t pt-3">
                  <h4 className="mb-2 font-medium text-muted-foreground text-xs">Content summary</h4>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{nodeSummary(node)}</p>
                  {nodeFields(node).map((field) => (
                    <DetailRow key={field.label} label={field.label}>
                      {field.value}
                    </DetailRow>
                  ))}
                </section>
                {node.type === "digest" && (
                  <>
                    {nodeSummary(node) && (
                      <section className="border-t pt-3">
                        <h4 className="mb-1.5 font-medium text-muted-foreground text-xs">Compression conclusion</h4>
                        <p className="whitespace-pre-wrap break-words text-foreground text-sm leading-relaxed">
                          {nodeSummary(node)}
                        </p>
                      </section>
                    )}
                    <section className="border-t pt-3">
                      <h4 className="mb-1.5 font-medium text-muted-foreground text-xs">

                        Compressed Nodes ({memberIds.length}）
                      </h4>
                      <div className="flex flex-col gap-1.5">
                        {members.map((m) => {
                          const mMeta = typeMeta[viewKind(m)] ?? typeMeta.intent;
                          const MIcon = mMeta.icon;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => onSelect(m)}
                              className="flex items-start gap-2 rounded-md border p-2 text-left transition-colors hover:bg-accent"
                            >
                              <span
                                className={cn(
                                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded",
                                  mMeta.iconBg,
                                )}
                              >
                                <MIcon className="size-3" style={{ color: mMeta.hex }} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="line-clamp-2 text-foreground text-xs leading-snug">
                                  {nodeSummary(m) || mMeta.label}
                                </span>
                                <span className="block font-mono text-[10px] text-muted-foreground">
                                  {mMeta.label} · #{m.id}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                        {members.length < memberIds.length && (
                          <span className="text-[10px] text-muted-foreground">

                            Also {memberIds.length - members.length}  member nodes are not loaded with the current graph
                          </span>
                        )}
                      </div>
                    </section>
                  </>
                )}

                <details className="border-t pt-3">
                  <summary className="cursor-pointer font-medium text-muted-foreground text-xs">Raw data</summary>
                  <div className="mt-2 mb-1.5 flex items-center justify-between">
                    <h4 className="font-medium text-muted-foreground text-xs">Raw data</h4>
                    <button
                      type="button"
                      onClick={copy}
                      className="text-muted-foreground text-xs transition-colors hover:text-foreground"
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="max-w-full overflow-hidden whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-foreground text-xs leading-relaxed">
                    {raw}
                  </pre>
                </details>
              </div>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ExplorationGraphInner renders the given nodes/edges as a React Flow canvas.
// Positions are auto-laid-out and preserved across prop updates (so a polling
// caller's graph doesn't jump); click a node to open its detail drawer.
function graphMotionDuration() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220;
}

function ExplorationGraphInner({
  nodes,
  edges,
  emptyHint = "No exploration data yet",
  fitInitialView = false,
}: {
  nodes: TaskNode[];
  edges: Edge[];
  emptyHint?: string;
  fitInitialView?: boolean;
}) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<ExploreRFNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([]);
  const [selected, setSelected] = React.useState<TaskNode | null>(null);
  const [motionEnabled, setMotionEnabled] = React.useState(true);
  const [motionAllowed, setMotionAllowed] = React.useState(false);
  const [pageVisible, setPageVisible] = React.useState(true);
  const [following, setFollowing] = React.useState(false);
  const [events, setEvents] = React.useState<RuntimeEvent[]>([]);
  const [pulseRevision, setPulseRevision] = React.useState(0);
  const pulses = React.useRef(new Map<string, { kind: "new" | "updated"; until: number }>());
  const snapshot = React.useRef<{ nodes: TaskNode[]; edges: Edge[] } | null>(null);
  const positions = React.useRef(new Map<string, GraphPoint>());
  const lastFollow = React.useRef("");
  const [indexOpen, setIndexOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [kindFilter, setKindFilter] = React.useState("all");
  const [indexLimit, setIndexLimit] = React.useState(40);
  const [focusedID, setFocusedID] = React.useState("");
  const [collapsedRoots, setCollapsedRoots] = React.useState<Set<string>>(new Set());
  const [focusRunning, setFocusRunning] = React.useState(false);
  const [pendingFocus, setPendingFocus] = React.useState("");
  const [fitRequested, setFitRequested] = React.useState(false);
  const toggleBranch = React.useCallback(
    (id: string) =>
      setCollapsedRoots((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const { setCenter, fitView, getZoom, viewportInitialized } = useReactFlow<ExploreRFNode>();
  const initialized = React.useRef(false);
  const focusNode = React.useCallback(
    (node: TaskNode) => {
      setFollowing(false);
      const visibleID = rfNodes.some((entry) => entry.id === node.id)
        ? node.id
        : edges.find((edge) => edge.rel === "covers" && edge.dst === node.id)?.src;
      const visible = rfNodes.find((entry) => entry.id === visibleID);
      if (visible) {
        setFocusedID(visible.id);
        void setCenter(
          visible.position.x + visible.data.size.width / 2,
          visible.position.y + visible.data.size.height / 2,
          { zoom: 1, duration: graphMotionDuration() },
        );
      } else if (
        nodes.some((entry) => entry.id === node.id) &&
        node.type !== "digest" &&
        !edges.some((edge) => edge.rel === "covers" && edge.dst === node.id)
      ) {
        setCollapsedRoots(new Set());
        setFocusRunning(false);
        setPendingFocus(node.id);
      } else setSelected(node);
    },
    [rfNodes, edges, nodes, setCenter],
  );
  React.useEffect(() => {
    if (!viewportInitialized || !rfNodes.length || initialized.current) return;
    const frame = window.requestAnimationFrame(() => {
      initialized.current = true;
      if (!fitInitialView && rfNodes.length > 2) {
        const node = rfNodes.find((entry) => entry.data.node.state === "running") ?? rfNodes[0];
        void setCenter(node.position.x + node.data.size.width / 2, node.position.y + node.data.size.height / 2, {
          zoom: 1,
          duration: graphMotionDuration(),
        });
      } else void fitView({ padding: 0.16, minZoom: 0.1, maxZoom: 0.9, duration: graphMotionDuration() });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [viewportInitialized, rfNodes, fitView, setCenter, fitInitialView]);
  React.useEffect(() => {
    if (!pendingFocus) return;
    const target = rfNodes.find((node) => node.id === pendingFocus);
    if (!target) return;
    void setCenter(target.position.x + target.data.size.width / 2, target.position.y + target.data.size.height / 2, {
      zoom: 1,
      duration: graphMotionDuration(),
    });
    setFocusedID(target.id);
    setPendingFocus("");
  }, [pendingFocus, rfNodes, setCenter]);
  React.useEffect(() => {
    if (!fitRequested) return;
    const frame = window.requestAnimationFrame(() => {
      const active = focusRunning ? rfNodes.find((entry) => entry.data.node.state === "running") : undefined;
      if (active)
        void setCenter(
          active.position.x + active.data.size.width / 2,
          active.position.y + active.data.size.height / 2,
          { zoom: 1, duration: graphMotionDuration() },
        );
      else void fitView({ padding: 0.2, maxZoom: 0.9, duration: graphMotionDuration() });
      setFitRequested(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitRequested, rfNodes, focusRunning, fitView, setCenter]);
  const indexNodes = React.useMemo(
    () =>
      nodes.filter(
        (node) =>
          (kindFilter === "all" || viewKind(node) === kindFilter) &&
          `${node.id} ${nodeSummary(node)} ${nodeFields(node)
            .map((field) => field.value)
            .join(" ")}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [nodes, query, kindFilter],
  );
  // Full node index (incl. folded members) so the digest drawer can resolve
  // covered members even though they are not rendered on the canvas.
  const nodesById = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // Collapsed view: folded members removed, their edges rewired onto the digest.
  const folded = React.useMemo(() => collapseDigestGraph(nodes, edges), [nodes, edges]);
  const branches = React.useMemo(
    () => collapseBranches(folded.viewNodes, folded.viewEdges, collapsedRoots),
    [folded, collapsedRoots],
  );
  const { nodes: viewNodes, edges: viewEdges } = React.useMemo(
    () => (focusRunning ? runningNeighborhood(branches.nodes, branches.edges) : branches),
    [branches, focusRunning],
  );
  const hasRunning = nodes.some((node) => node.type === "intent" && node.state === "running" && !node.inherited);
  const isEmpty = viewNodes.length === 0;

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setMotionAllowed(!media.matches && document.visibilityState === "visible");
      setPageVisible(document.visibilityState === "visible");
    };
    update();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  React.useEffect(() => {
    const previous = snapshot.current;
    snapshot.current = nodes.length || previous ? { nodes, edges } : null;
    if (!previous) return;
    const delta = graphDelta(previous.nodes, nodes, previous.edges, edges);
    if (!delta.added.length && !delta.changed.length && !delta.removed.length && !delta.relationsChanged) return;
    const now = Date.now(),
      before = new Map(previous.nodes.map((n) => [n.id, n]));
    for (const node of delta.added) pulses.current.set(node.id, { kind: "new", until: now + 2800 });
    for (const node of delta.changed) pulses.current.set(node.id, { kind: "updated", until: now + 2200 });
    const stateChanged = delta.changed.filter((n) => before.get(n.id)?.state !== n.state);
    const main =
      delta.added.find((n) => n.type === "finding") ??
      stateChanged.find((n) => n.type === "intent") ??
      stateChanged[0] ??
      delta.added.find((n) => n.type === "intent") ??
      delta.added[0] ??
      delta.changed[0];
    const prefix = main
      ? delta.added.includes(main)
        ? main.type === "finding"
          ? "New findings"
          : main.type === "intent"
            ? main.state === "running"
              ? "Start execution"
              : "Added new execution steps"
            : main.type === "fact"
              ? "Record new facts"
              : main.type === "goal"
                ? "Add new target"
                : "Add new node"
        : before.get(main.id)?.state !== main.state
          ? (runtimeState[main.state] ?? "Status updated")
          : "Node content update"
      : "Path relationship updated";
    const total = delta.added.length + delta.changed.length;
    const label = main
      ? prefix + " · " + nodeSummary(main).slice(0, 42) + (total > 1 ? "(Also " + (total - 1) + " changes)" : "")
      : prefix;
    setEvents((old) =>
      [{ key: now + "-" + (main?.id ?? "edges"), nodeId: main?.id ?? "", label, at: now }, ...old].slice(0, 8),
    );
    setPulseRevision((v) => v + 1);
  }, [nodes, edges]);
  React.useEffect(() => {
    if (!pulses.current.size) return;
    const until = Math.min(...[...pulses.current.values()].map((p) => p.until));
    const timer = window.setTimeout(
      () => {
        for (const [id, p] of pulses.current) if (p.until <= Date.now()) pulses.current.delete(id);
        setPulseRevision((v) => v + 1);
      },
      Math.max(10, until - Date.now() + 10),
    );
    return () => window.clearTimeout(timer);
  }, [pulseRevision]);
  const related = React.useMemo(
    () => relatedGraphNodes(viewNodes, viewEdges, focusedID),
    [viewNodes, viewEdges, focusedID],
  );
  const runningNodes = React.useMemo(
    () => nodes.filter((n) => !n.inherited && n.type === "intent" && n.state === "running"),
    [nodes],
  );
  const blockedCount = React.useMemo(
    () => nodes.filter((n) => !n.inherited && n.type === "intent" && n.state === "blocked").length,
    [nodes],
  );

  React.useEffect(() => {
    setSelected((cur) => (cur ? (nodesById.get(cur.id) ?? cur) : cur));
    const liveTargets = new Set(
      viewNodes.filter((n) => !n.inherited && n.type === "intent" && n.state === "running").map((n) => n.id),
    );
    const layout = computeLayout(viewNodes, viewEdges),
      sizes = new Map(viewNodes.map((n) => [n.id, nodeSize(n)]));
    const known = new Set(nodes.map((n) => n.id));
    for (const id of positions.current.keys()) if (!known.has(id)) positions.current.delete(id);
    setRfNodes((prev) => {
      const priorNodes = new Map(prev.map((n) => [n.id, n]));
      const previous = new Map(prev.map((n) => [n.id, n.position]));
      for (const [id, p] of previous) positions.current.set(id, p);
      const placed = placeGraphNodes(viewNodes, viewEdges, layout, positions.current, previous, sizes);
      for (const [id, p] of placed) positions.current.set(id, p);
      return viewNodes.map((n) => ({
        ...priorNodes.get(n.id),
        id: n.id,
        type: "explore" as const,
        position: placed.get(n.id) ?? { x: 0, y: 0 },
        style: { opacity: related.size && !related.has(n.id) ? 0.42 : 1 },
        data: {
          node: n,
          size: sizes.get(n.id)!,
          pulse: pulses.current.get(n.id)?.kind,
          collapsed: collapsedRoots.has(n.id),
          hiddenCount: branches.counts.get(n.id) ?? 0,
          hasChildren: folded.viewEdges.some((e) => e.src === n.id),
          onToggle: toggleBranch,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      }));
    });
    let flowing = 0;
    setRfEdges(
      viewEdges.map((e) => {
        const color = e.finding_path
          ? "var(--path-risk)"
          : liveTargets.has(e.dst)
            ? "var(--path-running)"
            : "var(--path-edge)";
        const active = liveTargets.has(e.dst),
          dimmed = related.size > 0 && (!related.has(e.src) || !related.has(e.dst));
        const flow = active && motionEnabled && motionAllowed && !dimmed && flowing++ < 12;
        return {
          id: `e-${e.src}-${e.rel}-${e.dst}`,
          source: e.src,
          target: e.dst,
          label: relLabel[e.rel] ?? e.rel,
          type: "path",
          className: cn(e.finding_path && "path-finding-edge", active && "path-working-edge"),
          data: { flowing: flow },
          style: {
            stroke: color,
            strokeWidth: e.finding_path ? 2.2 : active ? 1.8 : 1.15,
            opacity: dimmed ? 0.22 : 1,
            strokeOpacity: e.finding_path || active ? 1 : 0.72,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
        } satisfies RFEdge;
      }),
    );
  }, [
    viewNodes,
    viewEdges,
    nodesById,
    nodes,
    setRfNodes,
    setRfEdges,
    collapsedRoots,
    branches.counts,
    folded.viewEdges,
    toggleBranch,
    related,
    motionEnabled,
    motionAllowed,
    pulseRevision,
  ]);

  React.useEffect(() => {
    if (!following || !pageVisible || !viewportInitialized || selected || indexOpen || !runningNodes.length) return;
    const recent = events.find((e) => runningNodes.some((n) => n.id === e.nodeId));
    const target = rfNodes.find((n) => n.id === (recent?.nodeId ?? runningNodes[0].id));
    if (!target) return;
    const key = target.id + ":" + runningNodes.map((n) => n.id).join(",");
    if (lastFollow.current === key) return;
    lastFollow.current = key;
    setFocusedID(target.id);
    void setCenter(target.position.x + target.data.size.width / 2, target.position.y + target.data.size.height / 2, {
      zoom: Math.min(1, Math.max(0.8, getZoom())),
      duration: graphMotionDuration(),
    });
  }, [
    following,
    pageVisible,
    viewportInitialized,
    selected,
    indexOpen,
    runningNodes,
    rfNodes,
    events,
    setCenter,
    getZoom,
  ]);

  return (
    <>
      <div className="path-workspace" data-motion={motionEnabled && motionAllowed ? "on" : "off"}>
        <div className="path-workspace-toolbar">
          <div>
            <strong>Execution path</strong>
            <span>
              {viewNodes.length}  visible nodes · {branches.hiddenCount}  Item collapsed
            </span>
            {nodes.some((n) => n.finding_path) && <span className="path-finding-legend">Discovery path</span>}
          </div>
          <div className="path-toolbar-actions">
            <Button
              variant={following ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={following}
              disabled={!hasRunning && !following}
              onClick={() => {
                lastFollow.current = "";
                setFollowing((v) => !v);
              }}
            >
              <Navigation className="size-3.5" />

              Follow execution
            </Button>
            <Button
              variant={motionEnabled ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={motionEnabled}
              title={motionEnabled ? "Close running dynamics and continue to receive status updates" : "Enable running dynamics"}
              onClick={() => setMotionEnabled((v) => !v)}
            >
              <Play className="size-3.5" />

              Operational dynamics
            </Button>
            <Button
              variant={focusRunning ? "secondary" : "ghost"}
              size="sm"
              disabled={!hasRunning}
              aria-pressed={focusRunning}
              onClick={() => {
                setFocusRunning((value) => !value);
                setCollapsedRoots(new Set());
                setFitRequested(true);
              }}
            >

              Executing
            </Button>
            {collapsedRoots.size > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setCollapsedRoots(new Set())}>

                Expand branch
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const node = rfNodes.find((entry) => entry.id === focusedID) ?? rfNodes[0];
                if (node) focusNode(node.data.node);
              }}
            >
              <Crosshair className="size-3.5" />

              Reading ratio
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFollowing(false);
                void fitView({ padding: 0.2, minZoom: 0.1, maxZoom: 1, duration: graphMotionDuration() });
              }}
            >
              <Maximize2 className="size-3.5" />

              Full picture
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={indexOpen}
              onClick={() => {
                setFollowing(false);
                setIndexOpen((value) => !value);
              }}
            >
              <ListFilter className="size-3.5" />

              Node index
            </Button>
          </div>
        </div>
        <div className="path-runtime-strip">
          <span className="path-runtime-state" data-live={runningNodes.length > 0}>
            <Activity className="size-3.5" />
            {runningNodes.length ? `${runningNodes.length} steps are being executed` : "There are no steps currently executing"}
            {blockedCount > 0 && ` · ${blockedCount} Wait condition`}
          </span>
          <span className="path-runtime-announcement" role="status" aria-live="polite">
            {events[0]?.label ?? ""}
          </span>
          {events.length > 0 && (
            <details
              className="path-runtime-history"
              onToggle={(event) => {
                if (event.currentTarget.open) setFollowing(false);
              }}
            >
              <summary>Recent changes · {events.length}</summary>
              <div>
                {events.map((event) => (
                  <button
                    key={event.key}
                    type="button"
                    disabled={!nodesById.has(event.nodeId)}
                    onClick={(click) => {
                      const node = nodesById.get(event.nodeId);
                      if (node) focusNode(node);
                      const list = click.currentTarget.closest("details");
                      if (list) list.open = false;
                    }}
                  >
                    <time>{new Date(event.at).toLocaleTimeString("en-US", { hour12: false })}</time>
                    <span>{event.label}</span>
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
        <div className="path-workspace-body">
          <div
            className="path-flow-frame"
            onPointerDownCapture={() => setFollowing(false)}
            onWheelCapture={() => setFollowing(false)}
            onKeyDownCapture={() => setFollowing(false)}
          >
            <ReactFlow
              nodes={rfNodes.map((node) => ({ ...node, selected: node.id === focusedID }))}
              edges={rfEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, node) => {
                setFollowing(false);
                setFocusedID(node.id);
                setSelected(node.data.node);
              }}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onMoveStart={(event) => {
                if (event) setFollowing(false);
              }}
              onNodeDragStart={() => setFollowing(false)}
              onPaneClick={() => {
                setFollowing(false);
                setFocusedID("");
              }}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              panOnScroll
              zoomOnScroll={false}
              zoomOnDoubleClick={false}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
              onlyRenderVisibleElements
              minZoom={0.1}
              className="path-canvas"
            >
              <Background variant={BackgroundVariant.Lines} gap={32} color="var(--path-grid)" lineWidth={0.4} />
              <Controls
                showInteractive={false}
                className="path-controls !rounded-lg !border !shadow-sm [&>button]:!border-slate-200 [&>button]:!bg-white [&>button:hover]:!bg-slate-100 [&_svg]:!fill-slate-600"
              />
              <MiniMap
                pannable
                zoomable
                ariaLabel="Execution path minimap"
                className="!bg-white !rounded-lg !border !border-slate-200 !shadow-sm"
                maskColor="rgb(148 163 184 / 0.18)"
                nodeColor={(node) => {
                  const data = node.data as ExploreNodeData | undefined;
                  if (data?.node.type === "finding") return "var(--path-risk)";
                  const k = data?.node ? viewKind(data.node) : "intent";
                  return typeMeta[k]?.hex ?? "#94a3b8";
                }}
                nodeStrokeWidth={0}
                nodeBorderRadius={4}
              />
              <Panel position="top-left">
                <details className="path-legend">
                  <summary>Node type</summary>
                  <div className="mt-3 flex max-w-72 flex-wrap gap-3 text-xs">
                    {(["begin", "goal", "intent", "fact", "finding", "hint", "digest"] as ExploreKind[]).map((kind) => {
                      const meta = typeMeta[kind],
                        Icon = meta.icon;
                      return (
                        <span key={kind} className="inline-flex items-center gap-1">
                          <Icon className="size-3" style={{ color: meta.hex }} />
                          {meta.label}
                        </span>
                      );
                    })}
                  </div>

                </details>
              </Panel>
              {isEmpty && (
                <Panel position="top-center">
                  <p className="path-legend">{emptyHint}</p>
                </Panel>
              )}
            </ReactFlow>
          </div>
          {indexOpen && (
            <aside className="path-index" aria-label="Execution node index">
              <div className="path-index-header">
                <strong>Node index</strong>
                <Button variant="ghost" size="icon-sm" aria-label="Turn off node index" onClick={() => setIndexOpen(false)}>
                  <X />
                </Button>
              </div>
              <div className="path-index-filters">
                <div className="relative">
                  <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
                  <Input
                    aria-label="Search execution node"
                    className="h-8 pl-8 text-xs"
                    placeholder="Name, target or node number"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setIndexLimit(40);
                    }}
                  />
                </div>
                <select
                  aria-label="Filter execution node type"
                  value={kindFilter}
                  onChange={(event) => {
                    setKindFilter(event.target.value);
                    setIndexLimit(40);
                  }}
                >
                  <option value="all">All types</option>
                  {Object.entries(typeMeta)
                    .filter(([key]) => key !== "task")
                    .map(([key, meta]) => (
                      <option key={key} value={key}>
                        {meta.label}
                      </option>
                    ))}
                </select>
              </div>
              <div className="path-index-list">
                {indexNodes.slice(0, indexLimit).map((node) => {
                  const meta = typeMeta[viewKind(node)] ?? typeMeta.intent,
                    Icon = meta.icon;
                  return (
                    <div key={node.id} className="path-index-item" data-active={focusedID === node.id}>
                      <button
                        type="button"
                        aria-label={`Positioning ${nodeSummary(node) || node.id}`}
                        onClick={() => focusNode(node)}
                      >
                        <span>
                          <Icon className="size-3.5" style={{ color: meta.hex }} />
                          {meta.label}
                          <code>#{node.id}</code>
                        </span>
                        <strong>{nodeSummary(node) || meta.label}</strong>
                      </button>
                      <button
                        type="button"
                        className="path-index-detail"
                        aria-label={`View nodes ${node.id} Details`}
                        onClick={() => {
                          setFollowing(false);
                          setSelected(node);
                        }}
                      >

                        Details
                      </button>
                    </div>
                  );
                })}
                {!indexNodes.length && <p className="p-3 text-muted-foreground text-xs">No matching node</p>}
                {indexNodes.length > indexLimit && (
                  <Button variant="ghost" size="sm" onClick={() => setIndexLimit((value) => value + 40)}>

                    Show more nodes
                  </Button>
                )}
              </div>
              <p className="path-index-footer">{indexNodes.length}  Item · Maintain readable font size when positioning</p>
            </aside>
          )}
        </div>
      </div>
      <NodeDetailSheet
        node={selected}
        nodesById={nodesById}
        onSelect={(node) => {
          setFollowing(false);
          setSelected(node);
        }}
        onOpenChange={(o) => !o && setSelected(null)}
      />
    </>
  );
}

// ExplorationGraph is the sharedExploration map/Attack link diagram canvas — used by the task graph
// tab (full graph, polled) and the finding lineage view (origin→finding subgraph).
export function ExplorationGraph({
  nodes,
  edges,
  className,
  emptyHint,
  fitInitialView,
}: {
  nodes: TaskNode[];
  edges: Edge[];
  className?: string;
  emptyHint?: string;
  fitInitialView?: boolean;
}) {
  return (
    <div className={cn("w-full overflow-hidden rounded-xl", className)}>
      <ReactFlowProvider>
        <ExplorationGraphInner nodes={nodes} edges={edges} emptyHint={emptyHint} fitInitialView={fitInitialView} />
      </ReactFlowProvider>
    </div>
  );
}
