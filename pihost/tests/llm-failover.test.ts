/**
 * F11 手动恢复演练（不构成自动故障转移证据）：
 * 激活 profile + 备份 profile → 主 profile 端点故障 → 池链切换 → 会话用备份模型恢复。
 * mock：两个端点，主端点持续 500 → 备份端点正常 → 验证 fallback 生效。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { createHostedSession, resetPiRuntime } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM llm_profiles");
await pool.query("DELETE FROM business_events WHERE business_kind='chat'");

test("F11 手动恢复：故障探测→手动激活备份→会话恢复（自动切换见 llm-pool-runtime）", async () => {
  const llm = new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath);

  // 主 profile：持续 500（故障注入）
  const brokenServer: Server = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "injected failure" } }));
    });
  });
  await new Promise<void>((r) => brokenServer.listen(18984, "127.0.0.1", r));

  // 备份 profile：正常
  const { server: okServer } = await startMockAnthropic(18983, { marker: "FAILOVER_OK" });

  const primary = await llm.createProfile({ name: "fo-primary", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18984", api_key: "k", priority: 10 });
  const backup = await llm.createProfile({ name: "fo-backup", model: "mock-1", format: "anthropic", base_url: "http://127.0.0.1:18983", api_key: "k", priority: 5 });

  // 激活主 → 池链：主在前备份在后
  await llm.activate(primary.profile!.id as number);
  const chain = await llm.poolChain();
  assert.equal(chain.length, 2, "池链含两个 profile");
  assert.equal((chain[0] as { name: string }).name, "fo-primary", "激活项链首");
  assert.equal((chain[1] as { name: string }).name, "fo-backup", "备份在其后");

  // 直接测试主 profile → 应失败
  const testPrimary = await llm.testProfile(primary.profile!.id as number);
  assert.equal(testPrimary.ok, false, "主端点故障");

  // 备份 profile → 正常
  const testBackup = await llm.testProfile(backup.profile!.id as number);
  assert.equal(testBackup.ok, true, "备份端点正常");

  // 池故障转移：编译备份为激活 → 会话恢复
  await llm.activate(backup.profile!.id as number);
  await llm.compileToPiRuntime();
  resetPiRuntime();
  const h = await createHostedSession(pool, config, {
    kind: "chat", businessId: "failover-1", systemPrompt: "s",
    provider: `profile-${backup.profile!.id}`, modelId: "mock-1",
  });
  await h.session.prompt("ping");
  const dead = await h.flushEvents();
  await h.dispose();
  assert.equal(dead, 0);
  const end = await pool.query("SELECT payload->'messages' AS m FROM business_events WHERE business_kind='chat' AND business_id='failover-1' AND event_type='agent_end' ORDER BY seq DESC LIMIT 1");
  const text = JSON.stringify((end.rows[0] as { m?: unknown })?.m ?? []);
  assert.match(text, /FAILOVER_OK/, "failover 后会话用备份模型产出");

  // 池状态可查
  const pool2 = await llm.poolChain();
  assert.equal((pool2[0] as { name: string }).name, "fo-backup", "切换后备份为链首");

  brokenServer.close();
  okServer.close();
});

test("teardown", async () => {
  await pool.query("DELETE FROM llm_profiles");
  await pool.query("DELETE FROM business_events WHERE business_kind='chat'");
  await writeFile(config.pi.modelsPath, JSON.stringify({ providers: {} }));
  resetPiRuntime();
  await pool.end();
  process.exit(0);
});
