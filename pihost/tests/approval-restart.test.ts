/**
 * F19 持久等待者（owner 缺口：持久等待者——重启后未决审批恢复）：
 * pending 审批单 → 模拟重启（新 InterceptService 实例）→ decide 仍能生效
 * → 但等待者已不在（进程内）→ 审批状态持久、行为可预期。
 * WORMHOLE 原语义：进程内 channel（pendingManager），重启后 pending 行仍在。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { registerTool, runTool } from "../src/domains/tools/gate.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM intercept_rules"); await pool.query("DELETE FROM tool_calls");
await pool.query("DELETE FROM tool_approvals");

test("F19 重启恢复：pending 行持久→新实例 decide 生效→审批状态完整", async () => {
  const svc = new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl");
  await svc.createRule({ name: "重启测试", match_target: "tool_name", match_type: "string", pattern: "restart_tool", action: "ask", message: "需要审批", enabled: true });
  registerTool({
    key: "restart_tool", description: "重启测试工具", params: { v: "string" }, required: [],
    execute: async () => ({ ok: true }),
  });

  // 发起工具调用——ask → 生成审批单 → 30s 超时窗口（我们不批准，模拟进程崩溃）
  const execPromise = runTool(pool, "restart_tool", { v: "x" }, { businessKind: "test", businessId: "restart", agentKey: "auto" }, {
    rules: await svc.gateRules(),
    requestApproval: (tcid, reason) => svc.requestApproval(tcid, reason),
  });
  // 等审批单出现
  await new Promise((r) => setTimeout(r, 800));
  const pending = await svc.pending();
  assert.equal(pending.length, 1, "运行中 pending 单");
  const approvalId = (pending[0] as { id: number }).id;

  // 模拟重启：新实例
  const svc2 = new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl");

  // 新实例 decide → 生效（DB CAS）
  const decide = await svc2.decide(approvalId, "denied");
  assert.ok(decide.ok, "重启后 decide 生效");

  // 原 execPromise 的等待者已失效（旧实例 channel 没了）——runTool 的 promise 会超时
  // （30s 太长——我们不等待它，只验证 DB 状态）
  const hist = await svc2.history();
  assert.ok(hist.some((h) => (h as { id: number }).id === approvalId && (h as { status: string }).status === "denied"), "历史记录已拒绝");

  // 清理（exec promise 在后台 30s 超时后自动清理，这里不等）
  void execPromise;
});

test("teardown", async () => {
  await pool.query("DELETE FROM intercept_rules"); await pool.query("DELETE FROM tool_calls");
  await pool.query("DELETE FROM tool_approvals");
  await pool.end();
  process.exit(0);
});
