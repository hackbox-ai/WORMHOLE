import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.ts";
import { TaskEngine } from "../src/domains/tasks/engine.ts";
import { TaskService } from "../src/domains/tasks/service.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";
import type { PihostConfig } from "../src/config.ts";
const dsn = process.env.WORMHOLE_POC_TEST_DSN!;
assert.ok(dsn && new URL(dsn).pathname.startsWith("/wormhole_poc_test"));
const admin = new Pool({ connectionString: dsn }),
	schema = "parallel_model_" + process.pid + "_" + Date.now();
let pool: Pool, dir: string;
before(async () => {
	await admin.query("CREATE SCHEMA " + schema);
	pool = new Pool({
		connectionString: dsn,
		options: "-c search_path=" + schema,
	});
	await runMigrations(pool);
	dir = await mkdtemp(path.join(tmpdir(), "wormhole-parallel-model-"));
});
after(async () => {
	await pool?.end();
	await admin.query("DROP SCHEMA " + schema + " CASCADE");
	await admin.end();
	if (dir) await rm(dir, { recursive: true, force: true });
});
const wait = async (
	check: () => Promise<boolean> | boolean,
	timeout = 25000,
) => {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 30));
	}
	throw new Error("condition timeout");
};
async function setup(
	mode: "blocked" | "failed" | "publish",
	delayResponse = 0,
) {
	await pool.query(
		"UPDATE tasks SET status='failed',queued=false,paused=false WHERE status IN('created','running','paused')",
	);
	const seen: string[] = [];
	let release!: () => void;
	const barrier = new Promise<void>((r) => (release = r));
	let modelStarted = 0,
		modelActive = 0,
		maxModels = 0,
		maxSlots = 0;
	const target = createServer((req, res) => {
		seen.push(req.url!);
		if (mode === "publish") release();
		setTimeout(() => {
			res.setHeader("content-type", "text/plain");
			res.end("controlled parallel HTTP proof");
		}, delayResponse);
	});
	await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
	const url =
		"http://127.0.0.1:" + (target.address() as { port: number }).port + "/";
	const mock = await startMockAnthropic(0, {
		graphWorkflow: true,
		tool: (body) => {
			const names = ((body.tools as { name: string }[]) ?? []).map(
				(t) => t.name,
			);
			if (
				names.includes("http_request") &&
				!names.includes("api_model_submit") &&
				!names.includes("add_intent")
			) {
				const messages = body.messages as any[];
				if (!JSON.stringify(messages).includes('"name":"http_request"'))
					return {
						name: "http_request",
						input: { url: url + "proof", method: "GET" },
					};
			}
			return undefined;
		},
	});
	const config: PihostConfig = {
		listen: { host: "127.0.0.1", port: 0 },
		database: { dsn },
		dataDir: dir,
		pi: {
			agentDir: path.join(dir, "agent"),
			modelsPath: path.join(dir, "models.json"),
			provider: "fixture",
			modelId: "mock-1",
		},
	};
	await mkdir(config.pi.agentDir, { recursive: true });
	await writeFile(config.pi.modelsPath, '{"providers":{}}');
	const llm = new LlmService(pool, path.join(dir, "dlq"), config.pi.modelsPath),
		profile = await llm.createProfile({
			name: "parallel-" + Date.now(),
			model: "mock-1",
			format: "anthropic",
			base_url:
				"http://127.0.0.1:" + (mock.server.address() as { port: number }).port,
			api_key: "controlled-fixture",
		});
	assert.ok(profile.ok);
	await llm.activate(Number(profile.profile.id));
	resetPiRuntime();
	const engine = new TaskEngine(pool, config, {
		modelingProbe: async (_target, signal) => {
			modelStarted++;
			modelActive++;
			maxModels = Math.max(maxModels, modelActive);
			try {
				if (mode === "failed") throw new Error("controlled modeling failure");
				await Promise.race([
					barrier,
					new Promise<never>((_r, reject) => {
						if (signal.aborted) reject(signal.reason);
						else
							signal.addEventListener("abort", () => reject(signal.reason), {
								once: true,
							});
					}),
				]);
				return { status: 200, body: "controlled modeling entrance" };
			} finally {
				modelActive--;
			}
		},
		agents: new AgentsService(pool, path.join(dir, "dlq")),
		assets: new AssetsService(pool, path.join(dir, "dlq")),
		findings: new FindingsService(pool, path.join(dir, "dlq")),
		intercept: new InterceptService(pool, path.join(dir, "dlq")),
		settingsConsumers: {
			get: () => ({
				workers: 1,
				taskConcurrencyEnabled: true,
				taskConcurrencyLimit: 3,
				trafficCapture: false,
			}),
			getRebuildCount: () => 0,
		},
	});
	const tasks = new TaskService(
		pool,
		path.join(dir, "dlq"),
		(id) => void engine.launch(id),
	);
	const timer = setInterval(() => {
		maxSlots = Math.max(maxSlots, engine.slots.size);
		void engine.pumpQueue();
	}, 30);
	return {
		engine,
		tasks,
		mock,
		url,
		seen,
		get modelStarted() {
			return modelStarted;
		},
		get maxModels() {
			return maxModels;
		},
		get maxSlots() {
			return maxSlots;
		},
		async close() {
			clearInterval(timer);
			release();
			await engine.shutdown();
			resetPiRuntime();
			for (const s of [target, mock.server]) {
				s.closeAllConnections();
				await new Promise<void>((r) => s.close(() => r()));
			}
		},
	};
}
test("a never-returning model cannot prevent real target work or normal completion; progress precedes LLM output", async () => {
	const f = await setup("blocked");
	try {
		const result = await f.tasks.create({
			name: "nonblocking source",
			goal: "核验 " + f.url,
			timeout_seconds: 30,
			modeling_targets: [f.url],
		});
		assert.ok(result.ok);
		const id = Number(result.task.id);
		await wait(async () => !!(await f.tasks.get(id))?.progress);
		await wait(() => f.modelStarted > 0);
		await wait(() => f.seen.length > 0);
		const model = (await f.engine.modeling.catalog(id))[0];
		assert.ok(model);
		assert.equal(model.version_id, null);
		await wait(async () => (await f.tasks.get(id))?.status === "done");
		assert.equal((await f.tasks.get(id))?.status, "done");
		assert.ok(f.maxSlots <= 3);
		assert.equal(f.maxModels, 1);
		const phases = (
			await pool.query(
				"SELECT metadata->>'task_progress' phase FROM activity WHERE exploration_id=(SELECT exploration_id FROM tasks WHERE id=$1) AND metadata ? 'task_progress'",
				[id],
			)
		).rows.map((r) => r.phase);
		assert.ok(phases.includes("accepted"));
		assert.ok(phases.includes("planning"));
		assert.ok(phases.includes("testing"));
	} finally {
		await f.close();
	}
});
test("modeling failure is visible as unavailable while the primary task completes", async () => {
	const f = await setup("failed");
	try {
		const result = await f.tasks.create({
			goal: "核验 " + f.url,
			timeout_seconds: 30,
			modeling_targets: [f.url],
		});
		assert.ok(result.ok);
		const id = Number(result.task.id);
		await wait(
			async () => Number((await f.tasks.get(id))?.modeling_unavailable) > 0,
		);
		assert.equal(Number((await f.tasks.get(id))?.modeling_pending), 0);
		await wait(async () => (await f.tasks.get(id))?.status === "done");
		assert.ok(f.seen.length > 0);
	} finally {
		await f.close();
	}
});
test("background publication reaches an already-running worker and the model catalog without restarting it", async () => {
	const f = await setup("publish", 2000);
	try {
		const result = await f.tasks.create({
			goal: "核验 " + f.url,
			timeout_seconds: 30,
			modeling_targets: [f.url],
		});
		assert.ok(result.ok);
		const id = Number(result.task.id);
		await wait(
			async () => !!(await f.engine.modeling.catalog(id))[0]?.version_id,
		);
		await wait(() =>
			f.mock.state.calls.some((c) =>
				JSON.stringify(c.body?.messages).includes("业务模型后台更新"),
			),
		);
		await wait(async () => (await f.tasks.get(id))?.status === "done");
		assert.ok(f.maxSlots <= 3);
	} finally {
		await f.close();
	}
});
test("three primary tasks and three models run concurrently while a fourth primary queues", async () => {
	const f = await setup("blocked", 10000);
	try {
		const ids = [];
		for (let i = 0; i < 3; i++) {
			const r = await f.tasks.create({
				name: "concurrency " + i,
				goal: "核验 " + f.url + "scope/" + i,
				timeout_seconds: 30,
				modeling_targets: [f.url + "scope/" + i],
			});
			assert.ok(r.ok);
			ids.push(Number(r.task.id));
		}
		await wait(() => f.maxModels === 3 && ids.every(id=>f.engine.isRunning(id)));
		await new Promise((r) => setTimeout(r, 600));
		assert.equal(f.maxModels, 3);
        assert.equal(f.engine.slots.size,3);
        const models=(await pool.query("SELECT id FROM tasks WHERE kind='modeling' AND status='running' AND NOT queued")).rows;
        assert.equal(models.length,3);
        assert.ok(models.every(m=>!f.engine.slots.ids.includes(Number(m.id))));
        const fourth=await f.tasks.create({name:'fourth primary',goal:'wait for primary capacity',queued:true,timeout_seconds:30});
        assert.ok(fourth.ok);await f.engine.pumpQueue();
        assert.equal((await f.tasks.get(Number(fourth.task.id)))?.queued,true);
        assert.equal(f.engine.isRunning(Number(fourth.task.id)),false);
        const modelId=Number(models[0].id),release=await f.engine.acquireTaskSession(modelId,new AbortController().signal);
        assert.equal(f.engine.slots.size,3);release();
	} finally {
		await f.close();
	}
});

test("background deadline expiry changes only modeling status while the parent keeps its own clock", async () => {
	const f = await setup("blocked");
	try {
		const result = await f.tasks.create({
			goal: "核验 " + f.url,
			timeout_seconds: 30,
			modeling_targets: [f.url],
		});
		assert.ok(result.ok);
		const id = Number(result.task.id);
		await wait(() => f.modelStarted > 0);
		const model = (await f.engine.modeling.catalog(id))[0];
		const before = await f.tasks.get(id);
		await pool.query(
			"UPDATE tasks SET deadline_at=now()-interval '1 second' WHERE id=$1",
			[model.modeling_task_id],
		);
		await f.engine.pumpQueue();
		assert.equal(
			(await f.engine.modeling.get(Number(model.modeling_task_id))).status,
			"timeout",
		);
		const after = await f.tasks.get(id);
		assert.equal(after?.status, "running");
		assert.equal(String(after?.deadline_at), String(before?.deadline_at));
		assert.equal(Number(after?.modeling_pending), 0);
		assert.equal(Number(after?.modeling_unavailable), 1);
		await wait(async () => (await f.tasks.get(id))?.status === "done");
		assert.ok(f.seen.length > 0);
	} finally {
		await f.close();
	}
});
