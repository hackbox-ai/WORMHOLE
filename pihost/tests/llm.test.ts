import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { SettingsService } from "../src/domains/settings/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { createHostedSession, resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

const TMP = "/tmp/pihost-test-data";
await (await import("node:fs/promises")).mkdir(TMP, { recursive: true });
const config = loadConfig(); // config.test.json（隔离测试库 + 独立 modelsPath）
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM llm_profiles");
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");

const ctx: AppContext = {
  pool,
  config,
  startedAt: Date.now(),
  auth: new AuthService(pool, authKeyPath(TMP)),
  settings: new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  llm: new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath),
};
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

const TOKEN = (await ctx.auth.init("llm-test-pass-123")).token!;

test("F11 profile CRUD：密钥不回显、留空不覆盖", async () => {
  const bad = await call("POST", "/api/llm/profiles", { name: "p1", model: [] }, TOKEN);
  assert.equal(bad.status, 400, "按原 typed JSON 拒绝错误类型");
  const created = await call("POST", "/api/llm/profiles", { name: "p1", model: "m1", format: "anthropic", base_url: "http://127.0.0.1:1", api_key: "sk-abcdef123456" }, TOKEN);
  assert.equal(created.status, 200);
  assert.ok(!("api_key" in created.json), "api_key 永不回显");
  assert.deepEqual(created.json,{id:created.json.id},'原保存响应只有数字 id');
  const kept = await call("PUT", `/api/llm/profiles/${created.json.id}`, { priority: 10, api_key: null, pool_exclude: true }, TOKEN);
  assert.equal(kept.json.api_key_hint, "…3456", "null=不改（hint 保留）");
  assert.equal(kept.json.priority, 10);
  const cleared = await call("PUT", `/api/llm/profiles/${created.json.id}`, { api_key: "" }, TOKEN);
  assert.equal(cleared.json.api_key_hint, "…3456", "留空保留密钥");
});

test("F11 激活与池状态：激活优先、priority 排序；UI 保留 excluded 标记", async () => {
  const a = await call("POST", "/api/llm/profiles", { name: "pa",format:'anthropic', model: "ma", api_key: "k1", priority: 1 }, TOKEN);
  const b = await call("POST", "/api/llm/profiles", { name: "pb",format:'anthropic', model: "mb", api_key: "k2", priority: 9 }, TOKEN);
  const c = await call("POST", "/api/llm/profiles", { name: "pc",format:'anthropic', model: "mc", api_key: "k3", priority: 5, pool_exclude: true }, TOKEN);
  await call("POST", "/api/llm/profiles/active", { id: a.json.id }, TOKEN);
  const chain = await call("GET", "/api/llm/pool", undefined, TOKEN);
  const names = chain.json.chain.map((p: any) => p.name);
  assert.deepEqual(names, ["pa", "p1", "pb", "pc"], "原 UI 状态包括 excluded 和未配置 Key 的项；运行链另行过滤");
  assert.equal(chain.json.chain.find((p:any)=>p.name==='pc').excluded,true);
  assert.equal(chain.json.chain[0].active,true);
  assert.equal(chain.json.chain[0].profile_id,String(a.json.id));
  assert.equal((await call("POST", "/api/llm/pool/reset", {}, TOKEN)).json.chain.length,4);
  const retry = await call("POST", "/api/llm/retry-policy", { connect:{attempts:9} }, TOKEN);
  assert.deepEqual(retry.json.connect,{attempts:9,interval_ms:0});
});

test("F11 test 端点：真实小请求（对本地 mock）", async () => {
  const { server: mockSrv, state } = await startMockAnthropic(18996, { marker: "LLM_OK" });
  const p = await call("POST", "/api/llm/profiles", { name: "mockp", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18996", api_key: "mk" }, TOKEN);
  const t = await call("POST", "/api/llm/test", { profile_id: p.json.id,provider:'anthropic',model:'mock-1',base_url:'http://127.0.0.1:18996' }, TOKEN);
  assert.equal(t.json.ok, true, `test 应成功: ${JSON.stringify(t.json).slice(0, 120)}`);
  assert.ok(t.json.latency_ms >= 0);
  mockSrv.close();
  void state;
});

test("F11 放行门：激活 profile → 编译 → 可运行 Pi session（mock 真回复）", async () => {
  const { server: mockSrv } = await startMockAnthropic(18996, { marker: "COMPILE_OK" });
  const p = await call("POST", "/api/llm/profiles", { name: "gate", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18996", api_key: "mk" }, TOKEN);
  const act = await call("POST", "/api/llm/profiles/active", { id: p.json.id }, TOKEN);
  assert.deepEqual(act.json,{ok:true});
  const modelsJson = JSON.parse(await readFile(config.pi.modelsPath, "utf8"));
  assert.ok(modelsJson.providers[`profile-${p.json.id}`], "models.json 已包含编译出的 provider");
  resetPiRuntime();
  const h = await createHostedSession(pool, config, {
    kind: "chat",
    businessId: "f11-gate",
    systemPrompt: "F11 gate",
    provider: `profile-${p.json.id}`,
    modelId: "mock-1",
  });
  await h.session.prompt("ping");
  const dead = await h.flushEvents();
  await h.dispose();
  assert.equal(dead, 0);
  const end = await pool.query("SELECT payload->'messages' AS m FROM business_events WHERE business_kind='chat' AND business_id='f11-gate' AND event_type='agent_end' ORDER BY seq DESC LIMIT 1");
  const text = JSON.stringify((end.rows[0] as any)?.m ?? []);
  assert.ok(text.includes("COMPILE_OK"), `profile 编译的 session 应回固定响应: ${text.slice(0, 120)}`);
  mockSrv.close();
});

test("teardown", async () => {
  await pool.query("DELETE FROM llm_profiles");
  await pool.query("DELETE FROM business_events WHERE business_kind IN ('llm','chat')");
  // 恢复测试 models.json 为干净状态
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  server.close();
  await pool.end();
  // Pi 会话/runtime 留有非排空句柄（watcher/定时器），显式退出本测试进程
  process.exit(0);
});
