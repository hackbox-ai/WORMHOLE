import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.ts";
import { PocService } from "../src/domains/pocs/service.ts";
import { FingerprintService } from "../src/domains/fingerprints/service.ts";
import { seedBuiltinSkills } from "../src/domains/skills/seed-builtin.ts";
test("core skill installation is independent of optional packs and preserves user edits", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "wormhole-install-")),
		skills = path.join(root, "skills");
	try {
		const names = await seedBuiltinSkills(skills);
		assert.ok(names.includes("wormhole-test-plan"));
		assert.ok(!names.includes("wormhole-rea-toolkit"));
		await assert.rejects(access(path.join(skills, "scopesentry")));
		const file = path.join(skills, "wormhole-test-plan/SKILL.md");
		await writeFile(file, "user-edited");
		await seedBuiltinSkills(skills);
		assert.equal(await readFile(file, "utf8"), "user-edited");
		await access(path.join(root, "licenses/methodology/LICENSE.txt"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("empty database initializes without bundled data or fingerprint engine; imports and restarts preserve user data", {
	skip: !process.env.WORMHOLE_FRESH_TEST_DSN,
}, async () => {
	const dsn = process.env.WORMHOLE_FRESH_TEST_DSN!,
		schema = "wormhole_fresh_" + Date.now(),
		admin = new Pool({ connectionString: dsn });
	await admin.query("CREATE SCHEMA " + schema);
	const pool = new Pool({
		connectionString: dsn,
		options: "-c search_path=" + schema,
	});
	try {
		await runMigrations(pool);
		const pocs = new PocService(pool),
			fingerprints = new FingerprintService(pool);
		await pocs.seed();
		await fingerprints.seed();
		assert.equal(await pocs.available(), false);
		assert.equal(await fingerprints.available(), false);
		assert.equal((await pocs.sources()).sources.length, 0);
		await fingerprints.snapshot();
		await fingerprints.import("ehole", {
			fingerprint: [
				{
					cms: "User product",
					method: "keyword",
					location: "body",
					keyword: ["fixture"],
				},
			],
		});
		assert.equal((await fingerprints.all("ehole")).length, 1);
		assert.equal(await fingerprints.available(), false);
		await fingerprints.seed();
		await pocs.seed();
		assert.equal((await fingerprints.all("ehole")).length, 1);
		assert.deepEqual(await runMigrations(pool), []);
	} finally {
		await fingerprintsClose(pool);
		await admin.query("DROP SCHEMA " + schema + " CASCADE");
		await admin.end();
	}
});
async function fingerprintsClose(pool: Pool) {
	await pool.end();
}
