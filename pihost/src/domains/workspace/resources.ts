import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {lstat,readdir,unlink,rmdir,statfs} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import type {TrafficStore} from '../traffic/store.ts';
import {WorkspaceMaintenance,safeWorkspacePath} from './maintenance.ts';
import {WorkspaceError} from './errors.ts';
import {managedResourceRoot} from './resource-paths.ts';
import {taskEventScope} from '../../storage/task-events.ts';
import {objectFile} from '../../storage/artifacts.ts';

const categories=['files','traffic','recordings','sessions','history','artifacts','runtime'] as const;
type Category=typeof categories[number];
type EventSummary={business_kind:string;business_id:string;count:string;max_seq:string|null;bytes:string};
type Item={key:string;category:Category;source:string;owner:number;bytes:number;disk_bytes:number;path?:string;stamp?:string;kind?:string;protected_reason:string;meta?:any};
const stamp=(s:any)=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.mode,s.nlink].join(':');
const sum=(a:Item[],key:'bytes'|'disk_bytes')=>a.reduce((n,v)=>n+v[key],0);
const terminal=new Set(['done','failed','timeout','cancelled','stopped']);
// Cache repeated names across archive frames. A full path cannot occur unless
// its basename occurs; this shortcut preserves literal-reference semantics.
class ReferenceText {
 private cache=new Map<string,boolean>();
 constructor(private text:string){}
 includes(value:string):boolean{
  const cached=this.cache.get(value);if(cached!==undefined)return cached;
  const base=path.basename(value);
  let present:boolean;
  if(base!==value&&!this.includes(base))present=false;
  else if(/^\d{10}-\d{4}$/.test(value)&&!this.includes(value.split('-')[0]!))present=false;
  else present=this.text.includes(value);
  this.cache.set(value,present);return present;
 }
}
export class TaskResources {
 private traffic?:TrafficStore;
 private cache?:{at:number;value:any};
 private pending?:Promise<any>;
 constructor(private pool:Pool,private dataDir:string,private maintenance:WorkspaceMaintenance){}
 bind(traffic:TrafficStore){this.traffic=traffic;}
 async recover(){await this.pool.query("UPDATE task_resource_cleanup_runs SET state='interrupted',error='Service restart, need to re-preview and try again',finished_at=now() WHERE state='running'");}
 async history(){return {items:(await this.pool.query("SELECT id,task_id,state,categories,result,error,requested_at,finished_at FROM task_resource_cleanup_runs WHERE state<>'preview' ORDER BY requested_at DESC LIMIT 100")).rows};}
 private id(value:unknown){const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw new WorkspaceError(400,"Invalid task number");return id;}
 private async ownership(id:number){
  const task=(await this.pool.query('SELECT id,name,status,paused,queued,archived,deleted_at FROM tasks WHERE id=$1',[id])).rows[0];
  if(!task||task.deleted_at||task.archived)throw new WorkspaceError(404,"Task does not exist or has been archived");
  const links=(await this.pool.query('SELECT DISTINCT m.modeling_task_id AS id,t.name,t.status,(SELECT count(*) FROM task_business_models x WHERE x.modeling_task_id=m.modeling_task_id) AS refs FROM task_business_models m JOIN tasks t ON t.id=m.modeling_task_id WHERE m.task_id=$1 AND t.deleted_at IS NULL',[id])).rows;
  return {task,ids:[id,...links.filter(x=>Number(x.refs)===1).map(x=>Number(x.id))],links};
 }
 private async refs(db:Pool|PoolClient=this.pool){
  return new ReferenceText((await db.query("SELECT to_jsonb(f)::text AS doc FROM findings f UNION ALL SELECT markdown AS doc FROM task_reports UNION ALL SELECT payload::text AS doc FROM exploration_nodes WHERE kind='finding'")).rows.map(x=>String(x.doc)).join('\n'));
 }
 private async walk(root:string,category:Category,owner:number,items:Item[],refs:ReferenceText){
  await safeWorkspacePath(path.dirname(root),path.basename(root),true);
  const visit=async(file:string,inherited="")=>{
   if(items.length>=100000)throw new WorkspaceError(413,"Too many resources, please narrow the scope of task cleanup");
   const s=await lstat(file).catch((e)=>{if(e.code==='ENOENT')return null;throw e;});if(!s)return;
   const kind=s.isSymbolicLink()?'link':s.isDirectory()?'directory':s.isFile()?'file':'other';
   const reason=inherited|| (kind==='link'?"Symbolic links":kind==='other'?"Special files":s.isFile()&&s.nlink>1?"Shared hard link":refs.includes(file)||refs.includes(path.basename(file))?"Discovery or report citation":'');
   items.push({key:'file:'+file,category,source:'filesystem',owner,bytes:kind==='file'?s.size:0,disk_bytes:s.blocks*512,path:file,stamp:stamp(s),kind,protected_reason:reason,meta:{root}});
   if(kind==='directory')for(const n of await readdir(file))await visit(path.join(file,n),reason);
  };await visit(root);
 }
 private async inventory(id:number,catalog?:EventSummary[],referenceText?:ReferenceText){
  const scope=await this.ownership(id),refs=referenceText??await this.refs(),items:Item[]=[];
  const client=await this.pool.connect();
  try{for(const owner of scope.ids){
   for(const item of await this.maintenance.resourceFiles(owner,client))items.push({key:'file:'+path.join(this.dataDir,'workspace',item.path),category:'files',source:'filesystem',owner,bytes:item.bytes,disk_bytes:item.disk_bytes,path:path.join(this.dataDir,'workspace',item.path),stamp:item.stamp,kind:item.kind,protected_reason:item.protected_reason??'',meta:{root:path.join(this.dataDir,'workspace')}});
   const registered=(await client.query('SELECT kind,path FROM task_resource_paths WHERE task_id=$1',[owner])).rows;
   // Recover historical native sessions from exact recorded business IDs.
   const eventScope=await taskEventScope(client,String(owner));
   const business=catalog?catalog.filter(e=>(e.business_kind==='task'&&e.business_id===String(owner))||e.business_id==='task-'+owner||e.business_id.startsWith('task-'+owner+'-')||(eventScope.values[3] as string[]).includes(e.business_id)):(await client.query('SELECT DISTINCT e.business_kind,e.business_id FROM business_events e WHERE '+eventScope.sql,eventScope.values)).rows;
   const paths=new Map<string,{kind:Category;path:string}>();
   for(const row of registered)paths.set(row.path,{kind:row.kind,path:row.path});
   for(const row of business)if(/^[A-Za-z][A-Za-z0-9_-]*$/.test(row.business_kind)&&/^[A-Za-z0-9_-]+$/.test(row.business_id)){
    const file=path.join(this.dataDir,'pi-sessions',row.business_kind+'-'+row.business_id);
    paths.set(file,{kind:'sessions',path:file});
   }
   for(const row of paths.values()){
    managedResourceRoot(this.dataDir,row.kind as 'runtime'|'sessions',row.path);
    const start=items.length;
    await this.walk(row.path,row.kind,owner,items,refs);
    if((await client.query('SELECT 1 FROM task_resource_paths WHERE path=$1 AND NOT task_id=ANY($2::bigint[]) LIMIT 1',[row.path,scope.ids])).rowCount)for(const item of items.slice(start))item.protected_reason="Other tasks share session or run directory";
   }
   const records=(await client.query("SELECT id::text,COALESCE(body_raw_bytes,0)+COALESCE(octet_length(request_text),0)+COALESCE(octet_length(response_text),0)+COALESCE(octet_length(request_body),0)+COALESCE(octet_length(response_body),0)+COALESCE(octet_length(raw_request),0)+COALESCE(octet_length(raw_response),0) AS bytes,COALESCE(octet_length(body_storage),0)+COALESCE(octet_length(request_text),0)+COALESCE(octet_length(response_text),0)+COALESCE(octet_length(request_body),0)+COALESCE(octet_length(response_body),0)+COALESCE(octet_length(raw_request),0)+COALESCE(octet_length(raw_response),0) AS stored FROM llm_records WHERE task_id=$1 AND workspace_cleaned_at IS NULL",[String(owner)])).rows;
   for(const row of records)items.push({key:'record:'+row.id,category:'recordings',source:'postgres',owner,bytes:Number(row.stored),disk_bytes:0,protected_reason:refs.includes('llm_records/'+row.id)?"Discovery or report citation":'',meta:{id:row.id,raw_bytes:Number(row.bytes)}});
   const events=catalog?{count:business.reduce((n,e)=>n+Number(e.count),0),max_seq:business.reduce((m,e)=>e.max_seq&&BigInt(e.max_seq)>BigInt(m)?e.max_seq:m,'0'),bytes:business.reduce((n,e)=>n+Number(e.bytes),0)}:(await client.query("SELECT count(*) AS count,max(e.seq)::text AS max_seq,COALESCE(sum(CASE WHEN e.cold_archive_id IS NULL THEN pg_column_size(e.payload) ELSE 0 END),0) AS bytes FROM business_events e WHERE "+eventScope.sql+" AND e.event_type='message_update' AND NOT e.payload @> '{\"workspace_cleaned\":true}'::jsonb",eventScope.values)).rows[0];
   if(Number(events.count))items.push({key:'event-stream:'+owner,category:'history',source:'postgres',owner,bytes:Number(events.bytes),disk_bytes:0,protected_reason:'',meta:{max_seq:events.max_seq,count:Number(events.count)}});
   const archives=(await client.query('SELECT id,stored_bytes FROM storage_event_archives WHERE task_id=$1',[owner])).rows;
   const blockedArchives=new Set(archives.length?(await client.query("SELECT DISTINCT e.cold_archive_id FROM business_events e WHERE e.cold_archive_id=ANY($5::text[]) AND (NOT ("+eventScope.sql+") OR e.event_type<>'message_update' OR e.seq>$6)",[...eventScope.values,archives.map(a=>a.id),events.max_seq??'0'])).rows.map(x=>x.cold_archive_id):[]);
   for(const row of archives){
    if(!/^[0-9a-f-]{36}$/.test(row.id))continue;
    const dir=path.join(this.dataDir,'storage/events',row.id),start=items.length;
    await this.walk(dir,'history',owner,items,refs);
    for(const item of items.slice(start)){
     item.meta={...item.meta,archive:row.id};
     if(blockedArchives.has(row.id))item.protected_reason="Archive still retains event references";
    }
   }
   const artifacts=(await client.query('SELECT task_id,intent_id,hash,codec,layout,raw_bytes,stored_bytes FROM storage_artifacts WHERE task_id=$1',[owner])).rows;
   for(const row of artifacts){
    const file=objectFile(this.dataDir,row.hash,row.codec,row.layout);
    const refsCount=Number((await client.query('SELECT count(*) AS n FROM storage_artifacts WHERE hash=$1 AND codec=$2 AND layout=$3 AND NOT task_id=ANY($4::bigint[])',[row.hash,row.codec,row.layout,scope.ids])).rows[0].n);
    const s=await lstat(file).catch(()=>null);
    items.push({key:'artifact:'+owner+':'+row.intent_id+':'+row.hash,category:'artifacts',source:'artifact',owner,bytes:Number(row.stored_bytes),disk_bytes:s?.blocks? s.blocks*512:0,path:file,stamp:s?stamp(s):undefined,kind:'file',protected_reason:refsCount?"Other task sharing":refs.includes(row.hash)?"Discovery or report citation":s?.isSymbolicLink()?"Symbolic links":'',meta:{...row,root:path.join(this.dataDir,'storage/objects')}});
   }
   const traffic=this.traffic?.taskResources(owner);
   for(const row of traffic?.rows??[])items.push({key:'traffic:'+row.id,category:'traffic',source:'sqlite',owner,bytes:Number(row.inline_bytes??0),disk_bytes:0,protected_reason:refs.includes(String(row.id))?"Discovery or report citation":'',meta:{id:row.id}});
   for(const blob of traffic?.blobs??[]){
    if(items.some(i=>i.key==='blob:'+blob.hash))continue;
    const selected=new Set(items.filter(i=>i.source==='sqlite'&&!i.protected_reason).map(i=>i.meta.id));
    const outside=blob.owners.some(o=>!scope.ids.map(String).includes(o));
    const protectedFlow=blob.exchanges?.some(x=>!selected.has(x));
    const s=blob.file?await lstat(blob.file).catch(()=>null):null;
    items.push({key:'blob:'+blob.hash,category:'traffic',source:'blob',owner,bytes:blob.bytes,disk_bytes:blob.bytes,path:blob.file,stamp:s?stamp(s):undefined,kind:'file',protected_reason:outside?"Other tasks or unattributed traffic sharing":protectedFlow?"Preserve traffic references":refs.includes(blob.hash)?"Discovery or report citation":s?.isSymbolicLink()?"Symbolic links":'',meta:{hash:blob.hash,root:path.join(this.dataDir,'traffic')}});
   }
  }
   const jobs=(await client.query("SELECT progress FROM task_resource_cleanup_runs WHERE task_id=$1 AND state IN('partial','interrupted')",[id])).rows;
   for(const job of jobs)for(const item of job.progress?.pending??[]){
    if(!scope.ids.includes(item.owner)||!item.path||items.some(x=>x.key===item.key))continue;
    if(!item.meta?.root)continue;
    await safeWorkspacePath(item.meta.root,path.relative(item.meta.root,item.path),true);
    const stat=await lstat(item.path).catch(()=>null);if(!stat)continue;
    const recovered={...item,stamp:stamp(stat),disk_bytes:stat.blocks*512,bytes:stat.size};
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1)recovered.protected_reason="File type changed or shared";
    if(refs.includes(item.path)||item.meta.hash&&refs.includes(item.meta.hash))recovered.protected_reason="Discovery or report citation";
    if(item.source==='blob'&&this.traffic?.blobReferenced(item.meta.hash))recovered.protected_reason="Traffic still has references";
    if(item.source==='artifact'&&(await client.query('SELECT 1 FROM storage_artifacts WHERE hash=$1 AND NOT task_id=ANY($2::bigint[]) LIMIT 1',[item.meta.hash,scope.ids])).rowCount)recovered.protected_reason="Other task sharing";
    items.push(recovered);
   }
  }finally{client.release();}
  return {...scope,items};
 }
 private publicInventory(data:Awaited<ReturnType<TaskResources['inventory']>>){
  const unique=[...new Map(data.items.map(x=>[x.path||x.key,x])).values()];
  return {task_id:Number(data.task.id),name:data.task.name,status:data.task.paused?'paused':data.task.status,path:'tasks/'+data.task.id,
   associated_bytes:sum(unique,'bytes'),file_bytes:sum(unique,'disk_bytes'),linked_tasks:data.links,
   categories:categories.map(category=>{const group=unique.filter(x=>x.category===category);return {category,bytes:sum(group,'bytes'),file_bytes:sum(group,'disk_bytes'),reclaimable_bytes:sum(group.filter(x=>!x.protected_reason),'disk_bytes'),database_reusable_bytes:sum(group.filter(x=>!x.protected_reason&&['postgres','sqlite'].includes(x.source)),'bytes'),count:group.filter(x=>x.kind!=='directory').length};})};
 }
 async detail(value:unknown,catalog?:EventSummary[],referenceText?:ReferenceText){const data=await this.inventory(this.id(value),catalog,referenceText);let blocked='';try{await this.maintenance.resourceCheck(data.ids);}catch(e){blocked=(e as Error).message;}return {...this.publicInventory(data),cleanable:!blocked,blocked_reason:blocked,items:data.items.map(({stamp,meta,...x})=>x)};}
 async list(force=false){
  if(!force&&this.cache&&Date.now()-this.cache.at<30000)return this.cache.value;
  if(this.pending)return this.pending;
  this.pending=this.buildList();try{const value=await this.pending;this.cache={at:Date.now(),value};return value;}finally{this.pending=undefined;}
 }
 private async buildList(){
  const tasks=(await this.pool.query("SELECT t.id FROM tasks t WHERE t.deleted_at IS NULL AND NOT t.archived AND t.kind<>'modeling' ORDER BY t.id DESC")).rows;
  // Scan the event ledger once for all tasks. Repeating scope OR predicates
  // per task otherwise forces dozens of scans over historical multi-million ledgers.
  const catalog=(await this.pool.query("SELECT business_kind,business_id,count(*) FILTER(WHERE event_type='message_update' AND NOT payload @> '{\"workspace_cleaned\":true}'::jsonb)::text AS count,max(seq) FILTER(WHERE event_type='message_update' AND NOT payload @> '{\"workspace_cleaned\":true}'::jsonb)::text AS max_seq,COALESCE(sum(CASE WHEN event_type='message_update' AND cold_archive_id IS NULL AND NOT payload @> '{\"workspace_cleaned\":true}'::jsonb THEN pg_column_size(payload) ELSE 0 END),0)::text AS bytes FROM business_events GROUP BY business_kind,business_id")).rows as EventSummary[];
  const rows:Omit<Awaited<ReturnType<TaskResources['detail']>>,'items'>[]=[];const errors:{task_id:number;error:string}[]=[];const all=new Map<string,Item>();
  const referenceText=await this.refs();let next=0;
  await Promise.all(Array.from({length:Math.min(4,tasks.length)},async()=>{
   for(;;){const task=tasks[next++];if(!task)return;
    try{const {items,...row}=await this.detail(task.id,catalog,referenceText);rows.push(row);for(const item of items)all.set(item.path||item.key,item);}
    catch(e){errors.push({task_id:Number(task.id),error:(e as Error).message});}
   }
  }));
  let managedFileBytes=0,visited=0,incomplete=false;
  const scan=async(file:string)=>{if(++visited>200000){incomplete=true;return;}const s=await lstat(file).catch(()=>null);if(!s)return;if(s.isSymbolicLink())return;managedFileBytes+=s.blocks*512;if(s.isDirectory())for(const name of await readdir(file))await scan(path.join(file,name));};
  await scan(this.dataDir);
  const pgBytes=Number((await this.pool.query("SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])",[['business_events','llm_records','tool_calls','server_logs','activity','side_question_sessions']])).rows[0].bytes);
  const attributed=sum([...all.values()].filter(x=>x.path?.startsWith(this.dataDir+path.sep)),'disk_bytes');
  return {tasks:rows.sort((a,b)=>b.associated_bytes-a.associated_bytes),errors,associated_bytes:sum([...all.values()],'bytes'),scanned_at:Date.now(),shared:{...this.traffic?.storageOverview(),postgres_bytes:pgBytes,managed_file_bytes:managedFileBytes,unattributed_file_bytes:Math.max(0,managedFileBytes-attributed),incomplete},note:"The database is estimated for associated content; shared database pages, indexes and unregistered external files are not counted in the task exclusive space"};
 }
 async preview(value:unknown,selected:unknown){
  await this.pool.query("DELETE FROM task_resource_cleanup_runs WHERE state='preview' AND (expires_at<now() OR id IN(SELECT id FROM task_resource_cleanup_runs WHERE state='preview' ORDER BY requested_at DESC OFFSET 40))");
  const id=this.id(value);if(!Array.isArray(selected)||!selected.length||selected.some(x=>!categories.includes(x)))throw new WorkspaceError(400,"Please select a valid resource category");
  const data=await this.inventory(id);await this.maintenance.resourceCheck(data.ids);
  const items=data.items.filter(x=>selected.includes(x.category));
  const manifest={ids:data.ids,states:[data.task.status,data.task.paused,data.task.queued,...data.links.map(x=>[x.id,x.status,x.refs])],items},serialized=JSON.stringify(manifest);
  if(Buffer.byteLength(serialized)>16<<20)throw new WorkspaceError(413,"The list is too large, please sort it into categories.");
  const token=randomUUID(),fingerprint=createHash('sha256').update(serialized).digest('hex');
  await this.pool.query("INSERT INTO task_resource_cleanup_runs(id,task_id,state,categories,manifest,fingerprint,expires_at) VALUES($1,$2,'preview',$3,$4,$5,now()+interval '10 minutes')",[token,id,JSON.stringify(selected),serialized,fingerprint]);
  return {token,task_id:id,categories:selected,expires_at:Date.now()+600000,file_bytes:sum([...new Map(items.filter(x=>!x.protected_reason).map(x=>[x.path||x.key,x])).values()],'disk_bytes'),database_reusable_bytes:sum(items.filter(x=>!x.protected_reason&&['postgres','sqlite'].includes(x.source)),'bytes'),protected_count:items.filter(x=>x.protected_reason).length,items:items.map(({stamp,meta,...x})=>x)};
 }
 async execute(token:unknown){
  if(typeof token!=='string'||!/^[0-9a-f-]{36}$/.test(token))throw new WorkspaceError(400,"Invalid preview credentials");
  const run=(await this.pool.query("SELECT * FROM task_resource_cleanup_runs WHERE id=$1 AND state='preview' AND expires_at>now()",[token])).rows[0];if(!run)throw new WorkspaceError(409,"Preview has expired, please preview again");
  const data=await this.inventory(Number(run.task_id)),fresh={ids:data.ids,states:[data.task.status,data.task.paused,data.task.queued,...data.links.map(x=>[x.id,x.status,x.refs])],items:data.items.filter(x=>run.categories.includes(x.category))};
  if(createHash('sha256').update(JSON.stringify(fresh)).digest('hex')!==run.fingerprint)throw new WorkspaceError(409,"The resource or reference has changed, please preview again");
  await this.maintenance.resourceCheck(data.ids);
  const before=await statfs(this.dataDir),client=await this.pool.connect();
  let release:()=>void;try{release=this.maintenance.resourceLease(data.ids);}catch(e){client.release();throw e;}
  const result={removed_files:0,released_file_bytes:0,database_reusable_bytes:0,skipped:0,failed:[] as {key:string;error:string}[],filesystem_free_change:0};
  const ready=fresh.items.filter(x=>!x.protected_reason),pending:Item[]=[];let claimed=false;let locked=false;
  try{
   const claim=await client.query("UPDATE task_resource_cleanup_runs SET state='running' WHERE id=$1 AND state='preview' RETURNING id",[token]);if(!claim.rowCount)throw new WorkspaceError(409,"Cleanup performed");claimed=true;
   // Match lifecycle lock order; session locks span metadata commits and physical unlink.
   await client.query("SELECT pg_advisory_lock(hashtext(current_schema()||':wormhole_storage_events'))");
   await client.query("SELECT pg_advisory_lock(hashtext(current_schema()||':wormhole_storage_objects'))");locked=true;
   await client.query('BEGIN');
   const states=(await client.query('SELECT status,paused,queued,deleted_at,archived FROM tasks WHERE id=ANY($1::bigint[]) FOR UPDATE',[data.ids])).rows;
   if(states.length!==data.ids.length||states.some(t=>!terminal.has(t.status)||t.queued||t.deleted_at||t.archived))throw new WorkspaceError(409,"Task status changes and cannot be cleared");
   const refs=await this.refs(client);
   for(const item of ready){
    if(item.path&&item.kind!=='directory'&&(refs.includes(item.path)||item.meta?.hash&&refs.includes(item.meta.hash)))throw new WorkspaceError(409,"New evidence reference for resources, please preview again");
   }
   const recordIds=ready.filter(x=>x.source==='postgres'&&x.category==='recordings').map(x=>x.meta.id);
   if(recordIds.length)await client.query("UPDATE llm_records SET request_text='',response_text='',request_body=NULL,response_body=NULL,raw_request=NULL,raw_response=NULL,body_storage=NULL,body_codec=NULL,body_raw_bytes=NULL,body_sha256=NULL,workspace_cleaned_at=now() WHERE id=ANY($1::bigint[]) AND task_id=ANY($2::text[])",[recordIds,data.ids.map(String)]);
   for(const item of ready.filter(x=>x.source==='postgres'&&x.category==='history')){
    const scope=await taskEventScope(client,String(item.owner));
    await client.query("UPDATE business_events e SET payload='{\"type\":\"message_update\",\"workspace_cleaned\":true,\"assistantMessageEvent\":{}}'::jsonb,cold_archive_id=NULL WHERE "+scope.sql+" AND e.seq<=$5 AND e.event_type='message_update'",[...scope.values,item.meta.max_seq]);
   }
   for(const item of ready.filter(x=>x.source==='artifact')){
    const other=await client.query('SELECT 1 FROM storage_artifacts WHERE hash=$1 AND codec=$2 AND layout=$3 AND NOT task_id=ANY($4::bigint[]) LIMIT 1',[item.meta.hash,item.meta.codec,item.meta.layout,data.ids]);
    if(other.rowCount)throw new WorkspaceError(409,"A new shared reference has been added to the resource, please preview again");
    await client.query('DELETE FROM storage_artifacts WHERE task_id=$1 AND intent_id=$2 AND hash=$3',[item.owner,item.meta.intent_id,item.meta.hash]);
   }
   const archiveIds=[...new Set(ready.filter(x=>x.meta?.archive&&x.path).map(x=>x.meta.archive))];
   for(const id of archiveIds){if((await client.query('SELECT 1 FROM business_events WHERE cold_archive_id=$1 LIMIT 1',[id])).rowCount)throw new WorkspaceError(409,"Archive still referenced");await client.query('DELETE FROM storage_event_archives WHERE id=$1',[id]);}
   pending.push(...ready.filter(x=>x.path&&x.kind!=='directory'));
   await client.query('UPDATE task_resource_cleanup_runs SET progress=$2 WHERE id=$1',[token,JSON.stringify({pending})]);
   await client.query('COMMIT');
   const flowIds=ready.filter(x=>x.source==='sqlite').map(x=>x.meta.id);
   if(flowIds.length)this.traffic!.removeTaskExchanges(data.ids,flowIds);
   const seen=new Set<string>();
   for(const item of pending){
    const file=item.path!;if(seen.has(file))continue;seen.add(file);
    try{
     if(item.source==='blob'&&this.traffic!.blobReferenced(item.meta.hash)){result.skipped++;continue;}
     await safeWorkspacePath(item.meta.root,path.relative(item.meta.root,file),true);
     const s=await lstat(file).catch((e)=>{if(e.code==='ENOENT')return null;throw e;});if(!s)continue;
     if(stamp(s)!==item.stamp||s.isSymbolicLink()||!s.isFile()||s.nlink>1)throw new Error("File changes or shares, skipped");
     await unlink(file);result.removed_files++;result.released_file_bytes+=s.blocks*512;
    }catch(e){result.failed.push({key:item.key,error:(e as Error).message});}
   }
   for(const item of ready.filter(x=>x.kind==='directory').sort((a,b)=>b.path!.length-a.path!.length)){
    try{await safeWorkspacePath(item.meta.root,path.relative(item.meta.root,item.path!),true);await rmdir(item.path!);}catch(e){if(!['ENOENT','ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code??''))result.failed.push({key:item.key,error:(e as Error).message});}
   }
   result.database_reusable_bytes=sum(ready.filter(x=>['postgres','sqlite'].includes(x.source)),'bytes');
   this.traffic?.compactReleasedPages();
   const after=await statfs(this.dataDir);result.filesystem_free_change=(after.bavail*after.bsize)-(before.bavail*before.bsize);
   await client.query("UPDATE task_resource_cleanup_runs SET state=$2,result=$3,finished_at=now(),progress=$4,manifest='{}'::jsonb WHERE id=$1",[token,result.failed.length?'partial':'completed',JSON.stringify(result),JSON.stringify({pending:pending.filter(x=>result.failed.some(f=>f.key===x.key))})]);this.cache=undefined;
   return result;
  }catch(e){
   await client.query('ROLLBACK').catch(()=>{});
   if(claimed)await client.query("UPDATE task_resource_cleanup_runs SET state='partial',error=$2,result=$3,finished_at=now() WHERE id=$1",[token,(e as Error).message,JSON.stringify(result)]);
   throw e;
  }finally{
   if(claimed)this.cache=undefined;
   if(locked){await client.query("SELECT pg_advisory_unlock(hashtext(current_schema()||':wormhole_storage_objects'))").catch(()=>{});await client.query("SELECT pg_advisory_unlock(hashtext(current_schema()||':wormhole_storage_events'))").catch(()=>{});}
   client.release();release();
  }
 }
}
