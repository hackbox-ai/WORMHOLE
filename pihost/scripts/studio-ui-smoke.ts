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
    else if (apiPath.endsWith("/coverage-graph")) body = { nodes: coverageNodes, edges: coverageEdges };
    else if (apiPath.endsWith("/asset-refs")) body = { intents: [{ id: 102, kind: "intent", summary: "Check interface", state: "done" }], facts: [], findings: [] };
    else if (apiPath === "/api/exploration/graph") body = { nodes: graphNodes, edges: [{ src: "100", dst: "101", rel: "spawns" }, { src: "101", dst: "102", rel: "spawns" }, { src: "102", dst: "103", rel: "yields" }] };
    else body = await mockHandle(method, apiPath.slice(4) + url.search, request.postData());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const font = async () => { if (process.env.QA_FONT) { await page.addStyleTag({ content: '@font-face{font-family:StudioQA;src:url("/_qa/font.ttc")}body,button,input,textarea,select,pre,code{font-family:StudioQA,Arial,sans-serif!important}' }); await page.evaluate(() => document.fonts.ready); } };
  await mkdir("/tmp/wormhole-studio-ui", { recursive: true });
  await page.goto(origin + "/chat/", { waitUntil: "networkidle" }); await font();
  await page.getByText("How can I help you?", { exact: true }).waitFor();
  const logo=page.locator('.studio-welcome img[alt="WORMHOLE"]');
  await logo.waitFor();assert.ok(await logo.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0));
  const draftInput=page.locator('textarea.studio-message-input');await draftInput.click();
  assert.equal(await draftInput.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  assert.equal(await draftInput.evaluate(el=>getComputedStyle(el).boxShadow),'none');
  await page.getByRole('button',{name:"Select model",exact:true}).click();
  await page.getByText("Select LLM configuration",{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  const welcome = await page.locator(".studio-welcome").boundingBox(), composer = await page.locator(".studio-composer-shell").boundingBox();
  assert.ok(welcome && composer && composer.y > welcome.y && composer.y < 650);
  await page.screenshot({ path: "/tmp/wormhole-studio-ui/chat-draft.png" });
  await page.locator('[data-conversation-id="201"] button').first().click();
  await page.getByText("Reason for failure logged", { exact: true }).waitFor();
  const panels = page.locator(".execution-panel"); assert.equal(await panels.count(), 2);
  assert.equal(await panels.first().getByRole("button").first().getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByText("THINKING_DETAIL_ONLY", { exact: true }).count(), 0);
  await panels.first().getByRole("button").first().click();
  const completedTool=page.locator('[data-tool-call-id="toolu_a"]');
  assert.equal(await completedTool.getAttribute('data-tool-state'),'complete');
  assert.equal((await completedTool.locator('button').innerText()).trim(),'http_request');
  assert.equal(await completedTool.locator('.lucide-wrench,.lucide-check').count(),0);
  assert.equal(await completedTool.locator('.execution-duration').count(),0);
  await panels.first().getByRole('button',{name:"Thought process",exact:true}).click();
  await panels.first().locator('.execution-thought-detail').getByText('THINKING_DETAIL_ONLY',{exact:true}).waitFor();
  assert.ok(!(await panels.first().locator('.execution-thought-detail').innerText()).includes("[Inference]"));
  await page.locator('[data-tool-call-id="toolu_a"] button').click();
  await page.locator('[data-tool-call-id="toolu_a"] pre').getByText(/FIXTURE_A_RESULT/).waitFor();
  assert.ok(!(await page.locator('[data-tool-call-id="toolu_a"] pre').innerText()).includes("FIXTURE_B_RESULT"));
  assert.equal(await panels.nth(1).getByRole("button").first().getAttribute("aria-expanded"), "true");
  assert.ok((await page.locator('[data-tool-call-id="toolu_failed"] button').innerText()).includes("Failure"));
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await page.getByText("Allowed", { exact: true }).waitFor();
  assert.deepEqual(writes, ["POST /api/intercept/pending/901/decide"]);
  await page.screenshot({ path: "/tmp/wormhole-studio-ui/chat-transcript.png" });
  console.log("centered draft, folded execution, parallel tool pairing, visible failure and approval action PASS");

  await page.goto(origin + "/function/tasks/detail?id=t-acme-web", { waitUntil: "domcontentloaded" }); await font();
  await page.getByRole("tab", { name: "Overlay view", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab").count(), 10);
  assert.equal(await page.getByRole("tablist").getAttribute("aria-orientation"), "vertical");
  const first = await page.getByRole("tab", { name: "Task dialogue", exact: true }).boundingBox(), last = await page.getByRole("tab", { name: "Mission report", exact: true }).boundingBox();
  assert.ok(first && last && Math.abs(first.x - last.x) < 1 && last.y > first.y + 200);
  await page.getByRole("tab", {name: "Task dialogue", exact: true}).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("tab", {name: "Mission Overview", exact: true}).and(page.locator('[data-state="active"]')).waitFor();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Recovery", exact: true }).waitFor();
  assert.ok(writes.includes("POST /api/tasks/t-acme-web/control"));
  console.log("ten vertical task views and original task pause control PASS");
  await page.getByRole("tab", { name: "Execution path", exact: true }).click();
  await page.locator('[data-path-node-id="100"]').waitFor();
  await page.getByRole("button",{name:"Full picture",exact:true}).click();
  await page.locator('[data-path-node-id="102"]').waitFor();
  const card = page.locator('[data-path-node-id="102"]');
  assert.ok((await card.innerText()).includes("Check login interface")); assert.ok((await card.innerText()).includes("Worker #3"));
  assert.ok(!(await card.innerText()).includes('"summary"'));
  assert.ok(!(await page.locator('[data-path-node-id="103"]').innerText()).includes("KEEP_RAW_ONLY"));
  assert.equal(await page.locator(".react-flow__background").getAttribute("data-variant"), null); // Pattern verified below via line elements.
  assert.ok(await page.locator(".react-flow__background pattern path").count() > 0);
  await card.click(); await page.getByText("Content summary", { exact: true }).waitFor();
  assert.ok((await page.getByRole("dialog").innerText()).includes("https://example.test/api/login"));
  assert.equal(await page.getByRole("dialog").locator("details").getAttribute("open"), null);
  await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({state:"hidden"}); await page.screenshot({ path: "/tmp/wormhole-studio-ui/task-path.png" });
  console.log("neutral square grid, structured node fields and secondary raw details PASS");

  await page.getByRole("tab", { name: "Overlay view", exact: true }).click();
  await page.locator('[data-coverage-layout="tree"]').waitFor();
  await page.getByRole("button", { name: "Return to top of asset tree", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/wormhole-studio-ui/task-assets-initial.png" });
  // Deterministic canonical parent is alias.test; example.test remains an alternate relation.
  await page.getByRole("button", { name: "Expand alias.test", exact: true }).click();
  await page.getByRole("button", { name: "Expand 192.0.2.10", exact: true }).waitFor();
  await page.getByRole("button", { name: "Collapse alias.test", exact: true }).click();
  await page.getByRole("button", { name: "Expand 192.0.2.10", exact: true }).waitFor({state: "hidden"});
  await page.getByRole("button", { name: "Expand alias.test", exact: true }).click();
  await page.getByRole("button", { name: "Expand 192.0.2.10", exact: true }).click();
  await page.getByRole("button", { name: "Expand HTTPS:443", exact: true }).click();
  await page.getByRole("button", { name: "Showing more assets, 5 remaining", exact: true }).waitFor();
  await page.getByRole("button", { name: "Showing more assets, 5 remaining", exact: true }).click();
  await page.getByRole("button", { name: "Showing more assets, 5 remaining", exact: true }).waitFor({state: "hidden"});
  await page.getByRole("textbox", { name: "Search asset hierarchy" }).fill("192.0.2.10");
  await page.getByRole("button", { name: "192.0.2.10", exact: true }).click();
  await page.getByText("Related assets (3)", { exact: true }).waitFor();
  assert.ok((await page.getByRole("dialog").innerText()).includes("alias.test"));
  assert.ok((await page.getByRole("dialog").innerText()).includes("example.test"));
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Search asset hierarchy" }).fill("api/24");
  await page.getByRole("button", { name: "https://example.test/api/24", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Search asset hierarchy" }).fill("api/23");
  await page.getByRole("checkbox", { name: "View only not covered" }).check();
  await page.getByRole("button", { name: "https://example.test/api/23", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/wormhole-studio-ui/task-assets.png" });
  console.log("tree expand/collapse, show-more, search, pending filter and alternate relationship drawer PASS");

  for (const name of ["Mission Overview", "Real-time dynamics", "Vulnerability discovery", "Retest verification", "Asset List", "Execute Approval", "Mission report", "Task dialogue"]) {
    await page.getByRole("tab", { name: new RegExp("^" + name) }).click();
    await page.getByRole("tabpanel", {name: new RegExp("^" + name)}).waitFor();
    if (name === "Asset List") {
      const assets = page.getByRole("tabpanel", {name:"Asset List"});
      const list = assets.getByRole("tablist");
      assert.equal(await list.getAttribute("aria-orientation"), "horizontal");
      assert.equal(await list.evaluate(el=>getComputedStyle(el).flexDirection), "row");
      const types=assets.getByRole("tab"), boxes=await types.evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y};}));
      assert.equal(boxes.length,6);
      assert.ok(boxes.every(b=>Math.abs(b.y-boxes[0].y)<1));
      assert.ok(boxes[5].x>boxes[0].x+250);
      for(const type of ["IP","Subdomain name","Application","Service","Interface","Root domain name"]){
        await assets.getByRole("tab",{name:new RegExp("^"+type)}).click();
        await assets.getByRole("tabpanel",{name:new RegExp("^"+type)}).waitFor();
      }
      await page.screenshot({path:"/tmp/wormhole-studio-ui/task-assets-list.png"});
      console.log("nested asset types horizontal, six categories switch, outer task navigation vertical PASS");
    }
  }
  await page.screenshot({ path: "/tmp/wormhole-studio-ui/task-sessions.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "Task View" }).selectOption("graph");
  await page.locator(".path-canvas").waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("combobox", { name: "Task View" }).selectOption("coverage");
  await page.locator('[data-coverage-layout="tree"]').waitFor();
  await page.getByRole("button", { name: "Expand alias.test", exact: true }).waitFor();
  assert.ok(await page.locator('.coverage-tree-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth));
  await page.screenshot({ path: "/tmp/wormhole-studio-ui/task-mobile.png" });
  await page.goto(origin + "/chat/", { waitUntil: "networkidle" }); await font();
  await page.getByRole("button", { name: "Recent conversations", exact: true }).click();
  await page.locator('[data-conversation-id="201"] button').first().click();
  await page.getByText("Reason for failure logged", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Recent conversations", exact: true }).getAttribute("aria-expanded"), "false");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1));
  assert.deepEqual(errors, []);
  console.log("all task views mount, mobile history and task navigation, no page errors PASS");
  await context.close();
} finally { await browser.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
