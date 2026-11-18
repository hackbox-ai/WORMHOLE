/**
 * F03 deadline 协调器专项：未终态带截止任务在无活跃循环下到点收尾
 * 。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { TaskEngine } from "../src/domains/tasks/engine.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";

process.env.WORMHOLE_CONFIG = process.env.WORMHOLE_CONFIG ?? "/var/lib/wormhole/config.test.json";
const base = loadConfig();
const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
const {tmpdir}=await import('node:os');
const dir=await mkdtemp(tmpdir()+'/wormhole-deadline-coord-');
await mkdir(dir+'/agent');await writeFile(dir+'/agent/models.json',JSON.stringify({providers:{}}));
const config={...base,dataDir:dir,pi:{...base.pi,agentDir:dir+'/agent',modelsPath:dir+'/agent/models.json'}};
const {startMockAnthropic}=await import('./fixtures/mock-anthropic.ts');
const mock=await startMockAnthropic(0,{marker:'FINAL_NO_GOAL_MET'});
const supplier='http://127.0.0.1:'+(mock.server.address() as {port:number}).port;
const suffix = `dl_${process.pid}_${Date.now()}`;
const schema = `t_${suffix}`;
const admin = new Pool({ connectionString: config.database.dsn });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({ connectionString: config.database.dsn, options: `-c search_path=${schema}` });
await runMigrations(pool);
await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('deadline coordinator','anthropic','mock-1',$1,'fixture',true)",[supplier]);
const engine = new TaskEngine(pool, config, {
  agents: new AgentsService(pool, "/tmp/dl-dlq.jsonl"),
  assets: new AssetsService(pool, "/tmp/dl-dlq.jsonl"),
  findings: new FindingsService(pool, "/tmp/dl-dlq.jsonl"),
  intercept: new InterceptService(pool, "/tmp/dl-dlq.jsonl"),
  settingsConsumers: null,
});

test("F03 deadline：暂停任务（无活跃循环）到点转 timeout + 意图停止", async () => {
  const t = (await pool.query(
    "INSERT INTO tasks (name,goal,status,paused,deadline_at) VALUES ('dl','g','paused',TRUE, now() + interval '2 seconds') RETURNING id",
  )).rows[0] as { id: number };
  const id = Number(t.id);
  await pool.query("INSERT INTO exploration_nodes (task_id,kind,title,state) VALUES ($1,'intent','i1','open')", [id]);
  // 模拟重启路径：起协调器（不 launch——对应非活跃任务）
  engine.startDeadlineCoordinator(id);
  await new Promise((r) => setTimeout(r, 4500));
  const after = (await pool.query("SELECT status FROM tasks WHERE id=$1", [id])).rows[0] as { status: string };
  assert.equal(after.status, "timeout", `到点收尾（实际 ${after.status}）`);
  const n = (await pool.query("SELECT state FROM exploration_nodes WHERE task_id=$1 AND kind='intent'", [id])).rows[0] as { state: string };
  assert.equal(n.state, "stopped", "未完意图随收尾停止");
});

test("F03 deadline：未到点不收尾；无截止任务不动", async () => {
  const future = (await pool.query(
    "INSERT INTO tasks (name,goal,status,paused,deadline_at) VALUES ('dl2','g','paused',TRUE, now() + interval '1 hour') RETURNING id",
  )).rows[0] as { id: number };
  const none = (await pool.query("INSERT INTO tasks (name,goal,status,paused) VALUES ('dl3','g','paused',TRUE) RETURNING id")).rows[0] as { id: number };
  engine.startDeadlineCoordinator(Number(future.id));
  engine.startDeadlineCoordinator(Number(none.id));
  await new Promise((r) => setTimeout(r, 1500));
  const f = (await pool.query("SELECT status FROM tasks WHERE id=$1", [Number(future.id)])).rows[0] as { status: string };
  const n2 = (await pool.query("SELECT status FROM tasks WHERE id=$1", [Number(none.id)])).rows[0] as { status: string };
  assert.equal(f.status, "paused", "未到点不收尾");
  assert.equal(n2.status, "paused", "无截止不动");
});

import { after } from "node:test";
after(async () => {
  await engine.shutdown();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));
  const {resetPiRuntime}=await import('../src/pi/session-host.ts');resetPiRuntime();
  await pool.end();
  await admin.query("DROP SCHEMA " + schema + " CASCADE");
  await admin.end();await rm(dir,{recursive:true,force:true});
}, { timeout: 20_000 });
