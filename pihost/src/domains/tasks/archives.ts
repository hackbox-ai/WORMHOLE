import {refreshFingerprintProjection} from '../fingerprints/service.ts';
/**
 * F03 Cold Archive Subsystem。
 * State machine/DTO/Error semantics field by field; package format is self-consistent v2（manifest.json + payload Table of Contents tar.gz +
 * All inclusive sha256——Record the encoding and decoding differences and restore the read-only package written by yourself.）。
 * Snapshot range: task line + exploration_nodes/activity/findings/llm_usage/tool_calls/conversation_activities。
 */
import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
export const ARCHIVE_QUEUED = "archive_queued";
export const ARCHIVING = "archiving";
export const ARCHIVE_FAILED = "archive_failed";
export const READY = "ready";
export const RESTORE_QUEUED = "restore_queued";
export const RESTORING = "restoring";
export const RESTORE_FAILED = "restore_failed";
export const DELETE_QUEUED = "delete_queued";
export const DELETING = "deleting";
export const DELETE_FAILED = "delete_failed";
export const ERR_NOT_FOUND = "Archive does not exist";
export const ERR_BUSY = "Task already has an archive operation in progress";

const COLS = `id,task_id,state,phase,progress,error,warnings,format_version,archive_path,sha256,
original_size,compressed_size,task_name,task_description,task_goal,original_status,category_id_snapshot,
category_name_snapshot,source_task_ids,remaining_timeout_seconds,data_counts,aggregate_stats,archived_at,requested_at,created_at,updated_at`;

