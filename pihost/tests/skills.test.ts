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
import { ToolsService } from "../src/domains/tools/service.ts";
import { McpService } from "../src/domains/mcp/service.ts";
import { SkillsService } from "../src/domains/skills/service.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

const TMP = "/tmp/pihost-test-data";
const SKILL_ROOT = "/tmp/pihost-test-skills";
await rm(SKILL_ROOT, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });
process.env.WORMHOLE_CONFIG = "/var/lib/wormhole/config.test.json";
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");
await pool.query("DELETE FROM skill_usage");

const skills = new SkillsService(pool, "/tmp/pihost-test-dlq.jsonl", SKILL_ROOT);
const ctx: AppContext = {
  pool, config, startedAt: Date.now(),
  auth: new AuthService(pool, authKeyPath(TMP)),
  settings: new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  llm: new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath),
  agents: new AgentsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  tools: new ToolsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  mcp: new McpService(pool, "/tmp/pihost-test-dlq.jsonl"),
  skills,
};
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TOKEN = (await ctx.auth.init("skills-test-12345")).token!;

async function call(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, {
    method,
    headers: { "content-type": raw ? "application/zip" : "application/json", authorization: `Bearer ${TOKEN}` },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await resp.text();
  return { status: resp.status, json: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
}

test("F14 create/list/meta/文件 CRUD/usage", async () => {
  assert.equal((await call("POST", "/api/skills", { name: "Bad Name" })).status, 400);
  assert.equal((await call("POST", "/api/skills", { name: "recon", description: "信息收集" })).status, 200);
  assert.equal((await call("POST", "/api/skills", { name: "recon", description: "x" })).status, 400, "重名拒绝");
  const list = await call("GET", "/api/skills");
  assert.equal(list.json.skills[0].name, "recon");
  assert.equal(list.json.skills[0].description, "信息收集");
  assert.equal((await call("PUT", "/api/skills/recon/meta", { description: "信息收集2" })).status, 200);
  assert.equal((await call("GET", "/api/skills")).json.skills[0].description, "信息收集2");
  await call("PUT", "/api/skills/recon/files/scripts/run.md", { content: "# run" });
  const files = await call("GET", "/api/skills/recon/files");
  assert.ok(files.json.some((f: any) => f.path === "scripts/run.md"));
  assert.match((await call("GET", "/api/skills/recon/files/scripts/run.md")).json.content, /# run/);
  assert.equal((await call("PUT", "/api/skills/recon/files/%2e%2e%2fescape.md", { content: "x" })).status, 400, "路径穿越拒绝（编码形式穿透到服务层校验）");
  assert.equal((await call("DELETE", "/api/skills/recon/files/scripts/run.md")).status, 200);
  await skills.recordUsage("recon", "worker", "task", "1");
  const usage = await call("GET", "/api/skills/recon/usage");
  assert.equal(usage.json.length, 1);
});

test("F14 ZIP 上传：合法/恶意路径成员", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const good = zipSync({ "SKILL.md": strToU8("---\nname: zskill\ndescription: zip\n---\n"), "a/b.txt": strToU8("hi") });
  const r = await call("POST", "/api/skills/upload?name=zskill", undefined, good);
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 80));
  assert.equal(r.json.files, 2);
  const files = await call("GET", "/api/skills/zskill/files");
  assert.equal(files.json.length, 2);
  const evil = zipSync({ "../evil.txt": strToU8("x") });
  const e = await call("POST", "/api/skills/upload?name=evilskill", undefined, evil);
  assert.equal(e.status, 400, "恶意 ZIP 成员拒绝");
});

test("F14 missing：可见性引用但磁盘不存在", async () => {
  await pool.query("DELETE FROM agent_visibility");
  await pool.query("INSERT INTO agent_visibility (agent_key, resource_kind, resource_id) VALUES ('auto','skill','ghost-skill')");
  const m = await call("GET", "/api/skills/missing");
  assert.deepEqual(m.json.missing, ["ghost-skill"]);
});

test("teardown", async () => {
  await rm(SKILL_ROOT, { recursive: true, force: true });
  await pool.query("DELETE FROM skill_usage");
  await pool.query("DELETE FROM agent_visibility WHERE resource_id='ghost-skill'");
  await pool.query("DELETE FROM business_events WHERE business_kind='skills'");
  server.close();
  await pool.end();
  process.exit(0);
});
