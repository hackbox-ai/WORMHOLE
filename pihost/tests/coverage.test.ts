import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRoute, summarize, type RouteCoverage } from "../src/api/coverage.ts";

test("分类器（G15）：502 恒失败；参数 404 未验证；双探证据升级；SSE 仅入口", () => {
  assert.equal(classifyRoute("/api/x", 502, "upstream error").state, "server-error", "502 不再归入 validation");
  assert.equal(classifyRoute("/api/tasks/{id}", 404, '{"error":"任务不存在"}').state, "param-404-unverified", "合成 id 404 只算未验证");
  const verified = classifyRoute("/api/tasks/{id}", 200, "{}", { resourceVerified: true });
  assert.equal(verified.state, "first-slice-usable");
  const missingVerified = classifyRoute("/api/tasks/{id}", 404, '{"error":"任务不存在"}', { resourceVerified: true });
  assert.equal(missingVerified.state, "route-exists-verified", "真实资源双探 + 404 响应 → 路由存在已证实");
});

test("汇总（G15）：param-404-unverified 与 sse-entry-only 不计入可用，单列待证据", () => {
  const { summary } = summarize([
    { route: "/a", status: 200, state: "first-slice-usable" },
    { route: "/b/{id}", status: 404, state: "param-404-unverified" },
    { route: "/c/stream", status: 200, state: "sse-entry-only" },
    { route: "/d/{id}", status: 200, state: "route-exists-verified" },
  ]);
  assert.equal(summary.firstSliceUsable, 2, "只有 2xx 与双探证实计入可用");
  assert.deepEqual(summary.pendingEvidence, { param404Unverified: 1, sseEntryOnly: 1 });
});

test("分类器：401/404/500/501/200 各归各类，不混淆为已迁移", () => {
  assert.equal(classifyRoute("/api/x", 401, '{"error":"未授权"}').state, "auth-fail");
  assert.equal(classifyRoute("/api/x", 404, '{"error":"not_found"}').state, "no-route");
  assert.equal(classifyRoute("/api/x", 500, '{"error":"internal"}').state, "server-error");
  assert.equal(classifyRoute("/api/x", 503, "oops").state, "server-error");
  assert.equal(classifyRoute("/api/x", 501, '{"error":"not_migrated"}').state, "explicit-not-migrated", "501=显式未迁移，非已迁移");
  assert.equal(classifyRoute("/api/x", 200, "ok-text-not-json").state, "first-slice-usable", "非 JSON 不判失败但记 detail");
  assert.match(classifyRoute("/api/x", 200, "plain").detail ?? "", /非 JSON/);
});

test("分类器：结构检查（shape）把字段缺失判为失败", () => {
  assert.equal(classifyRoute('/api/stats',200,'null').state,'shape-mismatch');
  assert.equal(classifyRoute('/api/settings',200,'invalid json').state,'shape-mismatch');
  assert.equal(classifyRoute('/api/settings',200,JSON.stringify(Object.fromEntries(Array.from({length:21},(_,i)=>['fake'+i,true])))).state,'shape-mismatch','字段数量不能冒充正确字段');
  assert.equal(classifyRoute('/api/events',200,'',{contentType:'text/event-stream'}).state,'sse-entry-only');
  const bad = classifyRoute("/api/stats", 200, JSON.stringify({ assets: 1 }));
  assert.equal(bad.state, "shape-mismatch");
  assert.match(bad.detail ?? "", /缺字段/);
  const okStats = classifyRoute("/api/stats", 200, JSON.stringify({ asset_counts: {}, assets: 0, engine_mode: "idle", llm_configured: false, traffic: 0, traffic_enabled: true }));
  assert.equal(okStats.state, "first-slice-usable");
});

test("汇总：三档分离，accepted 恒 0 且带说明", () => {
  const routes: RouteCoverage[] = [
    { route: "/a", status: 200, state: "first-slice-usable" },
    { route: "/b", status: 501, state: "explicit-not-migrated" },
    { route: "/c", status: 401, state: "auth-fail" },
    { route: "/d", status: 404, state: "no-route" },
    { route: "/e", status: 500, state: "server-error" },
    { route: "/f", status: 200, state: "shape-mismatch" },
  ];
  const { summary } = summarize(routes);
  assert.equal(summary.total, 6);
  assert.equal(summary.firstSliceUsable, 1);
  assert.equal(summary.explicitNotMigrated, 1);
  assert.deepEqual(summary.failures, { authFail: 1, noRoute: 1, serverError: 1, shapeMismatch: 1 });
  assert.equal(summary.accepted, 0, "accepted 由脚本外证据链决定");
  assert.match(summary.acceptedNote, /仅提供覆盖分类/);
});
