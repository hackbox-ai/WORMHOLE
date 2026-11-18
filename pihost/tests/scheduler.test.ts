/**
 * F12 触发器 + F03 去抖测试（owner 第七轮语义补齐）。
 * 触发器：到期→fire→水位推进（scheduler_state）→重启后不重复；
 * 去抖：突发通知合并为一轮。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { TriggerScheduler, NotifyDebouncer, plannerInterval } from "../src/domains/tasks/scheduler.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM scheduler_state");
await pool.query("DELETE FROM agent_triggers");

test("F12 触发器：到期触发→水位推进→同窗口不重复", async () => {
  const fired: string[] = [];
  const s = new TriggerScheduler(pool, "/tmp/pihost-test-dlq.jsonl", async (k, m) => {
    fired.push(`${k}:${m}`);
  }, 200);
  await pool.query("INSERT INTO agent_triggers (agent_key, interval_sec, interval_message) VALUES ('auto', 3600, '定时巡检')");
  s.start();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && fired.length === 0) await new Promise((r) => setTimeout(r, 100));
  await s.stop();
  assert.equal(fired.length, 1, `应触发一次（实际 ${fired.length}）`);
  assert.match(fired[0]!, /^auto:定时巡检/);
  const st = await pool.query("SELECT next_fire_at FROM scheduler_state WHERE agent_key='auto'");
  assert.ok((st.rows[0] as { next_fire_at: Date }).next_fire_at > new Date(), "水位已推进（3600s 后）");
  // 重启（新实例同窗口）不重复触发
  const s2 = new TriggerScheduler(pool, "/tmp/pihost-test-dlq.jsonl", async (k) => { fired.push(`${k}:dup`); }, 200);
  s2.start();
  await new Promise((r) => setTimeout(r, 600));
  await s2.stop();
  assert.equal(fired.length, 1, "水位未到期不重复触发");
});

test("F03 去抖：突发通知合并一轮", async () => {
  const d = new NotifyDebouncer();
  d.notify(); d.notify(); d.notify();
  const fired = await d.settle(100);
  assert.equal(fired, true, "有通知→触发");
  const again = await d.settle(100);
  assert.equal(again, false, "合并后无残留");
});

test("F03 心跳间隔：600s 下限", () => {
  assert.equal(plannerInterval(100), 600_000);
  assert.equal(plannerInterval(1800), 1_800_000);
});

test("teardown", async () => {
  await pool.query("DELETE FROM scheduler_state");
  await pool.query("DELETE FROM agent_triggers");
  await pool.end();
  process.exit(0);
});
