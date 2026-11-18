/** Offline alternative to per-row UPDATE: transform during one heap/TOAST rewrite.
 * Keep the table OID, constraints, identities and references. Caller owns the
 * transaction and must have verified a complete original archive first.
 */
import type {PoolClient} from 'pg';
const literal=(text:string)=>"'"+text.replaceAll("'","''")+"'";
export async function rewriteTaskEvents(client:PoolClient,taskId:string,conversations:string[]):Promise<number>{
  if(!/^[1-9]\d*$/.test(taskId)||conversations.some(id=>!/^conv-[1-9]\d*$/.test(id)))throw new Error('invalid rewrite task scope');
  const live=(await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND application_name IN ('wormhole-execution','wormhole-projection')")).rows[0].n;
  if(live)throw new Error('offline rewrite requires the application database pools to be stopped');
  await client.query("SET LOCAL statement_timeout='15min'");await client.query("SET LOCAL lock_timeout='15s'");
  await client.query('CREATE TEMP SEQUENCE wormhole_storage_rewrite_counter');
  await client.query(`CREATE OR REPLACE FUNCTION pg_temp.wormhole_compact_legacy_update(original jsonb,event_seq bigint) RETURNS jsonb LANGUAGE plpgsql VOLATILE STRICT AS $rewrite$
    DECLARE is_native boolean; is_v2 boolean; invalid_update boolean; compacted jsonb;
    BEGIN
      SELECT COALESCE(bool_or(key='type' AND value='"message_update"'::jsonb),false),
        COALESCE(bool_or(key='storage_version' AND value IN ('2'::jsonb,'"2"'::jsonb)),false),
        COALESCE(bool_or(key='assistantMessageEvent' AND jsonb_typeof(value) NOT IN ('object','null')),false),
        '{"assistantMessageEvent":{}}'::jsonb || COALESCE(jsonb_object_agg(key,
          CASE WHEN key='assistantMessageEvent' THEN CASE WHEN jsonb_typeof(value)='object' THEN value-'partial' ELSE '{}'::jsonb END ELSE value END)
          FILTER(WHERE key NOT IN ('message','storage_version')),'{}'::jsonb) || '{"storage_version":2}'::jsonb
      INTO is_native,is_v2,invalid_update,compacted FROM jsonb_each(original);
      IF NOT is_native OR is_v2 THEN RETURN original; END IF;
      IF invalid_update THEN RAISE EXCEPTION 'unsupported legacy update payload'; END IF;
      PERFORM nextval('pg_temp.wormhole_storage_rewrite_counter');
      RETURN compacted;
    END
  $rewrite$`);
  const scope=`((business_kind='task' AND business_id=${literal(taskId)}) OR business_id=${literal('task-'+taskId)} OR business_id LIKE ${literal('task-'+taskId+'-%')}${conversations.length?' OR business_id IN ('+conversations.map(literal).join(',')+')':''})`;
  await client.query(`ALTER TABLE business_events ALTER COLUMN payload TYPE jsonb USING
    CASE WHEN ${scope} AND event_type='message_update' THEN pg_temp.wormhole_compact_legacy_update(payload,seq) ELSE payload END`);
  return Number((await client.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END::text AS changed FROM pg_temp.wormhole_storage_rewrite_counter')).rows[0].changed);
}
