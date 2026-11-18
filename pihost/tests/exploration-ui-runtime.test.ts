import { test } from "node:test";
import assert from "node:assert/strict";
import {
	graphRenderSignature,
	graphDelta,
	relatedGraphNodes,
	placeGraphNodes,
	graphPollInterval,
	type GraphPoint,
	type GraphSize,
} from "../../web/src/lib/exploration-runtime.ts";
import type { TaskNode, Edge } from "../../web/src/lib/types.ts";

const node = (
	id: string,
	type: TaskNode["type"] = "fact",
	extra: Partial<TaskNode> = {},
): TaskNode => ({
	id,
	type,
	state: "done",
	priority: 5,
	origin: "worker",
	ts: "2026-10-28T00:00:00Z",
	payload: JSON.stringify({ summary: id }),
	...extra,
});
const edge = (
	src: string,
	dst: string,
	rel: Edge["rel"] = "spawns",
	finding_path = false,
): Edge => ({ src, dst, rel, finding_path });
test("render signature refreshes discovery paths, inherited metadata and live detail timestamps", () => {
	const n = node("1"),
		e = edge("1", "2");
	const original = graphRenderSignature([n], [e]);
	for (const change of [
		{ finding_path: true },
		{ inherited: true, source_task_id: "20" },
		{ ts: "2026-10-28T01:00:00Z" },
		{ origin: "mainagent" },
		{ priority: 9 },
	])
		assert.notEqual(graphRenderSignature([{ ...n, ...change }], [e]), original);
	assert.notEqual(
		graphRenderSignature([n], [{ ...e, finding_path: true }]),
		original,
	);
});
test("runtime diff reports real additions and state changes without mutating graph data", () => {
	const running = node("work", "intent", { state: "running" }),
		before = [node("root"), running];
	const after = [
		node("root"),
		{ ...running, state: "done" },
		node("proof"),
		node("finding", "finding"),
	];
	const snapshot = JSON.stringify([before, after]);
	const delta = graphDelta(before, after);
	assert.deepEqual(
		delta.added.map((n) => n.id),
		["proof", "finding"],
	);
	assert.deepEqual(
		delta.changed.map((n) => n.id),
		["work"],
	);
	assert.equal(JSON.stringify([before, after]), snapshot);
});
test("inherited runs never produce current-task runtime additions", () => {
	const inherited = node("source", "intent", {
		state: "running",
		inherited: true,
		source_task_id: "9",
	});
	assert.deepEqual(graphDelta([], [inherited]).added, []);
	assert.deepEqual(
		graphDelta([inherited], [{ ...inherited, state: "done" }]).changed,
		[],
	);
});
test("unchanged polls and reorder-only relation responses do not generate false runtime events", () => {
	const nodes = [node("1"), node("2")],
		links = [edge("1", "2"), edge("2", "1", "derived_from")];
	const delta = graphDelta(nodes, nodes, links, [...links].reverse());
	assert.equal(delta.relationsChanged, false);
	assert.equal(
		delta.added.length + delta.changed.length + delta.removed.length,
		0,
	);
	assert.equal(
		graphDelta(nodes, nodes, links, [
			{ ...links[0], finding_path: true },
			links[1],
		]).relationsChanged,
		true,
	);
});
test("detail-only timestamp refresh does not falsely announce a worker completion", () => {
	const old = node("1", "intent");
	assert.equal(
		graphDelta([old], [{ ...old, ts: "2026-10-28T02:00:00Z" }]).changed.length,
		0,
	);
	assert.equal(
		graphDelta([old], [{ ...old, payload: '{"summary":"new detail"}' }]).changed
			.length,
		1,
	);
});
test("selected finding includes multiple causal parents and cycles, without pulling sibling branches", () => {
	const nodes = [
		"root",
		"a",
		"b",
		"merge",
		"finding",
		"sibling",
		"digest",
		"member",
	].map((id) => node(id));
	const links = [
		edge("root", "a"),
		edge("root", "b"),
		edge("a", "merge"),
		edge("b", "merge"),
		edge("merge", "finding", "yields"),
		edge("merge", "a", "derived_from"),
		edge("b", "sibling"),
		edge("digest", "a", "covers"),
	];
	assert.deepEqual(
		relatedGraphNodes(nodes, links, "finding"),
		new Set(["finding", "merge", "a", "b", "root"]),
	);
	assert.deepEqual(relatedGraphNodes(nodes, links, "missing"), new Set());
});
test("selected direction retains descendants while the shared root does not select unrelated work", () => {
	const nodes = ["root", "direction", "work", "fact", "unrelated"].map((id) =>
		node(id),
	);
	const links = [
		edge("root", "direction"),
		edge("direction", "work"),
		edge("work", "fact", "yields"),
		edge("root", "unrelated"),
	];
	assert.deepEqual(
		relatedGraphNodes(nodes, links, "direction"),
		new Set(["direction", "root", "work", "fact"]),
	);
});
function placement(
	ids: string[],
	points: Record<string, GraphPoint>,
	previous: Record<string, GraphPoint>,
	cached: Record<string, GraphPoint> = {},
	links: Edge[] = [],
) {
	const nodes = ids.map((id) => node(id)),
		layout = new Map(Object.entries(points)),
		old = new Map(Object.entries(previous)),
		cache = new Map(Object.entries(cached)),
		sizes = new Map(
			ids.map(
				(id) => [id, { width: 220, height: 130 }] satisfies [string, GraphSize],
			),
		);
	return placeGraphNodes(nodes, links, layout, cache, old, sizes);
}
test("initial layout keeps its barycentric arrangement and later polls preserve manually dragged nodes", () => {
	const layout = {
		root: { x: 0, y: 200 },
		a: { x: 430, y: 0 },
		b: { x: 430, y: 400 },
	};
	assert.deepEqual(
		Object.fromEntries(placement(["root", "a", "b"], layout, {})),
		layout,
	);
	const dragged = {
		root: { x: -120, y: 80 },
		a: { x: 470, y: -90 },
		b: { x: 430, y: 430 },
	};
	assert.deepEqual(
		Object.fromEntries(placement(["root", "a", "b"], layout, dragged)),
		dragged,
	);
});
test("new work grows close to its real parent while existing positions stay exact", () => {
	const previous = { root: { x: 0, y: 100 }, work: { x: 430, y: 120 } };
	const result = placement(
		["root", "work", "fact"],
		{ ...previous, fact: { x: 860, y: 9000 } },
		previous,
		previous,
		[edge("root", "work"), edge("work", "fact", "yields")],
	);
	assert.deepEqual(result.get("work"), previous.work);
	assert.deepEqual(result.get("root"), previous.root);
	assert.equal(result.get("fact")!.x, 860);
	assert.ok(Math.abs(result.get("fact")!.y - 120) < 20);
});
test("reopening a branch reuses its cached layout without overlapping existing visible nodes", () => {
	const result = placement(
		["a", "b"],
		{ a: { x: 430, y: 0 }, b: { x: 430, y: 0 } },
		{ a: { x: 430, y: 0 } },
		{ b: { x: 430, y: 0 } },
	);
	assert.deepEqual(result.get("a"), { x: 430, y: 0 });
	assert.ok(Math.abs(result.get("b")!.y) >= 160);
});
test("a large new sibling batch has collision-free positions and no global relayout", () => {
	const nodes = [
		node("root"),
		...Array.from({ length: 1000 }, (_, i) => node("w" + i, "intent")),
	];
	const layout = new Map(
		nodes.map((n, i) => [n.id, { x: i ? 430 : 0, y: i * 238 }]),
	);
	const sizes = new Map(nodes.map((n) => [n.id, { width: 220, height: 130 }]));
	const previous = new Map([["root", { x: 0, y: 0 }]]);
	const placed = placeGraphNodes(
		nodes,
		nodes.slice(1).map((n) => edge("root", n.id)),
		layout,
		previous,
		previous,
		sizes,
	);
	assert.deepEqual(placed.get("root"), { x: 0, y: 0 });
	assert.equal(placed.size, 1001);
	const ys = nodes
		.slice(1)
		.map((n) => placed.get(n.id)!.y)
		.sort((a, b) => a - b);
	for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 160);
});
test("polling stays live for current workers, bounds large graphs and slows hidden pages", () => {
	const active = [node("run", "intent", { state: "running" })];
	assert.equal(graphPollInterval(active), 3000);
	assert.equal(graphPollInterval(active, false), 30000);
	assert.equal(
		graphPollInterval(active.map((n) => ({ ...n, inherited: true }))),
		8000,
	);
	assert.equal(
		graphPollInterval(Array.from({ length: 1001 }, (_, i) => node(String(i)))),
		15000,
	);
});

test("short closing grace keeps final goal changes responsive without accelerating large graphs", () => {
	assert.equal(graphPollInterval([node("done")], true, true), 3000);
	assert.equal(
		graphPollInterval(
			Array.from({ length: 1001 }, (_, i) => node(String(i))),
			true,
			true,
		),
		15000,
	);
});
