import assert from "node:assert/strict";
import { readFile, writeFile, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
const root =
		process.env.WORMHOLE_WORKSPACE_QA_ROOT ??
		(() => {
			throw new Error("set WORMHOLE_WORKSPACE_QA_ROOT to the isolated QA directory");
		})(),
	fixture = JSON.parse(
		await readFile(root + "/evidence/ui-fixture.json", "utf8"),
	),
	origin = "http://127.0.0.1:31889";
for (let attempt = 0; ; attempt++) {
	try {
		const r = await fetch(origin + "/api/health");
		if (r.ok) break;
	} catch {}
	if (attempt >= 120) throw new Error("isolated UI startup timeout");
	await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch({
	executablePath:
		"/root/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome",
	headless: true,
	args: ["--no-sandbox"],
});
const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		reducedMotion: "reduce",
	}),
	errors: string[] = [];
await context.addInitScript(
	(token) => localStorage.setItem("wormhole_token", token),
	fixture.token,
);
await context.addCookies([
	{ name: "wormhole_token", value: fixture.token, url: origin },
	{ name: "theme_mode", value: "light", url: origin },
]);
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/__qa/font.ttc", (route) =>
	route.fulfill({
		contentType: "font/collection",
		path: root + "/qa-font.ttc",
	}),
);
const exists = async (file: string) => !!(await lstat(file).catch(() => null));
const request = async (route: string, method = "GET", body?: unknown) =>
	context.request.fetch(origin + "/api/workspace/" + route, {
		method,
		headers: { authorization: "Bearer " + fixture.token },
		...(body ? { data: body } : {}),
	});
