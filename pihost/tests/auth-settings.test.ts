import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { AuthService, authKeyPath } from "../src/auth/service.ts";
import { SettingsService } from "../src/domains/settings/service.ts";
import { SettingsConsumers } from "../src/domains/settings/consumers.ts";
import { routeRequest, type AppContext } from "../src/api/server.ts";

// 用独立 dataDir 隔离 jwt.key；DB 共用测试库（密码键先清后建，测试自包含）
const TMP_DATA = "/tmp/pihost-test-data";
await (await import("node:fs/promises")).mkdir(TMP_DATA, { recursive: true });
process.env.WORMHOLE_CONFIG ??= "/var/lib/wormhole/config.json";
const config = loadConfig();
const pool = new Pool({ connectionString: config.database.dsn });
await runMigrations(pool);
await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");

const ctx: AppContext = {
  pool,
  config,
  startedAt: Date.now(),
  auth: new AuthService(pool, authKeyPath(TMP_DATA)),
  settings: new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl"),
  settingsConsumers: new SettingsConsumers(pool, new SettingsService(pool, "/tmp/pihost-test-dlq.jsonl"), "/tmp/pihost-test-dlq.jsonl"),
};
const server = createServer((req, res) => void routeRequest(req, res, ctx));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let TOKEN = "";

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const resp = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, json: text ? JSON.parse(text) : null };
}

test("auth flow mirrors WORMHOLE contract", async () => {
  assert.equal((await call("GET", "/api/auth/status")).json.initialized, false);
  assert.equal((await call("POST", "/api/auth/init", { password: "short" })).status, 400);
  const init = await call("POST", "/api/auth/init", { password: "test-pass-12345" });
  assert.equal(init.status, 200, "首次 init 成功");
  assert.ok(init.json.token);
  assert.equal((await call("POST", "/api/auth/init", { password: "another-pass-123" })).status, 403, "重复 init 403");
  assert.equal((await call("POST", "/api/auth/login", { username: "WORMHOLE", password: "wrong-pass-999" })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { username: "admin", password: "test-pass-12345" })).status, 401, "用户名必须是 WORMHOLE");
  const login = await call("POST", "/api/auth/login", { username: "WORMHOLE", password: "test-pass-12345" });
  assert.equal(login.status, 200);
  TOKEN = login.json.token;
  assert.equal((await call("GET", "/api/auth/status")).json.initialized, true);
});

test("protected APIs require token (对照基线 401 未授权)", async () => {
  assert.equal((await call("GET", "/api/settings")).status, 401);
  assert.equal((await call("GET", "/api/logs")).status, 401);
  assert.equal((await call("GET", "/api/health")).status, 200, "health 公开");
  assert.equal((await call("GET", "/api/health")).json.version,'0.1.0');
  assert.equal((await call('GET','/api/migration-status')).status,401,'obsolete endpoints are not public');
  assert.equal((await call('GET','/api/migration-status',undefined,TOKEN)).status,404,'new project has no legacy migration API');
});

test("F21 GET /api/settings: 基础字段与任务预算 + 密钥不回显", async () => {
  const r = await call("GET", "/api/settings", undefined, TOKEN);
  assert.equal(r.status, 200);
  const keys = Object.keys(r.json).sort();
  for (const must of ["network_mode","network_channel_id","traffic_capture", "workers", "task_concurrency_limit", "notify_digest_interval_min", "brave_key_set", "constraints_inject_planner"]) {
    assert.ok(keys.includes(must), `缺少 ${must}`);
  }
  assert.equal(r.json.traffic_capture, false, "基线空库默认 false");
  assert.equal(r.json.workers, 3);
});

test("F21 PUT /api/settings: 校验/指针语义/审计事件", async () => {
  assert.equal((await call("PUT", "/api/settings", { notify_public_base_url: "ftp://x" }, TOKEN)).status, 400);
  assert.equal((await call("PUT", "/api/settings", { workers: 0 }, TOKEN)).status, 400);
  const ok = await call("PUT", "/api/settings", { notify_public_base_url: "https://wormhole.example.com/", workers: 8, brave_search_api_key: "bk-1" }, TOKEN);
  assert.equal(ok.status, 200);
  const after = await call("GET", "/api/settings", undefined, TOKEN);
  assert.equal(after.json.notify_public_base_url, "https://wormhole.example.com", "尾部斜杠应裁掉");
  assert.equal(after.json.workers, 8);
  assert.equal(after.json.brave_key_set, true, "密钥原文不回显，只回 *_set");
  // null=不改，""=清空
  const auditBefore = await pool.query("SELECT count(*)::int AS n FROM business_events WHERE business_kind='settings' AND event_type='settings_changed'");
  await call("PUT", "/api/settings", { notify_public_base_url: null, workers: null }, TOKEN);
  assert.equal((await call("GET", "/api/settings", undefined, TOKEN)).json.workers, 8, "null 不改");
  const auditMid = await pool.query("SELECT count(*)::int AS n FROM business_events WHERE business_kind='settings' AND event_type='settings_changed'");
  assert.equal((auditMid.rows[0] as { n: number }).n, (auditBefore.rows[0] as { n: number }).n, "无实际变更不发审计事件");
  const cleared = await call("PUT", "/api/settings", { brave_search_api_key: "" }, TOKEN);
  assert.equal(cleared.status, 200);
  assert.equal((await call("GET", "/api/settings", undefined, TOKEN)).json.brave_key_set, false, "空串清除密钥");
  const audit = await pool.query("SELECT count(*)::int AS n FROM business_events WHERE business_kind='settings' AND event_type='settings_changed'");
  assert.equal((audit.rows[0] as { n: number }).n, (auditBefore.rows[0] as { n: number }).n + 1, "清密钥产生一条新审计事件");
});

