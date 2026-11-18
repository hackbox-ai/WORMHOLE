/** Explicit real-model verification against this script's disposable loopback service. */
import assert from "node:assert/strict";
import { Pool } from "pg";
import { createServer } from "node:http";
import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { TrafficRuntime } from "../src/domains/traffic/runtime.ts";
import { TrafficFlow } from "../src/domains/traffic/flow.ts";
import { bindTargetRoute } from "../src/domains/traffic/network.ts";
import {
	bindTrafficRuntime,
	registerTrafficTools,
} from "../src/domains/traffic/tools.ts";
import { seedCheckTools } from "../src/domains/traffic/check-tools.ts";
import { McpService } from "../src/domains/mcp/service.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { TaskEngine } from "../src/domains/tasks/engine.ts";
import { TaskService } from "../src/domains/tasks/service.ts";
import { SkillsService } from "../src/domains/skills/service.ts";
import { seedBuiltinSkills } from "../src/domains/skills/seed-builtin.ts";
import { resetPiRuntime } from "../src/pi/session-host.ts";
const root = process.env.WORMHOLE_FLOW_QA_ROOT;
assert.equal(root, "/root/wormhole-flow-qa-20261103");
const config = loadConfig();
assert.match(
	new URL(config.database.dsn).pathname,
	/^\/wormhole_poc_test_flow_(live|worker|acceptance)_20261103$/,
);
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await mkdir(config.dataDir, { recursive: true });
await seedBuiltinSkills(path.join(config.pi.agentDir, "skills"));
// Read only the selected provider; the credential is copied privately and never printed.
const sourceConfig = JSON.parse(
		await readFile("/var/lib/wormhole/config.json", "utf8"),
	),
	source = new Pool({ connectionString: sourceConfig.database.dsn });
const profile = (
	await source.query(
		"SELECT * FROM llm_profiles WHERE api_key<>'' ORDER BY (model ILIKE '%flash%') DESC,is_default DESC,id LIMIT 1",
	)
).rows[0];
await source.end();
assert.ok(profile, "a configured real provider is required");
const columns = Object.keys(profile);
await pool.query(
	"INSERT INTO llm_profiles(" +
		columns.map((c) => '"' + c + '"').join(",") +
		") VALUES(" +
		columns.map((_, i) => "$" + (i + 1)).join(",") +
		") ON CONFLICT(id) DO NOTHING",
	columns.map((c) => profile[c]),
);
const llm = new LlmService(
	pool,
	path.join(root, "live.dlq"),
	config.pi.modelsPath,
);
await llm.activate(Number(profile.id));
const compiled = await llm.compileToPiRuntime();
assert.ok(!("error" in compiled));
config.pi.provider = compiled.provider;
config.pi.modelId = compiled.modelId;
resetPiRuntime();
const key = Buffer.from("11".repeat(32), "hex"),
	iv = Buffer.from("22".repeat(16), "hex"),
	secret = "controlled-fixture-sign";
const encode = (value: unknown) => {
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	return JSON.stringify({
		data: Buffer.concat([
			cipher.update(JSON.stringify(value)),
			cipher.final(),
		]).toString("base64"),
	});
};
const decode = (raw: string) => {
	const decipher = createDecipheriv("aes-256-cbc", key, iv);
	return JSON.parse(
		Buffer.concat([
			decipher.update(Buffer.from(JSON.parse(raw).data, "base64")),
			decipher.final(),
		]).toString(),
	);
};
const wire: { url: string; valid: boolean; internal: boolean; id?: number }[] =
	[];
