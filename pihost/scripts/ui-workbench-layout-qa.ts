/** Browser fixtures for the redesigned workspace. Every API call is intercepted;
 * tool execution, approvals and task controls never reach a real backend. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { mockHandle } from "../../web/src/lib/mock/handler.ts";
import { collapseBranches, runningNeighborhood } from "../../web/src/lib/exploration-view.ts";

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
  await context.addCookies([{ name: "wormhole_token", value: token, url: origin }]);
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
  let approvalStatus = "pending";
  const goals = [{id:"goal-fixture",text:"Verify test interface authorization boundaries",state:"open",vulnclass:""}];
  const markdown = "# Test task report\n\n## Executive Summary\n\nAuthorization boundary checking of test interface completed.\n\n## Reproduction steps\n\n1. Use the test account to request the interface.\n2. Compare responses and negative examples.\n\n```text\n# NOT_A_HEADING\n```\n\n## Evidence\n\nThe request and response have been associated with a discovery record.";
  const qaFile={path:"summary.md",size:200,content:"# Task summary\nCheck completed.",binary:false,too_large:false};
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), apiPath = url.pathname, method = request.method();
    if (method !== "GET") writes.push(method + " " + apiPath);
    if (apiPath.endsWith("/stream") || apiPath === "/api/events") { await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture\n\n" }); return; }
    if (apiPath === "/api/report") {await route.fulfill({contentType:"text/markdown",body:markdown});return;}
    if (apiPath === "/api/workspace/list") {await route.fulfill({json:{path:"",entries:[{path:"summary.md",name:"summary.md",size:200,dir:false,mtime:Date.now()}]}});return;}
    if (apiPath === "/api/workspace/read") {await route.fulfill({json:qaFile});return;}
    if (apiPath.endsWith("/goals")) {
      if(method==="POST") {const input=request.postDataJSON();goals.push({id:"goal-added",text:input.text,state:"open",vulnclass:input.vulnclass});}
      await route.fulfill({json:method==="GET"?{goals}:goals.at(-1)});return;
    }
    if (apiPath === "/api/exploration/activity/history") {const worker=url.searchParams.get('session')?.startsWith('main')?'mainagent':'planner';await route.fulfill({json:{items:steps.map(step=>({...step,worker})),snapshot_cursor:11,earliest_cursor:1,has_more:false}});return;}
    if (/^\/api\/exploration\/activity\/\d+$/.test(apiPath)) {await route.fulfill({json:{detail:details.get(Number(apiPath.split('/').at(-1)))??''}});return;}
    if (apiPath === "/api/exploration/findings/qa-report") {await route.fulfill({json:{id:"qa-report",task_id:"t-acme-web",name:"Controlled Report Discovery",severity:"medium",status:"pending",summary:"Test interface evidence confirmed",evidence:"GET /api/exports\nHTTP 200",report:markdown,created_at:stamp,updated_at:stamp,ts:stamp,vulnclass:"Permission check"}});return;}
    if(apiPath === "/api/exploration/findings/qa-report/retests") {await route.fulfill({json:{retests:[]}});return;}
    if(apiPath === "/api/exploration/findings/qa-report/traffic") {await route.fulfill({json:{bindings:[],version:1,finding_id:"qa-report"}});return;}
    let body: unknown;
    if (apiPath === "/api/agents") body = { agents: [{ key: "auto", name: "Auto", role: "assistant", enabled: true, builtin: true }] };
    else if (apiPath === "/api/conversations") body = { conversations: [{ id: 201, agent_key: "auto", title: "Interface check", last_message: "Interface check completed", created_at: stamp, updated_at: stamp }] };
    else if (apiPath === "/api/conversations/201/messages") body = { items: steps, cursor: 11, running: false, hasMore: false };
    else if (/^\/api\/conversations\/201\/messages\/\d+$/.test(apiPath)) body = { detail: details.get(Number(apiPath.split("/").at(-1))) ?? "" };
    else if (apiPath === "/api/intercept/pending/901/decide") { approvalStatus = request.postDataJSON().decision; body = { ok: true }; }
    else if (apiPath === "/api/intercept/pending/901") body = { id: 901, status: approvalStatus, tool: "Bash", input: { command: "echo approved" }, rule_id: 1, created_at: stamp };
    else if (apiPath.endsWith("/coverage-graph")) body = { nodes: coverageNodes, edges: coverageEdges };
    else if (apiPath.endsWith("/asset-refs")) body = { intents: [{ id: 102, kind: "intent", summary: "Check interface", state: "done" }], facts: [], findings: [] };
    else if (apiPath === "/api/exploration/graph") body = { nodes: graphNodes, edges: [{ src: "100", dst: "101", rel: "spawns" }, { src: "101", dst: "102", rel: "spawns" }, { src: "102", dst: "103", rel: "yields" }] };
    else body = await mockHandle(method, apiPath.slice(4) + url.search, request.postData());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const font = async () => { if (process.env.QA_FONT) { await page.addStyleTag({ content: '@font-face{font-family:StudioQA;src:url("/_qa/font.ttc")}body,button,input,textarea,select,pre,code{font-family:StudioQA,Arial,sans-serif!important}' }); await page.evaluate(() => document.fonts.ready); } };

  await mkdir("/tmp/wormhole-workbench-ui", {recursive:true});
  const go=async (url:string)=>{await page.goto(origin+url,{waitUntil:"domcontentloaded"});await page.waitForTimeout(350);await font();};
  const fit=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"page has horizontal overflow");
  const shot=async(name:string)=>page.screenshot({path:"/tmp/wormhole-workbench-ui/"+name+".png"});
  const dummy=(id:string)=>({id,type:"fact",state:"confirmed",payload:"{}"});
  const shared=collapseBranches([dummy("a"),dummy("b"),dummy("c"),dummy("d")] as any,[{src:"a",dst:"b"},{src:"b",dst:"c"},{src:"d",dst:"c"}] as any,new Set(["a"]));
  assert.deepEqual(shared.nodes.map(x=>x.id),["a","c","d"]);
  assert.deepEqual(collapseBranches([dummy("a"),dummy("b"),dummy("c"),dummy("d")] as any,[{src:"a",dst:"b"},{src:"b",dst:"c"},{src:"d",dst:"c"}] as any,new Set(["a","d"])).nodes.map(node=>node.id),["a","d"]);
  const cycle=collapseBranches([dummy("a"),dummy("b")] as any,[{src:"a",dst:"b"},{src:"b",dst:"a"}] as any,new Set(["a"]));
  assert.deepEqual(cycle.nodes.map(x=>x.id),["a"]);
  assert.equal(runningNeighborhood([dummy("a")] as any,[]).nodes.length,1);
  console.log("branch collapse shared-parent/cycle and empty-running fallback PASS");

  await go("/function/tasks/detail/?id=t-acme-web");
  await page.getByRole("button",{name:"Switch task session"}).waitFor();
  assert.equal(await page.locator('.task-session-history:visible').count(),0);
  await page.getByRole("button",{name:"Switch task session"}).click();
  await page.getByRole("dialog").getByRole("heading",{name:"Participate in conversation"}).waitFor();
  assert.ok(await page.locator('.task-session-picker .task-session-select').count()>0);
  await page.locator('.task-session-picker .task-session-select').first().click();
  await page.getByRole("dialog").waitFor({state:"hidden"});
  assert.ok((await page.locator('.task-session-conversation').boundingBox())!.width>900);
  await page.getByText("Reason for failure logged",{exact:true}).waitFor();
  await page.locator('.execution-panel').first().getByRole('button').first().click();
  await page.locator('[data-tool-call-id="toolu_a"] button').click();await page.getByText('FIXTURE_A_RESULT',{exact:false}).waitFor();
  await shot("task-conversation");
  await page.getByRole("tab",{name:"Mission Overview",exact:true}).click();
  await page.getByText("Verify test interface authorization boundaries",{exact:true}).waitFor();
  assert.equal(await page.locator('.overview-metrics > div').count(),4);
  const goalsBox=await page.locator('.overview-goals').boundingBox(),runBox=await page.locator('.overview-run').boundingBox();
  assert.ok(goalsBox&&runBox&&Math.abs(goalsBox.y-runBox.y)<2&&runBox.x>goalsBox.x+goalsBox.width);
  await page.getByText("Add target",{exact:true}).click();
  await page.getByPlaceholder("Add new goals, such as \"obtain unauthorized access to the administrator account\"").fill("Complete evidence and negative examples");
  await page.locator('.overview-goals').getByRole("button",{name:"Add",exact:true}).click();
  await page.getByText("Complete evidence and negative examples",{exact:true}).waitFor();
  assert.ok(writes.some(x=>x.endsWith('/goals')));
  await shot("task-overview");
  await page.getByRole("tab",{name:"Execution path",exact:true}).click();
  await page.getByRole("button",{name:"Full picture",exact:true}).click();
  await page.locator('[data-path-node-id="101"]').waitFor();
  await page.getByRole("button",{name:"Collapse branch of node 101",exact:true}).click();
  await page.getByText(/2 visible nodes/).waitFor();
  await page.getByRole("button",{name:"Expand branch",exact:true}).click();
  await page.getByText(/4 visible nodes/).waitFor();
  await page.getByRole("button",{name:"Executing",exact:true}).click();
  assert.equal(await page.getByRole("button",{name:"Executing",exact:true}).getAttribute("aria-pressed"),"true");
  await shot("task-path");
  await page.getByRole("button",{name:"Node index",exact:true}).click();
  await page.getByRole("textbox",{name:"Search execution node"}).fill("Check login");
  assert.equal(await page.locator('.path-index-item').count(),1);
  await page.locator('.path-index-item').getByRole("button",{name:/View node/}).click();
  await page.getByRole("dialog").waitFor();await page.keyboard.press("Escape");
  await page.getByRole("tab",{name:"Mission report",exact:true}).click();
  await page.locator('.document-prose').getByRole("heading",{name:"Reproduction steps",exact:true}).waitFor();
  assert.equal(await page.locator('.document-outline button').count(),4);
  assert.equal(await page.locator('.document-outline').getByText('NOT_A_HEADING').count(),0);
  await page.locator('.document-outline').getByRole("button",{name:"Evidence",exact:true}).click();
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"Export",exact:true}).click();assert.ok((await download).suggestedFilename().endsWith('.md'));
  await shot("task-report");
  for(const name of ["Real-time dynamics","Vulnerability discovery","Retest verification","Asset List","Overlay view","Execute Approval"]){await page.getByRole("tab",{name:new RegExp('^'+name)}).click();await page.getByRole("tabpanel",{name:new RegExp('^'+name)}).waitFor();await fit();}
  console.log("task session picker, overview editing, graph collapse/focus/index, report TOC/export and ten views PASS");

  for(const route of ["dashboard","chat","function/tasks","function/findings","function/assets","function/traffic","function/commands","function/llm-records","function/workspace"]){
    await go('/'+route+'/');await fit();
    if(route!=='chat')assert.equal(await page.locator('[data-slot="card"]:visible').count(),0,route+' still has generic cards');
    await shot(route.replaceAll('/','-'));
  }
  await page.getByRole("button",{name:"summary.md",exact:true}).click();
  await page.locator('.workspace-file-preview textarea').waitFor();
  const editor=page.locator('.workspace-file-preview textarea');await editor.fill("# Rewritten task summary");
  const write=page.waitForRequest(r=>r.method()!=="GET"&&new URL(r.url()).pathname==='/api/workspace/write');
  await page.getByRole("button",{name:"Save",exact:true}).click();await write;
  await page.getByText("Synced",{exact:true}).waitFor();
  await editor.fill("# Content not saved");page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole("button",{name:"Turn off file preview",exact:true}).click();assert.equal(await editor.count(),1);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole("button",{name:"Turn off file preview",exact:true}).click();await page.getByText("Select file to view content",{exact:true}).waitFor();
  console.log("workspace inline preview/save/unsaved guard PASS");
  await go('/function/llm-records/');await page.locator('tbody tr').first().click();
  await page.getByRole("dialog").getByRole("heading",{name:"Model call details"}).waitFor();
  await page.getByRole("dialog").getByRole("button",{name:"Original text",exact:true}).waitFor();await page.keyboard.press("Escape");
  await go('/function/commands/');await page.locator('tbody tr').first().click();await page.getByRole("dialog").getByRole("heading",{name:"Tool execution details"}).waitFor();await page.keyboard.press("Escape");
  await go('/function/traffic/');await page.locator('tbody tr').first().click();await page.getByRole("complementary",{name:"Traffic details"}).getByRole("tab",{name:"Response Response",exact:true}).click();await page.getByRole("button",{name:"Turn off traffic details",exact:true}).click();
  console.log("trace/tool/traffic list-to-detail interactions PASS");
  await go('/function/findings/detail/?id=qa-report');
  await page.locator('.document-prose').getByRole('heading',{name:"Reproduction steps",exact:true}).waitFor();
  assert.equal(await page.locator('[data-slot="card"]:visible').count(),0);
  await fit();await shot('finding-report');
  await page.setViewportSize({width:390,height:844});
  for(const route of ["dashboard","chat","function/tasks","function/findings","function/assets","function/traffic","function/commands","function/llm-records","function/workspace"]){await go('/'+route+'/');await fit();}
  await go('/function/tasks/detail/?id=t-acme-web');
  for(const name of ['overview','sessions','graph','broadcast','findings','retests','assets','coverage','intercept','report']){await page.getByRole("combobox",{name:"Task View"}).selectOption(name);await page.waitForTimeout(150);await fit();}
  await shot("task-report-mobile");
  await page.getByRole("combobox",{name:"Task View"}).selectOption('sessions');await page.getByRole("button",{name:"Switch task session"}).click();await page.getByRole("dialog").waitFor();await fit();await page.keyboard.press("Escape");
  await page.setViewportSize({width:1440,height:900});
  await context.addCookies([{name:"theme_mode",value:"light",url:origin}]);
  for (const [url,name] of [["/function/tasks/detail/?id=t-acme-web","task-overview-light"],["/dashboard/","dashboard-light"]]) {
    await go(url);
    assert.ok(await page.evaluate(()=>document.documentElement.style.colorScheme==='light'&&!document.documentElement.classList.contains('dark')));
    if(url.includes('detail')){await page.getByRole('tab',{name:"Mission Overview",exact:true}).click();await page.getByText("Verify test interface authorization boundaries",{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.overview-brief p')?.textContent?.includes('acme.com'));}
    else await page.waitForFunction(()=>Array.from(document.querySelectorAll('.dashboard-metric-value')).some(el=>Number.parseFloat(el.textContent||'0')>0));
    await fit();await shot(name);
  }
  assert.deepEqual(errors,[]);console.log("9 workbench pages + 10 task views mobile layout; zero page errors PASS");
  console.log(JSON.stringify({writes,errors}));await context.close();
} finally {await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
