/** request-owned MCP, typed writes, company scopes. */
import type {Pool} from 'pg';
import type {AssetsService} from '../assets/service.ts';
import {CompaniesService} from '../assets/companies.ts';
import type {SourceAssetInput} from '../assets/source-writes.ts';
import {connectMcp,type McpConnection} from '../mcp/client.ts';
import {McpService,type McpServerRecord} from '../mcp/service.ts';
export class SyncError extends Error{constructor(public status:number,message:string){super(message);}}
export const syncQueryInt=(v:string|null,def:number)=>v!==null&&/^[+-]?\d+$/.test(v)&&Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):def;
export async function seedScopeSentry(pool:Pool){await pool.query("INSERT INTO mcp_servers(name,transport,url,env,enabled) VALUES('ScopeSentry','http','', '{\"X-API-Key\":\"\"}'::jsonb,false) ON CONFLICT(name) DO NOTHING");}
export class SyncService{
 constructor(private pool:Pool,private assets:AssetsService,private dlqPath:string){}
 private async server():Promise<McpServerRecord|null>{return (await this.pool.query("SELECT * FROM mcp_servers WHERE name='ScopeSentry' ORDER BY id LIMIT 1")).rows[0]??null;}
 private configured(m:McpServerRecord){return !!m.url&&Object.values(m.env??{}).some(v=>v.trim()!=='');}
 private async withClient<T>(timeout:number,signal:AbortSignal|undefined,fn:(c:McpConnection,s:AbortSignal)=>Promise<T>):Promise<T>{
  const m=await this.server();if(!m)throw new SyncError(502,"The data source ScopeSentry does not exist, please create it first");if(!m.url)throw new SyncError(502,"Data source ScopeSentry does not have a URL configured, please configure it first");if(!m.enabled)throw new SyncError(409,"Data source ScopeSentry is disabled");
  const abort=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);let connection:McpConnection;
  try{connection=await connectMcp({...m,transport:'http'},abort);}catch(e){throw new SyncError(502,(e as Error).message);}
  try{return await fn(connection,abort);}finally{await connection.close().catch(()=>{});}
 }
 private async call(c:McpConnection,s:AbortSignal,name:string,args:Record<string,unknown>){
  const result=await c.client.callTool({name,arguments:args},undefined,{signal:s,timeout:600_000});const text=(result.content as {text?:string}[]|undefined)?.map(v=>v.text??'').join('')??'';
  if(result.isError)throw new Error(`mcp tool ${JSON.stringify(name)} error: ${text}`);return text;
 }
 async status(signal?:AbortSignal):Promise<Record<string,unknown>>{
  const m=await this.server(),out:Record<string,unknown>={exists:!!m,configured:false,enabled:false,reachable:false,tools:[]};if(!m)return out;
  out.configured=this.configured(m);out.enabled=m.enabled===true;out.url=m.url??'';out.tools=(await this.pool.query('SELECT name FROM mcp_tools_cache WHERE server_id=$1 ORDER BY name',[m.id])).rows.map(r=>`mcp__ScopeSentry__${r.name}`);
  if(out.configured&&out.enabled)try{await this.withClient(12_000,signal,async(c,s)=>{await c.client.listTools(undefined,{signal:s,timeout:12_000});out.reachable=true;});}catch{}return out;
 }
 async datasource(body:Record<string,unknown>,signal?:AbortSignal){
  const current=await this.server(),m:McpServerRecord=current??{name:'ScopeSentry',transport:'http',env:{'X-API-Key':''}};
  if(typeof body.url==='string'&&body.url.trim())m.url=body.url.trim();if(typeof body.api_key==='string'&&body.api_key.trim())m.env={'X-API-Key':body.api_key.trim()};
  m.enabled=this.configured(m);const service=new McpService(this.pool,this.dlqPath),id=await service.save({...m,enabled:false});
  await this.pool.query('UPDATE mcp_servers SET enabled=$2 WHERE id=$1',[id,m.enabled]);
  if(m.enabled&&!signal?.aborted)try{await this.withClient(30_000,signal,async(c,s)=>{
   const tools=[];let cursor:string|undefined;const seen=new Set<string>();do{const page=await c.client.listTools(cursor?{cursor}:{},{signal:s,timeout:30_000});tools.push(...page.tools);cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw new Error("MCP tools/list returns duplicate paging cursor");if(cursor)seen.add(cursor);}while(cursor);
   const tx=await this.pool.connect();try{await tx.query('BEGIN');await tx.query('DELETE FROM mcp_tools_cache WHERE server_id=$1',[id]);for(const t of tools)await tx.query('INSERT INTO mcp_tools_cache(server_id,name,description,schema) VALUES($1,$2,$3,$4::jsonb)',[id,t.name,t.description??'',JSON.stringify(t.inputSchema)]);await tx.query('COMMIT');}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
  });}catch{}return {id,enabled:m.enabled};
 }
 async projects(page:number,size:number,search:string,signal?:AbortSignal){return this.withClient(60_000,signal,async(c,s)=>{
  let text;try{text=await this.call(c,s,'list_projects_data',{pageIndex:page,pageSize:size,...(search?{search}:{})});}catch(e){throw new SyncError(502,"list_projects_data failed: "+(e as Error).message);}
  try{const env=JSON.parse(text);return {projects:env.result?.All??[],tag:env.tag??null};}catch(e){throw new SyncError(502,"Failed to parse project list: "+(e as Error).message);}
 });}
 async tasks(page:number,size:number,search:string,signal?:AbortSignal){return this.withClient(60_000,signal,async(c,s)=>{
  let text;try{text=await this.call(c,s,'list_tasks',{pageIndex:page,pageSize:size,...(search?{search}:{})});}catch(e){throw new SyncError(502,"list_tasks failed: "+(e as Error).message);}
  try{return {tasks:JSON.parse(text).list??[]};}catch(e){throw new SyncError(502,"Failed to parse task list: "+(e as Error).message);}
 });}
 async sync(req:{dimension?:string;targets?:string[];asset_types?:string[];create_company?:boolean;page_size?:number},signal?:AbortSignal){
  if(!['project','task'].includes(req.dimension??''))throw new SyncError(400,"dimension must be project or task");if(!req.targets?.length)throw new SyncError(400,"targets cannot be empty");
  const types=req.asset_types?.length?req.asset_types:['subdomain','service','app'],pageSize=req.page_size&&req.page_size>0&&req.page_size<=500?req.page_size:100;
  return this.withClient(600_000,signal,async(c,s)=>{
   const synced:Record<string,number>={subdomain:0,app:0,service:0,ip:0},companies:string[]=[],warnings:string[]=[],errors:string[]=[];let madeCompany=false;
   for(const target of req.targets!){const filter={[req.dimension!]:[target]};if(req.dimension==='project'&&req.create_company){
    let project:any;try{project=JSON.parse(await this.call(c,s,'get_project',{id:target}));}catch(e){warnings.push(`Project ${target} Failed to obtain details: ${(e as Error).message}`);}
    if(project?.name){const store=new CompaniesService(this.pool);try{const row=await store.create(project.name,'',[],true);companies.push(project.name);madeCompany=true;
      const roots=String(project.target??'').split('\n').map(t=>t.trim()).filter(Boolean);if(roots.length)await store.updateScope(row.id,roots.map(value=>({value})),`scopesentry:${project.name}`).catch(()=>{});
     }catch(e){warnings.push(`Company ${project.name} Creation failed: ${(e as Error).message}`);}}
   }
   for(const at of types){const ssType=({subdomain:'subdomain',service:'asset',app:'app'} as Record<string,string>)[at];if(!ssType){warnings.push("Unknown asset type, skipped: "+at);continue;}
    let items:any[]=[];try{for(let page=1;;page++){const env=JSON.parse(await this.call(c,s,'list_assets',{asset_type:ssType,pageIndex:page,pageSize,filter}));const list=env.list??[];if(!Array.isArray(list))throw new Error('list must be an array');if(!list.length)break;items.push(...list);if(items.length>=5000){items=items.slice(0,5000);warnings.push(`${at}(${target}) reaches the limit of 5000 and has been truncated`);break;}if(list.length<pageSize)break;}}
    catch(e){errors.push(`${at}(${target}) Pull failed: ${(e as Error).message}`);continue;}
    for(const item of items){const error=await this.ingest(at,item,synced);if(error)errors.push(error);}
   }}if(madeCompany)await new CompaniesService(this.pool).reattribute().catch(()=>{});
   return {synced,companies:companies.length?companies:null,warnings:warnings.length?warnings:null,errors:errors.length?errors:null};
  });
 }
 private async ingest(type:string,it:any,synced:Record<string,number>):Promise<string>{
  let input:SourceAssetInput,label:string;it=it??{};if(typeof it!=='object'||Array.isArray(it))return type+" Parsing failed: asset must be an object";
  if(type==='subdomain'){if(!it.host)return '';input={type:'subdomain',domain:it.host,record_type:it.type??'',record_value:it.value??[],source:'sync'};label=it.host;}
  else if(type==='app'){if(!it.name)return '';input={type:'app',app_name:it.name,category:it.category??'',description:it.description??'',app_icp:it.icp??'',source:'sync'};label=it.name;}
  else if(it.service==='http'||it.url){if(!it.url)return '';input={type:'service',url:it.url,technologies:it.products??[],status_code:it.status??undefined,page_title:it.title??'',favicon_mmh3:it.icon??'',ip:it.ip??'',source:'sync'};label=it.url;}
  else{const port=typeof it.port==='string'&&/^[+-]?\d+$/.test(it.port)?Number(it.port):0;input={type:'service',domain:it.domain??'',ip:it.ip??'',port,service_name:it.service??'',source:'sync'};label=`${it.ip??''}:${it.port??''}`;}
  const r=await this.assets.upsertSource(input);if(!r.ok)return `${type} ${label}: ${r.error}`;synced[type]=(synced[type]??0)+1;
  if(type==='subdomain')for(const ip of it.ip??[])if(ip){const result=await this.assets.upsertSource({type:'ip',ip,bound_domains:[it.host],source:'sync'});if(result.ok)synced.ip=(synced.ip??0)+1;}return '';
 }
}
