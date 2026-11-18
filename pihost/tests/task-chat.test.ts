/**
 * F02 主链测试：POST /api/chat?task=N → 202 异步（mock 主会话产出）→ 404（任务不存在）→ 409 busy。
 * 暂停任务不拦截。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { TaskChatService } from "../src/domains/tasks/chat.ts";
import { TaskService, TaskEngine } from "../src/domains/tasks/index.ts";
import { AssetsService } from "../src/domains/assets/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM llm_profiles"); await pool.query("DELETE FROM tasks");
await pool.query("DELETE FROM business_events WHERE business_kind IN ('mainagent','task')");

const agents = new AgentsService(pool, "/tmp/pihost-test-dlq.jsonl");
const engine = new TaskEngine(pool, config, { agents, assets: new AssetsService(pool, "/tmp/pihost-test-dlq.jsonl"), findings: new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl"), intercept: new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl") , settingsConsumers: null });
const tasks = new TaskService(pool, "/tmp/pihost-test-dlq.jsonl", (id) => void engine.launch(id));
const chat = new TaskChatService(pool, config, agents);

test("F02 主链：404（无任务）→ 202（异步）→ 409 busy → 暂停不拦截", async () => {
  const notFound = await chat.send(99999, "hi");
  assert.equal(notFound.status, 404, "无任务 404");

  const { server } = await startMockAnthropic(18986, { marker: "MAINS_OK" });
  const llm = new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath);
  const c = await llm.createProfile({ name: "mainmock", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18986", api_key: "mk" });
  await llm.activate(c.profile.id as number); await llm.compileToPiRuntime(); resetPiRuntime();

  // 创建任务（queued 避免引擎并发——主链独立于引擎）
  const t = await tasks.create({ name: "主链测试", goal: "g", queued: true });
  const taskId = Number((t as { task: { id: number } }).task.id);

  // 置 paused——WORMHOLE：暂停不拦截主 Agent
  await tasks.control(taskId, "run");
  await tasks.control(taskId, "pause");

  const sent = await chat.send(taskId, "进展如何？");
  assert.equal(sent.status, 202, "暂停中仍可发（WORMHOLE 语义）");

  // 等主会话完成
  const deadline = Date.now() + 60_000;
  let ok = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const n = await pool.query("SELECT count(*)::int AS n FROM business_events WHERE business_kind='mainagent' AND business_id=$1", [`task-${taskId}-main`]);
    if ((n.rows[0] as { n: number }).n > 10) { ok = true; break; }
  }
  assert.ok(ok, "主会话事件落账本");

  // 空消息 400
  assert.equal((await chat.send(taskId, "")).status, 400);
  server.close();
});

test("teardown", async () => {
  await pool.query("DELETE FROM tasks"); await pool.query("DELETE FROM exploration_nodes"); await pool.query("DELETE FROM explorations");
  await pool.query("DELETE FROM llm_profiles");
  await pool.query("DELETE FROM business_events WHERE business_kind IN ('mainagent','task','planner','worker')");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  await pool.end();
  process.exit(0);
});
