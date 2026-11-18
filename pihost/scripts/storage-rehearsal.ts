/** Rehearse historical conversion and VACUUM FULL in an already-restored private
 * schema on a separately named test database. No source database writes.
 */
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Pool} from 'pg';
import {performance} from 'node:perf_hooks';
import {EventArchiveWriter} from '../src/storage/event-archive.ts';
import {taskEventScope,taskEventLines} from '../src/storage/task-events.ts';
import {compactTaskEvents} from '../src/storage/compact-events.ts';
const [sourceConfigFile,targetConfigFile,schema,output]=process.argv.slice(2);
const offlineRewrite=process.argv.includes('--rewrite');
if(!sourceConfigFile||!targetConfigFile||!schema||!output||!/^storage_restore_[a-z0-9_]+$/.test(schema))throw Error('expected source config, target config, restored schema, new output directory');
const sourceConfig=JSON.parse(await readFile(sourceConfigFile,'utf8')),targetConfig=JSON.parse(await readFile(targetConfigFile,'utf8'));
const source=new Pool({connectionString:sourceConfig.database.dsn,max:1}),target=new Pool({connectionString:targetConfig.database.dsn,max:1,options:`-c search_path=${schema}`,statement_timeout:60000});
const client=await target.connect();
try{
  const a=(await source.query('SELECT current_database() AS name')).rows[0].name,b=(await client.query('SELECT current_database() AS name')).rows[0].name;
  if(a===b)throw Error('rehearsal requires a separately named test database');
  await client.query('BEGIN');await client.query("SET LOCAL timezone='UTC'");
  await client.query(`ALTER TABLE ${schema}.events RENAME TO business_events`);
  await client.query(`CREATE TABLE ${schema}.tasks(id bigint PRIMARY KEY,status text,paused boolean,deleted_at timestamptz,updated_at timestamptz)`);
  await client.query(`CREATE TABLE ${schema}.conversations(id bigint PRIMARY KEY,task_id bigint)`);
  await client.query("INSERT INTO tasks VALUES(44,'failed',false,null,now())");await client.query('COMMIT');
  const physical=async()=>Number((await client.query("SELECT pg_total_relation_size('business_events')::text AS bytes")).rows[0].bytes);
  const semantic=async()=> (await client.query(`SELECT event_type,count(*)::text AS rows,md5(string_agg(md5(to_jsonb(e)::text),',' ORDER BY seq)) AS hash
    FROM business_events e WHERE event_type<>'message_update' GROUP BY event_type ORDER BY event_type`)).rows;
  const physicalBefore=await physical(),semanticBefore=await semantic();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL timezone='UTC'");
  const scope=await taskEventScope(client,'44'),writer=await EventArchiveWriter.create(output,'zstd',{taskId:'44',sample:false,representation:'exact-source-json',rehearsal:true});
  for await(const line of taskEventLines(client,scope))await writer.append(line);
  await writer.finish();await client.query('ROLLBACK');
  const started=performance.now(),conversion=await compactTaskEvents(client,output,true,undefined,512,offlineRewrite?{before:async()=>{}}:undefined),conversionMs=performance.now()-started;
  const semanticAfter=await semantic();if(JSON.stringify(semanticBefore)!==JSON.stringify(semanticAfter))throw Error('non-streaming events changed');
  const vacuumStarted=performance.now();if(!offlineRewrite)await client.query('VACUUM (FULL, ANALYZE) business_events');
  const report={schema,sourceWrites:0,conversion,conversionMs,vacuumMs:offlineRewrite?0:performance.now()-vacuumStarted,physicalBefore,physicalAfter:await physical(),semanticEventsUnchanged:true};
  await writeFile(path.join(output,'rehearsal.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
finally{client.release();await source.end();await target.end();}
