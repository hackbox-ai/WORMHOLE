import type { Pool, PoolClient } from "pg";

/** Product progress is persisted before slow network/model work begins. */
export async function taskProgress(
	db: Pool | PoolClient,
	taskId: number,
	phase: string,
	message: string,
) {
	await db.query(
		`INSERT INTO activity(exploration_id,worker,kind,summary,metadata)
    SELECT exploration_id,'system','text',$3,jsonb_build_object('task_progress',$2::text)
    FROM tasks WHERE id=$1 AND deleted_at IS NULL AND status IN('created','running','paused')`,
		[taskId, phase, message],
	);
}
export const progressSQL = (
	alias = "t",
) => `COALESCE((SELECT jsonb_build_object('phase',CASE WHEN r.last_outcome='planning' THEN CASE WHEN r.strategy='normal' THEN 'planning' ELSE 'planning_recovery' END ELSE 'planning_retry_wait' END,'message',r.message,'updated_at',r.updated_at,'next_attempt_at',r.next_attempt_at,'strategy',r.strategy) FROM task_planner_recovery r WHERE r.task_id=${alias}.id AND r.message<>'' AND ${alias}.status='running' AND NOT ${alias}.paused),(SELECT jsonb_build_object('phase',a.metadata->>'task_progress','message',a.summary,'updated_at',a.created_at)
  FROM activity a WHERE a.exploration_id=${alias}.exploration_id AND a.metadata ? 'task_progress' ORDER BY a.id DESC LIMIT 1))`;
export const modelingPendingSQL = (alias = "t") =>
	`(SELECT count(*)::int FROM task_business_models bm JOIN tasks mt ON mt.id=bm.modeling_task_id WHERE bm.task_id=${alias}.id AND bm.version_id IS NULL AND mt.status IN('created','running','paused') AND mt.deleted_at IS NULL)`;
export const modelingUnavailableSQL = (alias = "t") =>
	`(SELECT count(*)::int FROM task_business_models bm LEFT JOIN tasks mt ON mt.id=bm.modeling_task_id WHERE bm.task_id=${alias}.id AND bm.version_id IS NULL AND (mt.id IS NULL OR mt.status IN('failed','timeout') OR mt.deleted_at IS NOT NULL))`;
