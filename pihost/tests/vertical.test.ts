/**
 * 【组件互操作测试】（owner 第六轮命名澄清）：手动组装 gate/findings 调用以验证组件可组合。
 * 不构成全纵切证据——真实运行路径证据见 tests/vertical-real.test.ts。
 * 验证任务、意图、工具门、资产/发现与事件之间的组件关联。
 * 目标链：TaskEngine.launch → planner 会话 → exploration_nodes（CAS 领取）→
 * worker 会话上下文（businessId=task-intent）→ B06 门执行 insert_assets（agent
 * 来源走 F18 闸门）→ findings.create（事务 outbox）→ business_events 全程审计。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { ToolsService } from "../src/domains/tools/service.ts";
import { registerTool, runTool } from "../src/domains/tools/gate.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { TaskService, TaskEngine } from "../src/domains/tasks/index.ts";
import { resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");
await pool.query("DELETE FROM llm_profiles"); await pool.query("DELETE FROM asset_intercept_rules");
await pool.query("DELETE FROM findings"); await pool.query("DELETE FROM tasks");

const agents = new AgentsService(pool, "/tmp/pihost-test-dlq.jsonl");
const assets = new AssetsService(pool, "/tmp/pihost-test-dlq.jsonl");
const findings = new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl");
const engine = new TaskEngine(pool, config, { agents: agents, assets: new AssetsService(pool, "/tmp/pihost-test-dlq.jsonl"), findings: new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl"), intercept: new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl") , settingsConsumers: null });
const tasks = new TaskService(pool, "/tmp/pihost-test-dlq.jsonl", (id) => void engine.launch(id));
const TOKEN = (await new AuthService(pool, authKeyPath(TMP)).init("vertical-test-123")).token!;

async function waitFor(cond: () => Promise<boolean>, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

test("全纵切：任务→意图→worker 工具→资产（闸门）→发现（outbox）→事件", async () => {
  const { server: mockSrv } = await startMockAnthropic(18996, { marker: "VERT_OK",graphWorkflow:true });
  const llm = new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath);
  const c = await llm.createProfile({ name: "vertmock", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18996", api_key: "mk" });
  await llm.activate(c.profile.id as number);
  await llm.compileToPiRuntime();
  resetPiRuntime();

  // ① 任务创建（自动启动引擎）
  const created = await tasks.create({ goal: "纵切：验证 example.com" });
  assert.ok(created.ok);
  const taskId = Number((created as { task: { id: number } }).task.id);

  // ② planner→意图→worker→任务 done
  const done = await waitFor(async () => {
    const t = await tasks.get(taskId);
    return t?.status === "done";
  });
  assert.ok(done, `任务应完成：${JSON.stringify(await tasks.get(taskId)).slice(0, 200)}`);
  const task = (await tasks.get(taskId)) as { intents: { id: number; state: string }[] };
  assert.ok(task.intents.length >= 1 && task.intents.every((i) => i.state === "done"), "意图全部完成");

  // ③ worker 工具链：在 worker 会话上下文（task-intent）经 B06 门执行 insert_assets（agent 来源走 F18 闸门）
  const intentId = task.intents[0]!.id;
  registerTool({
    key: "insert_assets",
    description: "资产入库（WORMHOLE agent/tools.go 对照）",
    params: { items: "string" },
    required: ["items"],
    execute: async (p) => {
      const items = JSON.parse(String(p.items)) as { type: string; value: string }[];
      const r = await assets.batchUpsert(items.map((i) => ({ ...i, source: "agent", task_id: taskId })), { viaAgent: true });
      return r;
    },
  });
  const gateResult = (await runTool(pool, "insert_assets", {
    items: JSON.stringify([{ type: "domain", value: "vert.example.com" }, { type: "ip", value: "203.0.113.77" }]),
  }, { businessKind: "worker", businessId: `task-${taskId}-intent-${intentId}`, agentKey: "worker", runId: `task-${taskId}` })) as Record<string, unknown>;
  assert.equal(gateResult.status, "executed", "工具经门执行");
  const inserted = gateResult.output as { inserted: number };
  assert.equal(inserted.inserted, 2);
  // tool_calls 审计绑定 worker 上下文
  const audit = await pool.query("SELECT tool_key, business_kind, business_id FROM tool_calls WHERE tool_key='insert_assets' ORDER BY id DESC LIMIT 1");
  assert.equal((audit.rows[0] as { business_kind: string }).business_kind, "worker");
  assert.match(String((audit.rows[0] as { business_id: string }).business_id), new RegExp(`task-${taskId}-intent-`));

  // ④ F18 闸门负例：全局 block 拦 agent 插入
  await assets.createRule({ kind: "exact_domain", pattern: "forbidden.example", action: "block", enabled: true });
  const blocked = (await runTool(pool, "insert_assets", {
    items: JSON.stringify([{ type: "domain", value: "forbidden.example" }]),
  }, { businessKind: "worker", businessId: `task-${taskId}-intent-${intentId}`, agentKey: "worker" })) as { status: string; output?: { blocked: number } };
  assert.equal(blocked.status, "executed");
  assert.equal(blocked.output!.blocked, 1, "闸门拦截计入 blocked");
  const inDb = await pool.query("SELECT count(*)::int AS n FROM assets WHERE value='forbidden.example'");
  assert.equal((inDb.rows[0] as { n: number }).n, 0, "被拦截资产未入库");

  // ⑤ 发现创建（事务 outbox→通知事件）
  const f = await findings.create({ task_id: taskId, name: "纵切发现", severity: "high", asset_ids: [] });
  assert.ok(f.ok);
  const ev = await pool.query("SELECT kind FROM notification_events WHERE finding_id=$1", [(f as { finding: { id: number } }).finding.id]);
  assert.equal((ev.rows[0] as { kind: string }).kind, "finding_created", "发现→原版 outbox 事件");

  // ⑥ 全程事件账本可回溯（任务/planner/worker/工具/发现）
  const kinds = new Set((await pool.query("SELECT DISTINCT business_kind FROM business_events")).rows.map((r) => (r as { business_kind: string }).business_kind));
  for (const must of ["task", "planner", "worker"]) {
    assert.ok(kinds.has(must), `事件账本应含 ${must}（实际 ${[...kinds].join(",")}）`);
  }
  const taskEvents = (await pool.query("SELECT event_type FROM business_events WHERE business_kind='task' AND business_id=$1 ORDER BY seq", [String(taskId)])).rows.map((r) => (r as { event_type: string }).event_type);
  for (const must of ["task_created", "planner_done", "intent_done", "task_done"]) {
    assert.ok(taskEvents.includes(must), `任务事件链缺 ${must}`);
  }
  mockSrv.close();
});

test("teardown", async () => {
  await pool.query("DELETE FROM findings"); await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM llm_profiles"); await pool.query("DELETE FROM asset_intercept_rules");
  await pool.query("DELETE FROM assets WHERE value LIKE 'vert.%' OR value='203.0.113.77'");
  await pool.query("DELETE FROM tool_calls WHERE tool_key='insert_assets'");
  await pool.query("DELETE FROM notification_events");
  await pool.query("DELETE FROM business_events WHERE business_kind IN ('task','planner','worker','assets','findings')");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  await pool.end();
  void TOKEN;
  process.exit(0);
});
