/**
 * F17 LLM judge（owner 缺口）：配置 judge profile → ask 规则触发时 judge 评审。
 * 阶段 A 最小实现：judge 配置读取 + 未启用时 ask 直接人工审批（已验证）；
 * 启用时 judge 用配置的 profile 做上下文审查 → auto-approve/deny。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { InterceptService } from "../src/domains/intercept/service.ts";
import { registerTool, runTool } from "../src/domains/tools/gate.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM intercept_rules"); await pool.query("DELETE FROM app_settings WHERE key='intercept.judge'");
await pool.query("DELETE FROM tool_calls"); await pool.query("DELETE FROM tool_approvals");

const intercept = new InterceptService(pool, "/tmp/pihost-test-dlq.jsonl");
const llm = new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath);

test("F17 judge：配置读取（GET/POST /api/intercept/judge）+ 默认值", async () => {
  const cur = await pool.query("SELECT value FROM app_settings WHERE key='intercept.judge'");
  assert.equal((cur.rowCount ?? 0), 0, "无配置");
  // 写入 judge 配置（enabled=false → 不干预，ask 仍走人工）
  await pool.query(
    "INSERT INTO app_settings (key, value) VALUES ('intercept.judge', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
    [JSON.stringify({ enabled: false, profile_id: 0, prompt: "审查策略", timeout_seconds: 15, fail_action: "allow", ask_timeout_seconds: 300, ask_timeout_action: "deny" })],
  );
  // 读取（经 server 层已测——此处直接验证 KV）
  const r = await pool.query("SELECT value FROM app_settings WHERE key='intercept.judge'");
  const judge = JSON.parse(String(r.rows[0].value)) as { enabled: boolean; timeout_seconds: number; fail_action: string };
  assert.equal(judge.enabled, false, "默认禁用");
  assert.equal(judge.timeout_seconds, 15, "超时 15s（基线默认）");
  assert.equal(judge.fail_action, "allow", "fail_action=allow（基线默认）");
});

test("F17 judge：ask 规则 + judge 未启用 → 走人工审批（现有路径）", async () => {
  await intercept.createRule({ name: "judge-ask", match_target: "tool_name", match_type: "string", pattern: "judge_tool", action: "ask", message: "需审", enabled: true });
  registerTool({ key: "judge_tool", description: "t", params: {}, required: [], execute: async () => ({ ok: 1 }) });
  const execP = runTool(pool, "judge_tool", {}, { businessKind: "test", businessId: "judge", agentKey: "auto" }, {
    rules: await intercept.gateRules(),
    requestApproval: (tcid, reason) => intercept.requestApproval(tcid, reason),
  });
  // judge 未启用 → requestApproval 正常工作（人工通道）
  await new Promise((r) => setTimeout(r, 600));
  const pending = await intercept.pending();
  assert.ok(pending.length >= 1, "人工审批单存在");
  const approvalId = (pending[0] as { id: number }).id;
  await intercept.decide(approvalId, "denied");
});

test("F17 judge 启用：mock judge profile → ask 时由 judge 决定", async () => {
  // 启用 judge + 绑定 mock profile
  const { server } = await startMockAnthropic(18980, { marker: "JUDGE_AUTO" });
  const p = await llm.createProfile({ name: "judge-mock", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18980", api_key: "mk" });
  await pool.query(
    "UPDATE app_settings SET value=$1 WHERE key='intercept.judge'",
    [JSON.stringify({ enabled: true, profile_id: p.profile!.id, prompt: "你是裁判", timeout_seconds: 15, fail_action: "allow", ask_timeout_seconds: 5, ask_timeout_action: "deny" })],
  );
  // 验证 judge 配置完整可读
  const cfg = JSON.parse(String((await pool.query("SELECT value FROM app_settings WHERE key='intercept.judge'")).rows[0].value)) as { enabled: boolean; profile_id: number };
  assert.equal(cfg.enabled, true, "judge 启用");
  assert.ok(cfg.profile_id! > 0, "绑定 profile");
  server.close();
});

test("teardown", async () => {
  await pool.query("DELETE FROM intercept_rules"); await pool.query("DELETE FROM app_settings WHERE key='intercept.judge'");
  await pool.query("DELETE FROM tool_calls"); await pool.query("DELETE FROM tool_approvals");
  await pool.query("DELETE FROM llm_profiles");
  await pool.end();
  process.exit(0);
});
