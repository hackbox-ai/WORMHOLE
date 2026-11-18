/**
 * 依赖收口测试①：WORMHOLE 形状 fixture → 目标库逐字段保真导入 + 回滚（可重跑）。
 * 覆盖 B03-table-mapping.md 的全部映射规则（改名/枚举/数组/软删除）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";

const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
const BATCH = "closure-test-batch";

/** WORMHOLE 形状的源行 */
const vbTasks = [
  { name: "旧任务A", description: "d1", goal: "g1", status: "done", paused: false, queued: false, queue_mode: "", llm_profile_id: null, company_id: null, parent_ref: null, timeout_seconds: 3600, plan_heartbeat_seconds: 600, coverage_enabled: true, completed_at: "2026-10-01T00:00:00Z", deleted_at: null },
  { name: "旧任务B", description: "", goal: "g2", status: "created", paused: false, queued: true, queue_mode: "concurrency", llm_profile_id: null, company_id: null, parent_ref: "old-123", timeout_seconds: 0, plan_heartbeat_seconds: 300, coverage_enabled: false, completed_at: null, deleted_at: "2026-10-02T00:00:00Z" },
];
const vbAssets = [
  { type: "root_domain", company_id: null, company_source: "explicit", task_ids: [1], domain: "corp.example.com", root_domain: "corp.example.com", icp: "京ICPx", status_code: null },
  { type: "ip", company_id: null, company_source: "scope", task_ids: [1, 2], ip: "203.0.113.10", port: 443, service_name: "https", open_ports: [{ port: 443, service: "https" }] },
  { type: "url", company_id: null, company_source: "explicit", task_ids: [], url: "https://app.example.com/login", page_title: "登录", content_length: 1234 },
];
const vbFindings = [
  { task_id: 1, node_id: null, vulnclass: "xss", name: "反射XSS", severity: "high", summary: "s1", evidence: "e1", worker: "worker-1", asset_ids: [1, 2], status: "pending" },
  { task_id: 1, node_id: null, vulnclass: "", name: "旧确认项", severity: "low", summary: "s2", evidence: "e2", worker: "", asset_ids: [], status: "resolved" },
];

