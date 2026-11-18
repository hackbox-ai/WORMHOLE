import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	lstat,
	symlink,
	link,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { WorkspaceService } from "../src/domains/workspace/service.ts";
import { workspaceGate } from "../src/domains/workspace/maintenance.ts";
import { TaskService } from "../src/domains/tasks/service.ts";
import { TaskEngine } from "../src/domains/tasks/engine.ts";
import { ExplorationService } from "../src/domains/exploration/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { mergeTriggeredRuns } from "../src/domains/tasks/scheduler.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

const config = loadConfig(),
	admin = new Pool({ connectionString: config.database.dsn }),
	schema = "workspace_cleanup_" + process.pid + "_" + Date.now();
let pool: Pool,
	dir: string,
	workspace: WorkspaceService,
	tasks: TaskService,
	graph: ExplorationService,
	findings: FindingsService,
	origin: string,
	token: string;
const busy = new Set<number>(),
	locks = new Set<number>();
const server = createServer((req, res) => void routeRequest(req, res, context));
let context: AppContext;
before(async () => {
	await admin.query("CREATE SCHEMA " + schema);
	pool = new Pool({
		connectionString: config.database.dsn,
		options: "-c search_path=" + schema,
	});
	await runMigrations(pool);
	dir = await mkdtemp(path.join(tmpdir(), "wormhole-workspace-cleanup-"));
	workspace = new WorkspaceService(
		pool,
		path.join(dir, "dlq"),
		path.join(dir, "workspace"),
	);
	await workspace.ensure();
	workspace.maintenance.bind({
		taskBusy: (id) => busy.has(id) || locks.has(id),
		acquireTask: (id) => {
			if (busy.has(id) || locks.has(id)) return null;
			locks.add(id);
			return () => {
				locks.delete(id);
			};
		},
		sessionBusy: (id) => id === 987,
	});
	tasks = new TaskService(pool, path.join(dir, "dlq"), () => {});
	graph = new ExplorationService(pool);
	findings = new FindingsService(pool, path.join(dir, "dlq"));
	const auth = new AuthService(pool, authKeyPath(dir));
	const result = await auth.init("isolated-workspace-password");
	assert.ok(result.ok);
	token = result.token;
	context = { pool, config, workspace, auth } as AppContext;
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
after(async () => {
	server.closeAllConnections();
	await new Promise<void>((r) => server.close(() => r()));
	await pool?.end();
	await admin.query("DROP SCHEMA " + schema + " CASCADE");
	await admin.end();
	if (dir) await rm(dir, { recursive: true, force: true });
});
async function task(status = "done") {
	const result = await tasks.create({
		name: "空间清理夹具",
		goal: "受控空间验证",
		queued: true,
	});
	assert.ok(result.ok);
	const id = Number(result.task.id);
	await pool.query(
		"UPDATE tasks SET status=$2,queued=false,paused=false,modeling_initialized=true WHERE id=$1",
		[id, status],
	);
	await graph.ensure(id);
	const rel = "tasks/" + id;
	await mkdir(path.join(workspace.root, rel), { recursive: true });
	return { id, rel };
}
async function file(rel: string, content = "temporary-output") {
	const full = path.join(workspace.root, rel);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, content);
	return full;
}
const missing = (rel: string) =>
	lstat(path.join(workspace.root, rel)).catch(() => null);
async function http(
	route: string,
	method = "GET",
	body?: unknown,
	authorized = true,
) {
	return fetch(origin + "/api/workspace/" + route, {
		method,
		headers: {
			...(authorized ? { authorization: "Bearer " + token } : {}),
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

test("per-task disk usage includes all workers and refreshes after selective cleanup", async () => {
	const { id, rel } = await task();
	await file(rel + "/main.txt", "main");
	await file(rel + "/i22/output.txt", "worker");
	await file(rel + "/i23/large.bin", "x".repeat(12000));
	const before = (await workspace.maintenance.tasks()).tasks.find(
		(t) => t.task_id === id,
	)!;
	assert.equal(before.file_count, 3);
	assert.equal(before.bytes, 12010);
	assert.ok(before.disk_bytes >= before.bytes);
	assert.equal(before.cleanable, true);
	const preview = await workspace.maintenance.preview([rel + "/i22"]);
	assert.equal(preview.removable_files, 1);
	const result = await workspace.maintenance.execute(preview.token);
	assert.equal(result.removed_files, 1);
	assert.equal(result.failed.length, 0);
	assert.equal(result.released_bytes, preview.removable_disk_bytes);
	assert.equal(
		(await workspace.maintenance.tasks()).tasks.find((t) => t.task_id === id)!
			.file_count,
		2,
	);
	assert.ok(await missing(rel + "/main.txt"));
	await assert.rejects(
		() => workspace.maintenance.execute(preview.token),
		/失效/,
	);
});
test("findings, late report references, evidence folders and uploads survive whole-task cleanup", async () => {
	const { id, rel } = await task();
	const proof = await file(rel + "/repro.py", 'print("proof")');
	await file(rel + "/cache.bin");
	await file(rel + "/uploads/user.txt");
	await file(rel + "/evidence/screenshot.png");
	await file(rel + "/i2/kept.json");
	await findings.record({
		task_id: id,
		vulnclass: "fixture",
		name: "合成发现",
		severity: "info",
		summary: "受控文件证据",
		evidence: "复现脚本 " + proof,
	});
	await pool.query(
		"INSERT INTO task_reports(task_id,phase,markdown) VALUES($1,'final',$2) ON CONFLICT(task_id) DO UPDATE SET markdown=EXCLUDED.markdown",
		[id, "附件 " + rel + "/i2/kept.json"],
	);
	const preview = await workspace.maintenance.preview([rel]);
	assert.equal(preview.removable_files, 1);
	assert.equal(preview.protected_files, 4);
	await workspace.maintenance.execute(preview.token);
	assert.equal(await missing(rel + "/cache.bin"), null);
	for (const p of [
		"repro.py",
		"uploads/user.txt",
		"evidence/screenshot.png",
		"i2/kept.json",
	])
		assert.ok(await missing(rel + "/" + p), p);
	await assert.rejects(
		() => workspace.remove(rel + "/uploads/user.txt"),
		/保护/,
	);
});
test("running, paused, queued tasks and terminal tasks with live users refuse both deletion paths", async () => {
	for (const status of ["running", "created", "paused"]) {
		const { rel, id } = await task(status);
		await file(rel + "/out.txt");
		if (status === "paused")
			await pool.query("UPDATE tasks SET paused=true WHERE id=$1", [id]);
		await assert.rejects(() => workspace.maintenance.preview([rel]), /已结束/);
		await assert.rejects(() => workspace.remove(rel + "/out.txt"), /已结束/);
	}
	const { id, rel } = await task();
	await file(rel + "/out.txt");
	busy.add(id);
	try {
		await assert.rejects(() => workspace.maintenance.preview([rel]), /未结束/);
	} finally {
		busy.delete(id);
	}
	const release = workspaceGate.use(path.join(workspace.root, rel));
	try {
		await assert.rejects(() => workspace.maintenance.preview([rel]), /使用/);
	} finally {
		release();
	}
	await pool.query("UPDATE tasks SET queued=true WHERE id=$1", [id]);
	await assert.rejects(() => workspace.maintenance.preview([rel]), /已结束/);
});
test("stale preview cannot delete changed files, new files or newly referenced proof", async () => {
	for (const change of ["content", "new-file", "reference"]) {
		const { id, rel } = await task();
		await file(rel + "/sample.txt", "original");
		const preview = await workspace.maintenance.preview([rel]);
		if (change === "content")
			await file(rel + "/sample.txt", "new-data-longer");
		else if (change === "new-file") await file(rel + "/late.txt");
		else
			await findings.record({
				task_id: id,
				name: "late reference",
				vulnclass: "fixture",
				severity: "info",
				summary: "受控晚到引用",
				evidence: rel + "/sample.txt",
			});
		await assert.rejects(
			() => workspace.maintenance.execute(preview.token),
			/变化/,
		);
		assert.ok(await missing(rel + "/sample.txt"));
		assert.equal(locks.size, 0);
	}
});
test("state change after preview preserves files and a task lease is always released", async () => {
	const { id, rel } = await task();
	await file(rel + "/sample.txt");
	const preview = await workspace.maintenance.preview([rel]);
	await pool.query("UPDATE tasks SET status='running' WHERE id=$1", [id]);
	await assert.rejects(
		() => workspace.maintenance.execute(preview.token),
		/已结束/,
	);
	assert.ok(await missing(rel + "/sample.txt"));
	assert.equal(locks.size, 0);
});
test("roots, traversal, symbolic links and shared hardlinks are protected", async () => {
	const { rel } = await task();
	const outside = path.join(dir, "outside.txt");
	await writeFile(outside, "KEEP_OUTSIDE");
	await symlink(dir, path.join(workspace.root, rel, "escape"));
	const original = await file(rel + "/shared.txt", "KEEP_SHARED");
	await link(original, path.join(dir, "shared-other.txt"));
	await file(rel + "/temp.txt");
	for (const paths of [
		[""],
		["tasks"],
		["sessions"],
		["../outside.txt"],
		[rel + "/escape/outside.txt"],
	])
		await assert.rejects(() => workspace.maintenance.preview(paths));
	await assert.rejects(
		() => workspace.write(rel + "/escape/outside.txt", "wrong"),
		/符号链接/,
	);
	await assert.rejects(
		() => workspace.download(rel + "/escape/outside.txt"),
		/符号链接/,
	);
	const plan = await workspace.maintenance.preview([rel]);
	assert.equal(plan.removable_files, 1);
	await workspace.maintenance.execute(plan.token);
	assert.equal(await readFile(outside, "utf8"), "KEEP_OUTSIDE");
	assert.ok(await missing(rel + "/shared.txt"));
	assert.ok(await lstat(path.join(workspace.root, rel, "escape")));
});
test("HTTP auth, previews, manual execution, legacy delete protections and durable audit", async () => {
	const { id, rel } = await task();
	await file(rel + "/a.txt");
	assert.equal((await http("tasks", "GET", undefined, false)).status, 401);
	const response = await http("cleanup-preview", "POST", { paths: [rel] });
	assert.equal(response.status, 200);
	const preview = await response.json();
	assert.ok(await missing(rel + "/a.txt"), "preview never mutates files");
	const deleted = await http("cleanup", "POST", { token: preview.token });
	assert.equal(deleted.status, 200);
	assert.equal((await deleted.json()).removed_files, 1);
	const history = await (await http("cleanup-history")).json();
	const record = history.items.find((r: any) => r.id === preview.token);
	assert.equal(record.state, "completed");
	assert.equal(record.actor, "WORMHOLE");
	assert.deepEqual(record.payload.task_ids, [id]);
	assert.equal(record.payload.removed_files, 1);
	const running = await task("running");
	await file(running.rel + "/keep.txt");
	assert.equal(
		(await http("delete?path=" + encodeURIComponent(running.rel), "DELETE"))
			.status,
		409,
	);
	assert.ok(await missing(running.rel + "/keep.txt"));
});
test("exclusive cleanup lease blocks browser writes, attachment directories and native session admission", async () => {
	const { rel } = await task();
	const release = workspaceGate.exclusive([path.join(workspace.root, rel)]);
	try {
		await assert.rejects(
			() => workspace.write(rel + "/late.txt", "late"),
			/清理/,
		);
		await assert.rejects(() => workspace.makeDir(rel + "/new"), /清理/);
		assert.throws(
			() => workspaceGate.use(path.join(workspace.root, rel, "uploads")),
			/清理/,
		);
	} finally {
		release();
	}
	await workspace.write(rel + "/late.txt", "late");
	assert.ok(await missing(rel + "/late.txt"));
});
test("real task engine cleanup gate excludes admission, uploads and archive drain", async () => {
	const { id } = await task();
	const engine = new TaskEngine(
		pool,
		{ ...config, dataDir: dir },
		{
			assets: new AssetsService(pool, path.join(dir, "dlq")),
			findings,
			agents: new AgentsService(pool, path.join(dir, "dlq")),
			intercept: new InterceptService(pool, path.join(dir, "dlq")),
		},
	);
	try {
		const operation = engine.beginTaskOperation(id)!;
		assert.equal(engine.beginWorkspaceCleanup(id), null);
		operation();
		const release = engine.beginWorkspaceCleanup(id)!;
		assert.ok(release);
		assert.equal(engine.isDeleting(id), true);
		assert.equal(engine.beginTaskOperation(id), null);
		await assert.rejects(() =>
			engine.acquireTaskSession(id, new AbortController().signal),
		);
		await assert.rejects(() => engine.beginDelete(id), /清理/);
		release();
		assert.equal(engine.isDeleting(id), false);
		const admitted = engine.beginTaskOperation(id);
		assert.ok(admitted);
		admitted();
	} finally {
		await engine.shutdown();
	}
});
test("merged report triggers retain every source task for cleanup protection", () => {
	const run = (id: number) => ({
		agentKey: "reporter",
		taskId: id,
		title: "report",
		message: "report",
		mergeable: true,
		taskDesc: "",
		taskGoal: "",
	});
	assert.deepEqual(
		mergeTriggeredRuns([run(11), run(12), run(11)], true).taskIds,
		[11, 12],
	);
});
test("busy conversation directories refuse cleanup and crash recovery preserves audit intent", async () => {
	await file("sessions/987/tmp.txt");
	await assert.rejects(
		() => workspace.maintenance.preview(["sessions/987"]),
		/对话/,
	);
	const id = "00000000-0000-4000-8000-000000000001";
	await pool.query(
		"INSERT INTO workspace_cleanup_runs(id,state,paths,manifest) VALUES($1,'running','[\"test\"]','[]')",
		[id],
	);
	await workspace.maintenance.recover();
	assert.equal(
		(
			await pool.query("SELECT state FROM workspace_cleanup_runs WHERE id=$1", [
				id,
			])
		).rows[0].state,
		"interrupted",
	);
});

test("audit must persist before deletion; failed audit leaves every file untouched", async () => {
	const { rel } = await task();
	await file(rel + "/must-remain.txt");
	const plan = await workspace.maintenance.preview([rel]);
	await pool.query(
		`CREATE FUNCTION reject_cleanup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit storage failure'; END $$`,
	);
	await pool.query(
		"CREATE TRIGGER reject_cleanup_audit BEFORE INSERT ON workspace_cleanup_runs FOR EACH ROW EXECUTE FUNCTION reject_cleanup_audit()",
	);
	try {
		await assert.rejects(
			() => workspace.maintenance.execute(plan.token),
			/injected audit storage failure/,
		);
		assert.ok(await missing(rel + "/must-remain.txt"));
		assert.equal(locks.size, 0);
	} finally {
		await pool.query(
			"DROP TRIGGER reject_cleanup_audit ON workspace_cleanup_runs",
		);
		await pool.query("DROP FUNCTION reject_cleanup_audit()");
	}
});

test("pending retest blocks usage-list cleanup and invalidates a prior preview", async () => {
	const { id, rel } = await task();
	await file(rel + "/retest-input.txt");
	await findings.record({
		task_id: id,
		name: "复测夹具",
		vulnclass: "fixture",
		severity: "info",
		summary: "controlled",
		evidence: "受控证据",
	});
	const findingId = (
		await pool.query("SELECT id FROM findings WHERE task_id=$1", [id])
	).rows[0].id;
	const plan = await workspace.maintenance.preview([rel]);
	await pool.query(
		"INSERT INTO finding_retests(finding_id,notes,snapshot) VALUES($1,'','{}')",
		[findingId],
	);
	const row = (await workspace.maintenance.tasks()).tasks.find(
		(t) => t.task_id === id,
	)!;
	assert.equal(row.cleanable, false);
	assert.equal(row.blocked_reason, "发现正在复测");
	await assert.rejects(() => workspace.maintenance.execute(plan.token), /复测/);
	assert.ok(await missing(rel + "/retest-input.txt"));
});

test("single-connection pools persist the final audit and empty tasks remain visible", async () => {
	const { id, rel } = await task();
	await file(rel + "/last-file.txt");
	const single = new Pool({
		connectionString: config.database.dsn,
		options: "-c search_path=" + schema,
		max: 1,
		connectionTimeoutMillis: 1000,
	});
	const ws = new WorkspaceService(
		single,
		path.join(dir, "single-dlq"),
		workspace.root,
	);
	ws.maintenance.bind({
		taskBusy: () => false,
		acquireTask: () => () => {},
		sessionBusy: () => false,
	});
	try {
		const plan = await ws.maintenance.preview([rel]);
		await ws.maintenance.execute(plan.token);
		assert.equal(
			(
				await single.query(
					"SELECT 1 FROM business_events WHERE event_type='cleanup_finished' AND payload->>'operation_id'=$1",
					[plan.token],
				)
			).rowCount,
			1,
		);
		const row = (await ws.maintenance.tasks()).tasks.find(
			(t) => t.task_id === id,
		)!;
		assert.ok(row);
		assert.equal(row.file_count, 0);
		assert.equal(row.disk_bytes, 0);
	} finally {
		await single.end();
	}
});

test("a different terminal lifecycle also requires a new preview", async () => {
	const { id, rel } = await task();
	await file(rel + "/old-run.txt");
	const plan = await workspace.maintenance.preview([rel]);
	await pool.query(
		"UPDATE tasks SET status='failed',updated_at=now() WHERE id=$1",
		[id],
	);
	await assert.rejects(
		() => workspace.maintenance.execute(plan.token),
		/任务状态已变化/,
	);
	assert.ok(await missing(rel + "/old-run.txt"));
});

test("resource HTTP routes use authentication and execute a durable scoped cleanup",async()=>{
 const {id,rel}=await task();await file(rel+"/resource-http.tmp","x".repeat(16000));
 assert.equal((await http("resources","GET",undefined,false)).status,401);
 const detail=await http("resource-detail?task_id="+id);assert.equal(detail.status,200);assert.equal((await detail.json()).task_id,id);
 const preview=await http("resource-preview","POST",{task_id:id,categories:["files"]});assert.equal(preview.status,200);const plan=await preview.json();assert.ok(plan.token);
 const result=await http("resource-cleanup","POST",{token:plan.token});assert.equal(result.status,200);assert.equal((await result.json()).failed.length,0);assert.equal(await missing(rel+"/resource-http.tmp"),null);
 const history=await http("resource-history");assert.ok((await history.json()).items.some((x:any)=>Number(x.task_id)===id&&x.state==="completed"));
});
