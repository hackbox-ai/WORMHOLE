import {createHash} from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { methodologySkills } from "./methodology.ts";
const root = path.resolve(import.meta.dirname, "../../../builtin-skills");
const names = [
	"api-recon",
	"playwright-cli",
	"wormhole-web-reverse",
	"wormhole-vuln-intel",
	...methodologySkills,
];
/** Install missing files only. Operator edits and removed grants survive restarts. */
export async function installSkillFiles(
	source: string,
	destination: string,
): Promise<void> {
	try {
		if ((await lstat(destination)).isSymbolicLink())
			throw new Error("Skill destination is a symlink");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	await mkdir(destination, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) throw new Error("Skill source is a symlink");
		const from = path.join(source, entry.name),
			to = path.join(destination, entry.name);
		if (entry.isDirectory()) await installSkillFiles(from, to);
		else {
			try {
				if ((await lstat(to)).isSymbolicLink())
					throw new Error("Skill destination is a symlink");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
			try {
				await copyFile(from, to, constants.COPYFILE_EXCL);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}
		}
	}
}
async function upgradeBundled(targetRoot: string): Promise<void> {
  try { if ((await lstat(targetRoot)).isSymbolicLink()) throw new Error('Skill root is a symlink'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const manifestPath = path.join(root, 'bundled-v1-hashes.json');
  let known: Record<string, string[]>;
  try { known = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, string[]>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const [relative, hashes] of Object.entries(known)) {
    const parts = relative.split('/');
    if (!parts[0] || !names.includes(parts[0]) || parts.some(p => !p || p === '..' || p === '.')) throw new Error('Invalid bundled upgrade path');
    const destination = path.join(targetRoot, ...parts);
    try {
      for (let i = 1; i <= parts.length; i++) {
        if ((await lstat(path.join(targetRoot, ...parts.slice(0, i)))).isSymbolicLink()) throw new Error('Bundled upgrade target is a symlink');
      }
      const current = createHash('sha256').update(await readFile(destination)).digest('hex');
      if (!hashes.includes(current)) continue;
      await writeFile(destination, await readFile(path.join(root, ...parts)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function seedBuiltinSkills(target: string): Promise<string[]> {
  await upgradeBundled(target);
	for (const name of names)
		await installSkillFiles(path.join(root, name), path.join(target, name));
	const legal = path.join(path.dirname(target), "licenses/methodology");
	await mkdir(legal, { recursive: true });
	try {
		await copyFile(
			path.join(root, "methodology-LICENSE.txt"),
			path.join(legal, "LICENSE.txt"),
			constants.COPYFILE_EXCL,
		);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	return [...names];
}
