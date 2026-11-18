/**
 * G06 回归：统一工具门——judge 兜底、规则审批超时/超时动作、http_request 入门、执行前复验。
 * mock 边界：只替「模型裁决」与「审批等待」（GateOptions 注入点），门/审计/校验/注册表全部真实。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { runTool, registerTool } from "../src/domains/tools/gate.ts";
import { registerBusinessTools } from "../src/domains/tools/business.ts";
import { parseVerdict, DEFAULT_JUDGE_PROMPT } from "../src/domains/tools/judge-prompt.ts";

process.env.WORMHOLE_CONFIG = process.env.WORMHOLE_CONFIG ?? "/var/lib/wormhole/config.test.json";
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);

let executed = 0;
registerTool({
  key: "g6_probe", description: "G06 探针", params: { x: "string" }, required: ["x"],
  execute: async () => { executed += 1; return { ok: true }; },
});
registerBusinessTools({
  assets: { batchUpsert: async (i) => ({ inserted: i.length, blocked: 0, errors: [] }) },
  findings: { create: async () => ({ ok: true, finding: { id: 1 } }) },
});
const CTX = { businessKind: "worker", businessId: "task-1-intent-1", agentKey: "worker", taskId: 1, intentId: 1 };

test("G06：judge 未接线/返回 null → 维持放行（基线 !judged 语义）", async () => {
  const before = executed;
  const r = await runTool(pool, "g6_probe", { x: "1" }, CTX, { judge: async () => null });
  assert.equal(r.status, "executed");
  assert.equal(executed, before + 1);
});

test("G06：judge deny → blocked，裁决落事件账本（judge_verdict）", async () => {
  const before = executed;
  const r = await runTool(pool, "g6_probe", { x: "2" }, CTX, {
    judge: async () => ({ action: "deny", comment: "实际操作：删库；成功后的后果：数据丢失；命中规则：D4", modelFallback: false }),
  });
  assert.equal(r.status, "blocked");
  assert.match(r.error ?? "", /D4/);
  assert.equal(executed, before, "deny 不得执行");
  const ev = await pool.query<{ payload: { action: string } }>(
    "SELECT payload FROM business_events WHERE event_type='judge_verdict' ORDER BY seq DESC LIMIT 1");
  assert.equal(ev.rows[0]!.payload.action, "deny");
});

test("G06：judge ask → 走人工审批；批准执行 / 拒绝不执行", async () => {
  const before = executed;
  const approved = await runTool(pool, "g6_probe", { x: "3" }, CTX, {
    judge: async () => ({ action: "ask", comment: "归属不明", modelFallback: false }),
    requestApproval: async () => "approved",
  });
  assert.equal(approved.status, "executed");
  assert.equal(executed, before + 1);

  const denied = await runTool(pool, "g6_probe", { x: "4" }, CTX, {
    judge: async () => ({ action: "ask", comment: "归属不明", modelFallback: false }),
    requestApproval: async () => "denied",
  });
  assert.equal(denied.status, "denied");
  assert.equal(executed, before + 1, "拒绝后不执行");
});

test("G06：ask 规则 timeout_action=deny + timeout_seconds=1 → 超时拒绝", async () => {
  const before = executed;
  const r = await runTool(pool, "g6_probe", { x: "5" }, CTX, {
    rules: [{ toolPattern: /g6_probe/, action: "ask", reason: "需审批", timeoutSeconds: 1, timeoutAction: "deny" }],
    requestApproval: (tcid, reason, timeoutMs, timeoutAction) => {
      assert.equal(timeoutMs, 1000, "规则 timeout_seconds 传入等待层");
      assert.equal(timeoutAction, "deny");
      return Promise.resolve(timeoutAction === "allow" ? "timeout-allow" : "timeout");
    },
  });
  assert.equal(r.status, "approval-timeout");
  assert.equal(executed, before);
});

test("G06：ask 规则 timeout_action=allow → 超时放行执行", async () => {
  const before = executed;
  const r = await runTool(pool, "g6_probe", { x: "6" }, CTX, {
    rules: [{ toolPattern: /g6_probe/, action: "ask", reason: "需审批", timeoutSeconds: 1, timeoutAction: "allow" }],
    requestApproval: async (_tcid, _reason, _ms, action) => (action === "allow" ? "timeout-allow" : "timeout") as "timeout-allow",
  });
  assert.equal(r.status, "executed", "timeout_action=allow 超时后放行");
  assert.equal(executed, before + 1);
});

test("G06：http_request 入门——deny 规则命中即阻断，不发起网络请求", async () => {
  const r = await runTool(pool, "http_request", { url: "http://127.0.0.1:1/never-reached" }, CTX, {
    rules: [{ toolPattern: /http_request/, action: "block", reason: "测试阻断" }],
  });
  assert.equal(r.status, "blocked");
  assert.equal(r.error, "测试阻断");
});

test("G06：执行前复验——审批期间可见性收回后不再执行", async () => {
  const { setVisibility } = await import("../src/domains/tools/gate.ts");
  setVisibility("worker", ["insert_assets"]); // 收回 g6_probe
  const r = await runTool(pool, "g6_probe", { x: "7" }, CTX, {
    judge: async () => ({ action: "ask", comment: "转人工", modelFallback: false }),
    requestApproval: async () => "approved",
  });
  assert.equal(r.status, "not-visible", "审批通过但可见性已收回 → 拒绝执行");
  setVisibility("worker", []); // 恢复全部可见
});

test("G06：parseVerdict 严格解析（对照基线 ParseVerdict）", async () => {
  assert.deepEqual(parseVerdict('{"decision":"allow","comment":"x"}'), { action: "allow", reason: "x" });
  assert.deepEqual(parseVerdict('```json\n{"decision":"deny","comment":"y"}\n```'), { action: "deny", reason: "y" });
  assert.equal(parseVerdict('{"decision":"allow"}').action, "", "缺 comment 不可解析");
  assert.equal(parseVerdict('{"decision":"allow","comment":"y","extra":1}').action, "", "多字段不可解析");
  assert.equal(parseVerdict("我觉得可以放行").action, "", "散文不可解析");
  assert.equal(parseVerdict('{"decision":"maybe","comment":"y"}').action, "", "非法 decision 不可解析");
  assert.ok(DEFAULT_JUDGE_PROMPT.includes("裁决输出协议"), "默认策略含输出协议（EffectiveJudgePrompt 语义）");
  assert.ok(DEFAULT_JUDGE_PROMPT.length > 3000, "基线策略正文完整迁入");
});

process.on("beforeExit", () => { void pool.end(); });
