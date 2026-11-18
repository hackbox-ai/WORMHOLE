import { readdir, lstat, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appendEvent } from "../../events/ledger.ts";
import { WorkspaceError } from "./errors.ts";

type Item = {
	path: string;
	kind: "file" | "directory" | "link" | "other";
	bytes: number;
	disk_bytes: number;
	mtime: number;
	stamp: string;
	protected_reason: string;
};
type Plan = {
	token: string;
	expires_at: number;
	paths: string[];
	items: Item[];
	revision: string;
	task_ids: number[];
	retained_bytes: number;
	task_revision: string;
};
export interface WorkspaceRuntime {
	taskBusy(id: number): boolean;
	acquireTask(id: number): (() => void) | null;
	sessionBusy(id: number): boolean;
}
const terminal = new Set(["done", "failed", "timeout", "cancelled", "stopped"]);
const protectedNames = new Set([
	"uploads",
	"evidence",
	"reports",
	"attachments",
]);

/** All web writes and native session lifetimes participate in the same gate.
 * A cleanup lease never stops an agent: admission fails while a user is busy. */
export class WorkspaceGate {
	private users = new Map<string, number>();
	private cleaning: string[] = [];
	isCleaning(absolute: string) {
		return this.cleaning.some((p) => this.overlaps(p, path.resolve(absolute)));
	}
	private overlaps(a: string, b: string) {
		return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
	}
	use(absolute: string): () => void {
		absolute = path.resolve(absolute);
		if (this.cleaning.some((p) => this.overlaps(p, absolute)))
			throw new WorkspaceError(409, "Directory is being cleaned, please try again later");
		this.users.set(absolute, (this.users.get(absolute) ?? 0) + 1);
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			const n = (this.users.get(absolute) ?? 1) - 1;
			if (n) this.users.set(absolute, n);
			else this.users.delete(absolute);
		};
	}
	busy(absolute: string) {
		absolute = path.resolve(absolute);
		return [...this.users.keys(), ...this.cleaning].some((p) =>
			this.overlaps(p, absolute),
		);
	}
	exclusive(absolute: string[]): () => void {
		if (this.cleaning.length || absolute.some((p) => this.busy(p)))
			throw new WorkspaceError(409, "Directory is still in use or cleaned");
		this.cleaning = absolute;
		return () => {
			this.cleaning = [];
		};
	}
}
// One host per process. Tests and separate hosts have independent processes.
export const workspaceGate = new WorkspaceGate();

export async function safeWorkspacePath(
	root: string,
	rel: string,
	allowMissing = false,
): Promise<string> {
	const absolute = path.resolve(root, rel),
		base = path.resolve(root);
	if (absolute !== base && !absolute.startsWith(base + path.sep))
		throw new WorkspaceError(400, "Illegal path");
	let current = base;
	for (const part of [
		"",
		...path.relative(base, absolute).split(path.sep).filter(Boolean),
	]) {
		if (part) current = path.join(current, part);
		const s = await lstat(current).catch((e) => {
			if (e.code === "ENOENT" && allowMissing) return null;
			throw e;
		});
		if (!s) return absolute;
		if (s.isSymbolicLink()) throw new WorkspaceError(409, "Manipulating symbolic links is not supported");
	}
	return absolute;
}

