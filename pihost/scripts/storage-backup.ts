/** Targeted rollback material for the additive recording schema/runtime release.
 * Original task events are backed up separately by task-storage export.
 */
import {readFile,mkdir,writeFile,chmod,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
const [configFile,directory,sourceRoot]=process.argv.slice(2);
if(!configFile||!directory||!sourceRoot)throw Error('expected config, new backup directory, source repository');
const config=JSON.parse(await readFile(configFile,'utf8'));await mkdir(directory,{mode:0o700});
async function run(command:string,args:string[]):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});let out='';
    child.stdout.on('data',b=>{if(out.length<2*1024*1024)out+=String(b);});
    child.stderr.on('data',()=>{}); // never log a database connection string
    child.on('error',()=>reject(Error(command+' failed to start')));
    child.on('close',code=>code===0?resolve(out):reject(Error(command+' failed (private connection diagnostics withheld)')));
  });
}
const dump=path.join(directory,'llm-records.dump'),schema=path.join(directory,'schema.sql'),files=path.join(directory,'runtime-files.tgz');
await run('pg_dump',['--dbname='+config.database.dsn,'--format=custom','--table=public.llm_records','--file='+dump]);await chmod(dump,0o600);
await run('pg_dump',['--dbname='+config.database.dsn,'--schema-only','--no-owner','--no-privileges','--file='+schema]);await chmod(schema,0o600);
const candidates=[configFile,config.dataDir,config.pi.agentDir,config.pi.modelsPath,path.join(sourceRoot,'pihost/src'),path.join(sourceRoot,'pihost/migrations')].map(p=>path.resolve(p));
const roots=[...new Set(candidates)].filter(p=>!candidates.some(parent=>parent!==p&&p.startsWith(parent+path.sep)));
await run('tar',['-czf',files,'--',...roots]);await chmod(files,0o600);
const toc=await run('pg_restore',['--list',dump]);
if(!toc.includes('TABLE DATA public llm_records'))throw Error('recording dump has no table data');
const manifest={createdAt:new Date().toISOString(),kind:'targeted-storage-release',dump:{path:dump,bytes:(await stat(dump)).size},schema:{path:schema,bytes:(await stat(schema)).size},runtime:{path:files,bytes:(await stat(files)).size},recordingDumpTocChecked:true,fullDatabaseBackup:false,restoreTested:false};
await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(manifest));
