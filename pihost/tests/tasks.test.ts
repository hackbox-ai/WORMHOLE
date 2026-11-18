import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { SettingsService } from "../src/domains/settings/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { ToolsService } from "../src/domains/tools/service.ts";
import { McpService } from "../src/domains/mcp/service.ts";
import { SkillsService } from "../src/domains/skills/service.ts";
import { WorkspaceService } from "../src/domains/workspace/service.ts";
import { TaskService, TaskEngine } from "../src/domains/tasks/index.ts";
import { resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");
await pool.query("DELETE FROM tasks");
await pool.query("DELETE FROM llm_profiles");
await pool.query("DELETE FROM agent_prompts");

const agents = new AgentsService(pool, "/tmp/pihost-test-dlq.jsonl");
const taskEngine = new TaskEngine(pool, config, { agents: agents, assets: new AssetsService(pool, "/tmp/pihost-test-dlq.jsonl"), findings: new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl"), intercept: new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl") , settingsConsumers: null });
const tasks = new TaskService(pool, "/tmp/pihost-test-dlq.jsonl", (id) => void taskEngine.launch(id), (id, action) => action === "stop" ? taskEngine.stopExecution(id) : action === "pause" ? taskEngine.pause(id) : taskEngine.resume(id));
import { TaskArchives } from '../src/domains/tasks/archives.ts';
const ctx: AppContext = {
  taskArchives: new TaskArchives(pool, '/tmp/pihost-test-archives', { isTaskRunning: () => false, abortTask: () => {}, drainSide: async () => {} }),
  pool, config, startedAt: Date.now(),
  auth: new AuthService(pool, authKeyPath(TMP)),
  settings: new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  llm: new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath),
  agents,
  tools: new ToolsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  mcp: new McpService(pool, "/tmp/pihost-test-dlq.jsonl"),
  skills: new SkillsService(pool, "/tmp/pihost-test-dlq.jsonl", "/tmp/pihost-test-skills"),
  workspace: new WorkspaceService(pool, "/tmp/pihost-test-dlq.jsonl", "/tmp/pihost-test-ws"),
  tasks,
  taskEngine,
};
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TOKEN = (await ctx.auth.init("tasks-test-123456")).token!;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

async function waitFor(cond: () => Promise<boolean>, ms = 60_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

test("F03 E2E（mock 模型）：创建→planner→worker→done + 全程事件", async () => {
  const { server: mockSrv } = await startMockAnthropic(18996, { marker: "TASK_OK",graphWorkflow:true });
  const prof = await call("POST", "/api/llm/profiles", { name: "taskmock", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18996", api_key: "mk" });
  await call("POST", "/api/llm/profiles/active", { id: prof.json.id });
  resetPiRuntime();

  const created = await call("POST", "/api/tasks", { goal: "对 example.com 做一次基础验证", name: "E2E" });
  assert.equal(created.status, 201, JSON.stringify(created.json).slice(0, 120));
  const id = Number(created.json.id);

  const done = await waitFor(async () => {
    const t = await call("GET", `/api/tasks/${id}`);
    return t.json.status === "done";
  });
  assert.ok(done, `任务应到 done，当前：${JSON.stringify((await call("GET", `/api/tasks/${id}`)).json).slice(0, 200)}`);

  const t = await call("GET", `/api/tasks/${id}`);
  assert.ok(Array.isArray(t.json.intents) && t.json.intents.length >= 1, "planner 至少产出一个意图");
  assert.equal(t.json.intents[0].state, "done", "意图完成");
  const events = await pool.query("SELECT DISTINCT event_type FROM business_events WHERE business_kind='task' AND business_id=$1", [String(id)]);
  const types = events.rows.map((r) => (r as { event_type: string }).event_type);
  for (const must of ["task_created", "planner_done", "intent_done", "task_done"]) {
    assert.ok(types.includes(must), `事件账本应含 ${must}（实际: ${types.join(",")}）`);
  }
  const workerSessions = await pool.query("SELECT count(*)::int AS n FROM business_events WHERE business_kind='worker' AND business_id LIKE $1", [`task-${id}-%`]);
  assert.ok((workerSessions.rows[0] as { n: number }).n > 0, "worker 会话事件已落账本");
  mockSrv.close();
});

test("F03 控制面：pause/resume/stop/删除排他/归档", async () => {
  const created = await call("POST", "/api/tasks", { goal: "控制面测试", queued: true });
  const id = Number(created.json.id);
  assert.equal(created.json.status, "created", "queued 任务不自动启动");
  assert.equal((await call("POST", `/api/tasks/${id}/pause`)).status, 200, "原版允许暂停 created/queued 任务并退出队列");
  assert.equal((await call("POST", `/api/tasks/${id}/pause`)).status, 400, "原版拒绝重复暂停");
  assert.equal((await call("POST", `/api/tasks/${id}/run`)).status, 200);
  assert.equal((await call("POST", `/api/tasks/${id}/pause`)).status, 200);
  assert.equal((await call("POST", `/api/tasks/${id}/resume`)).status, 200);
  assert.equal((await call("POST", `/api/tasks/${id}/stop`)).status, 200);
  const stopped = await call("GET", `/api/tasks/${id}`);
  assert.equal(stopped.json.status, "failed");
  assert.equal(stopped.json.stopped_reason, "manual");
  assert.equal((await call("DELETE", `/api/tasks/${id}`)).status, 200, "非运行中可删");
  assert.equal((await call("GET", `/api/tasks/${id}`)).status, 404);

  const fin = await call("POST", "/api/tasks", { goal: "归档测试", queued: true });
  const fid = Number(fin.json.id);
  // 冷归档：两次排队 → 第一次 202、进行中重复 409（对照原文重复归档拒绝）
  assert.equal((await call("POST", `/api/tasks/${fid}/archive`)).status, 202, "冷归档进入队列");
  assert.equal((await call("POST", `/api/tasks/${fid}/archive`)).status, 409, "进行中的归档任务重复排队拒绝");
  await call("POST", `/api/tasks/${fid}/stop`);
  assert.equal((await call("POST", `/api/tasks/${fid}/restore`)).status, 200);
});

test("teardown", async () => {
  await pool.query("DELETE FROM tasks");
  await pool.query("DELETE FROM llm_profiles");
  await pool.query("DELETE FROM business_events WHERE business_kind IN ('task','planner','worker')");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  server.close();
  await pool.end();
  process.exit(0);
});
