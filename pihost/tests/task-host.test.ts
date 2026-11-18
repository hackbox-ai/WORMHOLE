import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { addIntent, claimNextIntent, createTask, recoverOnBoot, retryIntent } from "../src/domains/tasks/host.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
let taskId: number;

test("setup: create task + intents", async () => {
  taskId = await createTask(pool, { name: "host-test", goal: "测 CAS/重试/恢复" });
  await pool.query("UPDATE tasks SET status='running' WHERE id=$1", [taskId]);
  await addIntent(pool, taskId, "low", 0);
  await addIntent(pool, taskId, "high", 10);
  await addIntent(pool, taskId, "mid", 5);
});

test("claim follows priority order", async () => {
  const c1 = await claimNextIntent(pool, taskId, "w1");
  assert.equal(c1.claimed, true);
  const c2 = await claimNextIntent(pool, taskId, "w1");
  assert.equal(c2.claimed, true);
  const order = [c1.intentId, c2.intentId];
  const priorities = await pool.query(
    "SELECT id, priority FROM exploration_nodes WHERE id = ANY($1) ORDER BY priority DESC",
    [order],
  );
  assert.deepEqual(
    priorities.rows.map((r) => Number(r.id)),
    order,
    "应按 priority DESC 领取",
  );
});

test("concurrent claims never double-claim one intent (CAS)", async () => {
  const claims = await Promise.all(
    Array.from({ length: 6 }, (_, i) => claimNextIntent(pool, taskId, `w${i}`)),
  );
  const ids = claims.filter((c) => c.claimed).map((c) => c.intentId);
  assert.equal(ids.length, 1, "只剩 1 个 open 意图，并发 6 个 worker 只有 1 个领到");
});

test("retryIntent requeues under maxAttempts, exhausts at cap", async () => {
  const fresh = await addIntent(pool, taskId, "retry-target", 0);
  const c = await claimNextIntent(pool, taskId, "w9");
  assert.equal(c.intentId, fresh); // 唯一 open 意图
  const r1 = await retryIntent(pool, fresh, 5);
  assert.equal(r1, "requeued");
  const c2 = await claimNextIntent(pool, taskId, "w9");
  assert.equal(c2.intentId, fresh); // requeue 后可再领取，attempts=2
  const r2 = await retryIntent(pool, fresh, 2);
  assert.equal(r2, "exhausted", "attempts>=2 应落 exhausted");
  assert.equal(await retryIntent(pool,fresh,2),'unchanged','terminal intent cannot be retried by a stale error handler');
});

test("recoverOnBoot resets running intents to open", async () => {
  await addIntent(pool, taskId, "recover-target", 0);
  const c = await claimNextIntent(pool, taskId, "wA");
  assert.ok(c.intentId);
  const before = await pool.query<{ count: string }>("SELECT count(*) AS count FROM exploration_nodes WHERE state='running'");
  assert.ok(Number(before.rows[0]!.count) >= 1);
  const rec = await recoverOnBoot(pool);
  assert.ok(rec.intentsReset >= 1, "running 意图应被重置");
  const after = await pool.query<{ count: string }>("SELECT count(*) AS count FROM exploration_nodes WHERE state='running'");
  assert.equal(Number(after.rows[0]!.count), 0);
});

test("teardown", async () => {
  await pool.query("DELETE FROM tasks WHERE id=$1", [taskId]);
  await pool.end();
});
