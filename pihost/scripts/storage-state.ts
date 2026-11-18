/** Private maintenance evidence: hashes/counts, never business text or credentials. */
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {AuthService,authKeyPath} from '../src/auth/service.ts';
const [configFile,output,compareFile]=process.argv.slice(2);
if(!configFile||!output)throw Error('expected config, new output file, optional previous state');
const config=JSON.parse(await readFile(configFile,'utf8')),pool=new Pool({connectionString:config.database.dsn,max:1,statement_timeout:30000});
try{
  const core:Record<string,unknown>={};
  for(const table of ['tasks','findings','exploration_nodes','exploration_edges','activity','conversations','conversation_activities','tool_calls','tool_approvals','llm_usage','pi_session_map']){
    core[table]=(await pool.query(`SELECT count(*)::text AS rows,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),',' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash FROM ${table} t`)).rows[0];
  }
  core.semantic_events=(await pool.query(`SELECT event_type,count(*)::text AS rows,md5(string_agg(md5(to_jsonb(e)::text),',' ORDER BY seq)) AS hash
    FROM business_events e WHERE event_type<>'message_update' GROUP BY event_type ORDER BY event_type`)).rows;
  core.recordings=(await pool.query(`SELECT count(*)::text AS rows,md5(COALESCE(string_agg(md5((to_jsonb(r)-ARRAY['body_storage','body_codec','body_raw_bytes','body_sha256'])::text),',' ORDER BY id),'')) AS hash FROM llm_records r`)).rows[0];
  const sizes=(await pool.query(`SELECT relname,pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname IN ('business_events','llm_records')`)).rows;
  const events=(await pool.query('SELECT count(*)::text AS rows,min(seq)::text AS first_seq,max(seq)::text AS last_seq FROM business_events')).rows[0];
  const safety={
    tasks:(await pool.query("SELECT count(*)::int AS n FROM tasks WHERE deleted_at IS NULL AND status IN ('running','queued')")).rows[0].n,
    approvals:(await pool.query("SELECT count(*)::int AS n FROM tool_approvals WHERE status='pending'")).rows[0].n,
    sideRequests:(await pool.query("SELECT count(*)::int AS n FROM side_question_requests WHERE status='running'")).rows[0].n,
    deliveries:(await pool.query("SELECT count(*)::int AS n FROM notification_deliveries WHERE state IN ('pending','sending')")).rows[0].n,
    conversationBusy:0,taskChatBusy:0
  };
  // A short-lived administrative token remains in memory. Read the existing key
  // first so the AuthService cannot create or replace a production key here.
  const keyFile=authKeyPath(config.dataDir);await stat(keyFile);
  if((await readFile(keyFile,'utf8')).trim().length<32)throw Error('existing authentication key invalid');
  const token=await new AuthService(pool,keyFile).signTokenForTest(300),base=`http://127.0.0.1:${config.listen.port}`;
  const get=async(route:string)=>{const response=await fetch(base+route,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error(`read-only API check failed: ${route} (${response.status})`);return response.json() as Promise<any>;};
  for(const row of (await pool.query('SELECT id FROM conversations')).rows)if((await get(`/api/conversations/${row.id}/messages?limit=1`)).running)safety.conversationBusy++;
  for(const row of (await pool.query('SELECT id FROM tasks WHERE deleted_at IS NULL')).rows)if((await get(`/api/tasks/${row.id}/chat/status`)).busy)safety.taskChatBusy++;
  const id=(await pool.query('SELECT min(id)::text AS id FROM llm_records')).rows[0].id;
  const record=id?await get(`/api/llm/records/${id}`):null;
  const detailHash=record?createHash('sha256').update(JSON.stringify(record)).digest('hex'):null;
  const health=await get('/api/health');
  const report={createdAt:new Date().toISOString(),core,events,sizes,safety,health,recordDetail:{id,hash:detailHash},sourceWrites:0};
  if(Object.values(safety).some(n=>n!==0))throw Error('active work; maintenance cannot proceed');
  if(compareFile){const before=JSON.parse(await readFile(compareFile,'utf8'));
    if(JSON.stringify(before.core)!==JSON.stringify(core)||JSON.stringify(before.events)!==JSON.stringify(events)||JSON.stringify(before.recordDetail)!==JSON.stringify(report.recordDetail))throw Error('protected business data changed');
  }
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({output,safety,sizes,events,health,protectedDataMatched:!!compareFile}));
}finally{await pool.end();}
