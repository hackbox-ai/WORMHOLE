/**
 * G04 回归：全局工具注册表不得捕获任务上下文——并发任务/对话交错注册与调用时，
 * 资产、发现的归属与 tool_calls 审计必须始终跟随「本次调用的 ctx」。
 *
 * 复现路径（原缺陷）：engine.workerTools 每个 worker 重注册捕获 taskId 的闭包，
 * 任务 B 注册后 A 再调用 → A 的审计行 + B 的业务写入。本测试用真实 gate/DB 审计
 * + 记录型假服务（只替模型/业务服务层，不替门与账本）证明新契约成立。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { runTool } from "../src/domains/tools/gate.ts";
import { registerBusinessTools } from "../src/domains/tools/business.ts";

process.env.WORMHOLE_CONFIG = process.env.WORMHOLE_CONFIG ?? "/var/lib/wormhole/config.test.json";
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);

/** 记录型假服务：记录每次调用的入参（归属字段断言依据） */
function recordingDeps() {
  const assetCalls: { inputs: { task_id?: number | null }[] }[] = [];
  const findingCalls: Record<string, unknown>[] = [];
  return {
    assetCalls,
    findingCalls,
    assets: {
      upsertSource: async (input: { task_id?: number | null }, _opts?: unknown) => {
        assetCalls.push({ inputs: [input] });
        return { ok: true, status: 200, asset: { id: 1 } };
      },
    },
    findings: {
      record: async (input: any) => {
        findingCalls.push(input);
        return { finding_id: String(9000 + findingCalls.length), finding_node_id: "10" };
      },
    },
  };
}

test("G04：B 注册后 A 调用仍写 A——归属来自调用 ctx 而非注册闭包", async () => {
  const d1 = recordingDeps();
  const d2 = recordingDeps();
  // 模拟 worker A 启动注册，随后 worker B 启动重注册（旧行为下 B 的闭包捕获 taskId=2）
  registerBusinessTools(d1);
  registerBusinessTools(d2);

  // A 的会话在 B 注册之后才调用（审计上下文是 A）
  const rA = await runTool(pool, "report_finding", { name: "A 的发现", severity: "high", vulnclass: "fixture", summary: "verified" },
    { businessKind: "worker", businessId: "task-1-intent-1", agentKey: "worker", runId: "task-1", taskId: 1, intentId: 1 });
  assert.equal(rA.status, "executed");
  // 全局注册表此时是 d2 的 handler——但归属必须来自 ctx（task_id=1），且写入落在当前 handler
  assert.equal(d2.findingCalls.at(-1)?.task_id, 1, "归属跟随调用 ctx.taskId=1，而非任何注册时的捕获");
  assert.equal(d1.findingCalls.length, 0, "旧注册的闭包不应再被使用（等价重注册无害但只有一份活跃 handler）");
  assert.match(String(rA.output), /finding recorded: 10/);
  assert.equal(d2.findingCalls.at(-1)?.intent_id,0,'no model intent_id means no invented graph edge');

  // B 的会话调用 → 写 2
  await runTool(pool, "report_finding", { name: "B 的发现", severity: "low", vulnclass: "fixture", summary: "verified" },
    { businessKind: "worker", businessId: "task-2-intent-9", agentKey: "worker", runId: "task-2", taskId: 2, intentId: 9 });
  assert.equal(d2.findingCalls.at(-1)?.task_id, 2);
});

test("G04：任务与对话交错调用同批工具，互不串归属", async () => {
  const d = recordingDeps();
  registerBusinessTools(d);
  const assets = [{ type: "root_domain", domain: `g04-${Date.now()}.example` }];

  // worker（taskId=7）→ 资产带 task_id=7
  const w = await runTool(pool, "insert_assets", { assets },
    { businessKind: "worker", businessId: "task-7-intent-3", agentKey: "worker", runId: "task-7", taskId: 7, intentId: 3 });
  assert.equal(w.status, "executed");
  assert.equal(d.assetCalls.at(-1)!.inputs[0]!.task_id, 7);

  // 对话（pentest，无 taskId）→ task_id=null（跨任务登记）
  const c = await runTool(pool, "insert_assets", { assets },
    { businessKind: "chat", businessId: "conv-12", agentKey: "pentest", conversationId: 12 });
  assert.equal(c.status, "executed");
  assert.equal(d.assetCalls.at(-1)!.inputs[0]!.task_id, null, "对话场景无任务归属");

  // 审计行跟随调用者 ctx（worker 的两行 business_id 分别是各自会话）
  const audit = await pool.query<{ business_id: string; tool_key: string }>(
    "SELECT business_id, tool_key FROM tool_calls WHERE tool_key='insert_assets' ORDER BY id DESC LIMIT 2");
  assert.equal(audit.rows[0]!.business_id, "conv-12");
  assert.equal(audit.rows[1]!.business_id, "task-7-intent-3");
});

test("G04：清理——恢复真实服务 handler（不向后续测试文件泄漏记录型假服务）", async () => {
  const { AssetsService } = await import("../src/domains/assets/service.ts");
  const { FindingsService } = await import("../src/domains/findings/service.ts");
  registerBusinessTools({ assets: new AssetsService(pool, "/tmp/pihost-test-dlq.jsonl"), findings: new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl") });
});

test("G04：ctx 缺失任务态时 report_finding 按 WORMHOLE 拒绝，禁止无任务发现", async () => {
  const d = recordingDeps();
  registerBusinessTools(d);
  const r = await runTool(pool, "report_finding", { name: "对话发现", severity: "info", vulnclass: "fixture", summary: "verified" },
    { businessKind: "chat", businessId: "conv-3", agentKey: "pentest", conversationId: 3 });
  assert.equal(r.status, "blocked");
  assert.match(r.error ?? "", /需要任务上下文/);
  assert.equal(d.findingCalls.length, 0);
});

process.on("beforeExit", () => { void pool.end(); });