async function font() {
	await page.addStyleTag({
		content:
			'@font-face{font-family:WorkspaceQA;src:url("/__qa/font.ttc")}*{font-family:WorkspaceQA,Arial,sans-serif!important}',
	});
	await page.evaluate(() => document.fonts.ready);
}
async function dialog() {
	const d = page.getByRole("dialog").filter({
		has: page.getByRole("heading", { name: "Clean preview", exact: true }),
	});
	await d.waitFor();
	return d;
}
async function screenshot(name: string) {
	await page.screenshot({
		path: root + "/evidence/" + name + ".png",
		fullPage: true,
	});
}
try {
	await page.goto(origin + "/function/workspace/", {
		waitUntil: "networkidle",
	});
	await font();
	const legal = page.getByRole("dialog").filter({ hasText: "Disclaimer" });
	if (await legal.isVisible().catch(() => false)) {
		const check = legal.getByRole("checkbox");
		if (await check.count()) await check.check();
		const accept = legal.getByRole("button", { name: /同意|接受|确认/ }).last();
		await accept.click();
	}
	await page.getByRole("tab", { name: "Task product", exact: true }).waitFor();
	const ended = page
			.getByRole("row")
			.filter({ hasText: "Authorized demo site · Completed" }),
		active = page.getByRole("row").filter({ hasText: "Authorized demo site · To be continued" }),
		failed = page.getByRole("row").filter({ hasText: "Authorization demo site · Timed out" });
	await ended.waitFor();
	assert.equal(
		await active
			.getByRole("button", { name: "Cleanup", exact: true })
			.isDisabled(),
		true,
	);
	const initial = await (await request("tasks")).json();
	const first = initial.tasks.find((t: any) => t.task_id === fixture.ended.id);
	assert.equal(first.file_count, 5);
	assert.ok(first.disk_bytes > 100000);
	await screenshot("workspace-products");
	await ended.getByRole("button", { name: "Cleanup", exact: true }).click();
	let preview = await dialog();
	await preview.getByText("Reserved: Discovery or report citation", { exact: true }).waitFor();
	assert.equal(
		await preview.getByRole("cell", { name: "Delete", exact: true }).count(),
		2,
	);
	await screenshot("workspace-cleanup-preview");
	await preview.getByRole("button", { name: "Cancel", exact: true }).click();
	assert.ok(await exists(fixture.ended.dir + "/tmp/scan-cache.txt"));
	await ended.getByRole("button", { name: "File", exact: true }).click();
	await page.getByRole("button", { name: "i100", exact: true }).click();
	await page
		.getByRole("checkbox", { name: "Select response.txt", exact: true })
		.check();
	await page.getByRole("button", { name: /清理所选/ }).click();
	preview = await dialog();
	assert.equal(
		await preview.getByRole("cell", { name: "Delete", exact: true }).count(),
		1,
	);
	await preview.getByRole("button", { name: "Confirm deletion", exact: true }).click();
	await preview.waitFor({ state: "hidden" });
	assert.equal(await exists(fixture.ended.dir + "/i100/response.txt"), false);
	await page.getByRole("tab", { name: "Task product", exact: true }).click();
	await ended.waitFor();
	await ended.getByRole("checkbox").check();
	await failed.getByRole("checkbox").check();
	await page.getByRole("button", { name: /清理所选/ }).click();
	preview = await dialog();
	assert.equal(
		await preview.getByRole("cell", { name: "Delete", exact: true }).count(),
		2,
	);
	await preview.getByRole("button", { name: "Confirm deletion", exact: true }).click();
	await preview.waitFor({ state: "hidden" });
	assert.equal(await exists(fixture.ended.dir + "/tmp/scan-cache.txt"), false);
	for (const name of [
		"reproduce.py",
		"uploads/scope.txt",
		"evidence/proof.txt",
	])
		assert.ok(await exists(fixture.ended.dir + "/" + name), name);
	assert.ok(await exists(fixture.active.dir + "/worker-output.txt"));
	const refreshed = await (await request("tasks")).json();
	assert.equal(
		refreshed.tasks.find((t: any) => t.task_id === fixture.ended.id).file_count,
		3,
	);
	assert.equal(
		refreshed.tasks.find((t: any) => t.task_id === fixture.failed.id)
			.file_count,
		0,
	);
	assert.equal(
		(
			await request(
				"delete?path=" + encodeURIComponent(fixture.active.rel),
				"DELETE",
			)
		).status(),
		409,
	);
	assert.equal(
		(
			await request(
				"delete?path=" +
					encodeURIComponent(fixture.ended.rel + "/uploads/scope.txt"),
				"DELETE",
			)
		).status(),
		409,
	);
	await page.getByRole("button", { name: "Clear records", exact: true }).click();
	const history = page.getByRole("dialog").filter({
		has: page.getByRole("heading", { name: "Clear records", exact: true }),
	});
	await history.waitFor();
	assert.equal(
		await history.getByRole("cell", { name: "WORMHOLE", exact: true }).count(),
		2,
	);
	await screenshot("workspace-cleanup-history");
	await page.keyboard.press("Escape");
	await mkdir(fixture.failed.dir, { recursive: true });
	await writeFile(fixture.failed.dir + "/stale.txt", "ORIGINAL");
	await page.getByRole("button", { name: "Refresh statistics", exact: true }).click();
	await page.getByRole("button", { name: "Refresh statistics", exact: true }).waitFor();
	await failed.getByRole("button", { name: "Cleanup", exact: true }).click();
	preview = await dialog();
	await writeFile(fixture.failed.dir + "/stale.txt", "CHANGED_LONGER");
	await preview.getByRole("button", { name: "Confirm deletion", exact: true }).click();
	await page
		.getByText("The file or evidence reference has changed, please preview again", { exact: true })
		.waitFor();
	assert.ok(await exists(fixture.failed.dir + "/stale.txt"));
	await page.setViewportSize({ width: 390, height: 844 });
	await screenshot("workspace-mobile");
	assert.ok(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
		"mobile page stays within viewport",
	);
	assert.deepEqual(errors, []);
	await writeFile(
		root + "/evidence/browser-verification.json",
		JSON.stringify(
			{
				real_http: true,
				single_file_cleanup: true,
				batch_cleanup: true,
				protected_evidence: true,
				protected_uploads: true,
				active_task_rejected: true,
				stale_preview_rejected: true,
				usage_refreshed: true,
				audit_visible: true,
				mobile_no_page_overflow: true,
				browser_errors: errors,
			},
			null,
			2,
		),
	);
	console.log("Real browser and HTTP workspace cleanup checks passed");
} finally {
	await browser.close();
}
