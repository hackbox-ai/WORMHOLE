import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
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
import { ConversationsService } from "../src/domains/conversations/service.ts";
import { resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");
await pool.query("DELETE FROM conversations");
await pool.query("DELETE FROM llm_profiles");

const agents = new AgentsService(pool, "/tmp/pihost-test-dlq.jsonl");
const conversations = new ConversationsService(pool, config, agents, "/tmp/pihost-test-dlq.jsonl");
const taskEngine = new TaskEngine(pool, config, { agents: agents, assets: new AssetsService(pool, "/tmp/pihost-test-dlq.jsonl"), findings: new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl"), intercept: new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl") , settingsConsumers: null });
const ctx: AppContext = {
  pool, config, startedAt: Date.now(),
  auth: new AuthService(pool, authKeyPath(TMP)),
  settings: new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  llm: new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath),
  agents,
  tools: new ToolsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  mcp: new McpService(pool, "/tmp/pihost-test-dlq.jsonl"),
  skills: new SkillsService(pool, "/tmp/pihost-test-dlq.jsonl", "/tmp/pihost-test-skills"),
  workspace: new WorkspaceService(pool, "/tmp/pihost-test-dlq.jsonl", "/tmp/pihost-test-ws"),
  tasks: new TaskService(pool, "/tmp/pihost-test-dlq.jsonl", () => {}),
  taskEngine,
  conversations,
};
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TOKEN = (await ctx.auth.init("conv-test-123456")).token!;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

test("F02 E2E（mock）：创建→202 异步→result/usage activity→自动标题→409 busy", async () => {
  const { server: mockSrv } = await startMockAnthropic(18996, { marker: "CHAT_OK" });
  const prof = await call("POST", "/api/llm/profiles", { name: "chatmock", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18996", api_key: "mk" });
  await call("POST", "/api/llm/profiles/active", { id: prof.json.id });
  resetPiRuntime();

  assert.equal((await call("POST", "/api/conversations", { agent_key: "ghost" })).status, 404, "agent 不存在");
  const c = await call("POST", "/api/conversations", { agent_key: "auto", title: "F02 测试" });
  assert.equal(c.status, 200);
  const id = Number(c.json.id);

  const busy = await call("POST", `/api/conversations/${id}/messages`, { message: "第一条消息，触发 busy" });
  assert.equal(busy.status, 202);
  const concurrent = await call("POST", `/api/conversations/${id}/messages`, { message: "并发第二条" });
  assert.equal(concurrent.status, 409, "同会话并发 409 busy");
  assert.equal((await call("POST", `/api/conversations/${id}/messages`, { message: "" })).status, 400, "空消息 400");

  // 等异步完成：assistant activity 出现
  const deadline = Date.now() + 60_000;
  let msgs: any[] = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    msgs = (await call("GET", `/api/conversations/${id}/messages`)).json.items;
    if (msgs.some((m) => m.kind === "result")) break;
  }
  const kinds = msgs.map((m) => m.kind);
  assert.ok(kinds.includes("user"), "用户消息已落");
  assert.ok(kinds.includes("result"), `助手回复已落（实际序列：${kinds.join(",")}）`);
  assert.match(msgs.find((m) => m.kind === "result").summary, /CHAT_OK/, "mock 固定回复");
  const detail = await call("GET", `/api/conversations/${id}/messages/${msgs[0].seq}`);
  assert.equal(detail.status, 200, "消息详情");

  // 自动标题：仅默认标题（新对话）时触发
  const c3 = await call("POST", "/api/conversations", { agent_key: "auto" });
  await call("POST", `/api/conversations/${c3.json.id}/messages`, { message: "自动标题消息" });
  await new Promise((r) => setTimeout(r, 800));
  const list2 = await call("GET", "/api/conversations");
  const auto = list2.json.conversations.find((x: any) => x.id == c3.json.id);
  assert.equal(auto.title, "自动标题消息", "无标题会话按首条消息自动命名");
  const list = await call("GET", "/api/conversations");
  assert.equal(list.json.conversations.find((x: any) => x.id == id).title, "F02 测试", "已有标题不自动改");

  // rename/pin/delete/batch
  assert.equal((await call("PATCH", `/api/conversations/${id}`, { title: "改名" })).status, 200);
  assert.equal((await call("PATCH", `/api/conversations/${id}`, { pinned: true })).status, 200);
  const c2 = await call("POST", "/api/conversations", { agent_key: "auto" });
  const b = await call("POST", "/api/conversations/delete/batch", { ids: [id, Number(c2.json.id), Number(c3.json.id)] });
  assert.equal(b.json.items.filter((x: any) => x.ok).length, 3);
  mockSrv.close();
});

test("teardown", async () => {
  await pool.query("DELETE FROM conversations");
  await pool.query("DELETE FROM llm_profiles");
  await pool.query("DELETE FROM business_events WHERE business_kind IN ('conversation','chat')");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  server.close();
  await pool.end();
  process.exit(0);
});
