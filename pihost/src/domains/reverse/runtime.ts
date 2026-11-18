import {existsSync} from 'node:fs';
import path from 'node:path';
import type {Pool} from 'pg';
import {analysisSlots} from './resources.ts';
import type {CodeIntelService,CodeIntelOptions} from '../codeintel/service.ts';
import {registerTool} from '../tools/gate.ts';
export const REVERSE_ROOT=process.env.WORMHOLE_TOOLS_DIR??'/opt/wormhole/tools';
export interface AnalysisSettings{index_enabled:boolean;audit_enabled:boolean;service_url:string;service_token_set:boolean;native_concurrency:number}
const defaults={index_enabled:false,audit_enabled:false,service_url:'',native_concurrency:1};
export class ReverseRuntime{
 private settings:AnalysisSettings={...defaults,service_token_set:false};private token='';private health={at:0,ok:false};private tail:Promise<unknown>=Promise.resolve();
 constructor(private pool:Pool,private code:CodeIntelService,private fallback?:Partial<CodeIntelOptions>,private dlqPath='/var/lib/wormhole/data/reverse-events.jsonl'){
  registerTool({key:'analysis_capabilities',description:"View the status of reverse engineering tools, protocol analysis and code analysis services available for the current task. Missing components are shown explicitly and dependencies are not assumed to be installed.",params:{},required:[],schema:{type:'object',properties:{},additionalProperties:false},execute:()=>this.payload()});
 }
 async initialize(){
  const values=Object.fromEntries((await this.pool.query("SELECT key,value FROM app_settings WHERE key LIKE 'reverse.%'")).rows.map(r=>[r.key,r.value]));
  this.settings={index_enabled:values['reverse.index_enabled']?values['reverse.index_enabled']==='true':this.fallback?.enabled??false,audit_enabled:values['reverse.audit_enabled']?values['reverse.audit_enabled']==='true':this.fallback?.audit??false,service_url:values['reverse.service_url']??this.fallback?.baseUrl??'',native_concurrency:Number(values['reverse.native_concurrency']??1),service_token_set:false};
  this.token=values['reverse.service_token']??this.fallback?.token??'';this.settings.service_token_set=!!this.token;this.consume();
  await this.pool.query("INSERT INTO tools(key,description,schema,agents,enabled,system,kind) VALUES('analysis_capabilities','View reverse engineering and code analysis capabilities',$1,'[\"worker\"]',TRUE,TRUE,'builtin') ON CONFLICT(key) DO NOTHING",[JSON.stringify({type:'object',properties:{},additionalProperties:false})]);
 }
 private consume(){analysisSlots.configure(this.settings.native_concurrency);this.code.configure({enabled:this.settings.index_enabled&&!!this.settings.service_url,baseUrl:this.settings.service_url,audit:this.settings.audit_enabled,token:this.token});}
 async apply(input:Record<string,unknown>){const operation=this.tail.catch(()=>{}).then(async()=>{
  const allowed=['index_enabled','audit_enabled','service_url','service_token','native_concurrency'];if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error("Invalid configuration field");
  for(const key of ['index_enabled','audit_enabled'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw new Error("Invalid switch value");
  if(input.native_concurrency!==undefined&&(!Number.isInteger(input.native_concurrency)||Number(input.native_concurrency)<1||Number(input.native_concurrency)>3))throw new Error("Reverse concurrency range is 1–3");
  if(input.service_url!==undefined){if(typeof input.service_url!=='string')throw new Error("Invalid service address");const raw=input.service_url.trim();if(raw){const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error("Fill in the HTTP(S) service address and use the service token for authentication");}input={...input,service_url:raw.replace(/\/+$/,'')};}
  if(input.service_token!==undefined&&(typeof input.service_token!=='string'||input.service_token.length>4096))throw new Error("Invalid service token");
  const next={...this.settings,...input};
  if(next.service_url!==this.settings.service_url&&(await this.pool.query("SELECT 1 FROM exploration_nodes WHERE kind='fact' AND payload->>'kind'='code_ready' AND payload->>'audit_state' IN ('claimed','running','stopping','cancel_pending') LIMIT 1")).rowCount)throw new Error("There are still code analysis tasks that have not been completed. Please stop and confirm the cancellation first.");
  if(next.audit_enabled&&!next.index_enabled)throw new Error("Automatic auditing requires code indexing to be enabled");
  if(next.index_enabled&&!next.service_url)throw new Error("Please configure the code analysis service address first");
  const c=await this.pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('reverse-settings'))");for(const[key,value]of Object.entries(input))await c.query('INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',['reverse.'+key,String(value)]);await c.query("INSERT INTO business_events(business_kind,business_id,event_type,payload) VALUES('settings','reverse','reverse_settings_changed',$1)",[JSON.stringify({fields:Object.keys(input)})]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  this.settings={index_enabled:!!next.index_enabled,audit_enabled:!!next.audit_enabled,service_url:String(next.service_url),native_concurrency:Number(next.native_concurrency),service_token_set:false};if(input.service_token!==undefined)this.token=String(input.service_token);this.settings.service_token_set=!!this.token;this.health={at:0,ok:false};this.consume();return this.payload();
 });this.tail=operation;return operation;}
 async payload(force=false){
  const rows=(await this.pool.query("SELECT id,enabled,(SELECT count(*)::int FROM mcp_tools_cache t WHERE t.server_id=m.id) count FROM mcp_servers m WHERE name='rea'")).rows;
  const reaConnected=rows.some(r=>r.enabled&&r.count>0);
  const engine=existsSync(path.join(REVERSE_ROOT,'rea/node_modules/rea-agents/scripts/rea.mjs'));
  const native=existsSync(path.join(REVERSE_ROOT,'ghidra/support/analyzeHeadless'))&&existsSync(path.join(REVERSE_ROOT,'jdk/bin/java'));
  const proto=existsSync(path.join(REVERSE_ROOT,'proto-py/bin/python'))&&existsSync(path.join(REVERSE_ROOT,'proto-re/proto_re.py'));
  if(this.settings.service_url&&(force||Date.now()-this.health.at>15000)){let ok=false;try{const res=await fetch(this.settings.service_url+'/api/health',{headers:this.token?{Authorization:'Bearer '+this.token}:{},signal:AbortSignal.timeout(3000)});ok=res.ok&&((await res.json()) as {ok?:boolean}).ok===true;}catch{}this.health={at:Date.now(),ok};}
  const components=[
   {key:'rea',name:"Reverse engine",state:reaConnected?'available':engine?'unconnected':'missing',detail:reaConnected?'MCP · '+(rows[0]?.count??0)+" tools":engine?"Local component installed, MCP not connected yet":''},
   {key:'native',name:"Native program analysis",state:native?'installed':'missing',detail:native?'Ghidra 12.1.4 / JDK 21':''},
   {key:'android',name:"Android Analysis",state:existsSync(path.join(REVERSE_ROOT,'extras/jadx-headless-mcp-0.7.1-all.jar'))&&existsSync(path.join(REVERSE_ROOT,'extras/apktool_3.0.3.jar'))&&existsSync(path.join(REVERSE_ROOT,'jdk/bin/java'))?'installed':'missing',detail:'JADX / Apktool'},
   {key:'protocol',name:"Protocol Analysis",state:proto?'installed':'missing',detail:proto?"TCP reassembly, message analysis and reconstruction verification":''},
   {key:'whitebox',name:"Code Analysis Service",state:!this.settings.service_url?'unconfigured':this.health.ok?'available':'unreachable',detail:''},
  ];
  return {settings:{...this.settings},components,resources:analysisSlots.status()};
 }
 async taskSummary(taskId:number){
  const rows=(await this.pool.query("SELECT id,title,payload,updated_at FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND payload->>'kind' IN ('code_source','code_ready','artifact_download') ORDER BY id DESC LIMIT 100",[taskId])).rows;
  const artifacts=rows.filter(r=>r.payload.kind==='code_source'||r.payload.kind==='artifact_download').map(r=>({id:String(r.id),name:r.payload.name??r.title,kind:r.payload.artifact_kind??'',size:r.payload.size??0,state:r.payload.kind==='artifact_download'?'saved':r.payload.import_error?'failed':r.payload.import_state==='done'?'indexed':'pending',updated_at:r.updated_at,sha256:r.payload.sha256??'',sourceType:r.payload.kind}));
  const sources=[...new Map(artifacts.slice().sort((a,b)=>Number(a.sourceType==='code_source')-Number(b.sourceType==='code_source')).map(r=>[r.sha256||r.id,r])).values()];
  const analyses=rows.filter(r=>r.payload.kind==='code_ready').map(r=>({id:String(r.id),name:r.payload.source_name??r.title,state:r.payload.audit_state??'skipped',findings:r.payload.audit_findings??0}));
  return {sources,analyses,clues:Number((await this.pool.query("SELECT count(*)::int n FROM exploration_nodes WHERE task_id=$1 AND kind='fact' AND payload->>'kind'='code_finding'",[taskId])).rows[0].n)};
 }
}
