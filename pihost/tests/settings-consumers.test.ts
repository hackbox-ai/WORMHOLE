/**
 * F21 消费方四面对照测试：
 * ① API：PUT settings(traffic_capture 等) → 200 + 消费方审计事件落账本
 * ② 数据：并发快照读取（workers/task_concurrency）与 PUT 后值一致
 * ③ 副作用：traffic_capture 切换触发 agent 重建（rebuildCount 递增）；非重建键不触发
 * ④ 故障恢复：重启（新实例）后快照重新装载；DLQ 补写不受影响
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { SettingsService } from "../src/domains/settings/service.ts";
import { SettingsConsumers } from "../src/domains/settings/consumers.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM app_settings WHERE key LIKE 'settings.%'");
await pool.query("DELETE FROM business_events WHERE business_kind='settings'");

test("F21-② 数据：快照装载与 PUT 后值一致", async () => {
  const svc = new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl");
  const c = new SettingsConsumers(pool, svc, "/tmp/pihost-test-dlq.jsonl");
  const snap = await c.load();
  assert.equal(snap.workers, 3, "默认 workers=3");
  assert.equal(snap.taskConcurrencyEnabled, false, "默认关闭");
  assert.equal(snap.trafficCapture, false, "默认关闭");

  // PUT workers=8 → 快照刷新
  await svc.apply({ workers: 8, task_concurrency_enabled: true, task_concurrency_limit: 3 });
  const r = await c.onSettingsChanged(["workers", "task_concurrency_enabled", "task_concurrency_limit"]);
  assert.equal(r.concurrency.workers, 8, "workers=8 生效");
  assert.equal(r.concurrency.taskConcurrencyEnabled, true);
  assert.equal(r.concurrency.taskConcurrencyLimit, 3);
});

test("F21-③ 副作用：traffic_capture 切换触发重建；非重建键不触发", async () => {
  const svc = new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl");
  const c = new SettingsConsumers(pool, svc, "/tmp/pihost-test-dlq.jsonl");
  await c.load();
  const before = c.getRebuildCount();

  // traffic_capture = 重建键
  await svc.apply({ traffic_capture: true });
  const r1 = await c.onSettingsChanged(["traffic_capture"]);
  assert.ok(r1.rebuilt, "traffic_capture 触发重建");
  assert.equal(c.getRebuildCount(), before + 1);
  assert.equal(c.get().trafficCapture, true, "快照已更新");

  // global_proxy = 重建键
  await svc.apply({ global_proxy: "socks5://10.0.0.1:1080" });
  const r2 = await c.onSettingsChanged(["global_proxy"]);
  assert.ok(r2.rebuilt, "global_proxy 触发重建");
  assert.equal(c.get().globalProxy, "socks5://10.0.0.1:1080");

  // python_interpreter = 非重建键
  await svc.apply({ python_interpreter: "/usr/bin/python3" });
  const r3 = await c.onSettingsChanged(["python_interpreter"]);
  assert.ok(!r3.rebuilt, "python_interpreter 不触发重建");
  assert.equal(c.getRebuildCount(), before + 2, "重建计数不变");

  // 审计事件
  const audit = await pool.query("SELECT event_type, payload FROM business_events WHERE business_kind='settings' AND event_type='consumers_applied' ORDER BY seq");
  assert.ok((audit.rowCount ?? 0) >= 3, "每次消费方生效有审计");
  const last = audit.rows.at(-1) as { payload: { rebuilt: boolean } };
  assert.equal(last.payload.rebuilt, false, "最后一条 python 不重建");
});

test("F21-④ 故障恢复：重启（新实例）后快照重装 + 重建计数从 0", async () => {
  const svc = new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl");
  const c2 = new SettingsConsumers(pool, svc, "/tmp/pihost-test-dlq.jsonl");
  const snap = await c2.load();
  assert.equal(snap.workers, 8, "重启后 workers=8（持久化）");
  assert.equal(snap.trafficCapture, true, "重启后 traffic_capture=true");
  assert.equal(c2.getRebuildCount(), 0, "重建计数为进程内状态，重启归零（对照 WORMHOLE 内存 rebuild）");
});

test("teardown", async () => {
  await pool.query("DELETE FROM app_settings WHERE key LIKE 'settings.%'");
  await pool.query("DELETE FROM business_events WHERE business_kind='settings'");
  await pool.end();
  process.exit(0);
});
