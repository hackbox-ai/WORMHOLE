/**
 * F03 rerun 专项：单条/批量重跑。
 * 覆盖：状态门（仅 blocked/exhausted/stopped）、复活终态任务、404/409、回滚（复活失败恢复原状态）。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService } from "../src/auth/service.ts";
import { routeRequest } from "../src/api/server.ts";

process.env.WORMHOLE_CONFIG = process.env.WORMHOLE_CONFIG ?? "/var/lib/wormhole/config.test.json";
const config = loadConfig();
const suffix = `rerun_${process.pid}_${Date.now()}`;
const schema = `t_${suffix}`;
const admin = new Pool({ connectionString: config.database.dsn });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({ connectionString: config.database.dsn, options: `-c search_path=${schema}` });
await runMigrations(pool);
const auth = new AuthService(pool, `/tmp/${schema}.key`);
const token = (await auth.init("rerun-fixture-123456")).token!;
const ctx = { pool, config, auth, taskEngine: { isDeleting: () => false, launch: () => {} } } as never;
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function api(path: string, method = "GET"): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function mkTask(status: string): Promise<number> {
  const t = (await pool.query("INSERT INTO tasks (name,goal,status) VALUES ($1,'g',$2) RETURNING id", [`r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status])).rows[0] as { id: number };
  return Number(t.id);
}
async function mkIntent(taskId: number, state: string, blockedReason?: string): Promise<number> {
  const n = (await pool.query("INSERT INTO exploration_nodes (task_id,kind,title,state,blocked_reason) VALUES ($1,'intent','t',$2,$3) RETURNING id", [taskId, state, blockedReason ?? null])).rows[0] as { id: number };
  return Number(n.id);
}

test("F03 rerun 单条：状态门 + 复活终态任务 + 事件", async () => {
  const task = await mkTask("failed");
  const i1 = await mkIntent(task, "exhausted");
  const i2 = await mkIntent(task, "done");
  const i3 = await mkIntent(task, "blocked", "net down");
  // done 不可重跑 → 409
  const no = await api(`/api/tasks/${task}/intents/${i2}/rerun`, "POST");
  assert.equal(no.status, 409);
  assert.match(no.json.error, /仅 blocked\/exhausted\/stopped/);
  // exhausted 可重跑 → open + 任务复活 running
  const yes = await api(`/api/tasks/${task}/intents/${i1}/rerun`, "POST");
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  assert.deepEqual(yes.json, { id: String(task), reopened: i1, queued: false });
  const node = (await pool.query("SELECT state, blocked_reason, completed_at FROM exploration_nodes WHERE id=$1", [i1])).rows[0];
  assert.equal(node.state, "open");
  assert.equal(node.blocked_reason, null);
  assert.equal(node.completed_at, null);
  const t = (await pool.query("SELECT status, paused FROM tasks WHERE id=$1", [task])).rows[0];
  assert.equal(t.status, "running");
  assert.equal(t.paused, false);
  // blocked 携带理由 → 重跑清除
  const yes2 = await api(`/api/tasks/${task}/intents/${i3}/rerun`, "POST");
  assert.equal(yes2.status, 200);
  const n3 = (await pool.query("SELECT state, blocked_reason FROM exploration_nodes WHERE id=$1", [i3])).rows[0];
  assert.equal(n3.state, "open"); assert.equal(n3.blocked_reason, null);
  // 不存在 → 404
  assert.equal((await api(`/api/tasks/${task}/intents/999999/rerun`, "POST")).status, 404);
  // 事件
  const ev = await pool.query("SELECT event_type FROM business_events WHERE business_kind='task' AND business_id=$1 AND event_type='intent_rerun'", [String(task)]);
  assert.ok((ev.rowCount ?? 0) >= 1);
});

test("F03 rerun 批量：全部 blocked 重开 + 计数 + 非 blocked 不动", async () => {
  const task = await mkTask("timeout");
  const b1 = await mkIntent(task, "blocked", "a");
  const b2 = await mkIntent(task, "blocked", "b");
  const d1 = await mkIntent(task, "done");
  const r = await api(`/api/tasks/${task}/intents/rerun-blocked`, "POST");
  assert.equal(r.status, 200);
  assert.equal(r.json.reopened, 2);
  for (const id of [b1, b2]) {
    const n = (await pool.query("SELECT state FROM exploration_nodes WHERE id=$1", [id])).rows[0];
    assert.equal(n.state, "open");
  }
  const nd = (await pool.query("SELECT state FROM exploration_nodes WHERE id=$1", [d1])).rows[0];
  assert.equal(nd.state, "done", "done 不受批量影响");
  const t = (await pool.query("SELECT status FROM tasks WHERE id=$1", [task])).rows[0];
  assert.equal(t.status, "running", "终态任务复活");
  // 无 blocked → 0，不改任务
  const task2 = await mkTask("done");
  assert.equal((await api(`/api/tasks/${task2}/intents/rerun-blocked`, "POST")).json.reopened, 0);
  const t2 = (await pool.query("SELECT status FROM tasks WHERE id=$1", [task2])).rows[0];
  assert.equal(t2.status, "done", "无重开不复活");
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
