import type {Pool} from 'pg';
import {taskEventScope} from '../../storage/task-events.ts';

/** Consistent, body-free task diagnostics. Durations from concurrent workers
 * overlap; this report deliberately never subtracts their sum from wall time. */
export class TaskPerformance {
  constructor(readonly pool:Pool){}
  async report(taskId:string){
    if(!/^[1-9]\d*$/.test(taskId)||BigInt(taskId)>(1n<<63n)-1n)throw new Error('invalid task id');
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL statement_timeout='10s'");
      const task=(await c.query('SELECT id::text,status,paused,created_at,updated_at FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskId])).rows[0];
      if(!task){await c.query('COMMIT');return null;}
      const model=(await c.query(`SELECT count(*)::text AS calls,count(performance)::text AS measured_calls,
        count(*) FILTER(WHERE status='error')::text AS errors,sum(latency_ms)::float8 AS cumulative_latency_ms,
        percentile_cont(0.95) WITHIN GROUP(ORDER BY latency_ms) AS latency_p95_ms,
        COALESCE(sum(input_tokens),0)::text AS input_tokens,COALESCE(sum(output_tokens),0)::text AS output_tokens,
        COALESCE(sum(cache_read),0)::text AS cache_read_tokens,COALESCE(sum(cache_write),0)::text AS cache_write_tokens
        FROM llm_usage WHERE task_id=$1`,[taskId])).rows[0];
      const phaseKeys=['totalMs','firstContentMs','afterFirstContentMs','rateWaitMs','retryWaitMs','httpWaitMs','httpAttempts','requestBytes','responseBytes','contextMessages'];
      const phases:Record<string,{samples:string;total:number|null;p50:number|null;p95:number|null}>=Object.fromEntries(phaseKeys.map(key=>[key,{samples:'0',total:null,p50:null,p95:null}]));
      const measured=(await c.query(`SELECT metric.key,count(*)::text AS samples,sum(metric.value::text::float8) AS total,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY metric.value::text::float8) AS p50,
        percentile_cont(0.95) WITHIN GROUP(ORDER BY metric.value::text::float8) AS p95
        FROM llm_usage u CROSS JOIN LATERAL jsonb_each(u.performance) metric
        WHERE task_id=$1 AND performance->>'version'='1' AND metric.key=ANY($2::text[]) AND jsonb_typeof(metric.value)='number' GROUP BY metric.key`,[taskId,phaseKeys])).rows;
      for(const {key,...value} of measured)phases[key]=value;
      const scope="(business_id=$1 OR business_id LIKE $2)";
      const params=[`task-${taskId}`,`task-${taskId}-intent-%`];
      const tools=(await c.query(`SELECT count(*)::text AS calls,count(finished_at)::text AS finished,
        count(*) FILTER(WHERE is_error)::text AS errors,count(preflight_ms)::text AS measured_calls,
        sum(preflight_ms)::float8 AS cumulative_preflight_ms,sum(execution_ms)::float8 AS cumulative_execution_ms,
        percentile_cont(0.95) WITHIN GROUP(ORDER BY execution_ms) AS execution_p95_ms
        FROM tool_calls WHERE ${scope}`,params)).rows[0];
      const repeatSignals=(await c.query(`SELECT tool_key,count(*)::text AS argument_groups,sum(n-1)::text AS additional_calls FROM
        (SELECT tool_key,md5(params::text),count(*) AS n FROM tool_calls WHERE ${scope} GROUP BY tool_key,md5(params::text) HAVING count(*)>1) repeated
        GROUP BY tool_key ORDER BY sum(n-1) DESC,tool_key LIMIT 20`,params)).rows;
      const outcomes=(await c.query(`SELECT kind,state,count(*)::text AS nodes,
        count(*) FILTER(WHERE payload->'resolution'->>'outcome'='tested_negative')::text AS tested_negative,
        count(*) FILTER(WHERE payload->'resolution'->>'outcome'='blocked')::text AS blocked
        FROM exploration_nodes WHERE task_id=$1 AND delete_reason IS NULL GROUP BY kind,state ORDER BY kind,state`,[taskId])).rows;
      const artifacts=(await c.query(`WITH refs AS (SELECT * FROM storage_artifacts WHERE task_id=$1),
        objects AS (SELECT DISTINCT hash,codec,layout,raw_bytes,stored_bytes FROM refs)
        SELECT (SELECT count(*)::text FROM refs) AS refs,count(*)::text AS objects,
        COALESCE(sum(raw_bytes),0)::text AS unique_raw_bytes,COALESCE(sum(stored_bytes),0)::text AS unique_stored_bytes,
        count(*) FILTER(WHERE layout='frames-v2')::text AS framed_objects FROM objects`,[taskId])).rows[0];
      const handoffs=(await c.query('SELECT count(*)::text AS intents,COALESCE(sum(revision-1),0)::text AS revisions FROM worker_handoffs WHERE task_id=$1',[taskId])).rows[0];
      const eventScope=await taskEventScope(c,taskId);
      const events=(await c.query(`SELECT count(*)::text AS rows,count(*) FILTER(WHERE e.cold_archive_id IS NOT NULL)::text AS cold_rows,
        COALESCE(sum(pg_column_size(e.payload)),0)::text AS live_payload_field_bytes FROM business_events e WHERE ${eventScope.sql}`,eventScope.values)).rows[0];
      const archives=(await c.query('SELECT count(*)::text AS segments,COALESCE(sum(stored_bytes),0)::text AS frame_bytes FROM storage_event_archives WHERE task_id=$1',[taskId])).rows[0];
      const recordings=(await c.query(`SELECT count(*)::text AS rows,COALESCE(sum(pg_column_size(body_storage)),0)::text AS packed_field_bytes,
        count(*) FILTER(WHERE body_storage IS NULL)::text AS legacy_rows FROM llm_records WHERE task_id=$1`,[taskId])).rows[0];
      const modelTimeline=(await c.query(`SELECT id::text,ts,model,worker,status,latency_ms,performance FROM llm_usage WHERE task_id=$1 ORDER BY id DESC LIMIT 100`,[taskId])).rows;
      const toolTimeline=(await c.query(`SELECT id::text,ts,tool_key,is_error,preflight_ms,execution_ms,finished_at FROM tool_calls WHERE ${scope} ORDER BY id DESC LIMIT 100`,params)).rows;
      const timelineRows=(await c.query(`SELECT (SELECT count(*) FROM llm_usage WHERE task_id=$3)::text AS model_rows,
        count(*)::text AS tool_rows FROM tool_calls WHERE ${scope}`,[...params,taskId])).rows[0];
      await c.query('COMMIT');
      return {format:'wormhole-task-performance',version:1,capturedAt:new Date().toISOString(),task,model,phases,tools,repeatSignals,outcomes,artifacts,handoffs,storage:{events,archives,recordings},
        timeline:{model:modelTimeline,tools:toolTimeline,rows:timelineRows,limitPerSource:100},
        interpretation:{durationsOverlap:true,firstContentIncludesThinkingAndToolCalls:true,httpWaitEndsAtHeaders:true,
          retryWaitCovers:'explicit empty-response retries inside a profile call; router retries are separate call rows; SDK backoff is not separately measured',
          preflightIncludesApproval:true,repeatSignalsAreNotProvenWaste:true,outcomeCountsAreNotQualityScores:true,
          requestBytes:'first request body per call; retries can resend it; responseBytes counts consumed body bytes, not headers or TLS',
          storageBytesExclude:'table/index overhead, manifest files, WAL, backups, native sessions and user workspace; do not sum as exact disk footprint',
          toolScope:'task-N and task-N-intent-* business identities; side conversations are not attributed by guessing',
          unmeasured:['scheduler queue','context assembly','projection latency','per-task memory','task filesystem growth'],
          missingHistoricalMetrics:'null/unmeasured, never zero'}};
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }
}
