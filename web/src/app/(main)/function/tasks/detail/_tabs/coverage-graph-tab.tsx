"use client";

import * as React from "react";
import {
  AppWindow,
  Building2,
  Globe,
  Link2,
  Radio,
  Server,
  Waypoints,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  Network,
  ArrowUp,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { projectCoverageTree, type CoverageTreeItem } from "@/lib/coverage-tree";
import type { CoverageAssetRef, CoverageAssetRefs, CoverageGraphData, CoverageGraphNode } from "@/lib/types";
import { cn } from "@/lib/utils";

type Kind = CoverageGraphNode["kind"];
const kindMeta: Record<Kind, { label: string; icon: LucideIcon; iconBg: string }> = {
  company: { label: "Company", icon: Building2, iconBg: "bg-slate-500" },
  root_domain: { label: "Root domain name", icon: Globe, iconBg: "bg-slate-500" },
  subdomain: { label: "Subdomain name", icon: Waypoints, iconBg: "bg-slate-500" },
  ip: { label: "IP", icon: Server, iconBg: "bg-slate-500" },
  service: { label: "Service", icon: Radio, iconBg: "bg-slate-500" },
  app: { label: "Application", icon: AppWindow, iconBg: "bg-slate-500" },
  endpoint: { label: "Interface", icon: Link2, iconBg: "bg-slate-500" },
};

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === undefined || children === null || children === "") return null;
  return (
    <div className="flex items-start gap-3 py-1 text-sm">
      <span className="text-muted-foreground w-16 shrink-0">{label}</span>
      <span className="text-foreground min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

function RefList({ title, items }: { title: string; items: CoverageAssetRef[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-muted-foreground mb-1 text-xs font-medium">
        {title}（{items.length}）
      </h4>
      <div className="flex flex-col gap-1">
        {items.map((r) => (
          <div
            key={`${r.kind}-${r.id}`}
            className="flex flex-wrap items-start gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
          >
            <span className="shrink-0 font-mono text-muted-foreground">#{r.id}</span>
            {r.state && <span className="shrink-0 text-muted-foreground">{r.state}</span>}
            <span className="min-w-32 flex-1 break-words text-foreground">{r.summary || "—"}</span>
            {r.inherited && r.source_task_id && (
              <Badge variant="outline" className="shrink-0">

                Source #{r.source_task_id}  · Read only
              </Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AssetSheet({
  node,
  taskId,
  onOpenChange,
  related,
  onPick,
}: {
  related: CoverageGraphNode[];
  onPick: (node: CoverageGraphNode) => void;
  node: CoverageGraphNode | null;
  taskId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const meta = node ? kindMeta[node.kind] : null;
  const Icon = meta?.icon;
  const raw = node ? JSON.stringify(node, null, 2) : "";
  const [relatedLimit, setRelatedLimit] = React.useState(20);
  const [refs, setRefs] = React.useState<CoverageAssetRefs | null>(null);

  React.useEffect(() => {
    setRefs(null);
    setRelatedLimit(20);
    if (!node?.asset_id) return;
    let cancelled = false;
    api
      .taskAssetRefs(taskId, node.asset_id)
      .then((r) => {
        if (!cancelled) setRefs(r);
      })
      .catch(() => {
        /* Not relevant or error: do not display this block */
      });
    return () => {
      cancelled = true;
    };
  }, [node, taskId]);
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
                  <Icon className="size-4 text-white" />
                </span>
                <div className="min-w-0">
                  <SheetTitle className="leading-tight">{meta.label}</SheetTitle>
                  <span className="text-muted-foreground truncate font-mono text-xs" title={node.label}>
                    {node.label}
                  </span>
                </div>
              </div>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex w-full min-w-0 flex-col gap-4 p-4">
                <section>
                  <h4 className="text-muted-foreground mb-1 text-xs font-medium">Properties</h4>
                  <DetailRow label="Type">{meta.label}</DetailRow>
                  <DetailRow label="Test status">
                    {node.in_scope ? (
                      node.tested ? (
                        <span className="text-emerald-600 dark:text-emerald-400">Tested</span>
                      ) : (
                        <span className="text-neutral-500">Not tested</span>
                      )
                    ) : (
                      <span className="text-neutral-400">Out of range (connection node)</span>
                    )}
                  </DetailRow>
                  <DetailRow label="Domain name">{node.domain}</DetailRow>
                  <DetailRow label="Root domain name">{node.root_domain}</DetailRow>
                  <DetailRow label="IP">{node.ip}</DetailRow>
                  <DetailRow label="Port">{node.port ? node.port : undefined}</DetailRow>
                  <DetailRow label="URL">
                    {node.url ? <span className="font-mono text-xs break-all">{node.url}</span> : undefined}
                  </DetailRow>
                  <DetailRow label="Title">{node.page_title}</DetailRow>
                  <DetailRow label="Status code">{node.status_code ? node.status_code : undefined}</DetailRow>
                  <DetailRow label="App">{node.app_name}</DetailRow>
                  <DetailRow label="Asset ID">
                    {node.asset_id ? <span className="font-mono text-xs">{node.asset_id}</span> : undefined}
                  </DetailRow>
                </section>
                {refs && (refs.intents.length > 0 || refs.facts.length > 0 || refs.findings.length > 0) && (
                  <section className="flex flex-col gap-3 border-t pt-3">
                    <RefList title="Association intent" items={refs.intents} />
                    <RefList title="Relevant facts" items={refs.facts} />
                    <RefList title="Association discovery" items={refs.findings} />
                  </section>
                )}
                {related.length > 0 && (
                  <section className="border-t pt-3">
                    <h4 className="mb-2 text-xs font-medium text-muted-foreground">Related assets ({related.length}）</h4>

                    <div className="flex flex-col gap-1">
                      {related.slice(0, relatedLimit).map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          className="rounded-lg px-3 py-2 text-left text-xs hover:bg-muted"
                          onClick={() => onPick(item)}
                        >
                          {kindMeta[item.kind].label} · {item.label}
                        </button>
                      ))}
                    </div>
                    {related.length > relatedLimit && (
                      <Button size="sm" variant="ghost" onClick={() => setRelatedLimit((value) => value + 20)}>

                        Show more associations
                      </Button>
                    )}
                  </section>
                )}
                <details className="border-t pt-3">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Raw data</summary>
                  <pre className="bg-muted/50 text-foreground max-w-full overflow-hidden rounded-md border p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
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

type AssetTreeData = {
  item: CoverageTreeItem;
  coverageEnabled: boolean;
  onToggle: (id: string) => void;
  onMore: (id: string) => void;
  onPick: (node: CoverageGraphNode) => void;
  match: boolean;
};
function TreeNode({ data }: { data: AssetTreeData }) {
  const { item, onToggle, onMore, onPick, coverageEnabled } = data;
  if (item.moreFor)
    return (
      <button
        type="button"
        className="asset-tree-more nodrag nopan"
        onClick={() => onMore(item.moreFor!)}
        aria-label={`Show more assets, remaining ${item.hidden} item`}
      >
        <Plus className="size-4" />

        Show more · {item.hidden}  item
      </button>
    );
  const node = item.node,
    meta = node ? kindMeta[node.kind] : null,
    Icon = meta?.icon ?? Network;
  return (
    <div
      className={cn(
        "asset-tree-node",
        node && !node.in_scope && "asset-tree-outside",
        data.match && "asset-tree-match",
      )}
      data-asset-key={node?.key ?? "scope"}
    >
      <div className="asset-tree-node-kind">
        <Icon className="size-3.5" />
        <span>{meta?.label ?? "Mission Scope"}</span>
        {item.childCount > 0 && (
          <button
            type="button"
            className="asset-tree-toggle nodrag nopan"
            aria-label={`${item.open ? "Close" : "Expand"} ${node?.label ?? "Mission Scope"}`}
            aria-expanded={item.open}
            onClick={() => onToggle(item.id)}
          >
            {item.open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {item.childCount}
          </button>
        )}
      </div>
      {node ? (
        <button type="button" className="asset-tree-title nodrag nopan" title={node.label} onClick={() => onPick(node)}>
          {node.label}
        </button>
      ) : (
        <div className="asset-tree-title">Asset Hierarchy</div>
      )}
      <div className="asset-tree-status">
        {node ? (
          !node.in_scope ? (
            "Out of range · Associated node"
          ) : coverageEnabled ? (
            <>
              <span className={node.tested ? "asset-tested-dot" : "asset-pending-dot"} />
              {node.tested ? "Tested" : "To be covered"}
            </>
          ) : (
            "Assets in scope"
          )
        ) : (
          "Expand the branch to view services and interfaces"
        )}
      </div>
    </div>
  );
}

function GraphInner({ taskId, coverageEnabled = true }: { taskId: string; coverageEnabled?: boolean }) {
  const [data, setData] = React.useState<CoverageGraphData>({ nodes: [], edges: [] });
  const [loading, setLoading] = React.useState(true),
    [error, setError] = React.useState("");
  const [query, setQuery] = React.useState(""),
    [onlyUntested, setOnlyUntested] = React.useState(false);
  const [expanded, setExpanded] = React.useState(new Map<string, boolean>()),
    [limits, setLimits] = React.useState(new Map<string, number>());
  const [selectedAsset, setSelectedAsset] = React.useState<CoverageGraphNode | null>(null);
  const [revision, setRevision] = React.useState(0);
  const treeRef = React.useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision deliberately refreshes the same task endpoint.
  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api
      .taskCoverageGraph(taskId)
      .then((result) => {
        if (active) setData({ nodes: result.nodes ?? [], edges: result.edges ?? [] });
      })
      .catch((cause) => {
        if (active) setError((cause as Error).message || "Asset loading failed");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [taskId, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing tasks clears the previous task's presentation state.
  React.useEffect(() => {
    setExpanded(new Map());
    setLimits(new Map());
    setQuery("");
    setOnlyUntested(false);
    setSelectedAsset(null);
  }, [taskId]);
  const projection = React.useMemo(
    () =>
      projectCoverageTree(data.nodes, data.edges, {
        query,
        onlyUntested: coverageEnabled && onlyUntested,
        expanded,
        limits,
      }),
    [data, query, onlyUntested, coverageEnabled, expanded, limits],
  );
  const onToggle = React.useCallback(
    (id: string) => {
      const item = projection.items.find((entry) => entry.id === id);
      if (!item) return;
      setExpanded((previous) => new Map(previous).set(id, !item.open));
    },
    [projection.items],
  );
  const onMore = React.useCallback(
    (id: string) => setLimits((previous) => new Map(previous).set(id, (previous.get(id) ?? 20) + 20)),
    [],
  );
  const selected = selectedAsset ? (projection.byKey.get(selectedAsset.key) ?? selectedAsset) : null;
  const related = React.useMemo(() => {
    if (!selected) return [];
    const keys = new Set<string>();
    for (const link of projection.links) {
      if (link.src === selected.key && link.dst !== selected.key) keys.add(link.dst);
      if (link.dst === selected.key && link.src !== selected.key) keys.add(link.src);
    }
    return [...keys].map((key) => projection.byKey.get(key)!).filter(Boolean);
  }, [selected, projection]);
  const inScope = data.nodes.filter((node) => node.in_scope).length,
    tested = data.nodes.filter((node) => node.in_scope && node.tested).length;
  return (
    <div className="coverage-tree-workspace flex h-full min-h-0 flex-col">
      <div className="coverage-tree-toolbar">
        <div>
          <span className="font-medium">Asset Hierarchy</span>
          <span className="ml-3 text-xs text-muted-foreground">

            Within range {inScope}
            {coverageEnabled ? ` · Tested ${tested}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
            <Input
              className="h-8 w-48 pl-8 text-xs"
              aria-label="Search asset hierarchy"
              placeholder="Search domain name, IP, interface..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {coverageEnabled && (
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={onlyUntested}
                onChange={(event) => setOnlyUntested(event.target.checked)}
              />

              View only not covered
            </label>
          )}
          <Button variant="ghost" size="sm" onClick={() => treeRef.current?.scrollTo({top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"})} aria-label="Return to top of asset tree"><ArrowUp className="size-3.5" />Back to top</Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRevision((value) => value + 1)}
            aria-label="Refresh asset hierarchy"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>
      {error && (
        <div className="px-4 py-2 text-xs text-destructive" role="alert">
          {error}  · Click to refresh and try again
        </div>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable region needs keyboard focus for arrow/PageDown navigation. */}
      <section ref={treeRef} className="coverage-tree-scroll" data-coverage-layout="tree" data-growth-direction="vertical" aria-label="Vertical asset tree" tabIndex={0}>
        {!loading && (!data.nodes.length || (projection.filtered && !projection.matchedCount)) ? (
          <div className="coverage-tree-empty">{data.nodes.length ? "No matching assets" : "There are currently no assets. After the task is executed, it will be presented here layer by layer."}</div>
        ) : (
          <div className="coverage-tree-branches">
            {projection.items.map((item) => (
              <div key={item.id} className="coverage-tree-entry" data-depth={item.depth} style={{"--tree-depth": item.depth} as React.CSSProperties}>
                <TreeNode data={{ item, coverageEnabled, onToggle, onMore, onPick: setSelectedAsset,
                  match: Boolean(projection.filtered && item.node && (!onlyUntested || (item.node.in_scope && !item.node.tested)) && (!query.trim() || [item.node.label, item.node.domain, item.node.ip, item.node.url, item.node.app_name, item.node.page_title].some((text) => text?.toLowerCase().includes(query.trim().toLowerCase())))) }} />
              </div>
            ))}
          </div>
        )}
      </section>
      <div className="coverage-tree-footer">Vertical expansion · Click on the branch to collapse or expand · Click on the asset to view details{projection.filtered ? ` · Match ${projection.matchedCount} item` : " · Multiple associations remain in details"}</div>
      <AssetSheet
        node={selected}
        taskId={taskId}
        related={related}
        onPick={setSelectedAsset}
        onOpenChange={(open) => !open && setSelectedAsset(null)}
      />
    </div>
  );
}

export function CoverageGraphTab({ taskId, coverageEnabled = true }: { taskId: string; coverageEnabled?: boolean }) {
  return (
    <div className="h-[72vh] min-h-96 overflow-hidden rounded-2xl border">
      <GraphInner taskId={taskId} coverageEnabled={coverageEnabled} />
    </div>
  );
}