test("token 生命周期：重启后仍有效（key 持久化）、过期 token 拒绝、改密流程", async () => {
  // 模拟重启：用同一 keyPath 新建 AuthService 实例，旧 token 必须继续可用
  const restarted = new AuthService(pool, authKeyPath(TMP_DATA));
  const login1 = await call("POST", "/api/auth/login", { username: "WORMHOLE", password: "test-pass-12345" });
  const tok = login1.json.token as string;
  assert.ok(await restarted.verifyToken(tok), "重启（新实例）后旧 token 仍有效");
  // 过期 token
  const expired = await ctx.auth.signTokenForTest(-3600);
  assert.equal(await restarted.verifyToken(expired), false, "过期 token 拒绝");
  const viaExpired = await fetch(BASE + "/api/settings", { headers: { authorization: `Bearer ${expired}` } });
  assert.equal(viaExpired.status, 401);
  assert.match((await viaExpired.json()).error, /token is invalid or expired/, "过期走专用错误消息");
  // change-password 契约
  assert.equal((await call("POST", "/api/auth/change-password", { old_password: "x", new_password: "new-pass-67890" })).status, 401, "无 token 401");
  const badOld = await call("POST", "/api/auth/change-password", { old_password: "wrong-old-123", new_password: "new-pass-67890" }, tok);
  assert.equal(badOld.status, 401);
  assert.equal(badOld.json.error, "Current password is wrong");
  const okChange = await call("POST", "/api/auth/change-password", { old_password: "test-pass-12345", new_password: "new-pass-67890" }, tok);
  assert.equal(okChange.status, 200);
  assert.ok(okChange.json.token, "改密返回新 token");
  assert.equal((await call("POST", "/api/auth/login", { username: "WORMHOLE", password: "new-pass-67890" })).status, 200, "新密码可登录");
  // 恢复测试密码（后续测试依赖）
  const tok2 = (await call("POST", "/api/auth/login", { username: "WORMHOLE", password: "new-pass-67890" })).json.token;
  await call("POST", "/api/auth/change-password", { old_password: "new-pass-67890", new_password: "test-pass-12345" }, tok2);
});

test("token 提取三通道：Bearer / cookie wormhole_token / ?token=", async () => {
  const login = await call("POST", "/api/auth/login", { username: "WORMHOLE", password: "test-pass-12345" });
  const tok = login.json.token as string;
  const viaCookie = await fetch(BASE + "/api/settings", { headers: { cookie: `wormhole_token=${tok}` } });
  assert.equal(viaCookie.status, 200, "cookie 通道");
  const viaQuery = await fetch(`${BASE}/api/settings?token=${tok}`);
  assert.equal(viaQuery.status, 200, "?token= 通道（SSE 用）");
});

test("F21 同值 PUT：不写库、不发审计事件", async () => {
  const cur = await call("GET", "/api/settings", undefined, TOKEN);
  const before = await pool.query("SELECT count(*)::int AS n FROM business_events WHERE business_kind='settings'");
  const put = await call("PUT", "/api/settings", { workers: cur.json.workers, traffic_capture: cur.json.traffic_capture }, TOKEN);
  assert.equal(put.status, 200);
  assert.equal(put.json.workers, cur.json.workers);
  const after = await pool.query("SELECT count(*)::int AS n FROM business_events WHERE business_kind='settings'");
  assert.equal((after.rows[0] as { n: number }).n, (before.rows[0] as { n: number }).n, "同值 PUT 不产生审计事件");
});

test("teardown", async () => {
  await pool.query("DELETE FROM app_settings WHERE key='auth.admin_pass_hash'");
  await pool.query("DELETE FROM app_settings WHERE key LIKE 'settings.%' OR key LIKE 'secret.%'");
  await pool.query("DELETE FROM business_events WHERE business_kind='settings'");
  server.close();
  await pool.end();
});
