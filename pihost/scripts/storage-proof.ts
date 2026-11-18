/** Read-only logical proof across hot/cold and legacy/packed representations.
 * Payloads are canonicalized by PostgreSQL, preserving arbitrary JSON numbers.
 * Only counts/checksums are written to the report.
 */
import {Pool} from 'pg';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {expandRecordBodies,legacyBodyFields} from '../src/storage/record-body.ts';
import {taskEventLines} from '../src/storage/task-events.ts';
const [configFile,output]=process.argv.slice(2);if(!configFile||!output)throw Error('expected CONFIG NEW_PROOF_FILE');
const coreOnly=process.argv.includes('--core-only');
const config=JSON.parse(await readFile(configFile,'utf8')),pool=new Pool({connectionString:config.database.dsn,max:1,application_name:'wormhole-storage-proof',statement_timeout:60000});
const c=await pool.connect(),started=performance.now(),core:Record<string,unknown>={};
try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL timezone='UTC'");
  for(const table of ['tasks','findings','exploration_nodes','exploration_edges','activity','conversations','conversation_activities','tool_calls','tool_approvals','llm_usage','pi_session_map']){
    core[table]=(await c.query(`SELECT count(*)::text AS rows,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),',' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash FROM ${table} t`)).rows[0];
  }
  const recordings=createHash('sha256');let recordingRows=0;
  await c.query(`DECLARE proof_records NO SCROLL CURSOR FOR SELECT *,
    (to_jsonb(r)-ARRAY['request_text','response_text','request_body','response_body','raw_request','raw_response','body_storage','body_codec','body_raw_bytes','body_sha256'])::text AS metadata FROM llm_records r ORDER BY id`);
  while(true){const rows=(await c.query('FETCH FORWARD 8 FROM proof_records')).rows;if(!rows.length)break;for(const row of rows){
    const expanded=await expandRecordBodies(row);recordings.update(row.metadata+'\n');
    for(const field of legacyBodyFields){const value=expanded[field];if(value===null){recordings.update('null\n');continue;}if(typeof value!=='string')throw Error('invalid recording body in proof');recordings.update(Buffer.byteLength(value)+':');recordings.update(value);recordings.update('\n');}recordingRows++;
  }}await c.query('CLOSE proof_records');
  const hasCold=(await c.query("SELECT 1 FROM pg_attribute WHERE attrelid='business_events'::regclass AND attname='cold_archive_id' AND NOT attisdropped")).rowCount;
  const events=createHash('sha256');let eventRows=0,bytes=0,pending:string[]=[],pendingBytes=0;
  const hash=(line:string)=>{events.update(line+'\n');bytes+=Buffer.byteLength(line)+1;eventRows++;if(eventRows%100000===0)console.error(JSON.stringify({checked:eventRows,bytes,rss:process.memoryUsage().rss,elapsedMs:performance.now()-started}));};
  const flush=async()=>{if(!pending.length)return;const rows=(await c.query("SELECT (value-'cold_archive_id')::text AS line FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY e(value,ord) ORDER BY ord",['['+pending.join(',')+']'])).rows;for(const row of rows)hash(row.line);pending=[];pendingBytes=0;};
  if(coreOnly){}
  else if(hasCold){for await(const line of taskEventLines(c,{sql:'true',values:[]},{dataDir:config.dataDir})){pending.push(line);pendingBytes+=Buffer.byteLength(line);if(pending.length>=128||pendingBytes>=4*1024**2)await flush();}await flush();}
  else{
    await c.query(`DECLARE proof_events NO SCROLL CURSOR FOR SELECT (to_jsonb(e)||jsonb_build_object('seq',e.seq::text))::text AS line FROM business_events e ORDER BY seq`);
    while(true){const rows=(await c.query('FETCH FORWARD 32 FROM proof_events')).rows;if(!rows.length)break;for(const row of rows)hash(row.line);}await c.query('CLOSE proof_events');
  }
  await c.query('ROLLBACK');
  const report={readOnly:true,coreOnly,core,recordings:{rows:recordingRows,hash:recordings.digest('hex')},events:coreOnly?null:{rows:eventRows,logicalBytes:bytes,hash:events.digest('hex')},elapsedMs:performance.now()-started,peakRssBytes:process.resourceUsage().maxRSS*1024};
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({eventRows,recordingRows,elapsedMs:report.elapsedMs}));
}finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