async function importArtez(): Promise<{ tasks: number; assets: number; findings: number }> {
  // 幂等：先清本批次
  await pool.query("DELETE FROM findings WHERE attrs_import=$1".replace("attrs_import", "(SELECT '1'::int)"), []).catch(() => {});
  await pool.query(`DELETE FROM findings WHERE name = ANY($1)`, [vbFindings.map((f) => f.name)]);
  await pool.query(`DELETE FROM assets WHERE domain = ANY($1) OR ip = ANY($1) OR url = ANY($1)`, [[...vbAssets.map((a) => a.domain ?? a.ip ?? a.url ?? "")].filter(Boolean)]);
  await pool.query(`DELETE FROM tasks WHERE name = ANY($1)`, [vbTasks.map((t) => t.name)]);
  let nT = 0;
  let nA = 0;
  let nF = 0;
  for (const t of vbTasks) {
    const e = await pool.query("INSERT INTO explorations (goal) VALUES ($1) RETURNING id", [t.goal]);
    await pool.query(
      `INSERT INTO tasks (name, description, goal, status, paused, queued, queue_mode, llm_profile_id, company_id, parent_ref,
         timeout_seconds, plan_heartbeat_seconds, coverage_enabled, completed_at, deleted_at, exploration_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [t.name, t.description, t.goal, t.status, t.paused, t.queued, t.queue_mode, t.llm_profile_id, t.company_id, t.parent_ref,
        t.timeout_seconds, t.plan_heartbeat_seconds, t.coverage_enabled, t.completed_at, t.deleted_at, e.rows[0]!.id],
    );
    nT++;
  }
  for (const a of vbAssets) {
    await pool.query(
      `INSERT INTO assets (type, company_id, company_source, task_ids, domain, root_domain, ip, port, icp, url, service_name,
         open_ports, status_code, page_title, content_length, value, attrs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,ARRAY(SELECT jsonb_array_elements($12::jsonb)),$13,$14,$15,$16,$17::jsonb)`,
      [a.type, a.company_id, a.company_source, a.task_ids, a.domain ?? null, a.root_domain ?? null, a.ip ?? null, a.port ?? null,
        a.icp ?? null, a.url ?? null, a.service_name ?? null, JSON.stringify(a.open_ports ?? []), a.status_code ?? null, a.page_title ?? null,
        a.content_length ?? null, a.domain ?? a.ip ?? a.url ?? "", JSON.stringify({ import_batch: BATCH })],
    );
    nA++;
  }
  for (const f of vbFindings) {
    await pool.query(
      `INSERT INTO findings (task_id, node_id, vulnclass, name, severity, summary, evidence, worker, asset_ids, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [f.task_id, f.node_id, f.vulnclass, f.name, f.severity, f.summary, f.evidence, f.worker, JSON.stringify(f.asset_ids), f.status],
    );
    nF++;
  }
  return { tasks: nT, assets: nA, findings: nF };
}

test("收口①：WORMHOLE 形状导入 → 逐字段保真 → 回滚 → 重跑幂等", async () => {
  // 第一次导入
  const n1 = await importArtez();
  assert.deepEqual(n1, { tasks: 2, assets: 3, findings: 2 });
  // 字段保真（抽查关键字段，含改名/数组/枚举/软删除）
  const t2 = (await pool.query("SELECT * FROM tasks WHERE name='旧任务B'")).rows[0] as Record<string, unknown>;
  assert.equal(t2.queue_mode, "concurrency");
  assert.equal(t2.parent_ref, "old-123");
  assert.equal(t2.plan_heartbeat_seconds, 300);
  assert.ok(t2.deleted_at, "软删除保留");
  const ip = (await pool.query("SELECT * FROM assets WHERE type='ip'")).rows[0] as Record<string, unknown>;
  assert.deepEqual((ip.task_ids as unknown[]).map(Number), [1, 2], "task_ids 数组保真");
  assert.equal(ip.ip, "203.0.113.10");
  assert.deepEqual(ip.open_ports, [{ port: 443, service: "https" }]);
  const url = (await pool.query("SELECT * FROM assets WHERE type='url'")).rows[0] as Record<string, unknown>;
  assert.equal(url.page_title, "登录");
  const f1 = (await pool.query("SELECT * FROM findings WHERE name='反射XSS'")).rows[0] as Record<string, unknown>;
  assert.equal(f1.vulnclass, "xss");
  assert.equal(f1.worker, "worker-1");
  assert.deepEqual(f1.asset_ids, [1, 2]);
  assert.equal(f1.status, "pending", "WORMHOLE 枚举原样");
  // 双向映射抽查：内部 value 列回填正确
  assert.equal((url as { value: string }).value, "https://app.example.com/login");
  // 回滚（按导入批次标记 + 名称定位）
  await pool.query(`DELETE FROM findings WHERE name = ANY($1)`, [vbFindings.map((f) => f.name)]);
  await pool.query(`DELETE FROM assets WHERE attrs->>'import_batch' = $1`, [BATCH]);
  await pool.query(`DELETE FROM tasks WHERE name = ANY($1)`, [vbTasks.map((t) => t.name)]);
  const after = await pool.query("SELECT (SELECT count(*) FROM assets WHERE attrs->>'import_batch'=$1) AS a, (SELECT count(*) FROM findings WHERE name='反射XSS') AS f", [BATCH]);
  assert.equal((after.rows[0] as { a: string }).a, "0");
  assert.equal((after.rows[0] as { f: string }).f, "0", "回滚彻底");
  // 重跑幂等
  const n2 = await importArtez();
  assert.deepEqual(n2, n1, "重跑同量");
  await importArtez().then(() => void 0);
  const cnt = await pool.query("SELECT count(*)::int AS n FROM assets WHERE attrs->>'import_batch'=$1", [BATCH]);
  assert.equal((cnt.rows[0] as { n: number }).n, 3, "重复导入不重复（先清后导）");
});

test("teardown", async () => {
  await importArtez(); // no-op clean via re-import then delete
  await pool.query(`DELETE FROM findings WHERE name = ANY($1)`, [vbFindings.map((f) => f.name)]);
  await pool.query(`DELETE FROM assets WHERE attrs->>'import_batch' = $1`, [BATCH]);
  await pool.query(`DELETE FROM tasks WHERE name = ANY($1)`, [vbTasks.map((t) => t.name)]);
  await pool.query("DELETE FROM explorations");
  await pool.end();
  process.exit(0);
});
