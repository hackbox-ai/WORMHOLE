/** Browser fixtures for the redesigned workspace. Every API call is intercepted;
 * tool execution, approvals and task controls never reach a real backend. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { mockHandle } from "../../web/src/lib/mock/handler.ts";

const root = path.resolve("../web/out");
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, "http://fixture"), resolved = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (!resolved.startsWith(root + path.sep) && resolved !== root) { response.writeHead(403).end(); return; }
    if (url.pathname === "/_qa/font.ttc" && process.env.QA_FONT) { response.setHeader("Content-Type", "font/collection"); response.end(await readFile(process.env.QA_FONT)); return; }
    for (const candidate of [resolved, resolved + ".html", path.join(resolved, "index.html")]) {
      try { if (!(await stat(candidate)).isFile()) continue; } catch { continue; }
      const mime: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
      response.setHeader("Content-Type", mime[path.extname(candidate)] ?? "application/octet-stream"); response.end(await readFile(candidate)); return;
    }
    response.writeHead(404).end();
  } catch { response.writeHead(500).end(); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: "/root/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const token = "e30." + Buffer.from(JSON.stringify({ sub: "WORMHOLE", exp: Date.now() / 1000 + 600 })).toString("base64url") + ".fixture";
  await context.addInitScript((value) => localStorage.setItem("wormhole_token", value), token);
  await context.addCookies([{ name: "wormhole_token", value: token, url: origin }, {name: "theme_mode", value: "light", url: origin}]);
  const page = await context.newPage(), errors: string[] = [], writes: string[] = [], stamp = "2026-10-13T10:00:00Z";
  page.on("pageerror", (error) => errors.push(error.message));
  const steps = [
    { seq: 1, kind: "user", summary: "Check authorized test interfaces" },
    { seq: 2, kind: "thinking", summary: "THINKING_DETAIL_ONLY" },
    { seq: 3, kind: "tool_use", tool: "http_request", tool_use_id: "toolu_a", summary: 'http_request {"url":"https://example.test/api"}' },
    { seq: 4, kind: "tool_use", tool: "Bash", tool_use_id: "toolu_b", summary: 'Bash {"command":"echo fixture"}' },
    { seq: 5, kind: "tool_result", tool: "Bash", tool_use_id: "toolu_b", summary: "FIXTURE_B_RESULT" },
    { seq: 6, kind: "tool_result", tool: "http_request", tool_use_id: "toolu_a", summary: "FIXTURE_A_RESULT" },
    { seq: 7, kind: "result", summary: "Interface check completed", input_tokens: 120, output_tokens: 42 },
    { seq: 8, kind: "tool_use", tool: "Read", tool_use_id: "toolu_failed", summary: 'Read {"path":"missing.txt"}' },
    { seq: 9, kind: "tool_result", tool: "Read", tool_use_id: "toolu_failed", summary: "FIXTURE_MISSING_FILE", is_error: true },
    { seq: 10, kind: "result", summary: "Reason for failure logged" },
    { seq: 11, kind: "intercept_request", summary: "Tools Bash request approval (#901)" },
  ].map((step) => ({ worker: "auto", ts: stamp, ...step }));
  const details = new Map(steps.map((step) => [step.seq, step.seq === 2 ? "THINKING_DETAIL_ONLY" : step.seq === 3 ? '{"url":"https://example.test/api"}' : step.seq === 4 ? '{"command":"echo fixture"}' : step.seq === 11 ? '{"input":{"command":"echo approved"}}' : step.summary]));
  const coverageNodes = [
    { key: "co", kind: "company", label: "Authorized test scope" },
    { key: "a", kind: "root_domain", label: "example.test", tested: true },
    { key: "b", kind: "root_domain", label: "alias.test" },
    { key: "ip", kind: "ip", label: "192.0.2.10", asset_id: 901 },
    { key: "svc", kind: "service", label: "HTTPS :443" },
    ...Array.from({ length: 25 }, (_, index) => ({ key: "endpoint-" + index, kind: "endpoint", label: "https://example.test/api/" + index, asset_id: 1000 + index, tested: index % 2 === 0 })),
  ].map((node) => ({ tested: false, in_scope: true, ...node }));
  const coverageEdges = [{ src: "co", dst: "a" }, { src: "co", dst: "b" }, { src: "a", dst: "ip" }, { src: "b", dst: "ip" }, { src: "ip", dst: "svc" }, ...coverageNodes.filter((node) => node.kind === "endpoint").map((node) => ({ src: "svc", dst: node.key }))];
  const graphNodes = [
    { id: "100", type: "fact", state: "origin", payload: JSON.stringify({ summary: "Authorization interface check", target: "https://example.test" }) },
    { id: "101", type: "goal", state: "open", payload: JSON.stringify({ text: "Confirm interface access boundaries" }) },
    { id: "102", type: "intent", state: "running", payload: JSON.stringify({ summary: "Check login interface", url: "https://example.test/api/login", worker: "Worker #3", asset_ids: [901, 902] }) },
    { id: "103", type: "fact", state: "active", payload: JSON.stringify({ unfamiliar_field: "KEEP_RAW_ONLY", total: 7 }) },
  ].map((node) => ({ priority: 5, ts: stamp, origin: "planner", ...node }));
  graphNodes.push(...Array.from({length: 80}, (_, i) => ({id: String(200 + i), type: "intent", state: "done", priority: 5, ts: stamp, origin: "planner", payload: JSON.stringify({summary: "Big Picture Steps " + i, target: "https://example.test/api/" + i})})));
  let approvalStatus = "pending";
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), apiPath = url.pathname, method = request.method();
    if (method !== "GET") writes.push(method + " " + apiPath);
    if (apiPath.endsWith("/stream") || apiPath === "/api/events") { await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture\n\n" }); return; }
    let body: unknown;
    if (apiPath === "/api/agents") body = { agents: [{ key: "auto", name: "Auto", role: "assistant", enabled: true, builtin: true }] };
    else if (apiPath === "/api/conversations") body = { conversations: [{ id: 201, agent_key: "auto", title: "Interface check", last_message: "Interface check completed", created_at: stamp, updated_at: stamp }] };
    else if (apiPath === "/api/conversations/201/messages") body = { items: steps, cursor: 11, running: false, hasMore: false };
    else if (/^\/api\/conversations\/201\/messages\/\d+$/.test(apiPath)) body = { detail: details.get(Number(apiPath.split("/").at(-1))) ?? "" };
    else if (apiPath === "/api/intercept/pending/901/decide") { approvalStatus = request.postDataJSON().decision; body = { ok: true }; }
    else if (apiPath === "/api/intercept/pending/901") body = { id: 901, status: approvalStatus, tool: "Bash", input: { command: "echo approved" }, rule_id: 1, created_at: stamp };
    else if (apiPath === "/api/exploration/activity") body = {items:[], cursor:22};
    else if (apiPath === "/api/exploration/main-sessions") body = {sessions:[{seq:0, created_at:stamp}],current:0};
    else if (apiPath === "/api/exploration/activity/history") { const role=url.searchParams.get("session") === "plan" ? "planner" : "mainagent"; body = {items:[{seq:21, kind:"user", summary:"View task progress", worker:role, ts:stamp, main_seg:0},{seq:22, kind:"result", summary:role === "mainagent" ? "The task is being executed and the check results have been associated." : "The plan has been updated and the execution results are awaited.", worker:role, ts:stamp, main_seg:0}],snapshot_cursor:22,earliest_cursor:21,has_more:false}; }
    else if (apiPath.endsWith("/coverage-graph")) body = { nodes: coverageNodes, edges: coverageEdges };
    else if (apiPath.endsWith("/asset-refs")) body = { intents: [{ id: 102, kind: "intent", summary: "Check interface", state: "done" }], facts: [], findings: [] };
    else if (apiPath === "/api/exploration/graph") body = { nodes: graphNodes, edges: [{ src: "100", dst: "101", rel: "spawns" }, { src: "101", dst: "102", rel: "spawns" }, { src: "102", dst: "103", rel: "yields" }, ...graphNodes.slice(4).map(n=>({src:"100",dst:n.id,rel:"spawns"}))] };
    else body = await mockHandle(method, apiPath.slice(4) + url.search, request.postData());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const font = async () => { if (process.env.QA_FONT) { await page.addStyleTag({ content: '@font-face{font-family:StudioQA;src:url("/_qa/font.ttc")}body,button,input,textarea,select,pre,code{font-family:StudioQA,Arial,sans-serif!important}' }); await page.evaluate(() => document.fonts.ready); } };
  await mkdir("/tmp/wormhole-task-header-qa", {recursive:true});
  for (const mode of ["light", "dark"]) {
    await context.addCookies([{name:"theme_mode",value:mode,url:origin}]);
    await page.goto(origin+"/function/tasks/detail?id=t-acme-web",{waitUntil:"domcontentloaded"});await font();
    const header=page.locator('.task-session-conversation-header');await header.waitFor();
    await header.locator('.task-conversation-profile').waitFor();
    assert.equal((await header.locator('.task-conversation-name strong').innerText()).trim(),"Main Agent");
    assert.equal((await header.locator('.task-conversation-name > span').innerText()).trim(),"Dialogue 1");
    assert.equal(await header.locator('.task-conversation-profile[data-slot="badge"]').count(),0);
    assert.ok(await header.locator('img').evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0));
    const action=header.getByRole('button',{name:"Bypass question",exact:true});
    assert.equal(await action.getAttribute('data-variant'),'ghost');
    assert.ok(await header.evaluate(el=>el.scrollWidth<=el.clientWidth));
    await action.click();await page.getByRole('region',{name:"Bypass question panel",exact:true}).waitFor();
    await page.getByRole('button',{name:"Close bypass panel",exact:true}).click();
    await page.getByRole('region',{name:"Bypass question panel",exact:true}).waitFor({state:'hidden'});
    await page.screenshot({path:'/tmp/wormhole-task-header-qa/header-'+mode+'.png'});
    await page.locator('.task-session-item[data-session-role="planner"] button').first().click();
    await header.locator('.task-conversation-name strong').getByText('Planner',{exact:true}).waitFor();
    await page.locator('.task-session-item[data-session-role="mainagent"] button').first().click();
  }
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/wormhole-task-header-qa/header-mobile.png'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.ok(await page.locator('.task-session-conversation-header').evaluate(el=>el.scrollWidth<=el.clientWidth));
  const action=page.locator('.task-session-conversation-header').getByRole('button',{name:"Bypass question",exact:true});await action.click();
  await page.getByRole('button',{name:"Close bypass panel",exact:true}).waitFor();
  await page.getByRole('button',{name:"Close bypass panel",exact:true}).click();
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log('task header light/dark/mobile, model text, identity, role switch and side-panel open/close PASS; zero writes/errors');
  await context.close();
} finally {await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
