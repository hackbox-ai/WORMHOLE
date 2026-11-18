/**
 * 【全纵切测试】（owner 第六轮任务二）：真实 Pi 运行路径驱动的完整链路。
 * 与组件互操作测试（vertical.test.ts）的区别：工具调用由模型输出（确定性 mock 的
 * tool_use 序列）触发，经 Pi 会话原生工具执行器进入 B06 门；资产/发现由该运行路径
 * 在 worker 完成前产生——测试全程不直接调用 runTool()/findings.create()。
 *
 * 场景：A 允许执行（资产+发现产出）；B 拦截拒绝（规则阻断，资产不入库，worker 仍完成）；
 * C 工具失败恢复（执行器抛错→错误工具结果回模型→会话完成→审计行可追溯）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { TaskService, TaskEngine } from "../src/domains/tasks/index.ts";
import { resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";
import {NotificationService} from '../src/domains/notify/service.ts';

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(['insert_assets'])]);
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");
await pool.query("DELETE FROM llm_profiles"); await pool.query("DELETE FROM intercept_rules");
await pool.query("DELETE FROM tool_calls"); await pool.query("DELETE FROM findings");
await pool.query("DELETE FROM tasks"); await pool.query("DELETE FROM assets WHERE source='agent'");

const agents = new AgentsService(pool, "/tmp/pihost-test-dlq.jsonl");
const assets = new AssetsService(pool, "/tmp/pihost-test-dlq.jsonl");
const findings = new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl");
const intercept = new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl");
const engine = new TaskEngine(pool, config, { agents, assets, findings, intercept , settingsConsumers: null });
const tasks = new TaskService(pool, "/tmp/pihost-test-dlq.jsonl", (id) => void engine.launch(id));
void new AuthService(pool, authKeyPath(TMP)).init("vreal-test-12345");

const llm = new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath);

async function activateMock(toolCalls: { name: string; input: Record<string, unknown> }[], port: number): Promise<() => void> {
  const { server } = await startMockAnthropic(port, { marker: "VREAL", toolCalls,graphWorkflow:true });
  const c = await llm.createProfile({ name: `vreal-${port}`, model: "mock-1", format: "anthropic", base_url: `http://127.0.0.1:${port}`, api_key: "mk" });
  await llm.activate(c.profile.id as number);
  await llm.compileToPiRuntime();
  resetPiRuntime();
  return () => server.close();
}

async function waitFor(cond: () => Promise<boolean>, ms = 90_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

test("纵切-A 允许执行：模型驱动 insert_assets→report_finding，worker 完成前产出资产+发现+审计", async () => {
  const close = await activateMock([
    { name: "insert_assets", input: { assets: [{ type: "subdomain", domain: "vreal-a.example.com" }, { type: "ip", ip: "203.0.113.101" }] } },
    { name: "report_finding", input: { name: "纵切真实发现A", severity: "high", vulnclass: "fixture", summary: "由运行路径产出", evidence: "mock tool result" } },
  ], 18993);
  const created = await tasks.create({ goal: "纵切A：允许执行" });
  const taskId = Number((created as { task: { id: number } }).task.id);
  const done = await waitFor(async () => (await tasks.get(taskId))?.status === "done");
  assert.ok(done, `任务应完成：${JSON.stringify(await tasks.get(taskId)).slice(0, 200)}`);

  const a1 = await pool.query("SELECT * FROM assets WHERE value='vreal-a.example.com'");
  assert.equal((a1.rowCount ?? 0), 1, "资产由 worker 工具产出");
  assert.equal((a1.rows[0] as { source: string }).source, "agent");
  assert.equal(((a1.rows[0] as { task_ids: unknown[] }).task_ids ?? []).length, 1, "资产归属任务");
  assert.equal((await pool.query("SELECT 1 FROM assets WHERE value='203.0.113.101'")).rowCount, 1);

  const f = await pool.query("SELECT * FROM findings WHERE name='纵切真实发现A'");
  assert.equal((f.rowCount ?? 0), 1, "发现由 worker 工具产出");
  assert.equal(Number((f.rows[0] as { task_id: string }).task_id), taskId, "发现关联任务");

  // Pi-originated finding flows through the actual persistent outbox and
  // dispatcher. The transport adapter itself has independent wire parity tests.
  const delivered:any[]=[];
  const notification=new NotificationService(pool,async(_kind,_config,message)=>{delivered.push(message);return message.items.length;});
  await pool.query('DELETE FROM notification_channels');await pool.query('DELETE FROM notification_events WHERE finding_id<>$1',[f.rows[0].id]);
  await pool.query("INSERT INTO app_settings(key,value) VALUES('settings.notify_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'");
  const channel=await notification.store.saveChannel({name:'Pi vertical outbox',kind:'webhook',config:{url:'https://unused.invalid'},rate_per_min:0});
  await notification.dispatcher.step();
  assert.equal(delivered.length,1);assert.equal(delivered[0].items[0].finding_id,Number(f.rows[0].id));assert.equal(delivered[0].items[0].name,'纵切真实发现A');
  const history=await notification.store.list({channel_id:channel});assert.equal(history.total,1);assert.equal(history.deliveries[0]!.state,'sent');assert.equal(history.deliveries[0]!.attempts,1);
  await notification.dispatcher.stop();await notification.store.removeChannel(channel);

  // 审计：tool_calls 绑定 worker 上下文；账本含工具执行证据（Pi 事件里的 toolCall）
  const audit = await pool.query("SELECT tool_key, business_kind, business_id, is_error FROM tool_calls WHERE tool_key IN ('insert_assets','report_finding') ORDER BY id");
  assert.equal(audit.rowCount, 2, "两次工具调用均有审计");
  for (const row of audit.rows as { business_kind: string; business_id: string; is_error: boolean }[]) {
    assert.equal(row.business_kind, "worker");
    assert.match(row.business_id, new RegExp(`^task-${taskId}-intent-`));
    assert.equal(row.is_error, false);
  }
  const ledger = await pool.query("SELECT payload FROM business_events WHERE business_kind='worker' AND business_id LIKE $1", [`task-${taskId}-intent-%`]);
  const ledgerText = JSON.stringify(ledger.rows);
  assert.match(ledgerText, /insert_assets/, "Pi 会话事件含工具调用");
  assert.match(ledgerText, /toolu_/, "含 Anthropic 工具调用 ID");
  // 顺序：资产先于任务 done（运行路径内完成，非事后补写）
  const assetAt = new Date((a1.rows[0] as { created_at: Date }).created_at).getTime();
  const taskRow = (await pool.query("SELECT completed_at FROM tasks WHERE completed_at IS NULL AND id=$1", [taskId])).rows[0];
  void taskRow;
  const doneEvent = await pool.query("SELECT ts FROM business_events WHERE business_kind='task' AND business_id=$1 AND event_type='task_done'", [String(taskId)]);
  assert.ok((doneEvent.rows[0] as { ts: Date }).ts.getTime() >= assetAt, "资产在 task_done 之前产生");
  close();
});

test("纵切-B 拦截拒绝：规则阻断 insert_assets，被拦资产不入库，worker 仍完成且可追溯", async () => {
  await intercept.createRule({ name: "纵切拦截", match_target: "tool_input", match_type: "string", pattern: "forbidden-vreal", action: "deny", message: "纵切拦截", priority: 50, enabled: true });
  const close = await activateMock([
    { name: "insert_assets", input: { assets: [{ type: "subdomain", domain: "forbidden-vreal.example.com" }] } },
  ], 18992);
  const created = await tasks.create({ goal: "纵切B：拦截" });
  const taskId = Number((created as { task: { id: number } }).task.id);
  const done = await waitFor(async () => (await tasks.get(taskId))?.status === "done");
  assert.ok(done, "工具被拦截不炸 worker，任务仍完成");

  assert.equal((await pool.query("SELECT 1 FROM assets WHERE value='forbidden-vreal.example.com'")).rowCount, 0, "被拦资产未入库");
  const audit = await pool.query("SELECT is_error, error_text FROM tool_calls WHERE business_id LIKE $1 AND tool_key='insert_assets'", [`task-${taskId}-intent-%`]);
  assert.equal(audit.rowCount, 1);
  assert.equal((audit.rows[0] as { is_error: boolean }).is_error, true);
  assert.match((audit.rows[0] as { error_text: string }).error_text, /纵切拦截/, "拦截原因入审计");
  close();
});

test("纵切-C 原版逐项错误结果：无效资产不写入→错误详情回模型→审计可追溯", async () => {
  // 空类型资产触发执行器 400（upsert 校验），错误作为工具结果回模型
  const close = await activateMock([
    { name: "insert_assets", input: { assets: [{ type: "root_domain", domain: "" }] } },
  ], 18991);
  const created = await tasks.create({ goal: "纵切C：失败恢复" });
  const taskId = Number((created as { task: { id: number } }).task.id);
  const done = await waitFor(async () => (await tasks.get(taskId))?.status === "done");
  assert.ok(done, "工具失败不炸会话，任务完成");

  const audit = await pool.query("SELECT is_error, error_text FROM tool_calls WHERE business_id LIKE $1 AND tool_key='insert_assets'", [`task-${taskId}-intent-%`]);
  assert.equal(audit.rowCount, 1, "失败调用留审计");
  assert.equal((audit.rows[0] as { is_error: boolean }).is_error, false, "原版 insert_assets 批次返回 errors，不抛整个工具");
  const output = await pool.query("SELECT result FROM tool_calls WHERE business_id LIKE $1 AND tool_key='insert_assets'", [`task-${taskId}-intent-%`]);
  assert.match(JSON.stringify(output.rows), /domain is required/);
  const t = await tasks.get(taskId) as { intents: { state: string }[] };
  assert.equal(t.intents[0].state, "done", "意图完成（错误已由运行路径消化）");
  close();
});

test("teardown", async () => {
  await pool.query("DELETE FROM intercept_rules"); await pool.query("DELETE FROM tool_calls");
  await pool.query("DELETE FROM findings"); await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM assets WHERE source='agent'");
  await pool.query("DELETE FROM llm_profiles");
  await pool.query("DELETE FROM business_events WHERE business_kind IN ('task','planner','worker')");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  await pool.end();
  process.exit(0);
});
