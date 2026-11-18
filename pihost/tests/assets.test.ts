import assert from "node:assert/strict";
import { test,after } from "node:test";
import { createServer } from "node:http";
import { mkdtemp,rm } from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

const TMP = await mkdtemp(path.join(tmpdir(),'wormhole-assets-'));
const config = loadConfig(),schema='codex_assets_legacy_'+process.pid+'_'+Date.now();
const admin=new Pool({connectionString:config.database.dsn});await admin.query('CREATE SCHEMA '+schema);
const pool = new Pool({ connectionString: config.database.dsn,options:'-c search_path='+schema });
await runMigrations(pool);
await pool.query("DELETE FROM asset_intercept_rules;DELETE FROM task_intercept_rules;DELETE FROM assets;DELETE FROM companies");
await pool.query("INSERT INTO explorations(id,goal) VALUES(1,'fixture');INSERT INTO tasks(id,exploration_id,name,goal,description) VALUES(1,1,'fixture','fixture','fixture')");

const assets = new AssetsService(pool, path.join(TMP,"dlq.jsonl"));
const ctx: AppContext = {
  pool, config, startedAt: Date.now(),
  auth: new AuthService(pool, authKeyPath(TMP)),
  settings: {} as never, llm: {} as never, agents: {} as never, tools: {} as never,
  mcp: {} as never, skills: {} as never, workspace: {} as never,
  tasks: {} as never, taskEngine: {} as never, conversations: {} as never,
  intercept: {} as never, obs: {} as never,
  assets,
} as unknown as AppContext;
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TOKEN = (await ctx.auth.init("assets-test-12345")).token!;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

test("F18 闸门优先级：全局 block > 任务 block > 任务 allow > 默认", async () => {
  await call("POST", "/api/asset-intercept/rules", { kind: "exact_domain", pattern: "evil.com", action: "block", enabled: true });
  await call("POST", "/api/asset-intercept/rules", { kind: "cidr", pattern: "10.66.0.0/16", action: "block", enabled: true });
  const g1 = await assets.evaluateGate("domain", "evil.com", null);
  assert.equal(g1.allowed, false);
  assert.equal(g1.ruleSource, "global-block");
  const g2 = await assets.evaluateGate("domain", "sub.evil.com", null);
  assert.equal(g2.allowed, true, "原版 exact_domain 只全等匹配；覆盖子域应使用 fuzzy_domain");
  const g3 = await assets.evaluateGate("ip", "10.66.1.23", null);
  assert.equal(g3.allowed, false, "CIDR 命中");
  const g4 = await assets.evaluateGate("ip", "10.67.1.23", null);
  assert.equal(g4.allowed, true, "网段外放行");
  // 任务级：allow 不能越过全局 block；能越过任务 block？不能——顺序：任务 block 在 allow 前
  await pool.query("INSERT INTO task_intercept_rules (task_id, scope_kind, kind, pattern, value, action) VALUES (1,'domain','exact_domain','ok.com','ok.com','block')");
  await pool.query("INSERT INTO task_intercept_rules (task_id, scope_kind, kind, pattern, value, action) VALUES (1,'domain','exact_domain','ok.com','ok.com','allow')"); // 同值 allow（后配）
  const t1 = await assets.evaluateGate("domain", "ok.com", 1);
  assert.equal(t1.allowed, false, "任务 block 优先于任务 allow");
  await pool.query("INSERT INTO task_intercept_rules (task_id, scope_kind, kind, pattern, value, action) VALUES (1,'domain','exact_domain','fine.com','fine.com','allow')");
  const t2 = await assets.evaluateGate("domain", "fine.com", 1);
  assert.equal(t2.allowed, true);
  assert.equal(t2.ruleSource, "task-allow");
  const t3 = await assets.evaluateGate("domain", "other.com", 1);
  assert.equal(t3.allowed, false, "有启用白名单时未命中必须拒绝");
});

test("F08 入口差异（WORMHOLE 保留）：agent 走闸门，manual 不走；upsert 幂等去重", async () => {
  const agentBlocked = await assets.upsertSource({type:"root_domain",domain:"evil.com"},{viaAgent:true});
  assert.equal(agentBlocked.status,403);
  const manualOk = await call("POST", "/api/assets", { assets: [{type:"root_domain",domain:"evil.com"}], source:"agent" });
  assert.equal(manualOk.status,200,"原版人工 API 不消费 source 开关，也不走 agent 闸门");
  assert.equal(manualOk.json.results.length,1);
  await call("POST","/api/assets",{assets:[{type:"root_domain",domain:"site.example.com",icp:"old"}]});
  await call("POST","/api/assets",{assets:[{type:"root_domain",domain:"site.example.com",icp:"new"}]});
  const list=await call("GET","/api/assets?type=root_domain");
  assert.equal(list.json.assets.filter((a:any)=>a.domain==="site.example.com").length,1);
  assert.equal(list.json.assets.find((a:any)=>a.domain==="site.example.com").icp,"new");
  const batch = await assets.batchUpsert([
    { type: "domain", value: "b1.example.com" },
    { type: "domain", value: "evil.com" },
  ], { viaAgent: true });
  assert.equal(batch.inserted, 1);
  assert.equal(batch.blocked, 1, "批量部分命中");
});

test("F08 企业 + counts + 任务关联", async () => {
  const c = await call("POST", "/api/companies", { name: "示例企业", scope: ["example.com"] });
  assert.equal(c.status, 201);
  await call("POST", "/api/assets", { assets:[{type:"subdomain",domain:"corp.example.com"}] });
  const list = await call("GET", `/api/assets?company_id=${c.json.id}`);
  assert.ok(list.json.assets.some((a:any)=>a.domain==="corp.example.com"));
  assert.ok(list.json.assets.every((a:any)=>a.company_id===c.json.id));
  const counts = await call("GET", "/api/assets/counts");
  assert.ok(counts.json.root_domain >= 3);
  await assets.linkTask(9, list.json.assets[0].id);
  const tassets = await call("GET", "/api/tasks/9/assets");
  assert.equal(tassets.json.length, 1);
  const comps = await call("GET", "/api/companies");
  assert.equal(comps.json[0].asset_count, list.json.total, "企业资产计数");
});

after(async()=>{
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(TMP,{recursive:true,force:true});
});
