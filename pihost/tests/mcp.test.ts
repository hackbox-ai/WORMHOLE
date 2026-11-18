import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { SettingsService } from "../src/domains/settings/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { ToolsService } from "../src/domains/tools/service.ts";
import { McpService } from "../src/domains/mcp/service.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

const TMP = "/tmp/pihost-test-data";
await (await import("node:fs/promises")).mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");
await pool.query("DELETE FROM mcp_servers");

const mcp = new McpService(pool, "/tmp/pihost-test-dlq.jsonl");
const ctx: AppContext = {
  pool, config, startedAt: Date.now(),
  auth: new AuthService(pool, authKeyPath(TMP)),
  settings: new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  llm: new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath),
  agents: new AgentsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  tools: new ToolsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  mcp,
};
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TOKEN = (await ctx.auth.init("mcp-test-1234567")).token!;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

test("F13 CRUD 校验", async () => {
  // Low-level callers have validation; WORMHOLE HTTP saves full records and emits id.
  assert.equal((await mcp.create({name:'x'})).ok,false);
  assert.equal((await mcp.create({name:'x',transport:'grpc'})).ok,false);
  const c = await call("POST", "/api/mcp", {
    name: "mockmcp", transport: "stdio",
    enabled:true,
    command: process.execPath,
    args: [new URL('./fixtures/mock-mcp-server.mjs',import.meta.url).pathname],
  });
  assert.equal(c.status, 200);
  assert.deepEqual(Object.keys(c.json),['id']);
  assert.equal((await call("POST", "/api/mcp", { name: "mockmcp", transport: "stdio", command: "x" })).status, 500, "WORMHOLE DB unique error");
});

test("F13 refresh：实连 mock stdio MCP → 缓存 tools", async () => {
  const list = await call("GET", "/api/mcp");
  const id = list.json.servers[0].id;
  const r = await call("POST", `/api/mcp/${id}/refresh`);
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 100));
  assert.equal(r.json.tools.length, 2);
  const tools = await call("GET", `/api/mcp/${id}/tools`);
  assert.deepEqual(tools.json.tools.map((t: any) => t.name), ["mock_echo", "mock_ping"]);
  assert.deepEqual(Object.keys(tools.json.tools[0]).sort(),['description','name']);
  const after = await call("GET", "/api/mcp");
  assert.deepEqual(after.json.servers[0].tools, ["mock_echo", "mock_ping"], "列表带缓存 tools");
  const saved=await call('POST','/api/mcp',{...after.json.servers[0],enabled:false});assert.equal(saved.json.id,id);
  assert.equal((await call('GET','/api/mcp')).json.servers[0].enabled,false);
  assert.deepEqual((await call("DELETE", `/api/mcp/${id}`)).json,{deleted:id});
  assert.deepEqual((await call("GET", `/api/mcp/${id}/tools`)).json,{tools:[]});
});

test("teardown", async () => {
  await pool.query("DELETE FROM mcp_servers");
  await pool.query("DELETE FROM business_events WHERE business_kind='mcp'");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  server.close();
  await pool.end();
  process.exit(0);
});
