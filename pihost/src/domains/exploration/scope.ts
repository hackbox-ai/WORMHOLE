/** db/exploration_sources.go: live direct sources, never transitive closure. */
export const directExplorationScope=`owner AS (SELECT id task_id,exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL),
 scopes AS (
 SELECT task_id,exploration_id,FALSE inherited,0::bigint ordinal FROM owner
 UNION ALL
 SELECT s.id,s.exploration_id,TRUE,row_number() OVER(ORDER BY r.created_at,s.id)
 FROM owner o JOIN task_relations r ON r.task_id=o.task_id JOIN tasks s ON s.id=r.source_task_id AND s.deleted_at IS NULL
 )`;
