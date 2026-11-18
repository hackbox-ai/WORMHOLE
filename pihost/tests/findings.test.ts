import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { FindingsService } from "../src/domains/findings/service.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

const TMP = "/tmp/pihost-test-data";
await mkdir(TMP, { recursive: true });
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");
await pool.query("DELETE FROM findings"); await pool.query("DELETE FROM traffic_exchanges");
await pool.query("DELETE FROM notification_channels"); await pool.query("DELETE FROM notification_deliveries"); await pool.query("DELETE FROM notification_events");

const findings = new FindingsService(pool, "/tmp/pihost-test-dlq.jsonl");
const ctx: AppContext = { pool, config, startedAt: Date.now(), auth: new AuthService(pool, authKeyPath(TMP)), findings, assets: {}, intercept: {}, obs: {}, settings: { payload: async () => ({ traffic_capture: true }) }, llm: {}, agents: {}, tools: {}, mcp: {}, skills: {}, workspace: {}, tasks: {}, taskEngine: {}, conversations: {} } as unknown as AppContext;
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TOKEN = (await ctx.auth.init("findings-test-123")).token!;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

test("F04 创建（事务 outbox 事件）+ 状态变更（同值不发事件）", async () => {
  // 基线无 POST 创建（405），创建走 service
  const f0 = await findings.create({ name: "", severity: "high" });
  assert.equal((f0 as { ok: boolean }).ok, false);
  const f = await findings.create({ name: "SQL 注入", severity: "high", task_id: 3 });
  assert.ok((f as { ok: boolean }).ok);
  const findingId = (f as { finding: { id: number } }).finding.id;
  const events = await pool.query("SELECT * FROM notification_events WHERE finding_id=$1", [findingId]);
  assert.equal(events.rows.length, 1, "创建即发 outbox 事件");
  assert.equal((events.rows[0] as any).kind, "finding_created");
  await findings.changeStatus(findingId, "high"); // 非法值
  const ok = await findings.changeStatus(findingId, "resolved");
  assert.ok(ok.ok);
  const same = await findings.changeStatus(findingId, "resolved");
  assert.ok(same.ok, "同值 200");
  const after = await pool.query("SELECT count(*)::int AS n FROM notification_events WHERE finding_id=$1", [findingId]);
  assert.equal((after.rows[0] as { n: number }).n, 2, "同值不新增事件（created+status_changed）");
  const list = await call("GET", "/api/exploration/findings?severity=high");
  assert.ok(list.json.some((x: any) => x.id === findingId));
});

test("legacy PG evidence component remains readable; not original F05 capture parity", async () => {
  const id=await findings.recordExchange({ host: "api.victim.example", method: "POST", path: "/login", status: 200, req_body: "user=admin", res_body: "ok" });
  assert.equal((await findings.listExchanges({host:'api.victim.example'})).length,1);
  const f2 = await findings.create({ name: "登录绕过" });
  assert.equal(await findings.bindEvidence(Number(f2.finding!.id),id),true);
  // 删除源流量
  assert.equal(await findings.deleteExchangesByHost('api.victim.example'),1);
  assert.equal((await findings.listExchanges()).length,0,'旧 PG 源已删');
  const evidence = await findings.evidence(Number(f2.finding!.id));
  assert.equal(evidence.length, 1, "证据快照仍在");
  assert.match(JSON.stringify(evidence[0]!.snapshot), /user=admin/, "快照内容完整可读");
});

test("F16 渠道 + 投递（mock webhook）+ 重试", async () => {
  process.env.WORMHOLE_NOTIFY_ALLOW_LOCAL='1';
  // 用本地 http 服务当 webhook
  const received: Record<string, unknown>[] = [];
  const whSrv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received.push(JSON.parse(b));
      res.writeHead(200); res.end("ok");
    });
  });
  await new Promise<void>((r) => whSrv.listen(18995, "127.0.0.1", r));
  await call("POST", "/api/notify/channels", { name: "testhook", kind: "webhook", config: { url: "http://127.0.0.1:18995/hook" } });
  // 制造一个新事件并投递
  await findings.create({ name: "需要通知" });
  const d = await call("POST", "/api/notify/dispatch");
  assert.ok(d.json.sent >= 1, `应至少投递一条: ${JSON.stringify(d.json)}`);
  assert.ok(received.length >= 1, "webhook 收到 payload");
  assert.ok(received.some((p) => JSON.stringify(p).includes("需要通知")), `积压事件按序投递，最终含目标载荷: ${JSON.stringify(received).slice(0, 120)}`);
  // 失败重试路径：坏渠道
  await call("POST", "/api/notify/channels", { name: "badhook", kind: "webhook", config: { url: "http://127.0.0.1:1/x" } });
  await findings.create({ name: "第二条" });
  const d2 = await call("POST", "/api/notify/dispatch");
  assert.ok(d2.json.pending >= 1, "临时网络失败按原版保留 pending 并退避重试");
  const dels = await call("GET", "/api/notify/deliveries");
  assert.ok(dels.json.deliveries.some((x: any) => x.state === "pending" && x.attempts >= 1 && x.last_error), "失败投递含重试计数");
  whSrv.close();
});

test("teardown", async () => {
  await pool.query("DELETE FROM findings"); await pool.query("DELETE FROM traffic_exchanges");
  await pool.query("DELETE FROM notification_channels"); await pool.query("DELETE FROM notification_deliveries"); await pool.query("DELETE FROM notification_events");
  await pool.query("DELETE FROM business_events WHERE business_kind='findings'");
  server.close();
  await pool.end();
  process.exit(0);
});