const client = `// Controlled demo client: API uses AES-256-CBC and HMAC-SHA256.\nconst KEY_HEX='${key.toString("hex")}'; const IV_HEX='${iv.toString("hex")}'; const HMAC_SECRET='${secret}';\n// Serialize the plaintext object as UTF-8 JSON. Encrypt using KEY_HEX/IV_HEX with PKCS7 padding.\n// POST /secure/items with JSON.stringify({data: encryptedBase64}).\n// Set x-signature to HMAC-SHA256(HMAC_SECRET, exact JSON request body), lower-case hex.\n// The response has the same {data:encryptedBase64} envelope; decrypt with the same key and IV.\n// Missing/invalid signatures return ordinary JSON errors. id=1 and id=2 are read-only fixtures.\n`;
const target = createServer(async (req, res) => {
	res.setHeader("content-type", "application/json");
	if (req.url === "/") {
		res.setHeader("content-type", "text/html");
		res.end(
			'<h1>Controlled QA</h1><script src="/client.js"></script><p>Read-only encrypted POST /secure/items</p>',
		);
		return;
	}
	if (req.url === "/client.js") {
		res.setHeader("content-type", "application/javascript");
		res.end(client);
		return;
	}
	if (req.url !== "/secure/items" || req.method !== "POST") {
		res.writeHead(404);
		res.end('{"error":"not found"}');
		return;
	}
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const raw = Buffer.concat(chunks).toString();
	const valid =
		req.headers["x-signature"] ===
		createHmac("sha256", secret).update(raw).digest("hex");
	const item: any = {
		url: req.url,
		valid,
		internal: !!req.headers["x-wormhole-capture-context"],
	};
	wire.push(item);
	if (!valid) {
		res.writeHead(400);
		res.end('{"error":"invalid signature"}');
		return;
	}
	try {
		const body = decode(raw);
		item.id = body.id;
		res.end(
			encode({
				ok: true,
				item: { id: body.id, label: "controlled-" + body.id },
			}),
		);
	} catch {
		res.writeHead(400);
		res.end('{"error":"invalid envelope"}');
	}
});
await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
const origin =
	"http://127.0.0.1:" + (target.address() as { port: number }).port;
const settings = {
	get: () => ({
		workers: 1,
		taskConcurrencyEnabled: true,
		taskConcurrencyLimit: 3,
		trafficCapture: true,
		globalProxy: "",
	}),
	getRebuildCount: () => 0,
};
const traffic = new TrafficRuntime(config.dataDir, settings as any);
await traffic.start();
bindTargetRoute(() => traffic.route());
bindTrafficRuntime(() => traffic);
registerTrafficTools();
let engine: TaskEngine;
const flow = new TrafficFlow(pool, traffic.store, (id) => engine?.notify(id));
traffic.store.onCapture = (id, x) => flow.ingest(id, x);
await seedCheckTools(pool);
const dlq = path.join(root, "live.dlq"),
	agents = new AgentsService(pool, dlq);
