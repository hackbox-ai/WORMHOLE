/** UI retention + runtime feedback against real graph HTTP/DB and a controlled
 * native Pi task. Other page chrome uses fixtures; no external target is probed. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { chromium, type Page } from "playwright-core";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { TaskService, TaskEngine } from "../src/domains/tasks/index.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { ToolsService } from "../src/domains/tools/service.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";
import { resetPiRuntime } from "../src/pi/session-host.ts";
import {
	startMockAnthropic,
	type ToolCallSpec,
} from "../tests/fixtures/mock-anthropic.ts";
import { mockHandle } from "../../web/src/lib/mock/handler.ts";

const root = process.env.WORMHOLE_PATH_UI_QA_ROOT;
if (!root) throw new Error("set WORMHOLE_PATH_UI_QA_ROOT");
const config = loadConfig();
assert.ok(
	new URL(config.database.dsn).pathname.startsWith("/wormhole_poc_test_path_ui_"),
);
assert.ok(
	path.resolve(config.dataDir).startsWith(path.resolve(root) + path.sep),
);
process.env.WORMHOLE_WEB_DIST = path.resolve("../web/out");
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await mkdir(config.dataDir, { recursive: true });
const dlq = path.join(config.dataDir, "qa-dlq"),
	agents = new AgentsService(pool, dlq),
	assets = new AssetsService(pool, dlq),
	findings = new FindingsService(pool, dlq),
	intercept = new InterceptService(pool, dlq),
	tools = new ToolsService(pool, dlq);
const engine = new TaskEngine(pool, config, {
		agents,
		assets,
		findings,
		intercept,
		settingsConsumers: null,
	}),
	graph = engine.graph,
	tasks = new TaskService(pool, dlq, () => {});
const auth = new AuthService(pool, authKeyPath(config.dataDir));
let token: string;
if (await auth.initialized()) token = await auth.signToken();
else {
	const result = await auth.init("path-ui-fixture-password");
	assert.ok(result.ok);
	token = result.token;
}
let failGraph = false,
	failLineage = false;
const browserErrors: string[] = [],
	graphReads: { task: string; nodes: any[] }[] = [],
	uiWrites: string[] = [];
const ctx = {
	pool,
	config,
	auth,
	tasks,
	taskEngine: engine,
	findings,
	tools,
	startedAt: Date.now(),
} as AppContext;
const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? "/", "http://fixture"),
			p = url.pathname;
		if (p === "/_qa/font.ttc") {
			res.setHeader("Content-Type", "font/collection");
			res.end(await readFile(path.join(root, "qa-font.ttc")));
			return;
		}
		if (p === "/api/exploration/graph") {
			if (failGraph) {
				failGraph = false;
				res
					.writeHead(503, { "content-type": "application/json" })
					.end('{"error":"controlled graph transport failure"}');
				return;
			}
			await routeRequest(req, res, ctx);
			return;
		}
		if (/^\/api\/exploration\/findings\/\d+\/lineage$/.test(p)) {
			if (failLineage) {
				failLineage = false;
				res
					.writeHead(503, { "content-type": "application/json" })
					.end('{"error":"controlled lineage transport failure"}');
				return;
			}
			await routeRequest(req, res, ctx);
			return;
		}
		if (/^\/api\/exploration\/findings\/\d+$/.test(p)) {
			await routeRequest(req, res, ctx);
			return;
		}
		if (!p.startsWith("/api/") || p.startsWith("/api/auth/")) {
			await routeRequest(req, res, ctx);
			return;
		}
		if (p.endsWith("/stream") || p === "/api/events") {
			res
				.writeHead(200, { "content-type": "text/event-stream" })
				.end(": fixture\n\n");
			return;
		}
		let body: unknown;
		if (/^\/api\/tasks\/\d+$/.test(p))
			body = await tasks.get(Number(p.split("/").at(-1)));
		else if (/^\/api\/findings\/\d+$/.test(p))
			body = await findings.get(Number(p.split("/").at(-1)));
		else
			body = await mockHandle(
				req.method ?? "GET",
				p.slice(4) + url.search,
				undefined,
			);
		res
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify(body ?? {}));
	} catch (e) {
		res
			.writeHead(500, { "content-type": "application/json" })
			.end(JSON.stringify({ error: (e as Error).message }));
	}
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin =
	"http://127.0.0.1:" + (server.address() as { port: number }).port;
const browser = await chromium.launch({
	executablePath:
		"/root/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome",
	headless: true,
	args: ["--no-sandbox"],
});
const context = await browser.newContext({
	viewport: { width: 1440, height: 1000 },
	timezoneId: "Asia/Shanghai",
	permissions: ["clipboard-read", "clipboard-write"],
});
await context.addInitScript(
	(value) => localStorage.setItem("wormhole_token", value),
	token,
);
await context.addCookies([
	{ name: "wormhole_token", value: token, url: origin },
	{ name: "theme_mode", value: "light", url: origin },
]);
const page = await context.newPage();
page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("request", (request) => {
	if (
		request.url().startsWith(origin + "/api/") &&
		!["GET", "HEAD"].includes(request.method())
	)
		uiWrites.push(request.method() + " " + new URL(request.url()).pathname);
});
page.on("response", (response) => {
	const url = new URL(response.url());
	if (url.pathname === "/api/exploration/graph" && response.ok())
		void response
			.json()
			.then((data) =>
				graphReads.push({
					task: url.searchParams.get("task") ?? "",
					nodes: data.nodes ?? [],
				}),
			)
			.catch(() => {});
});
let model: Server | undefined;
async function task(name: string) {
	const result = await tasks.create({
		name,
		description: name,
		goal: "Controlled graph interface acceptance",
		queued: true,
	});
	assert.ok(result.ok);
	const id = Number(result.task.id);
	await pool.query(
		"UPDATE tasks SET status='running',queued=false,modeling_initialized=true WHERE id=$1",
		[id],
	);
	await graph.ensure(id);
	return id;
}
async function state(id: number, value: string) {
	await pool.query(
		"UPDATE exploration_nodes SET state=$2,updated_at=now() WHERE id=$1",
		[id, value],
	);
}
async function refresh() {
	await page.evaluate(() =>
		document.dispatchEvent(new Event("visibilitychange")),
	);
}
async function font() {
	await page.addStyleTag({
		content:
			'@font-face{font-family:PathQA;src:url("/_qa/font.ttc")}body,button,input,textarea,select,pre,code,h1,h2,h3,span{font-family:PathQA,Arial,sans-serif!important}',
	});
	await page.evaluate(() => document.fonts.ready);
}
async function openTask(id: number) {
	await page.goto(origin + "/function/tasks/detail/?id=" + id + "&tab=graph", {
		waitUntil: "networkidle",
	});
	await font();
	await page.locator(".path-runtime-state").waitFor();
	await page.locator(".react-flow__node").first().waitFor();
}
async function index() {
	const b = page.getByRole("button", { name: "Node index", exact: true });
	if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
	await page
		.getByRole("combobox", { name: "Filter execution node type", exact: true })
		.selectOption("all");
}
async function focus(id: number) {
	await index();
	await page
		.getByRole("textbox", { name: "Search execution node", exact: true })
		.fill(String(id));
	const item = page
		.locator(".path-index-item")
		.filter({ has: page.getByText("#" + id, { exact: true }) });
	await item.locator("button").first().click();
	await page.getByRole("button", { name: "Turn off node index", exact: true }).click();
	await page.locator(`[data-path-node-id="${id}"]`).waitFor();
	await page.waitForTimeout(280);
}
const viewport = () =>
	page.locator(".path-canvas .react-flow__viewport").getAttribute("style");
const position = (id: number) =>
	page.locator(`[data-path-node-id="${id}"]`).evaluate((el) => {
		const p = new DOMMatrix(getComputedStyle(el.parentElement!).transform);
		return { x: p.m41, y: p.m42 };
	});
async function screenshot(name: string) {
	await page.screenshot({
		path: path.join(root, "evidence", name + ".png"),
		fullPage: true,
	});
}
try {
	const id = await task("Roadmap retention function acceptance"),
		source = await task("Direct Source Task");
	const sourceFact = await graph.recordFact(source, {
		summary: "Original text of inheritance evidence",
		detail: "source-preserved",
	});
	await pool.query(
		"INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)",
		[id, source],
	);
	const goal = await graph.addGoal(id, {
		text: "Verify permission boundaries",
		vulnclass: "fixture",
	});
	const work = await graph.addIntent(id, { summary: "Controlled interface verification" });
	await state(work, "running");
	await pool.query(
		"UPDATE exploration_nodes SET payload=payload||$2::jsonb WHERE id=$1",
		[
			work,
			JSON.stringify({
				url: "http://fixture.invalid/login",
				worker: "Worker #1",
				detail: "KEEP_RAW_FIELDS",
			}),
		],
	);
	const oldIntent = await graph.addIntent(id, { summary: "Stage Check" });
	await state(oldIntent, "done");
	const fact = await graph.recordFact(
		id,
		{ summary: "Compressed facts", detail: "KEEP_DIGEST_MEMBER" },
		"worker",
		oldIntent,
	);
	const follow = await graph.addIntent(id, {
		summary: "Review based on stage facts",
		parent_ids: [fact],
	});
	await state(follow, "done");
	const finding = await findings.record({
		task_id: id,
		intent_id: follow,
		vulnclass: "ui-fixture",
		name: "Controlled Discovery Path",
		severity: "info",
		summary: "Fixed fixture, only verification drawing is displayed",
		evidence: "controlled graph evidence",
	});
	const eid = (
		await pool.query("SELECT exploration_id FROM tasks WHERE id=$1", [id])
	).rows[0].exploration_id;
	const digest = Number(
		(
			await pool.query(
				"INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,payload,state,origin) VALUES($1,$2,'digest','stage summary',$3::jsonb,'active','planner') RETURNING id",
				[
					id,
					eid,
					JSON.stringify({
						summary: "Stage Summary",
						member_ids: { facts: [fact], intents: [oldIntent] },
					}),
				],
			)
		).rows[0].id,
	);
	for (const member of [fact, oldIntent])
		await pool.query(
			"INSERT INTO exploration_edges(exploration_id,src_id,rel,dst_id) VALUES($1,$2,'covers',$3)",
			[eid, digest, member],
		);
	await graph.addIntent(id, {
		summary: "Use direct source evidence",
		parent_ids: [sourceFact],
	});
	for (let i = 0; i < 82; i++) {
		const n = await graph.recordFact(id, { summary: "History " + i });
		if (i === 0)
			await pool.query(
				"UPDATE exploration_nodes SET state='confirmed' WHERE id=$1",
				[n],
			);
	}
	assert.equal(
		(await fetch(origin + "/api/exploration/graph?task=" + id)).status,
		401,
	);
	await openTask(id);
	for (const name of [
		"Executing",
		"Reading ratio",
		"Full picture",
		"Node index",
		"Follow execution",
		"Operational dynamics",
	])
		await page.getByRole("button", { name, exact: true }).waitFor();
	await page.getByLabel("Execution path minimap", { exact: true }).waitFor();
	assert.ok(
		(await page.locator(".path-canvas .react-flow__controls button").count()) >=
			3,
	);
	assert.equal(
		await page
			.getByRole("button", { name: "Follow execution", exact: true })
			.getAttribute("aria-pressed"),
		"false",
	);
	assert.equal(
		await page.locator(".path-runtime-history").count(),
		0,
		"initial history is not announced as new work",
	);
	await focus(work);
	assert.ok(
		(await page.locator(`[data-path-node-id="${work}"]`).innerText()).includes(
			"Worker #1",
		),
	);
	const card = page.locator(`[data-path-node-id="${work}"]`);
	await card.click();
	const sheet = page.getByRole("dialog");
	await sheet.getByText("Content summary", { exact: true }).waitFor();
	assert.ok((await sheet.innerText()).includes("http://fixture.invalid/login"));
	await sheet.locator("summary").filter({ hasText: "Raw data" }).click();
	assert.ok((await sheet.innerText()).includes("KEEP_RAW_FIELDS"));
	await sheet.getByRole("button", { name: "Copy", exact: true }).click();
	await sheet.getByText("Copied", { exact: true }).waitFor();
	assert.ok(
		(await page.evaluate(() => navigator.clipboard.readText())).includes(
			"KEEP_RAW_FIELDS",
		),
	);
	await page.keyboard.press("Escape");
	const box = await card.boundingBox();
	assert.ok(box);
	await page.mouse.move(box.x + box.width / 2, box.y + 36);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 48, box.y + 68, { steps: 8 });
	await page.mouse.up();
	const manual = await position(work),
		stableViewport = await viewport();
	await state(work, "blocked");
	await refresh();
	await page
		.locator(`[data-path-node-id="${work}"][data-state="blocked"]`)
		.waitFor();
	assert.deepEqual(await position(work), manual);
	assert.equal(await viewport(), stableViewport);
	const fresh = await graph.addIntent(id, {
		summary: "Newly distributed controlled inspection",
		parent_ids: [fact],
	});
	await state(fresh, "running");
	await refresh();
	await page
		.locator(".path-runtime-announcement")
		.filter({ hasText: "Newly distributed controlled inspection" })
		.waitFor();
	assert.equal(await viewport(), stableViewport);
	assert.deepEqual(await position(work), manual);
	await page.getByRole("button", { name: "Follow execution", exact: true }).click();
	await page.locator(`[data-path-node-id="${fresh}"]`).waitFor();
	await page.waitForTimeout(300);
	assert.equal(
		await page
			.getByRole("button", { name: "Follow execution", exact: true })
			.getAttribute("aria-pressed"),
		"true",
	);
	assert.ok((await page.locator(".path-flow-particle").count()) > 0);
	await page
		.locator(".path-canvas .react-flow__controls button")
		.first()
		.click();
	assert.equal(
		await page
			.getByRole("button", { name: "Follow execution", exact: true })
			.getAttribute("aria-pressed"),
		"false",
	);
	await page.getByRole("button", { name: "Follow execution", exact: true }).click();
	await page.waitForTimeout(300);
	await page.getByRole("button", { name: "Operational dynamics", exact: true }).click();
	await page.locator('.path-workspace[data-motion="off"]').waitFor();
	assert.equal(await page.locator(".path-flow-particle").count(), 0);
	assert.ok(
		(await page.locator(".path-runtime-state").innerText()).includes("Executing"),
	);
	const pane = page.locator(".path-canvas .react-flow__pane"),
		pb = await pane.boundingBox();
	assert.ok(pb);
	await page.mouse.move(pb.x + 45, pb.y + pb.height - 110);
	await page.mouse.down();
	await page.mouse.move(pb.x + 105, pb.y + pb.height - 70, { steps: 5 });
	await page.mouse.up();
	assert.equal(
		await page
			.getByRole("button", { name: "Follow execution", exact: true })
			.getAttribute("aria-pressed"),
		"false",
	);
	await page.getByRole("button", { name: "Executing", exact: true }).click();
	assert.equal(
		await page
			.getByRole("button", { name: "Executing", exact: true })
			.getAttribute("aria-pressed"),
		"true",
	);
	await page.getByRole("button", { name: "Executing", exact: true }).click();
	await index();
	await page
		.getByRole("textbox", { name: "Search execution node", exact: true })
		.fill("");
	await page.getByRole("button", { name: "Show more nodes", exact: true }).click();
	assert.ok((await page.locator(".path-index-item").count()) > 40);
	await page
		.getByRole("combobox", { name: "Filter execution node type", exact: true })
		.selectOption("digest");
	assert.equal(await page.locator(".path-index-item").count(), 1);
	await page.getByRole("button", { name: "Turn off node index", exact: true }).click();
	await focus(digest);
	await page.locator(`[data-path-node-id="${digest}"]`).click();
	await sheet.getByText("Compressed nodes (2)", { exact: true }).waitFor();
	await sheet.getByRole("button").filter({ hasText: "Compressed facts" }).click();
	assert.ok((await sheet.innerText()).includes(String(fact)));
	await page.keyboard.press("Escape");
	await focus(sourceFact);
	await page.locator(`[data-path-node-id="${sourceFact}"]`).click();
	await sheet
		.getByText("Source Task #" + source + " · Read only", { exact: true })
		.waitFor();
	await page.keyboard.press("Escape");
	const raw = await graph.graph(id),
		originNode = raw.nodes.find(
			(n: any) => n.type === "fact" && n.state === "origin" && !n.inherited,
		)!;
	await focus(Number(originNode.id));
	const fullCount = Number(
		(await page.locator(".path-workspace-toolbar").innerText()).match(
			/(\d+) 个可见节点/,
		)![1],
	);
	await page
		.getByRole("button", {
			name: `Collapse node
Branch of ${originNode.id} branches`,
			exact: true,
		})
		.click();
	const foldedCount = Number(
		(await page.locator(".path-workspace-toolbar").innerText()).match(
			/(\d+) 个可见节点/,
		)![1],
	);
	assert.ok(foldedCount < fullCount);
	await page.getByRole("button", { name: "Expand branch", exact: true }).click();
	await focus(follow);
	assert.equal(
		await page
			.locator(`[data-path-node-id="${follow}"]`)
			.getAttribute("data-finding-path"),
		"true",
	);
	await page.getByRole("button", { name: "Full picture", exact: true }).click();
	await page.waitForTimeout(300);
	await screenshot("path-overview-light");
	failGraph = true;
	await refresh();
	await page
		.getByText("Graph data update failed, the last result has been retained.", { exact: true })
		.waitFor();
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await page
		.getByText("Graph data update failed, the last result has been retained.", { exact: true })
		.waitFor({ state: "hidden" });
	await page.evaluate(() => {
		document.documentElement.classList.add("dark");
		document.documentElement.style.colorScheme = "dark";
	});
	await screenshot("path-overview-dark");
	failLineage = true;
	await page.goto(
		origin + "/function/findings/detail/?id=" + finding.finding_id,
		{ waitUntil: "networkidle" },
	);
	await font();
	await page.getByRole("tab", { name: "Link diagram", exact: true }).click();
	await page.getByText(/链路加载失败/).waitFor();
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await page.locator(".path-canvas").waitFor();
	await page.locator(".path-node-finding").waitFor();
	assert.ok((await page.locator(".path-finding-edge").count()) > 0);
	await screenshot("finding-lineage");

	// A real Pi task drives its tools, DB graph, HTTP polling and final goal state.
	const responder = (
		body: Record<string, unknown>,
	): ToolCallSpec | undefined => {
		const names = (body.tools as { name: string }[]).map((t) => t.name),
			messages = body.messages as {
				content: { type: string; name?: string; text?: string }[];
			}[],
			last = messages.at(-1);
		const result = last?.content.some((c) => c.type === "tool_result"),
			used = (name: string) =>
				messages.some((m) =>
					m.content.some((c) => c.type === "tool_use" && c.name === name),
				);
		if (names.includes("record_fact")) {
			if (!used("record_fact"))
				return {
					name: "record_fact",
					input: {
						summary: "Native Worker has completed controlled check",
						confidence: "observed",
						evidence: "deterministic fixture",
					},
				};
			if (names.includes("report_finding") && !used("report_finding"))
				return {
					name: "report_finding",
					input: {
						intent_id: Number(
							messages
								.flatMap((m) =>
									m.content
										.filter((c) => c.type === "text")
										.map((c) => c.text ?? ""),
								)
								.join("\n")
								.match(/执行意图 #(\d+)/)?.[1],
						),
						name: "Native task controlled discovery",
						vulnclass: "ui-fixture",
						severity: "info",
						summary: "Validate UI feedback and data binding only",
						evidence: "controlled synthetic finding",
					},
				};
			return undefined;
		}
		if (result) return undefined;
		const input =
			last?.content
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("") ?? "";
		if (names.includes("prove_goal")) {
			const overview = JSON.parse(
				input.split("Mission exploration graph overview:\n")[1]!.split("\nOperational constraints:")[0]!,
			);
			const fact = overview.recent_facts.find(
				(f: any) => f.state === "confirmed",
			);
			if (fact && !overview.running_intents.length)
				return {
					name: "prove_goal",
					input: {
						goal_id: overview.goals[0].id,
						evidence_id: fact.id,
						reason: "controlled graph verified",
					},
				};
			if (
				!overview.open_intents.length &&
				!overview.running_intents.length &&
				!overview.done_intents_total
			)
				return {
					name: "add_intent",
					input: { summary: "Native Worker runtime verification" },
				};
		}
		if (names.includes("set_goals"))
			return { name: "set_goals", input: { text: "Verify graph updates for native tasks" } };
		return undefined;
	};
	const mock = await startMockAnthropic(0, {
		marker: "PATH_UI_NATIVE",
		tool: responder,
		delayMs: 1800,
	});
	model = mock.server;
	const llm = new LlmService(pool, dlq, config.pi.modelsPath),
		profile = await llm.createProfile({
			name: "path-ui-fixture-" + process.pid,
			model: "mock-1",
			format: "anthropic",
			base_url:
				"http://127.0.0.1:" + (model.address() as { port: number }).port,
			api_key: "fixture",
		});
	assert.ok(profile.ok);
	await llm.activate(Number(profile.profile!.id));
	const compiled = await llm.compileToPiRuntime();
	assert.ok(!("error" in compiled));
	config.pi.provider = compiled.provider;
	config.pi.modelId = compiled.modelId;
	resetPiRuntime();
	const native = await task("Native runtime interface acceptance");
	await openTask(id);
	await page.evaluate(
		(url) => history.pushState(null, "", url),
		"/function/tasks/detail/?id=" + native + "&tab=graph",
	);
	await page
		.getByRole("heading", { name: "Native runtime interface acceptance", exact: true })
		.waitFor();
	await index();
	await page
		.getByRole("textbox", { name: "Search execution node", exact: true })
		.fill("");
	const nativeRoot = (await graph.graph(native)).nodes.find(
		(n: any) => n.state === "origin",
	)!;
	await page
		.locator(".path-index")
		.getByText("#" + nativeRoot.id, { exact: true })
		.waitFor();
	assert.equal(
		await page.locator(".path-index-item").count(),
		1,
		"client navigation must not mix old task nodes into the new task",
	);
	await page.getByRole("button", { name: "Turn off node index", exact: true }).click();
	assert.equal(await page.locator(".path-runtime-history").count(), 0);
	await engine.launch(native);
	await page
		.locator(".path-runtime-state")
		.filter({ hasText: "Executing" })
		.waitFor({ timeout: 60000 });
	await page.getByRole("button", { name: "Follow execution", exact: true }).click();
	await page.locator(".path-node-live").first().waitFor();
	await page.waitForTimeout(300);
	assert.equal(
		await page
			.getByRole("button", { name: "Follow execution", exact: true })
			.getAttribute("aria-pressed"),
		"true",
	);
	await screenshot("native-worker-running");
	await page.locator(".path-node-finding").first().waitFor({ timeout: 60000 });
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline && (await tasks.get(native))?.status !== "done")
		await new Promise((r) => setTimeout(r, 250));
	assert.equal((await tasks.get(native))?.status, "done");
	await engine.drain(native);
	await page
		.locator(".path-runtime-state")
		.filter({ hasText: "There are no steps currently executing" })
		.waitFor({ timeout: 20000 });
	await page.locator(".path-runtime-history summary").click();
	await page
		.locator(".path-runtime-history")
		.getByRole("button")
		.filter({ hasText: "New findings" })
		.first()
		.waitFor();
	const calls = (
		await pool.query(
			"SELECT tool_key,native_tool_call_id,is_error FROM tool_calls WHERE business_id LIKE $1 ORDER BY id",
			[`task-${native}%`],
		)
	).rows;
	assert.ok(
		calls.some((c) => c.tool_key === "record_fact") &&
			calls.some((c) => c.tool_key === "prove_goal"),
	);
	assert.ok(calls.every((c) => c.native_tool_call_id && !c.is_error));
	assert.ok(
		graphReads.some(
			(r) =>
				r.task === String(native) &&
				r.nodes.some((n) => n.type === "intent" && n.state === "running"),
		),
	);
	const observedDeadline = Date.now() + 20000;
	while (
		Date.now() < observedDeadline &&
		!graphReads.some(
			(r) =>
				r.task === String(native) &&
				r.nodes.some((n) => n.type === "goal" && n.state === "met"),
		)
	)
		await page.waitForTimeout(200);
	assert.ok(
		graphReads.some(
			(r) =>
				r.task === String(native) &&
				r.nodes.some((n) => n.type === "goal" && n.state === "met"),
		),
	);
	await page.keyboard.press("Escape");
	await screenshot("native-task-complete");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.locator('.path-workspace[data-motion="off"]').waitFor();
	assert.equal(await page.locator(".path-flow-particle").count(), 0);
	await page.setViewportSize({ width: 390, height: 844 });
	await screenshot("path-mobile");
	assert.ok(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
	);
	assert.deepEqual(browserErrors, []);
	assert.deepEqual(uiWrites, []);
	await writeFile(
		path.join(root, "evidence/path-ui-browser.json"),
		JSON.stringify(
			{
				retained: [
					"search",
					"type_filter",
					"load_more",
					"locate_readable_zoom",
					"branch_collapse",
					"expand_all",
					"running_filter",
					"minimap",
					"zoom_controls",
					"legend",
					"node_summary_fields",
					"raw_data_copy",
					"digest_members",
					"inherited_readonly",
					"finding_path_highlights",
					"finding_lineage",
					"lineage_retry",
				],
				runtime: {
					new_node: true,
					state_transition: true,
					manual_position_preserved: true,
					viewport_preserved: true,
					opt_in_follow: true,
					manual_pan_disables_follow: true,
					manual_zoom_disables_follow: true,
					motion_toggle: true,
					reduced_motion: true,
					transport_retry: true,
				},
				native_task: {
					id: native,
					tool_calls: calls.map((c) => c.tool_key),
					observed_running: true,
					observed_goal_met: true,
				},
				browser_errors: browserErrors,
				ui_mutations: uiWrites,
			},
			null,
			2,
		),
	);
	console.log(
		"Graph feature retention, runtime interactions and real native Pi task PASS",
	);
} finally {
	await browser.close();
	await engine.shutdown();
	if (model) {
		model.closeAllConnections();
		await new Promise<void>((r) => model!.close(() => r()));
	}
	server.closeAllConnections();
	await new Promise<void>((r) => server.close(() => r()));
	await pool.end();
}
