import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { SettingsService } from "../src/domains/settings/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { createHostedSession, resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

const TMP = await mkdtemp(join(tmpdir(), "codex-agents-"));
const base = loadConfig();
const schema = "codex_agents_" + process.pid + "_" + Date.now();
const admin = new Pool({ connectionString: base.database.dsn });
await admin.query("CREATE SCHEMA " + schema);
const config = { ...base, dataDir: TMP, pi: { ...base.pi, agentDir: join(TMP,"pi"), modelsPath: join(TMP,"pi","models.json") } };
await mkdir(config.pi.agentDir, { recursive: true });
await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
const pool = new Pool({ connectionString: config.database.dsn, options: "-c search_path=" + schema });
await runMigrations(pool);
const ctx: AppContext = {
  pool, config, startedAt: Date.now(),
  auth: new AuthService(pool, authKeyPath(TMP)),
  settings: new SettingsService(pool, join(TMP,"dlq.jsonl")),
  llm: new LlmService(pool, join(TMP,"dlq.jsonl"), config.pi.modelsPath),
  agents: new AgentsService(pool, join(TMP,"dlq.jsonl")),
};
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TOKEN = (await ctx.auth.init("agents-test-12345")).token!;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

test("F12 内置种子 + 列表形状", async () => {
  const r = await call("GET", "/api/agents");
  const keys = r.json.agents.map((a: any) => a.key);
  assert.deepEqual(keys, ["goals", "planner", "mainagent", "worker", "auto", "pentest", "reporter", "retester", "modeler"]);
  assert.equal(r.json.agents[0].builtin, true);
  assert.equal(typeof r.json.agents[0].mcp_count, "number");
});

test("F12 CRUD：创建/PATCH/内置不可删", async () => {
  const dup = await call("POST", "/api/agents", { key: "auto",name:"Auto" });
  assert.equal(dup.status, 409, "key 冲突拒绝");
  const c = await call("POST", "/api/agents", { key: "myagent", name: "我的", description: "d" });
  assert.equal(c.status, 200);
  assert.equal(c.json.role, "assistant");
  const p = await call("PUT", "/api/agents/myagent/config", { max_turns: 5 });
  assert.equal(p.json.max_turns, 5);
  assert.equal((await call("GET","/api/agents/myagent")).json.agent.max_turns,5);
  assert.equal((await call("PATCH","/api/agents/myagent",{name:"新名称",description:"new"})).json.ok,true);
  assert.equal((await call("DELETE", "/api/agents/auto")).status, 400, "内置不可删");
  assert.equal((await call("DELETE", "/api/agents/myagent")).status, 200);
  assert.equal((await call("GET", "/api/agents/myagent")).status, 404);
});

test("F12 prompt 版本化 + 变量渲染 + 触发器 + 可见性", async () => {
  await pool.query("INSERT INTO agent_variables(agent_key,name,value,example) VALUES ('auto','role_name','渗透','渗透') ON CONFLICT DO NOTHING");
  const initial = (await call("GET", "/api/agents/auto/prompts")).json.versions;
  const version = initial.length ? initial[0].version : 0;
  await call("PUT", "/api/agents/auto/prompt", { template: "你是 {{.role_name}} 助手" });
  await call("PUT", "/api/agents/auto/prompt", { template: "你是 {{.role_name}} 高级助手" });
  const ps = await call("GET", "/api/agents/auto/prompts");
  assert.equal(ps.json.versions.length, initial.length + 2);
  assert.equal(ps.json.versions[0].version, version + 2, "最新在前");
  await pool.query("INSERT INTO agent_variables (agent_key, name, value) VALUES ('auto','role_name','渗透') ON CONFLICT DO NOTHING");
  const preview = await call("POST", "/api/agents/auto/prompt/preview", {});
  assert.equal(preview.json.rendered, "你是 渗透 高级助手");
  const beforeTriggers = (await call("GET", "/api/agents/reporter/triggers")).json.triggers;
  const t = await call("POST", "/api/agents/reporter/triggers", { enabled:true, interval_sec: 60, on_finding: true });
  assert.equal(t.json.on_finding, true);
  const ts = await call("GET", "/api/agents/reporter/triggers");
  assert.equal(ts.json.triggers.length, beforeTriggers.length + 1);
  assert.ok(ts.json.triggers.some((item: any) => item.id === t.json.id && item.on_finding === true));
  await call("PUT", "/api/agents/auto/visibility", { mcp: [Number((await pool.query("SELECT id FROM mcp_servers ORDER BY id LIMIT 1")).rows[0].id)], skill: ["recon"] });
  const v = await call("GET", "/api/agents/auto/visibility");
  assert.deepEqual(v.json, { mcp: [Number((await pool.query("SELECT id FROM mcp_servers ORDER BY id LIMIT 1")).rows[0].id)], skill: ["recon"] });
  await call("POST", "/api/agents/auto/prompt/reset", {});
  assert.equal((await call("GET", "/api/agents/auto/prompts")).json.versions.length, initial.length+3,"reset adds history instead of deleting");
});

