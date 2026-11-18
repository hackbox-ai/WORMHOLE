/** Settings navigation and preference acceptance using exported UI fixtures.
 * All API requests are intercepted. No live task, password or account is changed. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { mockHandle } from "../../web/src/lib/mock/handler.ts";

const root = path.resolve("../web/out");
const evidence = process.env.QA_OUTPUT ?? "/tmp/wormhole-settings-ui";
await mkdir(evidence, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, "http://fixture");
    if (url.pathname === "/_qa/font.ttc" && process.env.QA_FONT) {
      response.setHeader("Content-Type", "font/collection");
      response.end(await readFile(process.env.QA_FONT));
      return;
    }
    const resolved = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    for (const file of [resolved, resolved + ".html", path.join(resolved, "index.html")]) {
      try { if (!(await stat(file)).isFile()) continue; } catch { continue; }
      const types: Record<string, string> = { ".html": "text/html", ".txt": "text/plain; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
      response.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
      response.end(await readFile(file)); return;
    }
    response.writeHead(404).end();
  } catch { response.writeHead(500).end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/root/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome", args: ["--no-sandbox"], headless: true });
const passed: string[] = [];
const pass = (name: string) => { passed.push(name); console.log(name + " PASS"); };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const token = "e30." + Buffer.from(JSON.stringify({ sub: "WORMHOLE", exp: Date.now() / 1000 + 600 })).toString("base64url") + ".fixture";
  await context.addInitScript(value => {
    if (!localStorage.getItem("qa_settings_seeded")) {
      localStorage.setItem("wormhole_token", value); localStorage.setItem("qa_settings_seeded", "1");
    }
  }, token);
  await context.addCookies([{ name: "wormhole_token", value: token, url: origin }]);
  const page = await context.newPage(), errors: string[] = [], mutations: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let running = true;
  const stamp = "2026-10-13T10:00:00Z";
  await context.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), apiPath = url.pathname, method = request.method();
    if (method !== "GET") mutations.push(method + " " + apiPath);
    if (apiPath.endsWith("/stream") || apiPath === "/api/events") { await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture\n\n" }); return; }
    let body: unknown;
    if (apiPath === "/api/auth/status") body = { initialized: true };
    else if (apiPath === "/api/agents") body = { agents: [{ key: "auto", name: "Auto", builtin: true, enabled: true }] };
    else if (apiPath === "/api/conversations") body = { conversations: [{ id: 201, agent_key: "auto", title: "Running interface verification", running, created_at: stamp, updated_at: stamp }] };
    else if (apiPath === "/api/conversations/201/messages") body = { items: [{ seq: running ? 1 : 2, kind: "result", summary: running ? "SETTINGS_RUN_BEFORE" : "SETTINGS_RUN_AFTER", ts: stamp }], cursor: running ? 1 : 2, running, hasMore: false };
    else if (/^\/api\/conversations\/201\/messages\/\d+$/.test(apiPath)) body = { detail: running ? "SETTINGS_RUN_BEFORE" : "SETTINGS_RUN_AFTER" };
    else if (apiPath === "/api/intercept/pending") body = [];
    else body = await mockHandle(method, apiPath.slice(4) + url.search, request.postData());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const font = async () => {
    if (!process.env.QA_FONT) return;
    await page.addStyleTag({ content: '@font-face{font-family:SettingsQA;src:url("/_qa/font.ttc")}body,button,input,textarea,select{font-family:SettingsQA,Arial,sans-serif!important}' });
    await page.evaluate(() => document.fonts.ready);
  };
  const sidebar = () => page.locator('[data-slot="sidebar-inner"]');
  const navLink = (route: string) => sidebar().locator(`a:is([href="${route}"],[href="${route}/"])`);
  await page.goto(origin + "/chat/", { waitUntil: "networkidle" }); await font();
  await page.locator('[data-conversation-id="201"]').waitFor();
  assert.equal(await sidebar().locator('a[href^="/system/"]').count(), 0);
  assert.equal(await sidebar().locator('[data-slot="sidebar-content"] a').count(), 9);
  assert.equal(await page.locator("header.app-topbar").count(), 0);
  assert.equal(await page.locator('[data-slot="sidebar-trigger"]').count(), 1);
  assert.equal(await sidebar().locator('[data-slot="sidebar-group-label"]').count(), 0);
  assert.equal(await sidebar().getByRole("button", { name: "Settings", exact: true }).count(), 1);
  await page.screenshot({ path: path.join(evidence, "workbench.png") });
  pass("default workbench only; no group captions or global title bar; one sidebar trigger and bottom gear");

  await page.locator('[data-conversation-id="201"] button').first().click();
  await page.getByText("SETTINGS_RUN_BEFORE", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("c"), "201");
  await page.evaluate(() => { (window as any).__settingsNavigationMarker = "same-document"; });
  await sidebar().getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  assert.equal(await sidebar().locator('[data-slot="sidebar-content"] a').count(), 13);
  assert.equal(await sidebar().locator('[data-slot="sidebar-group-label"]').count(), 0);
  assert.equal(await navLink("/chat").count(), 0);
  assert.equal(await sidebar().getByRole("button", { name: "Settings", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await navLink("/system/appearance").getAttribute("data-active"), "true");
  assert.equal(await page.evaluate(() => (window as any).__settingsNavigationMarker), "same-document");
  await font(); await page.screenshot({ path: path.join(evidence, "appearance.png") });
  pass("first settings visit opens appearance; grouped settings directory; client navigation and active state");

  await page.getByLabel("light color", { exact: true }).click();
  await page.getByLabel("Dark color", { exact: true }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  assert.equal((await context.cookies()).find(cookie => cookie.name === "theme_mode")?.value, "dark");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await page.getByLabel("light color", { exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await page.getByLabel("Follow the system", { exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await page.getByLabel("Center", { exact: true }).click();
  await page.getByLabel("Covered", { exact: true }).click();
  assert.equal((await context.cookies()).find(cookie => cookie.name === "content_layout")?.value, "full-width");
  await page.getByLabel("Scroll with the page", { exact: true }).click();
  assert.equal((await context.cookies()).find(cookie => cookie.name === "navbar_style")?.value, "scroll");
  await page.getByLabel("Welt", { exact: true }).click();
  assert.equal(await page.locator('[data-slot="sidebar"][data-state]').getAttribute("data-variant"), "sidebar");
  await page.getByRole("combobox").first().click(); await page.getByRole("option", { name: "Soft", exact: true }).click();
  assert.equal((await context.cookies()).find(cookie => cookie.name === "theme_preset")?.value, "soft-pop");
  await page.getByRole("combobox").nth(1).click(); await page.getByRole("option", { name: "Inter", exact: true }).click();
  assert.equal((await context.cookies()).find(cookie => cookie.name === "font")?.value, "inter");
  await page.getByLabel("Keep icon", { exact: true }).click();
  assert.equal((await context.cookies()).find(cookie => cookie.name === "sidebar_collapsible")?.value, "icon");
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await sidebar().getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("SETTINGS_RUN_BEFORE", { exact: true }).waitFor();
  await sidebar().getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await page.getByRole("button", { name: "Restore default appearance", exact: true }).click();
  pass("seven appearance preferences persist; light/dark/system; collapsed gear and restore defaults");

  const settingsRoutes = [
    ["/system/llm", "LLM"], ["/system/agents", "Agent"], ["/system/mcp", "MCP"], ["/system/skills", "Skill"], ["/system/tools", "Tool Configuration"],
    ["/system/notify", "Notice"], ["/system/intercept", "Interception Rules"], ["/system/intercept/assets", "Asset Interception"], ["/system/intercept/approvals", "Approval record"], ["/system/logs", "Log"], ["/system/settings", "System configuration"],
  ];
  for (const [route, title] of settingsRoutes) {
    await navLink(route).click();
    try { await page.getByRole("heading", { name: title, exact: true }).first().waitFor(); }
    catch (error) {
      await page.screenshot({ path: path.join(evidence, "route-failure.png") });
      console.log("failed route", route, "url", page.url(), "headings", await page.getByRole("heading").allTextContents(), "browser errors", errors);
      throw error;
    }
    assert.equal(new URL(page.url()).pathname.replace(/\/$/, ""), route);
    assert.equal(await page.locator("header.app-topbar").count(), 0);
    assert.equal(await page.locator('[data-slot="sidebar-trigger"]').count(), 1);
    if (title === "Interception Rules" || title === "Asset Interception") {
      const heading = page.locator(".workspace-heading");
      assert.equal(await heading.locator(".workspace-heading-icon svg").count(), 1);
      assert.equal(await heading.locator("..").locator(":scope > svg").count(), 0);
    }
    assert.equal(await navLink(route).getAttribute("data-active"), "true");
  }
  pass("all eleven existing configuration pages remain accessible and correctly selected");

  await navLink("/system/account").click();
  await page.getByRole("heading", { name: "Account", exact: true }).waitFor();
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.getByLabel("Current password", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  running = false;
  await sidebar().getByRole("button", { name: "Return to workbench", exact: true }).click();
  await page.getByText("SETTINGS_RUN_AFTER", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("c"), "201");
  await sidebar().getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Account", exact: true }).waitFor();
  pass("account password dialog preserved; running chat resumes projection; last setting and original conversation restored");

  await page.goto(origin + "/system/mcp/", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "MCP", exact: true }).waitFor();
  assert.equal(await sidebar().getByRole("button", { name: "Return to workbench", exact: true }).count(), 1);
  await sidebar().getByRole("button", { name: "Return to workbench", exact: true }).click();
  await page.getByText("SETTINGS_RUN_AFTER", { exact: true }).waitFor();
  await page.goBack(); await page.getByRole("heading", { name: "MCP", exact: true }).waitFor();
  await page.goForward(); await page.getByText("SETTINGS_RUN_AFTER", { exact: true }).waitFor();
  pass("direct settings URL, reload and browser back/forward keep the correct sidebar mode");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-slot="sidebar-trigger"]').click();
  const mobileSidebar = page.locator('[data-slot="sidebar"][data-mobile="true"]');
  await mobileSidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "MCP", exact: true }).waitFor();
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await mobileSidebar.locator('a:is([href="/system/appearance"],[href="/system/appearance/"])').click();
  await page.waitForFunction(() => !document.querySelector('[data-slot="sidebar"][data-mobile="true"]'));
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await font(); await page.screenshot({ path: path.join(evidence, "appearance-mobile.png") });
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await mobileSidebar.getByRole("button", { name: "Return to workbench", exact: true }).click();
  await page.getByText("SETTINGS_RUN_AFTER", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  pass("mobile gear, settings directory, page selection and return; no horizontal overflow");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => sessionStorage.setItem("wormhole.navigation.settings", "//malicious.test/"));
  await sidebar().getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  await page.evaluate(() => sessionStorage.setItem("wormhole.navigation.workbench", "https://malicious.test/"));
  await sidebar().getByRole("button", { name: "Return to workbench", exact: true }).click();
  await page.getByText("SETTINGS_RUN_AFTER", { exact: true }).waitFor();
  assert.ok(page.url().startsWith(origin));
  assert.deepEqual(mutations, []);
  pass("stored return URLs validated; switching never sends cancel or mutation requests");

  await sidebar().getByRole("button", { name: "Settings", exact: true }).click();
  await navLink("/system/account").click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.waitForURL(/\/login\/?$/);
  assert.equal(await page.evaluate(() => localStorage.getItem("wormhole_token")), null);
  assert.equal((await context.cookies()).find(cookie => cookie.name === "wormhole_token"), undefined);
  assert.deepEqual(errors, []);
  pass("logout clears token and cookie; no browser runtime errors");
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ passed, browserErrors: errors, mutations }, null, 2));
  await context.close();
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
