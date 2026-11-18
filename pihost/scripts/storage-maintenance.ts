/** Explicit maintenance CLI. Credentials stay in the config file. No SDK/model calls. */
import {Pool} from 'pg';
import {readFile} from 'node:fs/promises';
import {StorageLifecycle,storageStatus} from '../src/storage/lifecycle.ts';
import {migrateRecordings} from '../src/storage/migrate-recordings.ts';
import {restoreColdArchive,archiveColdEvents} from '../src/storage/cold-events.ts';
import {archiveNativeCheckpoints} from '../src/storage/checkpoints.ts';
import {storagePolicy} from '../src/storage/policy.ts';
import {ArtifactStore} from '../src/storage/artifacts.ts';
const [command,configFile]=process.argv.slice(2);
if(!configFile||!['status','tick','migrate-recordings','restore-events','backfill-events','backfill-checkpoints','reframe-artifacts','restore-artifacts'].includes(command??''))throw Error('expected status|tick|migrate-recordings|restore-events|backfill-events|backfill-checkpoints|reframe-artifacts|restore-artifacts CONFIG [--archive UUID] [--max-bytes N] [--apply]');
const config=JSON.parse(await readFile(configFile,'utf8')),pool=new Pool({connectionString:config.database.dsn,max:1,application_name:'wormhole-storage-maintenance',statement_timeout:60000});
try{
  if(command==='status'){console.log(JSON.stringify(await storageStatus(pool)));}
  else{
    if(!process.argv.includes('--apply'))throw Error('explicit --apply required');
    if(command==='restore-events')console.log(JSON.stringify(await restoreColdArchive(pool,config.dataDir,process.argv[process.argv.indexOf('--archive')+1]??'')));
    else if(command==='reframe-artifacts'||command==='restore-artifacts'){
      const index=process.argv.indexOf('--max-bytes'),maxBytes=index<0?16*1024*1024:Number(process.argv[index+1]);
      const store=new ArtifactStore(pool,config.dataDir);
      let objects=0,refs=0,batch;do{batch=await(command==='restore-artifacts'?store.restoreLegacy(1,maxBytes):store.reframeLegacy(1,maxBytes));objects+=batch.objects;refs+=batch.refs;}while(batch.objects&&!batch.deferred);
      console.log(JSON.stringify({objects,refs,deferred:batch.deferred,maxBytes}));
    }
    else if(command==='backfill-events'){
      let rows=0,rawBytes=0,storedBytes=0,batch;const policy={...storagePolicy(config.storage),eventBatchRows:10000};
      do{batch=await archiveColdEvents(pool,config.dataDir,policy);rows+=batch.rows;rawBytes+=batch.rawBytes;storedBytes+=batch.storedBytes;console.error(JSON.stringify({rows,rawBytes,storedBytes}));}while(batch.rows);
      console.log(JSON.stringify({rows,rawBytes,storedBytes}));
    }
    else if(command==='backfill-checkpoints'){
      let files=0,batch;const policy=storagePolicy(config.storage);
      do{batch=await archiveNativeCheckpoints(pool,config.dataDir,policy.hotDays,25);files+=batch.files;console.error(JSON.stringify({files}));}while(batch.files);
      console.log(JSON.stringify({files}));
    }
    else if(command==='tick')console.log(JSON.stringify(await new StorageLifecycle(pool,config).runOnce()));
    else{let rows=0,skipped=0,batch;do{batch=await migrateRecordings(pool,8);rows+=batch.rows;skipped+=batch.skipped;console.error(JSON.stringify({rows,skipped}));}while(batch.rows||batch.skipped);console.log(JSON.stringify({migrated:rows,skipped}));}
  }
}finally{await pool.end();}
