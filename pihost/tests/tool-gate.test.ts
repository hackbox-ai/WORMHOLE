import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  registerTool,
  runTool,
  setVisibility,
  type InterceptRule,
  type ToolSchema,
} from "../src/domains/tools/gate.ts";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";

const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);

const echo: ToolSchema = {
  key: "test.echo",
  description: "echo",
  params: { text: "string" },
  required: ["text"],
  execute: async (p) => ({ echo: p.text }),
};
registerTool(echo);

const rules: InterceptRule[] = [
  { toolPattern: /^test\.echo$/, paramPattern: /rm -rf/, action: "block", reason: "危险命令" },
  { toolPattern: /^test\.echo$/, paramPattern: /sudo/, action: "ask", reason: "需要审批" },
];

test("gate: visibility denies hidden tool", async () => {
  setVisibility("restricted", []);
  const r = await runTool(pool, "test.echo", { text: "hi" }, { businessKind: "test", businessId: "gate", agentKey: "restricted" });
  assert.equal(r.status, "not-visible");
  setVisibility("restricted", ["test.echo"]);
});

test("gate: param validation rejects missing/wrong type", async () => {
  const r1 = await runTool(pool, "test.echo", {}, { businessKind: "test", businessId: "gate", agentKey: "open" });
  assert.equal(r1.status, "invalid-params");
  const r2 = await runTool(pool, "test.echo", { text: 42 }, { businessKind: "test", businessId: "gate", agentKey: "open" });
  assert.equal(r2.status, "invalid-params");
});

test("gate: block rule stops before execution", async () => {
  const r = await runTool(pool, "test.echo", { text: "rm -rf /" }, { businessKind: "test", businessId: "gate", agentKey: "open" }, { rules });
  assert.equal(r.status, "blocked");
  assert.match(r.error ?? "", /危险命令/);
});

test("gate: ask executes once after approval; deny/timeout/no-callback all refuse", async () => {
  let exec = 0;
  registerTool({
    key: "test.once",
    description: "once",
    params: { v: "string" },
    required: ["v"],
    execute: async () => {
      exec += 1;
      return { ok: true };
    },
  });
  const askRules: InterceptRule[] = [{ toolPattern: /^test\.once$/, action: "ask", reason: "需要审批" }];
  const ctx = { businessKind: "test", businessId: "gate", agentKey: "open" };

  const approved = await runTool(pool, "test.once", { v: "x" }, ctx, { rules: askRules, requestApproval: async () => "approved" });
  assert.equal(approved.status, "executed");
  assert.equal(exec, 1);
  assert.ok(approved.approvalId);

  const denied = await runTool(pool, "test.once", { v: "x" }, ctx, { rules: askRules, requestApproval: async () => "denied" });
  assert.equal(denied.status, "denied");
  assert.equal(exec, 1); // 未执行

  const timeout = await runTool(pool, "test.once", { v: "x" }, ctx, { rules: askRules, requestApproval: async () => "timeout" });
  assert.equal(timeout.status, "approval-timeout");
  assert.equal(exec, 1);

  const nocb = await runTool(pool, "test.once", { v: "x" }, ctx, { rules: askRules });
  assert.equal(nocb.status, "denied"); // 无人工通道=拒绝，不放行
  assert.equal(exec, 1);
});

test("gate: hook-modified params fail final re-validation", async () => {
  const params: Record<string, unknown> = { text: "sudo make me a sandwich" };
  const r = await runTool(pool, "test.echo", params, { businessKind: "test", businessId: "gate", agentKey: "open" }, {
    rules,
    // 审批回调模拟"审批后 hook 改写参数"（对应 Pi extension 修改 event.input 的风险）
    requestApproval: async () => {
      params.text = 12345;
      return "approved";
    },
  });
  assert.equal(r.status, "invalid-params");
});

test("gate audit ledger persists tool_calls", async () => {
  const n = await pool.query("SELECT count(*)::int AS n FROM tool_calls WHERE business_kind='test' AND business_id='gate'");
  assert.ok((n.rows[0] as { n: number }).n >= 6, "tool_calls 审计行应已落库");
});

test("cleanup test rows", async () => {
  await pool.query("DELETE FROM tool_calls WHERE business_kind='test'");
});
