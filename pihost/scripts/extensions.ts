import path from "node:path";
import { existsSync } from "node:fs";
import { Pool } from "pg";
import { loadConfig } from "../src/config.ts";
import { installSkillFiles } from "../src/domains/skills/seed-builtin.ts";
const packs: Record<string, string[]> = {
	scopesentry: ["scopesentry"],
	whitebox: ["wormhole-code-review"],
	rea: ["wormhole-rea-toolkit", "wormhole-native-review"],
	protocol: ["wormhole-proto-reverse"],
};
const [operation, name] = process.argv.slice(2);
if (operation === "list") {
	console.log(JSON.stringify(packs, null, 2));
} else if (operation === "install" && name && packs[name]) {
	const generated =
		(process.env.WORMHOLE_DATA_ROOT ?? "/var/lib/wormhole") + "/config.json";
	if (!process.env.WORMHOLE_CONFIG && existsSync(generated))
		process.env.WORMHOLE_CONFIG = generated;
	const config = loadConfig();
	if (!config.database.dsn || !config.pi.agentDir)
		throw new Error("Set WORMHOLE_CONFIG to the instance configuration");
	const pool = new Pool({ connectionString: config.database.dsn });
	try {
		for (const skill of packs[name]) {
			await installSkillFiles(
				path.resolve(import.meta.dirname, "../..", "extensions/skills", skill),
				path.join(config.pi.agentDir, "skills", skill),
			);
			for (const agent of name === "scopesentry"
				? ["auto"]
				: ["worker", "pentest"])
				await pool.query(
					"INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES($1,'skill',$2) ON CONFLICT DO NOTHING",
					[agent, skill],
				);
		}
		console.log(
			"Installed Skill pack " +
				name +
				". Configure the service/toolchain and inspect capabilities before use.",
		);
	} finally {
		await pool.end();
	}
} else {
	console.error(
		"Usage: npm run extensions -- list | install scopesentry|whitebox|rea|protocol",
	);
	process.exitCode = 1;
}
