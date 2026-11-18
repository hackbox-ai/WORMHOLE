/** Isolated synthetic load: no target traffic and no provider calls. */
import {Pool} from 'pg';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {runMigrations} from '../src/db/migrate.ts';
import {archiveColdEvents} from '../src/storage/cold-events.ts';
import {storagePolicy} from '../src/storage/policy.ts';
import {storageStatus} from '../src/storage/lifecycle.ts';
import {taskEventLines} from '../src/storage/task-events.ts';
import {ArtifactStore} from '../src/storage/artifacts.ts';
import {WorkerHandoffs} from '../src/domains/tasks/handoff.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {LlmRecords} from '../src/domains/observability/records.ts';
const [configFile,reportFile,durationText='900']=process.argv.slice(2),seconds=Number(durationText);
const rounds=Number(process.env.WORMHOLE_SOAK_ROUNDS??250);if(!Number.isSafeInteger(rounds)||rounds<5||rounds>250||rounds%5)throw Error('WORMHOLE_SOAK_ROUNDS must be a multiple of five in 5..250');
if(!configFile||!reportFile||!Number.isFinite(seconds)||seconds<0||seconds>86400)throw Error('expected TEST_CONFIG NEW_REPORT [DURATION_SECONDS]');
const config=JSON.parse(await readFile(configFile,'utf8'));
if(!/_test$/.test(new URL(config.database.dsn).pathname))throw Error('soak requires a separately named _test database');
const admin=new Pool({connectionString:config.database.dsn}),schema=`wormhole_soak_${process.pid}_${Date.now()}`;
await admin.query(`CREATE SCHEMA ${schema}`);let pool:Pool|undefined;
const root=await mkdtemp(path.join(tmpdir(),'wormhole-storage-soak-')),started=performance.now(),expected=createHash('sha256'),latencies:number[]=[];
try{
  pool=new Pool({connectionString:config.database.dsn,options:`-c search_path=${schema} -c timezone=UTC`,max:3});await runMigrations(pool);
  const graph=new ExplorationService(pool),tasks:{id:number;intent:number}[]=[],policy=storagePolicy({hotDays:0,eventBatchRows:10000});
  for(let i=0;i<50;i++){const id=Number((await pool.query("INSERT INTO tasks(name,goal,status) VALUES('storage soak fixture','verify recovery and bounded storage','running') RETURNING id")).rows[0].id);await graph.ensure(id);tasks.push({id,intent:await graph.addIntent(id,{summary:'fixture '+i})});}
  const repeated={content:[{type:'text',text:"Duplicate results 🧪\r\n".repeat(16000)}],details:{fixture:true}};
  let originalArtifactBytes=0;const expectedFirst:string[]=[],actualFirst:string[]=[];
  // Graph creation emits semantic ledger events through a DB trigger. Include
  // these in the independent baseline, not only the streamed fixture inserts.
  const seedRows=(await pool.query("SELECT (to_jsonb(e)-'cold_archive_id'||jsonb_build_object('seq',e.seq::text))::text AS line FROM business_events e ORDER BY seq")).rows;
  for(const row of seedRows){expected.update(row.line+'\n');if(expectedFirst.length<4)expectedFirst.push(row.line);}
  for(let round=0;round<rounds;round++){
    const task=tasks[Math.floor(round/5)]!;
    const rows=(await pool.query(`WITH added AS (
      INSERT INTO business_events(business_kind,business_id,event_type,payload,event_uid,ts)
      SELECT 'worker',$1,'message_update',jsonb_build_object('type','message_update','storage_version',2,'assistantMessageEvent',jsonb_build_object('type','text_delta','delta',repeat('bounded delta ',20)||i)), $2||'-'||i,now()-interval '2 days'
      FROM generate_series(1,4000) i RETURNING *
    ) SELECT (to_jsonb(e)-'cold_archive_id'||jsonb_build_object('seq',e.seq::text))::text AS line FROM added e ORDER BY seq`,[`task-${task.id}-intent-${task.intent}`,'soak-'+round])).rows;
    for(const row of rows){expected.update(row.line+'\n');if(expectedFirst.length<4)expectedFirst.push(row.line);}
    const artifact=await new ArtifactStore(pool,root).put(task.id,task.intent,repeated);originalArtifactBytes+=artifact.rawBytes;
    await new WorkerHandoffs(pool,root).save(task.id,task.intent,{progress:`batch ${round}`,next_step:'continue from stored cursor; do not repeat completed mutation',artifact:artifact.hash});
    if(round%5===4){await pool.query("UPDATE tasks SET status='done' WHERE id=$1",[task.id]);await new LlmRecords(pool).recordCall({model:'local-soak',profileId:null,profileName:'fixture',sessionId:'soak-'+round,taskId:String(task.id),worker:'fixture',explorationId:null,input:10,output:2,cacheRead:0,cacheWrite:0,latencyMs:1,status:'ok',error:'',stopReason:'end_turn',text:'done',thinking:'',rawRequest:'prompt '.repeat(30000),rawResponse:'local fixture'},true);}
    const start=performance.now();await pool.query('SELECT seq FROM business_events WHERE business_kind=$1 AND business_id=$2 ORDER BY seq DESC LIMIT 200',['worker',`task-${task.id}-intent-${task.intent}`]);latencies.push(performance.now()-start);
    await archiveColdEvents(pool,root,policy);
    if(round===124){await pool.end();pool=new Pool({connectionString:config.database.dsn,options:`-c search_path=${schema} -c timezone=UTC`,max:3});}
    if(round%25===24)console.error(JSON.stringify({round:round+1,events:(round+1)*4000,rss:process.memoryUsage().rss}));
    const wait=(round+1)*seconds*1000/rounds-(performance.now()-started);if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
  }
  while((await archiveColdEvents(pool,root,policy)).rows){}
  const actual=createHash('sha256'),client=await pool.connect();let checked=0,pending:string[]=[];
  const flush=async()=>{if(!pending.length)return;const rows=(await pool!.query("SELECT (value-'cold_archive_id')::text AS line FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY e(value,ord) ORDER BY ord",['['+pending.join(',')+']'])).rows;for(const row of rows){actual.update(row.line+'\n');checked++;if(actualFirst.length<4)actualFirst.push(row.line);}pending=[];};
  try{await client.query('BEGIN READ ONLY');for await(const line of taskEventLines(client,{sql:'true',values:[]},{dataDir:root})){pending.push(line);if(pending.length>=256)await flush();}await flush();await client.query('ROLLBACK');}finally{client.release();}
  const expectedHash=expected.digest('hex'),actualHash=actual.digest('hex');if(expectedHash!==actualHash||checked!==rounds*4000+seedRows.length){await writeFile(reportFile+'.failure.json',JSON.stringify({checked,expectedRows:rounds*4000+seedRows.length,expectedHash,actualHash,expectedFirst,actualFirst},null,2),{mode:0o600});throw Error('soak logical event checksum mismatch');}
  latencies.sort((a,b)=>a-b);const status=await storageStatus(pool),report={synthetic:true,realTargetOrModelCalls:false,schemaDroppedAfter:true,configuredDurationSeconds:seconds,elapsedMs:performance.now()-started,rows:checked,streamRows:rounds*4000,semanticRows:seedRows.length,expectedHash,actualHash,status,
    queryLatencyMs:{p50:latencies[Math.floor(latencies.length*.5)],p95:latencies[Math.floor(latencies.length*.95)],max:latencies.at(-1)},peakRssBytes:process.resourceUsage().maxRSS*1024,originalArtifactBytes,uniqueArtifactPayloads:status.artifacts.objects,connectionPoolRestarted:rounds>124};
  await writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
}finally{await pool?.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();if(!path.basename(root).startsWith('wormhole-storage-soak-'))throw Error('cleanup root mismatch');await rm(root,{recursive:true,force:true});}
