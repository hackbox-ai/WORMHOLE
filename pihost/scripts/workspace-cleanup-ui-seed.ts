import { Pool } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { TaskService } from "../src/domains/tasks/service.ts";
import { ExplorationService } from "../src/domains/exploration/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
const root =
		process.env.WORMHOLE_WORKSPACE_QA_ROOT ??
		(() => {
			throw new Error("set WORMHOLE_WORKSPACE_QA_ROOT to the isolated QA directory");
		})(),
	config = loadConfig();
if (
	!new URL(config.database.dsn).pathname.startsWith("/wormhole_poc_test") ||
	!config.dataDir.startsWith(path.resolve(root) + path.sep)
)
	throw new Error("isolated fixture only");
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await mkdir(config.dataDir, { recursive: true });
const auth = new AuthService(pool, authKeyPath(config.dataDir));
const init = await auth.init("workspace-ui-fixture-password");
if (!init.ok) throw new Error("fixture already initialized");
const tasks = new TaskService(pool, path.join(config.dataDir, "dlq"), () => {}),
	graph = new ExplorationService(pool),
	findings = new FindingsService(pool, path.join(config.dataDir, "dlq"));
async function create(name: string, status: string) {
	const t = await tasks.create({
		name,
		goal: "Validate workspace management only",
		queued: true,
	});
	if (!t.ok) throw new Error(t.error);
	const id = Number(t.task.id);
	await pool.query(
		"UPDATE tasks SET status=$2,paused=$3,queued=false,modeling_initialized=true WHERE id=$1",
		[id, status, status === "running"],
	);
	await graph.ensure(id);
	const dir = path.join(config.dataDir, "workspace", "tasks", String(id));
	await mkdir(dir, { recursive: true });
	return { id, dir, rel: "tasks/" + id };
}
async function file(dir: string, name: string, content: string) {
	const full = path.join(dir, name);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, content);
	return full;
}
const ended = await create("Authorized demo site · Completed", "done");
await file(
	ended.dir,
	"tmp/scan-cache.txt",
	"controlled temporary output\n".repeat(4000),
);
const proof = await file(
	ended.dir,
	"reproduce.py",
	'print("controlled proof")',
);
await file(ended.dir, "uploads/scope.txt", "USER_ATTACHMENT_KEEP");
await file(ended.dir, "evidence/proof.txt", "EVIDENCE_KEEP");
await file(ended.dir, "i100/response.txt", "worker result\n".repeat(100));
await findings.record({
	task_id: ended.id,
	name: "Controlled Discovery",
	vulnclass: "fixture",
	severity: "info",
	summary: "Page validation fixture",
	evidence: "Reproduction file " + proof,
});
const active = await create("Authorized demo site · To be continued", "running");
await file(active.dir, "worker-output.txt", "ACTIVE_KEEP");
const failed = await create("Authorization demo site · Timed out", "timeout");
await file(failed.dir, "i200/tmp/debug.log", "debug output\n".repeat(200));
const orphan = path.join(config.dataDir, "workspace", "tasks", "99999");
await file(orphan, "unknown.txt", "ORPHAN_KEEP");
await writeFile(
	root + "/evidence/ui-fixture.json",
	JSON.stringify({ ended, active, failed, token: init.token }),
	{ mode: 0o600 },
);
await pool.end();
console.log("Seeded isolated UI tasks and protected evidence");
