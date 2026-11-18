import { createServer, request } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { TaskService } from "../src/domains/tasks/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { startMockAnthropic } from "../tests/fixtures/mock-anthropic.ts";
const root =
		process.env.WORMHOLE_PARALLEL_QA_ROOT ??
		(() => {
			throw new Error("set WORMHOLE_PARALLEL_QA_ROOT to the isolated QA directory");
		})(),
	config = loadConfig();
if (
	!config.dataDir.startsWith(root) ||
	!new URL(config.database.dsn).pathname.startsWith("/wormhole_poc_test_parallel_ui")
)
	throw new Error("isolated UI only");
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await mkdir(config.dataDir, { recursive: true });
const mock = await startMockAnthropic(0, {
	graphWorkflow: true,
	tool: (body) => {
		const names = ((body.tools as { name: string }[]) ?? []).map((t) => t.name);
		if (
			names.includes("http_request") &&
			!names.includes("api_model_submit") &&
			!names.includes("add_intent")
		) {
			if (!JSON.stringify(body.messages).includes('"name":"http_request"'))
				return {
					name: "http_request",
					input: { url: targetURL + "/proof", method: "GET" },
				};
		}
		return undefined;
	},
});
const target = createServer((req, res) => {
	if (req.url === "/model-target") {
		const timer = setTimeout(() => res.end("controlled model entrance"), 15000);
		res.on("close", () => clearTimeout(timer));
	} else {
		res.setHeader("content-type", "text/plain");
		res.end("controlled testing response");
	}
});
await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
const targetURL =
	"http://127.0.0.1:" + (target.address() as { port: number }).port;
const proxy = createServer((req, res) => {
	let body = "";
	req.on("data", (b) => (body += b));
	req.on("end", () => {
		if (body.includes("Please check the current progress of the task")) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write('event: ping\ndata: {"type":"ping"}\n\n');
			const timer = setInterval(
				() => res.write('event: ping\ndata: {"type":"ping"}\n\n'),
				1000,
			);
			res.on("close", () => clearInterval(timer));
			return;
		}
		const forwarded = request(
			{
				hostname: "127.0.0.1",
				port: (mock.server.address() as { port: number }).port,
				path: req.url,
				method: req.method,
				headers: { ...req.headers, host: "127.0.0.1" },
			},
			(received) => {
				res.writeHead(received.statusCode ?? 500, received.headers);
				received.pipe(res);
			},
		);
		forwarded.on("error", () => res.destroy());
		res.on("close", () => forwarded.destroy());
		forwarded.end(body);
	});
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const llm = new LlmService(
		pool,
		path.join(root, "ui-dlq"),
		config.pi.modelsPath,
	),
	profile = await llm.createProfile({
		name: "Controlled UI Model",
		model: "mock-1",
		format: "anthropic",
		base_url: "http://127.0.0.1:" + (proxy.address() as { port: number }).port,
		api_key: "ui-fixture-key",
	});
if (!profile.ok) throw new Error(profile.error);
await llm.activate(Number(profile.profile.id));
await pool.query(
	"INSERT INTO app_settings(key,value) VALUES('fingerprint_enabled','false'),('poc_enabled','false') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
);
const auth = new AuthService(pool, authKeyPath(config.dataDir)),
	signed = await auth.init("parallel-ui-fixture-password");
if (!signed.ok) throw new Error("fixture already initialized");
const tasks = new TaskService(pool, path.join(root, "ui-dlq"), () => {}),
	result = await tasks.create({
		name: "Parallel tasks · Controlled site",
		goal: "Check " + targetURL + "Public response to /proof",
		queued: true,
		timeout_seconds: 120,
		modeling_targets: [targetURL + "/model-target"],
	});
if (!result.ok) throw new Error(result.error);
await pool.query(
	"UPDATE tasks SET execution_mode='continuous',worker_limit=1 WHERE id=$1",
	[result.task.id],
);
const conv = (
	await pool.query(
		"INSERT INTO conversations(agent_key,title,llm_profile_id) VALUES('auto','Streaming status acceptance',$1) RETURNING id",
		[profile.profile.id],
	)
).rows[0];
await writeFile(
	root + "/evidence/ui-fixture.json",
	JSON.stringify({
		task_id: Number(result.task.id),
		conversation_id: Number(conv.id),
		token: signed.token,
		target: targetURL,
	}),
	{ mode: 0o600 },
);
await pool.end();
console.log("Controlled model and target servers ready");
const stop = () => {
	for (const server of [mock.server, proxy, target]) {
		server.closeAllConnections();
		server.close();
	}
};
process.on("SIGTERM", () => {
	stop();
	process.exit(0);
});
