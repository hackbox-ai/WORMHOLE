/**
 * 【全纵切-审批场景】（owner 第七轮：审批串纵切）：真实运行路径中的 ask→人工审批→执行。
 * mock tool_use 序列：第1次 tool_use（被 ask 规则拦截）→ 等待审批 → 测试通过 decide API
 * 批准 → gate 放行 → 工具执行 → 模型收到结果 → 最终文本 → worker 完成。
 * 全程零手动 runTool()——审批决定经 HTTP API 到达（与人工操作同路径）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
import { routeRequest, type AppContext } from "../src/api/server.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("INSERT INTO app_settings(key,value) VALUES('intercept_enabled_tools',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(['insert_assets'])]);
await pool.query("DELETE FROM app_settings WHERE key LIKE 'auth.%'");
await pool.query("DELETE FROM llm_profiles"); await pool.query("DELETE FROM intercept_rules");
await pool.query("DELETE FROM tool_calls"); await pool.query("DELETE FROM tool_approvals");
await pool.query("DELETE FROM findings"); await pool.query("DELETE FROM tasks");
await pool.query("DELETE FROM assets WHERE source='agent'");

const agents = new AgentsService(pool, "/tmp/pihost-test-dlq.jsonl");
const assets = new AssetsService(pool, "/tmp/pihost-test-dlq.jsonl");
const findings = new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl");
const intercept = new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl");
const engine = new TaskEngine(pool, config, { agents, assets, findings, intercept , settingsConsumers: null });
const tasks = new TaskService(pool, "/tmp/pihost-test-dlq.jsonl", (id) => void engine.launch(id));
const TOKEN = (await new AuthService(pool, authKeyPath(TMP)).init("vapproval-123456")).token!;

const ctx: AppContext = { pool, config, startedAt: Date.now(), auth: new AuthService(pool, authKeyPath(TMP)), settings: {} as never, llm: {} as never, agents, tools: {} as never, mcp: {} as never, skills: {} as never, workspace: {} as never, tasks: {} as never, taskEngine: {} as never, conversations: {} as never, intercept, obs: {} as never, assets, findings, sync: {} as never } as unknown as AppContext;
const server: Server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

test("纵切-D 审批：模型调用被 ask 拦截→pending 出现→API 批准→工具执行一次→worker 完成", async () => {
  // ask 规则：insert_assets 且含 approval-needed
  await intercept.createRule({ name: "审批门", match_target: "tool_input", match_type: "string", pattern: "approval-needed", action: "ask", message: "需要人工审批", priority: 100, enabled: true });

  const { server: mockSrv } = await startMockAnthropic(18990, {
    marker: "VAPPROVE",graphWorkflow:true,
    toolCalls: [{ name: "insert_assets", input: { assets: [{ type: "subdomain", domain: "approval-needed.example.com" }] } }],
  });
  const llm = new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath);
  const c = await llm.createProfile({ name: "vapprove", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18990", api_key: "mk" });
  await llm.activate(c.profile.id as number); await llm.compileToPiRuntime(); resetPiRuntime();

  const created = await tasks.create({ goal: "纵切D：审批" });
  const taskId = Number((created as { task: { id: number } }).task.id);

  // 等待 pending 出现（worker 的工具调用被 ask 拦截进入等待）
  const deadline0 = Date.now() + 30_000;
  let pendingId = -1;
  while (Date.now() < deadline0) {
    await new Promise((r) => setTimeout(r, 300));
    const p = await call("GET", "/api/intercept/pending");
    if ((p.json.pending as { id: number }[]).length > 0) {
      pendingId = (p.json.pending as { id: number; tool_key: string })[0]!.id;
      assert.equal((p.json.pending as { tool_name: string })[0]!.tool_name, "insert_assets");
      break;
    }
  }
  assert.ok(pendingId > 0, "运行路径应产生待审批单");

  // 批准（HTTP API——与人工操作完全同路径）
  const decide = await call("POST", "/api/intercept/decide", { id: pendingId, decision: "approved" });
  assert.equal(decide.status, 200, "批准成功");

  // worker 完成且资产由批准后的执行产生
  const done = await waitFor(async () => (await tasks.get(taskId))?.status === "done", 60_000);
  assert.ok(done, "批准后 worker 完成");
  assert.equal((await pool.query("SELECT 1 FROM assets WHERE value='approval-needed.example.com'")).rowCount, 1, "批准后资产入库");
  const audit = await pool.query("SELECT is_error, error_text FROM tool_calls WHERE business_id LIKE $1 AND tool_key='insert_assets'", [`task-${taskId}-intent-%`]);
  assert.equal((audit.rows[0] as { is_error: boolean }).is_error, false, "审计无错");
  // 审批单状态
  const hist = await call("GET", "/api/intercept/history");
  assert.ok((hist.json.items as { id: number; status: string }[]).some((h) => h.id === pendingId && h.status !== "pending"), "审批历史可查");
  mockSrv.close();
});

async function waitFor(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

test("teardown", async () => {
  await pool.query("DELETE FROM intercept_rules"); await pool.query("DELETE FROM tool_calls");
  await pool.query("DELETE FROM tool_approvals"); await pool.query("DELETE FROM findings");
  await pool.query("DELETE FROM tasks"); await pool.query("DELETE FROM assets WHERE source='agent'");
  await pool.query("DELETE FROM llm_profiles");
  await pool.query("DELETE FROM business_events WHERE business_kind IN ('task','planner','worker','intercept')");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  server.close();
  await pool.end();
  process.exit(0);
});
