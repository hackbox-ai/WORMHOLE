import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { SettingsService } from "../src/domains/settings/service.ts";
import { ObservabilityService } from "../src/domains/observability/service.ts";
import { createHostedSession, resetPiRuntime, setCallRecorder } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";
import { LlmService } from "../src/domains/llm/service.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");
await pool.query("DELETE FROM llm_profiles");
await pool.query("DELETE FROM llm_usage"); await pool.query("DELETE FROM llm_records"); await pool.query("DELETE FROM server_logs");

const obs = new ObservabilityService(pool);
const settings = new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl");

setCallRecorder((u,on) => obs.recordCall(u,on,u.businessKind));
const TOKEN = (await new AuthService(pool, authKeyPath(TMP)).init("obs-test-123456")).token!;

test("F07：会话用量恒记；llm_record 开关控制原文录制", async () => {
  const { server: mockSrv } = await startMockAnthropic(18996, { marker: "OBS_OK" });
  const llm = new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath);
  const c = await llm.createProfile({ name: "obsmock", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18996", api_key: "mk" });
  await llm.activate(c.profile.id as number);
  const compiled = await llm.compileToPiRuntime();
  assert.ok("provider" in compiled, `编译应成功: ${JSON.stringify(compiled)}`);
  resetPiRuntime();

  await settings.apply({llm_record:false});
  const h = await createHostedSession(pool, config, { kind: "chat", businessId: "obs-1", systemPrompt: "s", provider: `profile-${c.profile.id}`, modelId: "mock-1" });
  await h.session.prompt("ping");
  await h.flushEvents();
  await h.dispose();
  await new Promise((r) => setTimeout(r, 500));
  const usage = await pool.query("SELECT * FROM llm_usage ORDER BY id DESC LIMIT 1");
  assert.ok((usage.rowCount ?? 0) >= 1, "llm_usage 恒记");
  assert.equal((usage.rows[0] as any).input_tokens, 11, "mock usage input");
  let recs = await pool.query("SELECT count(*)::int AS n FROM llm_records");
  assert.equal((recs.rows[0] as { n: number }).n, 0, "录制关：无原文");

  await settings.apply({llm_record:true});
  const h2 = await createHostedSession(pool, config, { kind: "chat", businessId: "obs-2", systemPrompt: "s", provider: `profile-${c.profile.id}`, modelId: "mock-1" });
  await h2.session.prompt("ping2");
  await h2.flushEvents();
  await h2.dispose();
  await new Promise((r) => setTimeout(r, 500));
  recs = await pool.query("SELECT * FROM llm_records ORDER BY id DESC LIMIT 1");
  assert.ok((recs.rowCount ?? 0) >= 1, "录制开：原文落库");
  const detail=await obs.llmRecordDetail(Number(recs.rows[0]!.id));
  assert.match(String(detail!.response_text), /OBS_OK/);
  mockSrv.close();
});

test("F06/F20：commands 读模型 + server_logs", async () => {
  await pool.query(`INSERT INTO tool_calls (business_kind, business_id, tool_key, params, result) VALUES ('obs-test','x','t1','{"a":1}','{"ok":true}')`);
  await pool.query(`INSERT INTO tool_calls (business_kind, business_id, tool_key, params, is_error, error_text) VALUES ('obs-test','x','t2','{}',TRUE,'boom')`);
  const cmds = await obs.commands({ tool: "t1" });
  assert.equal(cmds.length, 1);
  const stats = await obs.commandStats();
  assert.ok(stats.some((s) => s.tool_key === "t1" && s.calls >= 1));
  const bad = await obs.commands();
  assert.ok(bad.some((c) => c.is_error === true), "错误结果可查");
  await obs.log("warn", "test", "hello-log");
  const recent = await obs.recentLogs();
  assert.ok(recent.some((l) => l.text === "hello-log"));
  const hist = await obs.logHistory(0);
  assert.ok(hist.items.length >= 1, "历史分页");
  const byModel = await obs.usageByModel();
  assert.ok(byModel.length >= 1, "按模型用量");
  const daily = await obs.usageDaily();
  assert.equal(daily.length, 1, "按日聚合");
  const summary = await obs.usageSummary();
  assert.ok((summary as { calls: number }).calls >= 2);
});

test("teardown", async () => {
  setCallRecorder(null);
  await pool.query("DELETE FROM llm_profiles");
  await pool.query("DELETE FROM llm_usage"); await pool.query("DELETE FROM llm_records");
  await pool.query("DELETE FROM server_logs");
  await pool.query("DELETE FROM tool_calls WHERE business_kind='obs-test'");
  await pool.query("DELETE FROM business_events WHERE business_kind='chat'");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  await pool.end();
  void TOKEN;
  process.exit(0);
});
