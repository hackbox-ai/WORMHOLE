/**
 * F02 旁路提问专项：存储契约 + HTTP 契约 + 真实主会话捕获→旁路问答链（mock 供应商）。
 * +  + 。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService } from "../src/auth/service.ts";
import { routeRequest } from "../src/api/server.ts";
import { SideStore, parentKey, type SideSnapshot } from "../src/domains/sidequestions/store.ts";
import { SideRuntime } from "../src/domains/sidequestions/service.ts";
import { createSideChannel } from "../src/domains/sidequestions/channel.ts";
import { ConversationsService } from "../src/domains/conversations/service.ts";
import { AgentsService } from "../src/domains/agents/service.ts";
import { LlmService } from "../src/domains/llm/service.ts";
import { createHostedSession, resetPiRuntime, setSideCaptureSink } from "../src/pi/session-host.ts";
import { startMockAnthropic } from "./fixtures/mock-anthropic.ts";

process.env.WORMHOLE_CONFIG = process.env.WORMHOLE_CONFIG ?? "/var/lib/wormhole/config.test.json";
const config = loadConfig();
const suffix = `${process.pid}_${Date.now()}`;
const schema = `sideq_${suffix}`;
const admin = new Pool({ connectionString: config.database.dsn });
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({ connectionString: config.database.dsn, options: `-c search_path=${schema}` });
await runMigrations(pool);
const auth = new AuthService(pool, `/tmp/${schema}.key`);
const token = (await auth.init("sideq-fixture-123456")).token!;
const ctx = { pool, config, auth } as never;
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function api(path: string, method = "GET", body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const { server: mock } = await startMockAnthropic(18821, { marker: "SIDE_MAIN_OK" });
await pool.query("DELETE FROM llm_profiles");
const prof = (await pool.query("INSERT INTO llm_profiles (name,model,format,base_url,api_key,is_default) VALUES ('sideq','mock-1','anthropic','http://127.0.0.1:18821','mk',TRUE) RETURNING id")).rows[0] as { id: number };
const compiled = await new LlmService(pool, "/tmp/pihost-test-dlq.jsonl", config.pi.modelsPath).compileToPiRuntime();
if ("error" in compiled) throw new Error(JSON.stringify(compiled));
resetPiRuntime();

const runtime = new SideRuntime(pool, async (snap) => createSideChannel(pool, config, snap));
await runtime.boot();
setSideCaptureSink((snap) => runtime.publish(snap));
// 测试进程内嵌 runtime 到 ctx（路由读 ctx.sideQuestions）
(ctx as any).sideQuestions = runtime;
(ctx as any).taskEngine = { isDeleting: () => false };

const conv = await new ConversationsService(pool, config, new AgentsService(pool, "/tmp/dlq.jsonl"), "/tmp/dlq.jsonl").create("auto", "sideq", Number(prof.id));
const convId = Number((conv as { conv: { id: number } }).conv.id);

test("F02 旁路：无快照 POST→409；GET 空历史 items:[]", async () => {
  const no = await api(`/api/conversations/${convId}/side-questions`, "POST", { question: "hello?", client_request_id: "req-1" });
  assert.equal(no.status, 409);
  assert.match(no.json.error, /尚无上下文快照/);
  const g = await api(`/api/conversations/${convId}/side-questions`);
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.items, []);
  assert.equal(g.json.current, null);
  assert.equal(g.json.snapshot, null);
  assert.equal(g.json.next_cursor, 0);
});

test("F02 旁路：参数校验 400（空问题/超长/非法 client id）", async () => {
  assert.equal((await api(`/api/conversations/${convId}/side-questions`, "POST", { question: "", client_request_id: "a" })).status, 400);
  assert.equal((await api(`/api/conversations/${convId}/side-questions`, "POST", { question: "x".repeat(4001), client_request_id: "a" })).status, 400);
  assert.equal((await api(`/api/conversations/${convId}/side-questions`, "POST", { question: "ok?", client_request_id: "非法!" })).status, 400);
});

test("F02 旁路：主会话运行→快照捕获→提问→completed→幂等→清史", async () => {
  // 主会话一轮（发布快照）
  const h = await createHostedSession(pool, config, { kind: "chat", businessId: `conv-${convId}`, systemPrompt: "回答问题", provider: `profile-${prof.id}`, modelId: "mock-1" });
  await h.session.prompt("主会话第一轮");
  await h.flushEvents(); await h.dispose();
  await runtime.snapshotFor({ conversationId: convId }).then((s) => { assert.ok(s, "快照已捕获"); });

  const posted = await api(`/api/conversations/${convId}/side-questions`, "POST", { question: "旁路问题是什么状态？", client_request_id: "req-2" });
  assert.equal(posted.status, 202, JSON.stringify(posted.json));
  assert.equal(posted.json.status, "running");
  // 幂等：同 client 同题 → 200 旧行
  const again = await api(`/api/conversations/${convId}/side-questions`, "POST", { question: "旁路问题是什么状态？", client_request_id: "req-2" });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, posted.json.id);
  // 异题同 id → 409
  assert.equal((await api(`/api/conversations/${convId}/side-questions`, "POST", { question: "另一题", client_request_id: "req-2" })).status, 409);
  // 完成轮询
  let row: any = null;
  for (let i = 0; i < 200 && (!row || row.status === "running"); i++) {
    await new Promise((r) => setTimeout(r, 50));
    row = (await api(`/api/side-questions/${posted.json.id}/events`)).status === 404 ? row : row; // events 是 SSE，改用 store
    const store = new SideStore(pool);
    row = await store.request(posted.json.id);
  }
  assert.equal(row.status, "completed", `最终状态: ${JSON.stringify(row)}`);
  assert.match(row.answer, /SIDE_MAIN_OK/);
  assert.ok(row.sequence >= 1);
  // 历史 GET：items 1 条 + current null + snapshot meta available
  const g = await api(`/api/conversations/${convId}/side-questions`);
  assert.equal(g.json.items.length, 1);
  assert.equal(g.json.current, null);
  assert.ok(g.json.snapshot && g.json.snapshot.available === true, "快照 meta 可用");
  // DELETE 清史
  const del = await api(`/api/conversations/${convId}/side-questions`, "DELETE");
  assert.deepEqual(del.json, { cleared: true });
  const after2 = await api(`/api/conversations/${convId}/side-questions`);
  assert.deepEqual(after2.json.items, []);
});

after(async () => {
  setSideCaptureSink(null);
  runtime.stop();
  mock.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
