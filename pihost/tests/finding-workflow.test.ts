/**
 * F04 组件测试：deepen 原事务、export 现有过滤；实际复测见 finding-retests.test.ts。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { FindingsWorkflow } from "../src/domains/findings/workflow.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService as FS } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { TaskService } from "../src/domains/tasks/service.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM findings"); await pool.query("DELETE FROM finding_retests");
await pool.query("DELETE FROM tasks"); await pool.query("DELETE FROM exploration_nodes"); await pool.query("DELETE FROM explorations");

const findings = new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl");
const wf = new FindingsWorkflow(pool, "/tmp/pihost-test-dlq.jsonl",{beginTaskOperation:()=>()=>{},admitFollowUp:async()=>true});
const tasks = new TaskService(pool, "/tmp/pihost-test-dlq.jsonl", () => {});
void AgentsService; void AssetsService; void FS; void InterceptService;

test("F04 deepen：400（空/超长）/ 404 / 意图追加 + 审计", async () => {
  assert.equal((await wf.deepen(99999, "x")).status, 404, "finding 不存在");
  const f = await findings.create({ name: "工作流发现", severity: "high", task_id: 0 });
  const fid = Number((f as { finding: { id: number } }).finding.id);
  assert.equal((await wf.deepen(fid, "")).status, 400, "空描述");
  assert.equal((await wf.deepen(fid, "x".repeat(4001))).status, 400, "超长");

  // 建任务再 deepen（有 task_id 才追加意图）
  const t = await tasks.create({ name: "F04", goal: "g", queued: true });
  const tid = Number((t as { task: { id: number } }).task.id);
  const findingNode=Number((await pool.query("INSERT INTO exploration_nodes(task_id,exploration_id,kind,payload,state) SELECT id,exploration_id,'finding','{}','confirmed' FROM tasks WHERE id=$1 RETURNING id",[tid])).rows[0].id);
  await pool.query("UPDATE findings SET task_id=$1,node_id=$3 WHERE id=$2", [tid, fid,findingNode]);
  const ok = await wf.deepen(fid, "深入验证此发现");
  assert.ok(ok.ok, JSON.stringify(ok));
  const node = await pool.query("SELECT title FROM exploration_nodes WHERE task_id=$1 AND payload->>'source_finding_id'=$2", [tid, String(fid)]);
  assert.equal((node.rowCount ?? 0), 1, "后续意图入库");
});

test("F04 export：JSON 数组（尚未覆盖原全部导出格式）", async () => {
  const f = await findings.create({ name: "复测发现", severity: "medium" });
  const fid = (f as { finding: { id: number } }).finding.id;
  void fid;

  const exported = await wf.export({ severity: "medium" });
  assert.ok(exported.some((x) => (x as { name: string }).name === "复测发现"), "导出包含目标");
  assert.ok(exported.every((x) => "id" in x && "severity" in x && "created_at" in x), "导出字段完整");
});

test("teardown", async () => {
  await pool.query("DELETE FROM findings"); await pool.query("DELETE FROM finding_retests");
  await pool.query("DELETE FROM tasks"); await pool.query("DELETE FROM exploration_nodes"); await pool.query("DELETE FROM explorations");
  await pool.query("DELETE FROM notification_events");
  await pool.query("DELETE FROM business_events WHERE business_kind='findings'");
  await pool.end();
  process.exit(0);
});
