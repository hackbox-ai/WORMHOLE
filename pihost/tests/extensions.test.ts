import { test } from "node:test";
import assert from "node:assert/strict";
import {
	bindExtension,
	availableToolKeys,
	toolAvailable,
	skillAvailable,
	extensionGuidance,
} from "../src/domains/extensions/availability.ts";
test("optional tools fail closed until available; core tools remain usable and revocation takes effect", async () => {
	let state: "available" | "disabled" = "disabled";
	bindExtension("pocs", async () => ({
		key: "pocs",
		state,
		detail: "User data",
		settings: "/system/pocs",
	}));
	assert.deepEqual(
		await availableToolKeys([
			"http_request",
			"search_pocs",
			"read_poc",
			"report_finding",
		]),
		["http_request", "report_finding"],
	);
	assert.equal(await toolAvailable("search_pocs"), false);
	state = "available";
	assert.deepEqual(await availableToolKeys(["http_request", "search_pocs"]), [
		"http_request",
		"search_pocs",
	]);
	state = "disabled";
	assert.equal(await toolAvailable("search_pocs"), false);
});
test("service-dependent Skills require a working extension, and guidance identifies WORMHOLE", async () => {
	bindExtension("whitebox", async () => ({
		key: "whitebox",
		state: "not_configured",
		detail: "Configure the service",
		settings: "/system/reverse",
	}));
	assert.equal(await skillAvailable("wormhole-code-review"), false);
	assert.equal(await skillAvailable("wormhole-test-plan"), true);
	const guidance = await extensionGuidance();
	assert.match(guidance, /WORMHOLE/);
	assert.match(guidance, /not_configured/);
	assert.doesNotMatch(guidance, /Vackbot|墨云/);
});

test("a failed extension probe is isolated from core tools and reported as unavailable", async () => {
	bindExtension("rea", async () => {
		throw new Error("offline");
	});
	assert.equal(await skillAvailable("wormhole-rea-toolkit"), false);
	assert.deepEqual(await availableToolKeys(["http_request", "record_fact"]), [
		"http_request",
		"record_fact",
	]);
	assert.match(await extensionGuidance(), /unreachable/);
});
