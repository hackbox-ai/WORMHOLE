/** WORMHOLE replanning: initial planner creates intent; worker writes fact;
 * subsequent planner proves the goal from that fact. Both rounds execute
 * real Pi tools, not planner text parsed by the host. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { TaskService, TaskEngine } from "../src/domains/tasks/index.ts";
import { resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";
import { LlmService } from "../src/domains/llm/service.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM tasks"); await pool.query("DELETE FROM exploration_nodes"); await pool.query("DELETE FROM explorations");
await pool.query("DELETE FROM llm_profiles"); await pool.query("DELETE FROM business_events WHERE business_kind IN ('task','planner','worker')");

const agents = new AgentsService(pool, "/tmp/pihost-test-dlq.jsonl");
const engine = new TaskEngine(pool, config, { agents, assets: new AssetsService(pool, "/tmp/pihost-test-dlq.jsonl"), findings: new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl"), intercept: new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl"), settingsConsumers: null, mcp: null });
const tasks = new TaskService(pool, "/tmp/pihost-test-dlq.jsonl", (id) => void engine.launch(id));

async function waitFor(cond: () => Promise<boolean>, ms = 90_000): Promise<boolean> {
  const d = Date.now() + ms;
  while (Date.now() < d) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 400)); }
  return false;
}

test("F03 去抖联动：意图完成→事实→补充规划→目标证明", async () => {
  const { server: plannerMock,state } = await startMockAnthropic(18981, { marker: "PLAN",graphWorkflow:true });
  const llm = new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath);
  const c = await llm.createProfile({ name: "planner-round", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18981", api_key: "mk" });
  await llm.activate(c.profile!.id as number); await llm.compileToPiRuntime(); resetPiRuntime();

  const t = await tasks.create({ goal: "去抖联动测试", queued: false });
  const taskId = Number((t as { task: { id: number } }).task.id);

  const done = await waitFor(async () => (await tasks.get(taskId))?.status === "done");
  assert.ok(done, "任务完成");
  await engine.drain(taskId);

  // The proof round terminates the task immediately, without requesting a trailing model answer.
  const events = (await pool.query(
    "SELECT event_type, count(*)::int AS n FROM business_events WHERE business_kind='task' AND business_id=$1 GROUP BY 1",
    [String(taskId)],
  )).rows as { event_type: string; n: number }[];
  const byType = Object.fromEntries(events.map((e) => [e.event_type, e.n]));
  assert.equal(byType.planner_done,1,"首轮下发方向；最后证明轮立即取消，不伪造正常结束事件");
  const rounds=state.calls.filter(call=>{
    const body=call.body as any,last=body.messages?.at(-1);
    return body.tools?.some((t:any)=>t.name==='prove_goal')&&!last?.content?.some((c:any)=>c.type==='tool_result');
  });
  assert.equal(rounds.length,2,"两轮真实模型请求：首轮下发方向，第二轮证明目标");
  assert.equal(byType.task_done,1,"目标达成终态事件只有一次");
  assert.ok((byType.intent_done ?? 0) >= 1, "意图完成");
  assert.equal((await pool.query("SELECT count(*)::int n FROM exploration_nodes WHERE task_id=$1 AND kind='intent' AND state IN('open','running')",[taskId])).rows[0].n,0,"终态没有继续委派的意图");
  console.log("  events:", JSON.stringify(byType));
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM exploration_edges e JOIN tasks t ON t.exploration_id=e.exploration_id WHERE t.id=$1 AND e.rel='proves'",[taskId])).rows[0].n),1,"第二轮必须实际通过 prove_goal 建立证据边");
  plannerMock.close();
});

test("teardown", async () => {
  await pool.query("DELETE FROM tasks"); await pool.query("DELETE FROM exploration_nodes"); await pool.query("DELETE FROM explorations");
  await pool.query("DELETE FROM llm_profiles");
  await pool.query("DELETE FROM business_events WHERE business_kind IN ('task','planner','worker')");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  await pool.end();
  process.exit(0);
});