export class WorkspaceMaintenance {
	private plans = new Map<string, Plan>();
	private runtime?: WorkspaceRuntime;
	constructor(
		private pool: Pool,
		private root: string,
		private dlq: string,
	) {}
	bind(runtime: WorkspaceRuntime) {
		this.runtime = runtime;
	}
	async recover() {
		await this.pool.query(
			"UPDATE workspace_cleanup_runs SET state='interrupted',finished_at=now(),error='Service restart interrupted; please check the file and preview again' WHERE state='running'",
		);
	}
	private absolute(rel: string) {
		return path.join(this.root, rel);
	}
	private paths(input: unknown): string[] {
		if (
			!Array.isArray(input) ||
			!input.length ||
			input.length > 200 ||
			input.some(
				(p) =>
					typeof p !== "string" ||
					!p ||
					p.includes("\0") ||
					p.includes("\\") ||
					p.startsWith("/") ||
					p.split("/").includes(".."),
			)
		)
			throw new WorkspaceError(400, "Please select 1–200 valid paths");
		const paths = [
			...new Set((input as string[]).map((p) => path.posix.normalize(p))),
		].sort();
		if (
			paths.some(
				(p) => p === "." || ["tasks", "sessions", "drafts"].includes(p),
			)
		)
			throw new WorkspaceError(400, "Unable to clean workspace or category root");
		return paths.filter(
			(p, i) =>
				!paths.some((parent, j) => j !== i && p.startsWith(parent + "/")),
		);
	}
	private taskIds(paths: string[]) {
		return [
			...new Set(
				paths
					.map((p) => /^tasks\/([1-9]\d*)(?:\/|$)/.exec(p)?.[1])
					.filter(Boolean)
					.map(Number),
			),
		].sort((a, b) => a - b);
	}
	private async check(paths: string[], db: Pool | PoolClient = this.pool) {
		const ids = this.taskIds(paths);
		for (const rel of paths) {
			const task = /^tasks\//.test(rel),
				session = /^sessions\/([1-9]\d*)(?:\/|$)/.exec(rel);
			if (task && !/^tasks\/[1-9]\d*(?:\/|$)/.test(rel))
				throw new WorkspaceError(409, "The ownership of the task directory is unknown, please check first");
			if (workspaceGate.busy(this.absolute(rel)))
				throw new WorkspaceError(409, "Directory still in use");
			if (session && this.runtime?.sessionBusy(Number(session[1])))
				throw new WorkspaceError(409, "Conversation still running");
		}
		for (const id of ids) {
			const t = (
				await db.query(
					"SELECT status,paused,queued,archived,deleted_at FROM tasks WHERE id=$1",
					[id],
				)
			).rows[0];
			if (!t || t.deleted_at || t.archived)
				throw new WorkspaceError(409, "The task has been deleted, archived or unknown.");
			if (!terminal.has(t.status) || t.queued)
				throw new WorkspaceError(
					409,
					"Only completed tasks can be cleared, paused and queued tasks need to be kept on site",
				);
			if (!this.runtime || this.runtime.taskBusy(id))
				throw new WorkspaceError(409, "The task still has Agent, report or file operations that have not been completed.");
			const pending = await db.query(
				`SELECT 1 FROM finding_retests r JOIN findings f ON f.id=r.finding_id WHERE f.task_id=$1 AND r.status IN('pending','running') LIMIT 1`,
				[id],
			);
			if (pending.rowCount)
				throw new WorkspaceError(409, "It is found that it is still being retested, please clean it up later.");
		}
	}
	private async references(ids: number[], db: Pool | PoolClient = this.pool) {
		const documents = (
			await db.query(
				`SELECT task_id, to_jsonb(f)::text AS doc FROM findings f WHERE task_id=ANY($1::bigint[]) OR to_jsonb(f)::text LIKE $2
      UNION ALL SELECT task_id,markdown AS doc FROM task_reports WHERE task_id=ANY($1::bigint[]) OR markdown LIKE $2
      UNION ALL SELECT task_id,payload::text AS doc FROM exploration_nodes WHERE kind='finding' AND (task_id=ANY($1::bigint[]) OR payload::text LIKE $2)`,
				[ids, "%" + this.root + "%"],
			)
		).rows;
		return documents as { task_id: string; doc: string }[];
	}
	private async scan(
		paths: string[],
		db: Pool | PoolClient = this.pool,
	): Promise<Item[]> {
		const docs = await this.references(this.taskIds(paths), db),
			items: Item[] = [];
		const walk = async (rel: string, inherited = "") => {
			if (items.length >= 20000)
				throw new WorkspaceError(413, "Too many files, please choose a smaller directory");
			const full = this.absolute(rel),
				s = await lstat(full),
				kind = s.isSymbolicLink()
					? "link"
					: s.isDirectory()
						? "directory"
						: s.isFile()
							? "file"
							: "other";
			let reason =
				inherited ||
				(rel.split("/").some((p) => protectedNames.has(p))
					? "Attachment or evidence directory"
					: "");
			const taskId = /^tasks\/([1-9]\d*)(?:\/|$)/.exec(rel)?.[1];
			const name = path.posix.basename(rel);
			if (
				!reason &&
				kind !== "directory" &&
				docs.some(
					(d) =>
						d.doc.includes(full) ||
						d.doc.includes(rel) ||
						(String(d.task_id) === taskId &&
							name.length >= 4 &&
							d.doc.includes(name)),
				)
			)
				reason = "Discovery or report citation";
			if (!reason && kind === "link") reason = "Symbolic links";
			if (!reason && kind === "other") reason = "Special files";
			if (!reason && s.isFile() && s.nlink > 1) reason = "Shared hard link";
			items.push({
				path: rel,
				kind,
				bytes: s.isFile() ? s.size : 0,
				disk_bytes: s.isFile() ? s.blocks * 512 : 0,
				mtime: s.mtimeMs,
				stamp: [
					s.dev,
					s.ino,
					s.size,
					s.mtimeMs,
					s.ctimeMs,
					s.mode,
					s.nlink,
				].join(":"),
				protected_reason: reason,
			});
			if (kind === "directory")
				for (const name of (await readdir(full)).sort())
					await walk(rel + "/" + name, reason);
		};
		for (const rel of paths) {
			await safeWorkspacePath(this.root, rel);
			await walk(rel);
		}
		return items;
	}
	private async taskRevision(ids: number[], db: Pool | PoolClient = this.pool) {
		const rows = (
			await db.query(
				"SELECT id,status,paused,queued,updated_at,completed_at FROM tasks WHERE id=ANY($1::bigint[]) ORDER BY id",
				[ids],
			)
		).rows;
		return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
	}
	private revision(items: Item[]) {
		return createHash("sha256").update(JSON.stringify(items)).digest("hex");
	}
	private summary(items: Item[]) {
		const files = items.filter((i) => i.kind !== "directory");
		const eligible = files.filter((i) => !i.protected_reason);
		return {
			file_count: files.length,
			bytes: files.reduce((n, i) => n + i.bytes, 0),
			disk_bytes: files.reduce((n, i) => n + i.disk_bytes, 0),
			removable_files: eligible.length,
			removable_bytes: eligible.reduce((n, i) => n + i.bytes, 0),
			removable_disk_bytes: eligible.reduce((n, i) => n + i.disk_bytes, 0),
			protected_files: files.length - eligible.length,
		};
	}
	async preview(input: unknown) {
		const paths = this.paths(input);
		await this.check(paths);
		const items = await this.scan(paths);
		for (const [key, p] of this.plans)
			if (p.expires_at < Date.now()) this.plans.delete(key);
		const retainedBytes = Buffer.byteLength(JSON.stringify(items));
		const maxRetained = 16 * 1024 * 1024;
		if (retainedBytes > maxRetained)
			throw new WorkspaceError(413, "The file list is too large, please choose a smaller directory");
		while (
			this.plans.size >= 20 ||
			[...this.plans.values()].reduce((n, p) => n + p.retained_bytes, 0) +
				retainedBytes >
				maxRetained
		) {
			const oldest = this.plans.keys().next().value;
			if (!oldest) break;
			this.plans.delete(oldest);
		}
		const plan = {
			token: randomUUID(),
			expires_at: Date.now() + 600000,
			paths,
			items,
			revision: this.revision(items),
			task_ids: this.taskIds(paths),
			retained_bytes: retainedBytes,
			task_revision: await this.taskRevision(this.taskIds(paths)),
		};
		this.plans.set(plan.token, plan);
		const expiryToken = plan.token;
		const expiry = setTimeout(() => this.plans.delete(expiryToken), 600000);
		expiry.unref();
		return {
			token: plan.token,
			expires_at: plan.expires_at,
			paths: plan.paths,
			task_ids: plan.task_ids,
			items: items.map(({ stamp, ...item }) => item),
			...this.summary(items),
		};
	}
	async execute(token: unknown) {
		const plan = typeof token === "string" ? this.plans.get(token) : undefined;
		if (!plan || plan.expires_at < Date.now())
			throw new WorkspaceError(409, "Clean preview has expired, please preview again");
		this.plans.delete(plan.token);
		await this.check(plan.paths);
		const releases: (() => void)[] = [];
		let db: PoolClient | undefined;
		let started = false;
		const result = {
			ok: true,
			removed_files: 0,
			removed_bytes: 0,
			released_bytes: 0,
			protected_files: this.summary(plan.items).protected_files,
			failed: [] as { path: string; error: string }[],
		};
		try {
			for (const id of plan.task_ids) {
				const release = this.runtime?.acquireTask(id);
				if (!release) throw new WorkspaceError(409, "The task is still in use, please preview again");
				releases.push(release);
			}
			releases.push(
				workspaceGate.exclusive(plan.paths.map((p) => this.absolute(p))),
			);
			db = await this.pool.connect();
			await db.query("BEGIN");
			if (plan.task_ids.length)
				await db.query(
					"SELECT id FROM tasks WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
					[plan.task_ids],
				);
			// Do not call runtime check here: this operation owns its exclusive lease.
			for (const id of plan.task_ids) {
				const t = (
					await db.query(
						"SELECT status,queued,archived,deleted_at FROM tasks WHERE id=$1",
						[id],
					)
				).rows[0];
				if (
					!t ||
					!terminal.has(t.status) ||
					t.queued ||
					t.archived ||
					t.deleted_at
				)
					throw new WorkspaceError(409, "The task status has changed, please preview again");
			}
			if ((await this.taskRevision(plan.task_ids, db)) !== plan.task_revision)
				throw new WorkspaceError(409, "The task status has changed, please preview again");
			const current = await this.scan(plan.paths, db);
			if (this.revision(current) !== plan.revision)
				throw new WorkspaceError(409, "The file or evidence reference has changed, please preview again");
			await db.query(
				`INSERT INTO workspace_cleanup_runs(id,state,paths,task_ids,manifest) VALUES($1,'running',$2,$3,$4)`,
				[
					plan.token,
					JSON.stringify(plan.paths),
					plan.task_ids,
					JSON.stringify(
						current
							.filter((i) => i.kind === "file" && !i.protected_reason)
							.map((i) => ({ path: i.path, bytes: i.bytes })),
					),
				],
			);
			// Durable intent precedes filesystem changes. Task rows stay locked below.
			await db.query("COMMIT");
			started = true;
			await db.query("BEGIN");
			if (plan.task_ids.length)
				await db.query(
					"SELECT id FROM tasks WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",
					[plan.task_ids],
				);
			for (const id of plan.task_ids) {
				const t = (
					await db.query(
						"SELECT status,queued,archived,deleted_at FROM tasks WHERE id=$1",
						[id],
					)
				).rows[0];
				if (
					!t ||
					!terminal.has(t.status) ||
					t.queued ||
					t.archived ||
					t.deleted_at
				)
					throw new WorkspaceError(409, "The task status has changed, please preview again");
			}
			if (
				plan.task_ids.length &&
				(
					await db.query(
						`SELECT 1 FROM finding_retests r JOIN findings f ON f.id=r.finding_id WHERE f.task_id=ANY($1::bigint[]) AND r.status IN('pending','running') LIMIT 1`,
						[plan.task_ids],
					)
				).rowCount
			)
				throw new WorkspaceError(409, "Found that retesting is in progress, please preview again");
			if ((await this.taskRevision(plan.task_ids, db)) !== plan.task_revision)
				throw new WorkspaceError(409, "The task status has changed, please preview again");
			const latest = await this.scan(plan.paths, db);
			if (this.revision(latest) !== plan.revision)
				throw new WorkspaceError(409, "The file or evidence reference has changed, please preview again");
			for (const item of latest.filter(
				(i) => i.kind === "file" && !i.protected_reason,
			)) {
				try {
					await safeWorkspacePath(this.root, item.path);
					const s = await lstat(this.absolute(item.path));
					if (
						[s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.nlink].join(
							":",
						) !== item.stamp
					)
						throw new Error("File has changed");
					await unlink(this.absolute(item.path));
					result.removed_files++;
					result.removed_bytes += item.bytes;
					result.released_bytes += item.disk_bytes;
				} catch (e) {
					result.failed.push({ path: item.path, error: (e as Error).message });
					break;
				}
			}
			for (const dir of latest
				.filter((i) => i.kind === "directory" && !i.protected_reason)
				.sort((a, b) => b.path.length - a.path.length))
				await rmdir(this.absolute(dir.path)).catch(() => {});
			await db.query(
				"UPDATE workspace_cleanup_runs SET state=$2,finished_at=now(),result=$3 WHERE id=$1",
				[
					plan.token,
					result.failed.length ? "partial" : "completed",
					JSON.stringify(result),
				],
			);
			await db.query("COMMIT");
			db.release();
			db = undefined;
			await appendEvent(this.pool, this.dlq, {
				business_kind: "workspace",
				business_id: "global",
				event_type: "cleanup_finished",
				payload: {
					operation_id: plan.token,
					actor: "WORMHOLE",
					paths: plan.paths,
					task_ids: plan.task_ids,
					...result,
				},
			});
			return result;
		} catch (e) {
			await db?.query("ROLLBACK").catch(() => {});
			if (started)
				await db
					?.query(
						"UPDATE workspace_cleanup_runs SET state='failed',finished_at=now(),result=$2,error=$3 WHERE id=$1",
						[plan.token, JSON.stringify(result), (e as Error).message],
					)
					.catch(() => {});
			throw e;
		} finally {
			db?.release();
			for (const release of releases.reverse()) release();
		}
	}
  /** Typed adapters share the existing task-state and producer exclusion gates. */
  async resourceCheck(ids:number[]){await this.check(ids.map(id=>'tasks/'+id));}
  resourceLease(ids:number[]){
    const releases:(()=>void)[]=[];
    try{
      for(const id of ids){const release=this.runtime?.acquireTask(id);if(!release)throw new WorkspaceError(409,"Task is still in use");releases.push(release);}
      releases.push(workspaceGate.exclusive(ids.map(id=>this.absolute('tasks/'+id))));
      return ()=>{for(const release of releases.reverse())release();};
    }catch(error){for(const release of releases.reverse())release();throw error;}
  }
  async resourceFiles(id:number,db:Pool|PoolClient=this.pool){
    const rel='tasks/'+id;
    if(!await lstat(this.absolute(rel)).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))return [];
    return this.scan([rel],db);
  }

	async tasks() {
		const tasks = (
			await this.pool.query(
				"SELECT id,name,status,paused,queued,archived,deleted_at FROM tasks ORDER BY id DESC",
			)
		).rows;
		const retesting = new Set(
			(
				await this.pool.query(
					"SELECT DISTINCT f.task_id FROM finding_retests r JOIN findings f ON f.id=r.finding_id WHERE r.status IN('pending','running')",
				)
			).rows.map((r) => String(r.task_id)),
		);
		const byId = new Map(tasks.map((t) => [String(t.id), t]));
		const taskRoot = path.join(this.root, "tasks"),
			names = await readdir(taskRoot).catch((e) => {
				if (e.code === "ENOENT") return [];
				throw e;
			});
		const rows = [];
		for (const name of [
			...new Set([
				...names.filter((n) => /^[1-9]\d*$/.test(n)),
				...tasks
					.filter((t) => !t.deleted_at && !t.archived)
					.map((t) => String(t.id)),
			]),
		]) {
			const rel = "tasks/" + name,
				t = byId.get(name);
			const rootStat = await lstat(this.absolute(rel)).catch(() => null);
			if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink()))
				continue;
			let bytes = 0,
				disk = 0,
				files = 0,
				mtime = 0,
				incomplete = false,
				visited = 0;
			const walk = async (full: string) => {
				if (++visited > 100000) {
					incomplete = true;
					return;
				}
				try {
					const s = await lstat(full);
					mtime = Math.max(mtime, s.mtimeMs);
					if (s.isSymbolicLink()) return;
					if (s.isDirectory()) {
						for (const n of await readdir(full)) await walk(path.join(full, n));
					} else if (s.isFile()) {
						bytes += s.size;
						disk += s.blocks * 512;
						files++;
					}
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
				}
			};
			if (rootStat) {
				await safeWorkspacePath(this.root, "tasks");
				await walk(this.absolute(rel));
			}
			let reason = "";
			if (incomplete) reason = "Some files cannot be counted, please check in file browsing";
			else if (!t || t.deleted_at) reason = "Unknown task ownership";
			else if (t.archived) reason = "Task archived";
			else if (!terminal.has(t.status) || t.queued) reason = "The task is not over yet";
			else if (retesting.has(name)) reason = "Found that retesting is in progress";
			else if (
				!this.runtime ||
				this.runtime.taskBusy(Number(name)) ||
				workspaceGate.busy(this.absolute(rel))
			)
				reason = "Task is still in use";
			rows.push({
				task_id: Number(name),
				name: t?.name || "Task #" + name,
				status:
					t?.paused && !terminal.has(t.status)
						? "paused"
						: (t?.status ?? "unknown"),
				path: rel,
				bytes,
				disk_bytes: disk,
				file_count: files,
				mtime: mtime || 0,
				incomplete,
				cleanable: !reason,
				blocked_reason: reason,
			});
		}
		return {
			tasks: rows,
			bytes: rows.reduce((n, r) => n + r.bytes, 0),
			disk_bytes: rows.reduce((n, r) => n + r.disk_bytes, 0),
			file_count: rows.reduce((n, r) => n + r.file_count, 0),
			scanned_at: Date.now(),
		};
	}
	async history() {
		return {
			items: (
				await this.pool.query(`SELECT id,requested_at AS ts,state,actor,error,'cleanup_finished' AS event_type,
    jsonb_build_object('paths',paths,'task_ids',task_ids)||result AS payload FROM workspace_cleanup_runs ORDER BY requested_at DESC LIMIT 50`)
			).rows,
		};
	}
}
