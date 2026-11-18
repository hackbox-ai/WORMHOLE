/**
 * B05 Task host：Planner/Worker Scheduling, collection and life cycle management。
 * Stage A Semantics（RUNBOOK §2）：Task status/Lease/Recovery is the responsibility of the host，Pi Only run single session loop。
 * This document first implements the testable core：CAS Collection, priority, heartbeat、model_error Retry, restart recovery Complete trigger for。
 * plannerLoop/workerLoop The complete trigger of/Debounce semantics in F03（P2）Connect Pi Session completion。
 */
import type { Pool } from "pg";
import { normalizeHeartbeat } from "./state-machine.ts";

export interface ClaimResult {
  claimed: boolean;
  intentId?: number;
}

/** CAS Receive：UPDATE ... WHERE state='open'。 */
export async function claimNextIntent(
  pool: Pool,
  taskId: number,
  worker: string,
): Promise<ClaimResult> {
  const res = await pool.query(
    `UPDATE exploration_nodes SET state='running', claimed_by=$2, claimed_at=now(),
       heartbeat_at=now(), attempts = attempts + 1, updated_at=now()
     WHERE id = (
       SELECT id FROM exploration_nodes
       WHERE task_id=$1 AND kind='intent' AND state='open'
       AND EXISTS (SELECT 1 FROM tasks WHERE id=$1 AND status='running' AND paused=FALSE AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM explorations WHERE id=tasks.exploration_id AND status='achieved'))
       ORDER BY priority DESC, id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    [taskId, worker],
  );
  if (res.rowCount === 0) return { claimed: false };
  return { claimed: true, intentId: Number(res.rows[0]!.id) };
}

/** worker Heartbeat */
export async function heartbeat(pool: Pool, intentId: number): Promise<void> {
  await pool.query("UPDATE exploration_nodes SET heartbeat_at=now() WHERE id=$1", [intentId]);
}

/** Release legacy blocked intents without reopening a still-running worker. */
export async function releaseModelingIntent(pool:Pool,taskId:number,intentId:number,owner:string):Promise<boolean>{
 const r=await pool.query(`UPDATE exploration_nodes SET state='open',blocked_reason=NULL,claimed_by=NULL,claimed_at=NULL,updated_at=now()
   WHERE id=$1 AND task_id=$2 AND state='blocked' AND blocked_reason='business_modeling' AND claimed_by=$3 RETURNING id`,[intentId,taskId,owner]);return !!r.rowCount;
}
export async function recoverModelingIntents(pool:Pool):Promise<void>{
 await pool.query(`UPDATE exploration_nodes n SET state='open',blocked_reason=NULL,claimed_by=NULL,claimed_at=NULL,updated_at=now()
   FROM tasks t WHERE n.task_id=t.id AND t.status IN('created','running','paused') AND t.deleted_at IS NULL AND n.kind='intent' AND n.state='blocked' AND n.blocked_reason='business_modeling'`);
 await pool.query('UPDATE task_business_models SET initial_gate=false WHERE initial_gate');
}

/** model_error Try again：failed → open（attempts Already receiving +1）；Exceed maxAttempts Fall exhausted */
export async function retryIntent(pool: Pool, intentId: number, maxAttempts: number): Promise<"requeued" | "exhausted"|"unchanged"> {
  // One CAS statement: a concurrent stop/delete must never be resurrected by
  // a stale model-error handler. Original intent states have no failed stage.
  const row=(await pool.query(`UPDATE exploration_nodes SET
    state=CASE WHEN attempts >= $2 THEN 'exhausted' ELSE 'open' END,
    last_error=CASE WHEN attempts >= $2 THEN last_error ELSE NULL END,
    claimed_by=NULL,claimed_at=NULL,updated_at=now()
    WHERE id=$1 AND state='running' RETURNING state`,[intentId,maxAttempts])).rows[0];
  return !row?'unchanged':row.state==='open'?'requeued':'exhausted';
}

/** Restart recovery: residual running Intent to rollback open（Control restoreTaskRuntimes），Lease cleared */
export async function recoverOnBoot(pool: Pool): Promise<{ intentsReset: number; tasksResumed: number }> {
  const intents = await pool.query(
    "UPDATE exploration_nodes SET state='open', claimed_by=NULL, claimed_at=NULL, updated_at=now() WHERE state='running'",
  );
  const tasks = await pool.query(
    "UPDATE tasks SET updated_at=now() WHERE status='running' AND paused = FALSE",
  );
  return { intentsReset: intents.rowCount ?? 0, tasksResumed: tasks.rowCount ?? 0 };
}

/** Task creation (including queuing position and heartbeat normalization） */
export async function createTask(
  pool: Pool,
  input: { name: string; goal: string; queued?: boolean; heartbeatS?: number; deadlineAt?: Date | null },
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO tasks (name, goal, queued, plan_heartbeat_seconds, deadline_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.name, input.goal, input.queued ?? false, normalizeHeartbeat(input.heartbeatS), input.deadlineAt ?? null],
  );
  return Number(res.rows[0]!.id);
}

export async function addIntent(pool: Pool, taskId: number, title: string, priority = 0): Promise<number> {
  const res = await pool.query<{ id: number }>(
    "INSERT INTO exploration_nodes (task_id, title, priority) VALUES ($1,$2,$3) RETURNING id",
    [taskId, title, priority],
  );
  return Number(res.rows[0]!.id);
}
