import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverageForest, projectCoverageTree } from "./coverage-tree";
import type { CoverageGraphNode, CoverageGraphEdge } from "./types";

const node = (key: string, kind: CoverageGraphNode["kind"], tested = false): CoverageGraphNode => ({
  key,
  kind,
  label: key,
  tested,
  in_scope: true,
});

test("asset hierarchy keeps alternate parents, cycles and isolated nodes without inventing relationships", () => {
  const nodes = [
    node("company", "company"),
    node("domain-a", "root_domain"),
    node("domain-b", "root_domain"),
    node("ip", "ip"),
    node("service", "service"),
    node("isolated", "endpoint"),
  ];
  const edges: CoverageGraphEdge[] = [
    { src: "company", dst: "domain-a" },
    { src: "company", dst: "domain-b" },
    { src: "domain-a", dst: "ip" },
    { src: "domain-b", dst: "ip" },
    { src: "ip", dst: "service" },
    { src: "service", dst: "ip" },
    { src: "ip", dst: "ip" },
  ];
  const snapshot = JSON.stringify([nodes, edges]),
    forest = buildCoverageForest(nodes, edges);
  assert.equal(forest.links.length, 7);
  assert.equal(forest.parent.get("ip"), "domain-a");
  assert.ok(forest.roots.includes("isolated"));
  for (const key of forest.byKey.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = key;
    while (current) {
      assert.ok(!visited.has(current));
      visited.add(current);
      current = forest.parent.get(current);
    }
  }
  const expanded = new Map(nodes.map((item) => [item.key, true]));
  const result = projectCoverageTree(nodes, edges, { expanded });
  assert.deepEqual(
    new Set(result.items.filter((item) => item.node).map((item) => item.node!.key)),
    new Set(nodes.map((item) => item.key)),
  );
  assert.equal(JSON.stringify([nodes, edges]), snapshot);
  assert.deepEqual(
    result.items.map(({ id, x, y }) => ({ id, x, y })),
    projectCoverageTree(nodes, edges, { expanded }).items.map(({ id, x, y }) => ({ id, x, y })),
  );
});

test("search and pending filter retain the connecting ancestry and only match real pending assets", () => {
  const nodes = [
    node("company", "company", true),
    node("domain", "root_domain", true),
    node("api", "endpoint"),
    { ...node("outside", "endpoint"), in_scope: false },
  ];
  const edges = [
    { src: "company", dst: "domain" },
    { src: "domain", dst: "api" },
    { src: "company", dst: "outside" },
  ];
  const result = projectCoverageTree(nodes, edges, {
    query: "API",
    onlyUntested: true,
    expanded: new Map([["company", false]]),
  });
  assert.equal(result.matchedCount, 1);
  assert.deepEqual(
    result.items.filter((item) => item.node).map((item) => item.node!.key),
    ["company", "domain", "api"],
  );
  assert.equal(projectCoverageTree(nodes, edges, { query: "missing" }).matchedCount, 0);
  assert.equal(projectCoverageTree(nodes, edges, { onlyUntested: true }).matchedCount, 1);
});

test("large fan-out is bounded, folded branches expand and hidden assets remain searchable", () => {
  const nodes = [
    node("company", "company"),
    ...Array.from({ length: 5000 }, (_, index) => node(`endpoint-${index}`, "endpoint")),
  ];
  const edges = nodes.slice(1).map((item) => ({ src: "company", dst: item.key }));
  const first = projectCoverageTree(nodes, edges);
  assert.equal(first.items.filter((item) => item.node).length, 21);
  assert.equal(first.items.find((item) => item.moreFor === "company")?.hidden, 4980);
  const more = projectCoverageTree(nodes, edges, { limits: new Map([["company", 40]]) });
  assert.equal(more.items.filter((item) => item.node).length, 41);
  const collapsed = projectCoverageTree(nodes, edges, { expanded: new Map([["company", false]]) });
  assert.equal(collapsed.items.filter((item) => item.node).length, 1);
  const found = projectCoverageTree(nodes, edges, { query: "endpoint-4999" });
  assert.equal(found.items.filter((item) => item.node).length, 2);
  assert.equal(found.items.find((item) => item.node?.key === "endpoint-4999")?.node?.label, "endpoint-4999");
});
