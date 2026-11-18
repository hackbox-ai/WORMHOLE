import assert from "node:assert/strict";
import { test,after } from "node:test";
import { Pool } from "pg";
import { appendEvent, backfillDeadLetters, startBackfillLoop } from "../src/events/ledger.ts";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";

const config = loadConfig();
const schema=`codex_ledger_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:config.database.dsn});await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({ connectionString: config.database.dsn,options:`-c search_path=${schema}` });
await runMigrations(pool);
const fsp = await import("node:fs/promises");
const dir=await fsp.mkdtemp('/tmp/pihost-ledger-');
const dlq = dir+'/events.jsonl';
await fsp.writeFile(dlq, "");

// 坏连接池：模拟 DB 故障
const brokenPool = new Pool({ connectionString: "postgres://pihost:x@127.0.0.1:1/wormhole_target?sslmode=disable&connect_timeout=1", max: 1 });
brokenPool.on("error", () => {});
after(async()=>{await brokenPool.end();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await fsp.rm(dir,{recursive:true,force:true});});

test("appendEvent: DB 故障时落 DLQ 而非静默丢失", async () => {
  const r1 = await appendEvent(brokenPool, dlq, { business_kind: "test", business_id: "dlq", event_type: "e1", payload: { a: 1 } });
  const r2 = await appendEvent(brokenPool, dlq, { business_kind: "test", business_id: "dlq", event_type: "e2", payload: { a: 2 } });
  assert.equal(r1, false);
  assert.equal(r2, false);
  const lines = (await fsp.readFile(dlq, "utf8")).split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 2, "DLQ 应有 2 条死信");
  assert.ok(JSON.parse(lines[0]!).event_uid, "死信必须带 event_uid（幂等补写键）");
});

test("DB恢复→自动补写：backfillLoop 在周期内清空 DLQ 并入库", async () => {
  const stop = startBackfillLoop(pool, dlq, 150);
  // 轮询入库行数（rename 先移走文件，插入完成晚于文件消失）
  const deadline = Date.now() + 5000;
  let n = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const rows = await pool.query("SELECT count(*)::int AS n FROM business_events WHERE business_kind='test' AND business_id='dlq' AND payload->>'a' IN ('1','2')");
    n = (rows.rows[0] as { n: number }).n;
    if (n === 2) break;
  }
  stop();
  assert.equal(n, 2, "两条死信均应自动入库");
  assert.equal((await fsp.readFile(dlq, "utf8").catch(() => "")).trim(), "", "入库后 DLQ 清空");
});

test("补写幂等 + 并发追加不丢失（rename 取走语义）", async () => {
  // 手动重放一轮：再制造一条死信，补写期间追加新死信不会丢
  await appendEvent(brokenPool, dlq, { business_kind: "test", business_id: "dlq", event_type: "e3", payload: { a: 3 } });
  const p1 = backfillDeadLetters(pool, dlq); // 取走 e3
  await appendEvent(brokenPool, dlq, { business_kind: "test", business_id: "dlq", event_type: "e4", payload: { a: 4 } }); // 补写期间追加
  const first = await p1;
  const n = await backfillDeadLetters(pool, dlq); // e4 下一轮
  assert.equal(first + n, 2, "追加落在 rename 前或后均允许；两轮合计持久化两条且不丢失");
  const rows = await pool.query("SELECT count(*)::int AS n FROM business_events WHERE business_kind='test' AND business_id='dlq' AND payload->>'a' IN ('3','4')");
  assert.equal((rows.rows[0] as { n: number }).n, 2);
  await pool.query("DELETE FROM business_events WHERE business_kind='test' AND business_id='dlq'");
});


test("JSONB writes and legacy DLQ replay replace NUL without changing JSON serialization", async () => {
  const legacyDlq = dir + "/nul-events.jsonl";
  const payload = {
    "key\0": ["value\0", "\\u0000"],
    at: new Date("2026-11-04T00:00:00Z"),
    bytes: Buffer.from([0, 1]),
  };
  const row = { business_kind: "test", business_id: "nul\0", event_type: "json", payload };
  assert.equal(await appendEvent(pool, legacyDlq, row), true);
  await fsp.writeFile(legacyDlq, JSON.stringify({
    ...row, event_uid: "legacy-nul", ts: new Date().toISOString(),
  }) + "\n");
  assert.equal(await backfillDeadLetters(pool, legacyDlq), 1);
  const result = await pool.query("SELECT business_id,payload FROM business_events WHERE event_type='json'");
  assert.equal(result.rows.length, 2);
  for (const stored of result.rows) {
    assert.equal(stored.business_id, "nul\uFFFD");
    assert.deepEqual(stored.payload, {
      "key\uFFFD": ["value\uFFFD", "\\u0000"],
      at: payload.at.toISOString(),
      bytes: payload.bytes.toJSON(),
    });
  }
});