await pool.query(
	"UPDATE agents SET run_seconds=300 WHERE key IN('worker','planner','goals')",
);
engine = new TaskEngine(pool, config, {
	trafficFlow: flow,
	mcp: new McpService(pool, dlq),
	agents,
	assets: new AssetsService(pool, dlq),
	findings: new FindingsService(pool, dlq),
	intercept: new InterceptService(pool, dlq),
	skills: new SkillsService(pool, dlq, path.join(config.pi.agentDir, "skills")),
	settingsConsumers: settings,
});
const tasks = new TaskService(
	pool,
	dlq,
	(id) => void engine.bootstrap(id),
	(id, action) => {
		if (action === "pause") engine.pause(id);
		if (action === "resume") engine.resume(id);
		if (action === "stop") engine.abort(id);
	},
);
let taskId = 0;
try {
	const created = await tasks.create({
		name: "MITM/Worker real model acceptance",
		description: "JS adaptation, traffic correlation and sharing check acceptance for controlled native read-only services",
		goal: `Test only ${origin} This origin does not access other hosts or ports. This is a read-only controlled fixture that does not require discovery of vulnerabilities and does not allow fabrication of vulnerabilities. Acceptance requirements: Read the home page and /client.js to analyze the real message protocol, and the Worker will write the encodeRequest/decodeResponse adapter and start_reverse_proxy (default adapter). Successfully read the clear text response of POST /secure/items using the proxy parameter of http_request. The request header content-type should be application/json. Then call traffic_candidates to find the observed interface containing json:id; claim_http_check(parameter='json:id',check_type='input_validation'). After claimed=true, at least use id=1 and id=2 to make clear text baseline and comparison requests, carrying proxy, check_id, and content-type. complete_http_check saves the true results of negative/inconclusive/suspected. Claiming the same item again should return claimed=false, reuse it directly, and no longer send the package. Write back the request_id, capture_id, wire_capture_id and inspection conclusion of the real request with record_fact, and let Planner converge the task with these facts. Do not create additional scanning tasks, and do not regard successful encryption and decryption as vulnerabilities.`,
		queued: true,
		seed_first_intent: true,
		timeout_seconds: 600,
		llm_profile_id: Number(profile.id),
	});
	assert.ok(created.ok);
	taskId = Number(created.task.id);
	await pool.query(
		"UPDATE tasks SET modeling_initialized=true,worker_limit=1 WHERE id=$1",
		[taskId],
	);
	await engine.graph.addGoal(
		taskId,
		{
			text: "Complete the host adapter, MITM dual view, sharing check and repeated receipt acceptance based on real requests, without requiring vulnerabilities",
		},
		"system",
	);
	await engine.bootstrap(taskId);
	console.log(
		JSON.stringify({
			event: "started",
			task_id: taskId,
			model: profile.model,
			target: origin,
		}),
	);
	const until = Date.now() + 620_000;
	let task: any;
	while (Date.now() < until) {
		await new Promise((r) => setTimeout(r, 2000));
		task = await tasks.get(taskId);
		if (["done", "failed", "timeout"].includes(task?.status)) break;
	}
	await flow.drain();
	const checks = (
		await pool.query(
			"SELECT id,status,summary,requests,capture_ids FROM task_http_checks WHERE task_id=$1",
			[taskId],
		)
	).rows;
	const proxies = (
		await pool.query(
			"SELECT id,status,origin,method,path FROM reverse_proxies WHERE task_id=$1",
			[taskId],
		)
	).rows;
	const calls = (
		await pool.query(
			"SELECT tool_key,count(*)::int n FROM tool_calls WHERE business_id LIKE $1 GROUP BY tool_key ORDER BY tool_key",
			["task-" + taskId + "%"],
		)
	).rows;
	const pairs = traffic.store.db
		.prepare(
			"SELECT request_id,count(*) n FROM exchanges WHERE json_extract(context,'$.taskId')=? GROUP BY request_id HAVING count(*)=2",
		)
		.all(taskId);
	const report = (
		await pool.query("SELECT * FROM task_reports WHERE task_id=$1", [taskId])
	).rows;
	const plaintextRows = traffic.store.db
		.prepare(
			"SELECT id FROM exchanges WHERE json_extract(context,'$.taskId')=? AND json_extract(context,'$.view')='plaintext'",
		)
		.all(taskId);
	const decodedReplies = plaintextRows
		.map((row) => traffic.store.readEvidence(String(row.id)))
		.filter((row) => {
			try {
				return JSON.parse(row.respBody.toString()).ok === true;
			} catch {
				return false;
			}
		}).length;
	const proof = {
		decoded_replies: decodedReplies,
		task_id: taskId,
		status: task?.status,
		wire: wire.map((x) => ({ ...x })),
		checks,
		proxies,
		calls,
		correlated_pairs: pairs.length,
		report_present: report.length > 0,
	};
	await writeFile(
		path.join(
			root,
			new URL(config.database.dsn).pathname.includes("_worker_")
				? "live-proof-worker.json"
				: "live-proof.json",
		),
		JSON.stringify(proof, null, 2),
	);
	console.log(JSON.stringify(proof));
	assert.equal(task?.status, "done", "real task completes");
	assert.ok(
		wire.some((x) => x.valid && x.id === 1) &&
			wire.some((x) => x.valid && x.id === 2),
		"real signed baseline and control reached target",
	);
	assert.ok(
		wire.every((x) => !x.internal),
		"internal marker never reaches target",
	);
	assert.ok(
		checks.some((c) => c.status !== "running" && c.requests >= 2),
		"Worker finishes shared check",
	);
	assert.ok(
		decodedReplies >= 2,
		"responses are genuinely decrypted, not merely HTTP 200",
	);
	assert.ok(pairs.length >= 2, "plaintext and wire captured together");
	assert.ok(report.length, "report persists");
} finally {
	if (taskId) {
		const row = (
			await pool.query("SELECT status FROM tasks WHERE id=$1", [taskId])
		).rows[0];
		if (row && !["done", "failed", "timeout"].includes(row.status))
			await tasks.control(taskId, "pause");
	}
	await engine.shutdown();
	await flow.drain();
	bindTargetRoute(null);
	bindTrafficRuntime(null);
	await traffic.close();
	target.closeAllConnections();
	await new Promise<void>((r) => target.close(() => r()));
	resetPiRuntime();
	await pool.end();
}
