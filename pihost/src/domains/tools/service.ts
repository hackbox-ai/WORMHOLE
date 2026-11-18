import type {Pool} from 'pg';
import {appendEvent} from '../../events/ledger.ts';
import {registerTool,runTool,type ToolSchema,type ToolContext} from './gate.ts';
import {executeCustom,ensureCustomSchema,hasSchemaProps} from './custom-executor.ts';
import {goTrim} from '../assets/asset-match.ts';
export interface ToolRecord{key:string;system:boolean;description:string;schema:Record<string,unknown>;agents:string[];enabled:boolean;kind:string;exec:Record<string,unknown>;deferred:boolean;calls?:number}
const cols='key,system,description,schema,agents,enabled,kind,exec,deferred';
const validKind=(kind:unknown)=>['command','script','http','shell'].includes(String(kind));
export class ToolsService{
 constructor(private readonly pool:Pool,private readonly dlqPath:string){}
 async list():Promise<ToolRecord[]>{
  const rows=(await this.pool.query('SELECT '+cols+' FROM tools ORDER BY key')).rows;
  let counts=new Map<string,number>();try{counts=new Map((await this.pool.query('SELECT tool_key,count(*)::int AS calls FROM tool_usage GROUP BY tool_key')).rows.map(row=>[row.tool_key,row.calls]));}catch(error){console.warn('[tools] usage counts unavailable',String(error));}
  return rows.map(row=>({...row,agents:Array.isArray(row.agents)?row.agents:[],calls:counts.get(row.key)??0}));
 }
 async createCustom(input:Partial<ToolRecord>):Promise<{ok:true;tool:ToolRecord}|{ok:false;status:number;error:string}>{
  const key=goTrim(String(input.key??''));
  if(!/^[a-z][a-z0-9_]*$/.test(key))return {ok:false,status:400,error:"key must start with a lowercase letter and only contain lowercase letters/numbers/underscores"};
  if(!validKind(input.kind))return {ok:false,status:400,error:"kind needs to be command / script / http / shell"};
  if(input.kind==='http'&&!hasSchemaProps(input.schema))return {ok:false,status:400,error:"The http tool must provide parameter JSON Schema (cannot be left blank)"};
  const row=(await this.pool.query('INSERT INTO tools(key,system,description,schema,agents,enabled,kind,exec,deferred) VALUES($1,FALSE,$2,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb,$8) ON CONFLICT(key) DO NOTHING RETURNING '+cols,[key,input.description??'',JSON.stringify(input.schema===undefined?{}:input.schema),JSON.stringify(input.agents??null),input.enabled??false,input.kind,JSON.stringify(input.exec===undefined?{}:input.exec),input.deferred??false])).rows[0];
  if(!row)return {ok:false,status:409,error:"The key already exists (built-in or custom tool)"};
  await this.audit('tool_created',{key});return {ok:true,tool:row};
 }
 async updateCustom(key:string,input:Partial<ToolRecord>){
  const row=(await this.pool.query('SELECT system FROM tools WHERE key=$1',[key])).rows[0];if(!row||row.system)return {ok:false,status:400,error:"Only custom tools can be edited"};
  if(!validKind(input.kind))return {ok:false,status:400,error:"kind needs to be command / script / http / shell"};
  if(input.kind==='http'&&!hasSchemaProps(input.schema))return {ok:false,status:400,error:"The http tool must provide parameter JSON Schema (cannot be left blank)"};
  await this.pool.query('UPDATE tools SET description=$2,schema=$3::jsonb,agents=$4::jsonb,enabled=$5,kind=$6,exec=$7::jsonb,deferred=$8,updated_at=now() WHERE key=$1 AND system=FALSE',[key,input.description??'',JSON.stringify(input.schema===undefined?{}:input.schema),JSON.stringify(input.agents??null),input.enabled??false,input.kind,JSON.stringify(input.exec===undefined?{}:input.exec),input.deferred??false]);
  await this.audit('tool_updated',{key});return {ok:true,status:200};
 }
 async removeCustom(key:string){const row=await this.pool.query('DELETE FROM tools WHERE key=$1 AND system=FALSE',[key]);if(row.rowCount)await this.audit('tool_deleted',{key});return true;}
 async updateBuiltin(key:string,input:Partial<ToolRecord>){
  if(!(await this.pool.query('SELECT 1 FROM tools WHERE key=$1',[key])).rowCount)return {ok:false,status:404,error:"Tool does not exist: "+key};
  await this.pool.query('UPDATE tools SET description=$2,schema=$3::jsonb,agents=$4::jsonb,enabled=$5,updated_at=now() WHERE key=$1',[key,input.description??'',JSON.stringify(input.schema===undefined?{}:input.schema),JSON.stringify(input.agents??null),input.enabled??false]);
  await this.audit('tool_updated',{key});return {ok:true,status:200};
 }
 async reset(key:string){
  // Source UpsertToolForce resets prose/schema/binding/enabled only.
  // Existing kind/exec/deferred and original system flag are preserved.
  const row=await this.pool.query("INSERT INTO tools(key,system,description,schema,agents,enabled) SELECT key,TRUE,description,schema,agents,TRUE FROM tool_defaults WHERE key=$1 ON CONFLICT(key) DO UPDATE SET description=EXCLUDED.description,schema=EXCLUDED.schema,agents=EXCLUDED.agents,enabled=TRUE,updated_at=now() RETURNING key",[key]);
  if(!row.rowCount)return false;await this.audit('tool_reset',{key});return true;
 }
 async registerGateTools():Promise<void>{
  for(const row of (await this.pool.query('SELECT '+cols+" FROM tools WHERE enabled=TRUE AND system=FALSE AND kind<>'shell' ORDER BY key")).rows)registerTool(this.toolSchemaOf(row));
 }
 private toolSchemaOf(row:ToolRecord):ToolSchema{
  return {key:row.key,description:row.description,schema:ensureCustomSchema(row.schema),params:{},required:[],
   execute:async(params,ctx)=>{if(ctx.customSession)return ctx.customSession.execute(row.key,params,ctx.nativeToolCallId,ctx.signal);
    const latest=(await this.pool.query('SELECT '+cols+' FROM tools WHERE key=$1 AND system=FALSE',[row.key])).rows[0];
    if(!latest)throw new Error("Custom tool does not exist");return executeCustom(this.pool,latest,params,ctx);
   }};
 }
 async executeExec(row:ToolRecord,params:Record<string,unknown>,ctx:ToolContext={businessKind:'tools-test',businessId:row.key,agentKey:'auto',manualInvocation:true}):Promise<unknown>{return executeCustom(this.pool,row,params,ctx);}
 /** Original editor test runs an unsaved spec; no catalog save, usage meter or approval. */
 async testSpec(body:{kind?:string;exec?:unknown;params?:Record<string,unknown>},ctx:ToolContext){
  const kind=body.kind??'';if(kind==='shell')return {status:400,error:"Shell type tool is a bash environment declaration with no executable content"};
  if(!['command','script','http'].includes(kind))return {status:400,error:"Unknown tool type: "+kind};
  try{const result=await executeCustom(this.pool,{key:'test',kind,exec:body.exec},body.params??{},ctx);return {status:200,output:result.content.map(c=>c.text).join(''),is_error:false};}
  catch(error){return {status:200,output:error instanceof Error?error.message:String(error),is_error:true};}
 }
 async testCustom(key:string,params:Record<string,unknown>,intercept?:{gateRules():Promise<import('./gate.ts').InterceptRule[]>;requestApproval(toolCallId:number,reason?:string,timeoutMs?:number,timeoutAction?:'deny'|'allow'):Promise<'approved'|'denied'|'timeout'|'timeout-allow'>}):Promise<Record<string,unknown>>{
  const row=(await this.pool.query('SELECT '+cols+' FROM tools WHERE key=$1',[key])).rows[0];if(!row)return {status:'blocked',error:"Tool does not exist"};registerTool(this.toolSchemaOf(row));
  const result=await runTool(this.pool,key,params,{businessKind:'tools-test',businessId:key,agentKey:'auto',manualInvocation:true},{rules:await intercept?.gateRules(),requestApproval:(id,reason,ms,action)=>intercept?intercept.requestApproval(id,reason,ms,action):Promise.resolve('denied')});
  return {...result,output:result.output??null};
 }
 private audit(event:string,payload:Record<string,unknown>){return appendEvent(this.pool,this.dlqPath,{business_kind:'tools',business_id:'global',event_type:event,payload});}
}