test("F12 放行门：agent 绑定 profile → 编译 → Pi session 固定回复", async () => {
  const { server: mockSrv } = await startMockAnthropic(0, { marker: "AGENT_OK" });
  const prof = await call("POST", "/api/llm/profiles", { name: "agmock", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:" + (mockSrv.address() as {port:number}).port, api_key: "mk" });
  await call("POST", "/api/llm/profiles/active", { id: prof.json.id }, );
  await call("PUT", "/api/agents/auto/prompt", { template: "你是 F12 门禁会话" });
  const spec = await ctx.agents.resolveSessionSpec("auto");
  assert.ok(spec.systemPrompt.includes("F12 门禁会话"));
  assert.equal(spec.provider, `profile-${prof.json.id}`);
  resetPiRuntime();
  const h = await createHostedSession(pool, config, {
    kind: "chat", businessId: "f12-gate", systemPrompt: spec.systemPrompt,
    provider: spec.provider, modelId: spec.modelId,
  });
  await h.session.prompt("ping");
  const dead = await h.flushEvents();
  await h.dispose();
  assert.equal(dead, 0);
  const end = await pool.query("SELECT payload->'messages' AS m FROM business_events WHERE business_kind='chat' AND business_id='f12-gate' AND event_type='agent_end' ORDER BY seq DESC LIMIT 1");
  assert.ok(JSON.stringify((end.rows[0] as any)?.m ?? []).includes("AGENT_OK"), "agent 编译会话应回固定响应");
  mockSrv.close();
});

test("complete create draft persists configuration and removes every custom binding", async () => {
  const optionsBefore=Number((await pool.query("SELECT count(*) n FROM agents")).rows[0].n);
  const options=await call("GET","/api/agents/create-options");
  assert.equal(options.status,200);assert.equal(options.json.agent.run_seconds,1200);assert.ok(options.json.prompt);
  assert.equal(Number((await pool.query("SELECT count(*) n FROM agents")).rows[0].n),optionsBefore);
  const preview=await call("POST","/api/agents/create-options/preview",{template:"时间 {{.Now}}"});
  assert.equal(preview.status,200);assert.ok(preview.json.rendered.includes("时间"));assert.ok(!preview.json.error);
  const profile=await call("POST","/api/llm/profiles",{name:"draft-profile",model:"mock-draft",format:"openai",api_key:"test-only",base_url:"http://127.0.0.1:1"});
  const mcp=(await pool.query("INSERT INTO mcp_servers(name) VALUES('draft-mcp') RETURNING id")).rows[0].id;
  const previousTools=(await pool.query("SELECT agents FROM tools WHERE key='bash'")).rows[0].agents;
  const create=await call("POST","/api/agents",{key:"full_draft",name:"完整配置",description:"atomic draft",
    llm_profile_id:Number(profile.json.id),max_turns:17,run_seconds:91,web_search:true,interactive_shell:true,
    prompt:"独立助手 {{.Now}}",wrapup_prompt:"保存证据",wrapup_max_turns:4,
    trigger_run_mode:"parallel",trigger_merge_mode:"by_task",trigger_max_parallel:2,
    visibility:{mcp:[Number(mcp)],skill:["qa-skill"]},tools:["bash"],
    triggers:[{enabled:false,on_finding:true,finding_message:"检查发现"}]});
  assert.equal(create.status,200,JSON.stringify(create.json));
  const result=(await call("GET","/api/agents/full_draft")).json;
  assert.equal(result.agent.max_turns,17);assert.equal(result.agent.run_seconds,91);
  assert.equal(result.agent.web_search,true);assert.equal(result.agent.interactive_shell,true);
  assert.equal(result.agent.llm_profile_id,Number(profile.json.id));assert.equal(result.agent.trigger_run_mode,"parallel");
  assert.equal(result.prompt,"独立助手 {{.Now}}");assert.equal(result.wrapup_prompt,"保存证据");assert.equal(result.wrapup_max_turns,4);
  const compiled=await ctx.agents.resolveSessionSpec("full_draft");
  assert.equal(compiled.provider,"profile-"+profile.json.id);
  assert.ok(compiled.systemPrompt.includes("独立助手"));assert.ok(!compiled.systemPrompt.includes("{{.Now}}"));

  assert.deepEqual(result.visibility,{mcp:[Number(mcp)],skill:["qa-skill"]});
  assert.equal(result.versions.length,1);assert.equal((await call("GET","/api/agents/full_draft/triggers")).json.triggers.length,1);
  await pool.query("INSERT INTO scheduler_state(agent_key) VALUES('full_draft')");
  await pool.query("INSERT INTO agent_variables(agent_key,name,value) VALUES('full_draft','qa','value')");
  assert.equal((await call("DELETE","/api/agents/full_draft")).status,200);
  for(const table of ["agents","agent_prompts","agent_triggers","agent_visibility","agent_variables","scheduler_state"]){
    const field=table==="agents"?"key":"agent_key";
    assert.equal(Number((await pool.query("SELECT count(*) n FROM "+table+" WHERE "+field+"=$1",["full_draft"])).rows[0].n),0,table);
  }
  assert.deepEqual((await pool.query("SELECT agents FROM tools WHERE key='bash'")).rows[0].agents,previousTools);
});

test("invalid drafts create no records and retain existing agents", async () => {
  for(const [n,patch] of [
    {max_turns:-1},{run_seconds:1.5},{web_search:"true"},{llm_profile_id:999999999},
    {prompt:"{{.NotAllowed}}"},{tools:["missing-tool"]},{visibility:{mcp:[999999999]}},{triggers:[{on_tool_call:true}]},
  ].entries()){
    const key="invalid_draft_"+n;
    const r=await call("POST","/api/agents",{key,name:"无效配置",...patch});
    assert.equal(r.status,400,JSON.stringify(r.json));
    assert.equal((await call("GET","/api/agents/"+key)).status,404);
  }
});

test("late database failure rolls back agent prompt, visibility and tool bindings", async () => {
  await pool.query("ALTER TABLE agent_triggers ADD CONSTRAINT reject_test_draft CHECK(agent_key<>'failed_draft')");
  try{
    const r=await call("POST","/api/agents",{key:"failed_draft",name:"失败回滚",prompt:"fixture",visibility:{skill:["qa"]},tools:["bash"],triggers:[{on_finding:true}]});
    assert.equal(r.status,500);
    for(const table of ["agents","agent_prompts","agent_visibility"]){
      const field=table==="agents"?"key":"agent_key";
      assert.equal(Number((await pool.query("SELECT count(*) n FROM "+table+" WHERE "+field+"=$1",["failed_draft"])).rows[0].n),0,table);
    }
    assert.equal(Number((await pool.query("SELECT count(*) n FROM tools WHERE agents @> '[\"failed_draft\"]'::jsonb")).rows[0].n),0);
  }finally{await pool.query("ALTER TABLE agent_triggers DROP CONSTRAINT reject_test_draft");}
});

after(async () => {
  resetPiRuntime();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
  await admin.query("DROP SCHEMA " + schema + " CASCADE");
  await admin.end();
  await rm(TMP, {recursive:true,force:true});
});
