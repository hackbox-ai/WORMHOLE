import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root =
		process.env.WORMHOLE_PARALLEL_QA_ROOT ??
		(() => {
			throw new Error("set WORMHOLE_PARALLEL_QA_ROOT to the isolated QA directory");
		})(),
	origin = "http://127.0.0.1:31889",
	fixture = JSON.parse(
		await readFile(root + "/evidence/ui-fixture.json", "utf8"),
	);
for (let i = 0; ; i++) {
	try {
		if ((await fetch(origin + "/api/health")).ok) break;
	} catch {}
	if (i > 120) throw new Error("isolated startup timeout");
	await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch({
	executablePath:
		"/root/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome",
	headless: true,
	args: ["--no-sandbox"],
});
try {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
	});
	await context.addInitScript(
		(token) => localStorage.setItem("wormhole_token", token),
		fixture.token,
	);
	await context.addCookies([
		{ name: "wormhole_token", value: fixture.token, url: origin },
		{ name: "theme_mode", value: "light", url: origin },
	]);
	const page = await context.newPage(),
		errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.route("**/__qa/font.ttc", (route) =>
		route.fulfill({
			contentType: "font/collection",
			path: root + "/qa-font.ttc",
		}),
	);
	const font = async () => {
		await page.addStyleTag({
			content:
				'@font-face{font-family:ParallelQA;src:url("/__qa/font.ttc")}*{font-family:ParallelQA,Arial,sans-serif!important}',
		});
		await page.evaluate(() => document.fonts.ready);
	};
	await page.goto(origin + "/function/tasks/detail/?id=" + fixture.task_id, {
		waitUntil: "networkidle",
	});
	await font();
	await page.locator(".task-progress-status").waitFor();
  await page.getByText("Automated test is executing",{exact:true}).waitFor();
  await page.getByRole("button",{name:"View execution session",exact:true}).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
	await page.screenshot({
		path: root + "/evidence/task-progress.png",
		fullPage: true,
	});
	const primary = await context.request.get(
		origin + "/api/tasks/" + fixture.task_id,
		{ headers: { authorization: "Bearer " + fixture.token } },
	);
	assert.equal(primary.status(), 200);
	const task = await primary.json();
	assert.ok(task.progress?.message);
	assert.ok(task.first_run_at);
	assert.equal(task.status, "running");
	await page.goto(origin + "/chat/", { waitUntil: "networkidle" });
	await font();
	await page
		.locator(`[data-conversation-id="${fixture.conversation_id}"] button`)
		.first()
		.click();
	const accepted = await context.request.post(
		origin + "/api/conversations/" + fixture.conversation_id + "/messages",
		{
			headers: { authorization: "Bearer " + fixture.token },
			data: { message: "Please check the current progress of the task" },
		},
	);
	assert.equal(accepted.status(), 202);
	await page.locator(".studio-transcript .stream-status").waitFor();
	await page.getByText("Waiting for model response", { exact: true }).waitFor();
	assert.equal(
		await page.locator(".studio-transcript .animate-bounce").count(),
		0,
	);
	assert.equal((await page.locator(".stream-status-track").count()) > 0, true);
	await page.screenshot({
		path: root + "/evidence/stream-status-light.png",
		fullPage: true,
	});
	await page.waitForTimeout(8500);
	await page.locator(".studio-transcript .stream-status-elapsed").waitFor();
	await page.screenshot({
		path: root + "/evidence/stream-status-waiting.png",
		fullPage: true,
	});
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await page.screenshot({
		path: root + "/evidence/stream-status-dark.png",
		fullPage: true,
	});
	await page.emulateMedia({ reducedMotion: "reduce" });
	const animation = await page
		.locator(".studio-transcript .stream-status-track > span")
		.evaluate((el) => getComputedStyle(el).animationName);
	assert.equal(animation, "none");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: root + "/evidence/stream-status-mobile.png",
		fullPage: true,
	});
	assert.ok(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
	);
	await context.request.post(
		origin + "/api/conversations/" + fixture.conversation_id + "/stop",
		{ headers: { authorization: "Bearer " + fixture.token }, data: {} },
	);
	await page
		.locator(".studio-transcript .stream-status")
		.waitFor({ state: "hidden" });
	assert.deepEqual(errors, []);
	await writeFile(
		root + "/evidence/browser-verification.json",
		JSON.stringify(
			{
				real_backend: true,
				persisted_task_progress: true,
				stream_indicator: true,
				no_bouncing_dots: true,
				waiting_elapsed: true,
				reduced_motion: true,
				mobile_no_overflow: true,
				stops_cleanly: true,
				browser_errors: errors,
			},
			null,
			2,
		),
	);
	console.log("Parallel task progress and streaming UI checks passed");
} finally {
	await browser.close();
}