type Row = Record<string, unknown>;
function dto(r: Row): Row {
  return {
    id: Number(r.id), task_id: Number(r.task_id), state: r.state, phase: r.phase, progress: Number(r.progress),
    ...(String(r.error ?? "") ? { error: r.error } : {}), warnings: r.warnings ?? [],
    format_version: Number(r.format_version), ...(String(r.sha256 ?? "") ? { sha256: r.sha256 } : {}),
    original_size: Number(r.original_size), compressed_size: Number(r.compressed_size),
    task_name: r.task_name ?? "", task_description: r.task_description ?? "", task_goal: r.task_goal ?? "",
    original_status: r.original_status ?? "",
    ...(r.category_id_snapshot != null ? { category_id: Number(r.category_id_snapshot) } : {}),
    ...(String(r.category_name_snapshot ?? "") ? { category_name: r.category_name_snapshot } : {}),
    source_task_ids: (r.source_task_ids as number[] | null) ?? [],
    remaining_timeout_seconds: Number(r.remaining_timeout_seconds ?? 0),
    data_counts: r.data_counts ?? {}, aggregate_stats: r.aggregate_stats ?? {},
    ...(r.archived_at ? { archived_at: r.archived_at } : {}),
    requested_at: r.requested_at, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export interface ArchiveDeps {
  isTaskRunning(taskId: number): boolean;
  abortTask(taskId: number): void;
  drainSide(taskId: number): Promise<void>;
  endDrain?(taskId: number): void;
}

export class TaskArchives {
  private wake: () => void = () => {};
  constructor(readonly pool: Pool, readonly dataDir: string, private deps: ArchiveDeps | null = null) {}
  onWake(fn: () => void): void { this.wake = fn; }
  private notify(): void { this.wake(); }
  root(): string { return path.join(this.dataDir, "archives", "tasks"); }
  private packagePath(candidate: unknown): string {
    const resolved = path.resolve(String(candidate ?? ""));
    if (!String(candidate ?? "") || path.dirname(resolved) !== path.resolve(this.root())) throw new Error("Archive package path exceeds task archive directory");
    return resolved;
  }

  // ── Queue ──
  async queue(taskId: number): Promise<Row> {
    const t = (await this.pool.query("SELECT id,name,description,goal,status,category_id,deadline_at FROM tasks WHERE id=$1 AND deleted_at IS NULL", [taskId])).rows[0];
    if (!t) throw Object.assign(new Error("Task does not exist"), { status: 404 });
    const dup = await this.pool.query("SELECT id FROM task_archives WHERE task_id=$1 AND state NOT IN ('ready','restore_failed','delete_failed','archive_failed')", [taskId]);
    if ((dup.rowCount ?? 0) > 0) throw Object.assign(new Error(ERR_BUSY), { status: 409 });
    const ins = await this.pool.query(
      `INSERT INTO task_archives (task_id,task_name,task_description,task_goal,original_status,category_id_snapshot,remaining_timeout_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (task_id) DO UPDATE SET state='archive_queued',phase='queued',progress=0,error='',warnings='[]'::jsonb,requested_at=now(),updated_at=now()
       RETURNING ${COLS}`, [taskId, t.name ?? "", t.description ?? "", t.goal ?? "", t.status ?? "", t.category_id ?? null, t.deadline_at ? Math.max(0, Math.floor((new Date(t.deadline_at as string).getTime() - Date.now()) / 1000)) : 0],
    );
    this.notify();
    return dto(ins.rows[0]!);
  }
  async queueRestore(archiveId: number): Promise<Row> {
    const r = await this.pool.query("UPDATE task_archives SET state='restore_queued',phase='queued',progress=0,error='',updated_at=now() WHERE id=$1 AND state IN ('ready','restore_failed') RETURNING " + COLS, [archiveId]);
    if ((r.rowCount ?? 0) === 0) throw Object.assign(new Error(ERR_NOT_FOUND), { status: 404 });
    this.notify();
    return dto(r.rows[0]!);
  }
  async queueDelete(archiveId: number): Promise<Row> {
    const r = await this.pool.query("UPDATE task_archives SET state='delete_queued',phase='queued',progress=0,error='',updated_at=now() WHERE id=$1 AND state IN ('ready','restore_failed','delete_failed') RETURNING " + COLS, [archiveId]);
    if ((r.rowCount ?? 0) === 0) throw Object.assign(new Error(ERR_NOT_FOUND), { status: 404 });
    this.notify();
    return dto(r.rows[0]!);
  }

  // ── Read ──
  async list(q: string, state: string, page: number, size: number): Promise<Row> {
    if (size <= 0) size = 20;
    if (size > 100) size = 100;
    if (page < 0) page = 0;
    // Filter before COUNT/LIMIT/OFFSET so modeling never occupies archive pages.
    const where: string[] = ["EXISTS (SELECT 1 FROM tasks t WHERE t.id=task_archives.task_id AND t.kind='pentest' AND t.deleted_at IS NULL)"];
    const args: unknown[] = [];
    if (q) { args.push(`%${q}%`); where.push(`(task_name ILIKE $${args.length} OR task_goal ILIKE $${args.length} OR CAST(task_id AS TEXT)=${"$" + args.length})`); }
    if (state) { args.push(state); where.push(`state=$${args.length}`); }
    const total = Number((await this.pool.query(`SELECT count(*) FROM task_archives WHERE ${where.join(" AND ")}`, args)).rows[0].count);
    args.push(size, page * size);
    const rows = (await this.pool.query(`SELECT ${COLS} FROM task_archives WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args)).rows;
    return { archives: rows.map(dto), total, page, page_size: size };
  }
  async get(archiveId: number): Promise<Row | null> {
    const r = await this.pool.query(`SELECT ${COLS} FROM task_archives WHERE id=$1`, [archiveId]);
    return r.rows[0] ? dto(r.rows[0]) : null;
  }

  // ── Worker：Receive and execute a task ──
  async runOne(): Promise<boolean> {
    const claim = await this.pool.query(
      `UPDATE task_archives a SET state=CASE a.state WHEN 'archive_queued' THEN 'archiving' WHEN 'restore_queued' THEN 'restoring' ELSE 'deleting' END,
       phase='claimed',updated_at=now()
       WHERE a.id=(SELECT id FROM task_archives WHERE state IN ('archive_queued','restore_queued','delete_queued') ORDER BY requested_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING ${COLS}`,
    );
    if ((claim.rowCount ?? 0) === 0) return false;
    const job = claim.rows[0] as Row;
    try {
      if (job.state === ARCHIVING) await this.archiveJob(job);
      else if (job.state === RESTORING) await this.restoreJob(job);
      else await this.deleteJob(job);
    } catch (e) {
      const failed = { [ARCHIVING]: ARCHIVE_FAILED, [RESTORING]: RESTORE_FAILED, [DELETING]: DELETE_FAILED }[String(job.state)]!;
      await this.pool.query("UPDATE task_archives SET state=$2,error=$3,updated_at=now() WHERE id=$1", [job.id, failed, String((e as Error).message ?? e).slice(0, 500)]).catch(() => {});
      throw e;
    }
    this.notify();
    return true;
  }

  private async progress(archiveId: number, phase: string, progress: number, db: Pool | PoolClient = this.pool): Promise<void> {
    await db.query("UPDATE task_archives SET phase=$2,progress=$3,updated_at=now() WHERE id=$1", [archiveId, phase, progress]);
  }

  // ── Archive ──
  private async archiveJob(job: Row): Promise<void> {
    try { await this.archivePayload(job); }
    finally { this.deps?.endDrain?.(Number(job.task_id)); }
  }
  private async archivePayload(job: Row): Promise<void> {
    const taskId = Number(job.task_id);
    if (this.deps?.isTaskRunning(taskId)) this.deps.abortTask(taskId);
    await new Promise((r) => setTimeout(r, 300));
    if (this.deps) await this.deps.drainSide(taskId);
    if (this.deps?.isTaskRunning(taskId)) throw new Error("The task still has a running Agent. Please pause and then try archiving again.");
    await this.progress(Number(job.id), "stage_files", 10);
    const staging = path.join(this.root(), ".staging", `${job.id}-${taskId}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    let committed = false;
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const locked = await db.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
      if (!locked.rowCount) throw new Error(ERR_NOT_FOUND);
      await this.progress(Number(job.id), "snapshot_database", 20, db);
      const tables: [string, string][] = [
        ["poc_sources", "key IN (SELECT s->>'key' FROM poc_snapshots snap CROSS JOIN LATERAL jsonb_array_elements(snap.sources) s WHERE snap.id=(SELECT snapshot_id FROM task_poc_state WHERE task_id=$1))"],
        ["poc_source_revisions", "id IN (SELECT s->>'revision' FROM poc_snapshots snap CROSS JOIN LATERAL jsonb_array_elements(snap.sources) s WHERE snap.id=(SELECT snapshot_id FROM task_poc_state WHERE task_id=$1))"],
        ["poc_entries", "revision_id IN (SELECT s->>'revision' FROM poc_snapshots snap CROSS JOIN LATERAL jsonb_array_elements(snap.sources) s WHERE snap.id=(SELECT snapshot_id FROM task_poc_state WHERE task_id=$1))"],
        ["poc_snapshots", "id IN (SELECT snapshot_id FROM task_poc_state WHERE task_id=$1)"],
        ["task_poc_state", "task_id"],
        ["poc_candidates", "task_id"],
        ["poc_deliveries", "task_id"],
        ["fingerprint_snapshots", "id IN (SELECT snapshot_id FROM task_fingerprint_state WHERE task_id=$1)"],
        ["task_fingerprint_state", "task_id"],
        ["fingerprint_task_entries", "task_id"],
        ["fingerprint_deliveries", "task_id"],
        ["fingerprint_materials", "task_id"],
        ["fingerprint_jobs", "material_id IN (SELECT id FROM fingerprint_materials WHERE task_id=$1)"],
        ["fingerprint_observations", "job_id IN (SELECT j.id FROM fingerprint_jobs j JOIN fingerprint_materials m ON m.id=j.material_id WHERE m.task_id=$1)"],
        ["exploration_nodes", "task_id"],
        ["worker_handoffs", "task_id"],
        ["task_reports", "task_id"],
        ["exploration_edges", "exploration_id=(SELECT exploration_id FROM tasks WHERE id=$1)"],
        ["exploration_anchors", "node_id IN (SELECT id FROM exploration_nodes WHERE task_id=$1)"],
        ["activity", "exploration_id=(SELECT exploration_id FROM tasks WHERE id=$1)"],
        ["findings", "task_id"],
        ["finding_report_versions", "finding_id IN (SELECT id FROM findings WHERE task_id=$1)"],
        ["llm_usage", "task_id"],
        ["tool_calls", "run_id=$1"],
        ["tool_approvals", "tool_call_id IN (SELECT id FROM tool_calls WHERE run_id=$1)"],
        ["intercept_pending", "tool_call_id IN (SELECT id FROM tool_calls WHERE run_id=$1)"],
      ];
      const dataCounts: Record<string, number> = {};
      for (const [table, by] of tables) {
        const result = by === "task_id"
          ? await db.query(`SELECT row_to_json(t) AS row FROM ${table} t WHERE task_id=$1`, [taskId])
          : by.startsWith("exploration_id=")
            ? await db.query(`SELECT row_to_json(t) AS row FROM ${table} t WHERE ${by}`, [taskId])
            : by.includes(' IN ')
              ? await db.query(`SELECT row_to_json(t) AS row FROM ${table} t WHERE ${by}`, [by.startsWith('node_id')||table.startsWith('fingerprint_')||table.startsWith('poc_')||table==='finding_report_versions' ? taskId : `task-${taskId}`])
              : await db.query(`SELECT row_to_json(t) AS row FROM ${table} t WHERE run_id=$1`, [`task-${taskId}`]);
        const rows = result.rows.map(r => r.row) as Row[];
        dataCounts[table] = rows.length;
        await writeFile(path.join(staging, `${table}.json`), JSON.stringify(rows));
      }
      const taskRow = (await db.query("SELECT row_to_json(t) AS row FROM tasks t WHERE id=$1", [taskId])).rows[0]?.row;
      if (!taskRow) throw new Error(ERR_NOT_FOUND);
      await writeFile(path.join(staging, "tasks.json"), JSON.stringify([taskRow]));
      await this.progress(Number(job.id), "compress", 50, db);
      const manifest = { format_version: 2, task_id: taskId, archived_at: new Date().toISOString(), data_counts: dataCounts };
      await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest));
      const archivePath = path.join(this.root(), `${job.id}-${taskId}.tar.gz`);
      await mkdir(this.root(), { recursive: true });
      await exec("tar", ["-czf", archivePath, "-C", staging, "."]);
      const buf = await readFile(archivePath);
      const checksum = createHash("sha256").update(buf).digest("hex");
      const original = await this.dirSize(staging);
      await this.progress(Number(job.id), "compact_database", 78, db);
      // Compact database: delete task load rows, leaving compact metadata for task rows + Soft archive bit
      const fingerprintAssets=(await db.query('SELECT DISTINCT asset_id FROM fingerprint_materials WHERE task_id=$1 AND asset_id IS NOT NULL',[taskId])).rows;
      await db.query('DELETE FROM poc_candidates WHERE task_id=$1',[taskId]);
      await db.query('DELETE FROM poc_deliveries WHERE task_id=$1',[taskId]);
      await db.query('DELETE FROM task_poc_state WHERE task_id=$1',[taskId]);
      await db.query('DELETE FROM task_reports WHERE task_id=$1',[taskId]);
      await db.query('DELETE FROM fingerprint_materials WHERE task_id=$1',[taskId]);
      await db.query('DELETE FROM task_fingerprint_state WHERE task_id=$1',[taskId]);
      await db.query('DELETE FROM fingerprint_task_entries WHERE task_id=$1',[taskId]);
      await db.query('DELETE FROM fingerprint_deliveries WHERE task_id=$1',[taskId]);
      for(const row of fingerprintAssets)await refreshFingerprintProjection(db,Number(row.asset_id));
      await db.query("DELETE FROM exploration_nodes WHERE task_id=$1", [taskId]);
      await db.query("DELETE FROM activity WHERE exploration_id=(SELECT exploration_id FROM tasks WHERE id=$1)", [taskId]);
      await db.query("DELETE FROM llm_usage WHERE task_id=$1", [taskId]);
      await db.query("DELETE FROM tool_calls WHERE run_id=$1", [`task-${taskId}`]);
      await db.query("UPDATE tasks SET archived=TRUE, archived_at=now(), updated_at=now() WHERE id=$1", [taskId]);
      await db.query(
        "UPDATE task_archives SET state='ready',phase='ready',progress=100,archive_path=$2,sha256=$3,original_size=$4,compressed_size=$5,data_counts=$6,archived_at=now(),updated_at=now() WHERE id=$1",
        [job.id, archivePath, checksum, original, buf.length, JSON.stringify(dataCounts)],
      );
      await db.query('COMMIT');
      committed = true;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (!committed) { /* Failure path: package and staging directory are left for failed retries */ }
    }
  }

  // ── Recovery ──
  private async restoreJob(job: Row): Promise<void> {
    const archiveId = Number(job.id);
    const taskId = Number(job.task_id);
    await this.progress(archiveId, "verify_package", 10);
    if (!String(job.archive_path ?? "")) throw new Error("Archive package missing");
    const archivePath = this.packagePath(job.archive_path);
    const buf = await readFile(archivePath);
    if (String(job.sha256 ?? "") && createHash("sha256").update(buf).digest("hex") !== String(job.sha256)) throw new Error("task archive checksum mismatch");
    const extract = path.join(this.root(), ".restore", `${archiveId}`);
    await rm(extract, { recursive: true, force: true });
    await mkdir(extract, { recursive: true });
    try {
      const listing = (await exec('tar', ['-tzf', archivePath])).stdout.split('\n').filter(Boolean);
      if (listing.some(name => path.isAbsolute(name) || name.split('/').includes('..'))) throw new Error("Archive contains illegal path");
      const detailed = (await exec('tar', ['-tvzf', archivePath])).stdout.split('\n').filter(Boolean);
      if (detailed.some(line => !['-', 'd'].includes(line[0]!))) throw new Error("Archive contains links or special files");
      await exec("tar", ["-xzf", archivePath, "-C", extract]);
      const manifest = JSON.parse(await readFile(path.join(extract, "manifest.json"), "utf8")) as { format_version: number; task_id: number };
      if (manifest.task_id !== taskId || manifest.format_version !== 2) throw new Error("task archive format mismatch");
      await this.progress(archiveId, "restore_database", 40);
      const taskRows = JSON.parse(await readFile(path.join(extract, "tasks.json"), "utf8")) as Row[];
      const db = await this.pool.connect();
      try {
      await db.query('BEGIN');
      await db.query("SET LOCAL wormhole.finding_report_restore='on'");
      const locked = await db.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
      if (!locked.rowCount) throw new Error(ERR_NOT_FOUND);
      if (taskRows[0]) {
        const t = taskRows[0];
        await db.query(
          `UPDATE tasks SET archived=FALSE,archived_at=NULL,name=$2,description=$3,goal=$4,status=$5,updated_at=now() WHERE id=$1`,
          [taskId, t.name ?? "", t.description ?? "", t.goal ?? "", t.status ?? "done"],
        );
      }
      const restoreMap: [string, string][] = [
        ["poc_sources", "key"],
        ["poc_source_revisions", "id"],
        ["poc_entries", "id"],
        ["poc_snapshots", "id"],
        ["task_poc_state", "task_id"],
        ["poc_candidates", "id"],
        ["poc_deliveries", "id"],
        ["fingerprint_snapshots", "id"],
        ["task_fingerprint_state", "task_id"],
        ["fingerprint_task_entries", "task_id"],
        ["fingerprint_deliveries", "task_id"],
        ["fingerprint_materials", "id"],
        ["fingerprint_jobs", "id"],
        ["fingerprint_observations", "id"],
        ["exploration_nodes", "id"],
        ["worker_handoffs", "intent_id"],
        ["task_reports", "task_id"],
        ["exploration_edges", "id"],
        ["exploration_anchors", "id"],
        ["activity", "id"],
        ["findings", "id"],
        ["finding_report_versions", "id"],
        ["llm_usage", "id"],
        ["tool_calls", "id"],
        ["tool_approvals", "id"],
        ["intercept_pending", "id"],
      ];
      for (const [table] of restoreMap) {
        let contents: string;
        try { contents = await readFile(path.join(extract, `${table}.json`), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && ['finding_report_versions','task_reports','poc_sources','poc_source_revisions','poc_entries','poc_snapshots','task_poc_state','poc_candidates','poc_deliveries','fingerprint_task_entries','fingerprint_deliveries','fingerprint_snapshots','task_fingerprint_state','fingerprint_materials','fingerprint_jobs','fingerprint_observations','worker_handoffs','exploration_edges','exploration_anchors','tool_approvals','intercept_pending'].includes(table)) continue; throw error; }
        const rows = JSON.parse(contents) as Row[];
        for (const r of rows) {
          await this.restoreRow(db, table, r);
        }
      }
      for(const row of (await db.query('SELECT DISTINCT asset_id FROM fingerprint_materials WHERE task_id=$1 AND asset_id IS NOT NULL',[taskId])).rows)await refreshFingerprintProjection(db,Number(row.asset_id));
      await db.query("UPDATE task_archives SET phase='restored',progress=90,updated_at=now() WHERE id=$1", [archiveId]);
      await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
      finally { db.release(); }
      // Consume only after the complete restore transaction. Keep metadata on unlink failure.
      await rm(archivePath, { force: true });
      await this.pool.query('DELETE FROM task_archives WHERE id=$1', [archiveId]);
    } finally {
      await rm(extract, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ── Delete archive ──
  private async deleteJob(job: Row): Promise<void> {
    await rm(this.packagePath(job.archive_path), { force: true });
    await this.pool.query("DELETE FROM task_archives WHERE id=$1", [Number(job.id)]);
  }

  private async restoreRow(db: PoolClient, table: string, row: Row): Promise<void> {
    // Restoring a task must not overwrite global source activation or roll back its current revision.
    if(table==='poc_sources'){await db.query('INSERT INTO poc_sources(key,title,enabled) VALUES($1,$2,false) ON CONFLICT DO NOTHING',[row.key,row.title]);return;}
    // PostgreSQL applies the real column types, including jsonb arrays versus bigint[].
    if(table==='task_fingerprint_state')row={bootstrap_state:'pending',planner_revision:0,completion_requested:false,settlement_outcome:'',gaps:{},...row};
    if(table==='findings')row={report_status:row.report&&!String(row.report).includes("Compiled based on registered evidence. Scope of influence")?'completed':'basic',report_quality:{},report_updated_at:null,...row};
    const raw = JSON.stringify(row);
    await db.query(`INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::${table}, $1::json) ON CONFLICT DO NOTHING`, [raw]);
    const keys = table === 'fingerprint_task_entries'?['task_id','url']:['task_fingerprint_state','task_poc_state','task_reports'].includes(table)?['task_id']:table === 'worker_handoffs'?['intent_id']:table === 'exploration_edges' ? ['exploration_id','src_id','rel','dst_id'] : table === 'exploration_anchors' ? ['node_id','asset_id'] : ['id'];
    const saved = await db.query(`SELECT t IS NOT DISTINCT FROM json_populate_record(NULL::${table},$1::json) AS equal FROM ${table} t WHERE ${keys.map((key,i)=>`t.${key}=$${i+2}`).join(' AND ')}`, [raw,...keys.map(key=>row[key])]);
    if (saved.rows[0]?.equal !== true) throw new Error(`Archive recovery row conflict: ${table}/${row.id}`);
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else total += (await stat(p)).size;
      }
    };
    await walk(dir);
    return total;
  }

  /** Starting recovery: Archive in progress/Recovery/Delete the task and return to the failed state (compare RecoverTaskArchiveJobs）。 */
  async recover(): Promise<void> {
    await this.pool.query("UPDATE task_archives SET state=CASE state WHEN 'archiving' THEN 'archive_failed' WHEN 'restoring' THEN 'restore_failed' ELSE 'delete_failed' END, error='Service restarted, operation interrupted', updated_at=now() WHERE state IN ('archiving','restoring','deleting')");
  }
}

/** 2 Second polling worker（Control startTaskArchiveWorker）。 */
export function startArchiveWorker(archives: TaskArchives): () => Promise<void> {
  let stopped = false;
  let wake:()=>void=()=>{};
  archives.onWake(()=>wake());
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try { await archives.runOne(); } catch (e) { console.error("[task-archive] worker:", String((e as Error).message ?? e).slice(0, 200)); }
      if (!stopped) await new Promise<void>((resolve) => {
        const timer=setTimeout(resolve,2000);
        wake=()=>{clearTimeout(timer);resolve();};
      });
    }
  };
  const done=loop();
  return async () => { stopped = true;wake();await done;archives.onWake(()=>{}); };
}
