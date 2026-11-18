import type {Pool} from 'pg';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {assembleTools} from './assembly.ts';
import {registerTool,runTool,type ToolContext,type GateOptions} from './gate.ts';
import {executeCustom,ensureCustomSchema,schemaFingerprint,type CustomRecord} from './custom-executor.ts';
/** Each session pins schemas, and resolves side effects only from its own context. */
export async function customSessionTools(pool:Pool,ctx:ToolContext,gate:GateOptions){
 const rows=(await pool.query("SELECT * FROM tools WHERE system=FALSE AND enabled=TRUE AND kind<>'shell' AND agents @> $1::jsonb ORDER BY key",[JSON.stringify([ctx.agentKey])])).rows as CustomRecord[];
 const pinned=new Map(rows.map(row=>[row.key,ensureCustomSchema(row.schema)])),deferred=new Set(rows.filter(row=>row.deferred).map(row=>row.key));
 const current=async(key:string)=>{const row=(await pool.query('SELECT * FROM tools WHERE key=$1 AND system=FALSE',[key])).rows[0] as CustomRecord|undefined;
  if(!row?.enabled||!(row.agents??[]).includes(ctx.agentKey)||row.kind==='shell'||!pinned.has(key))throw new Error("Custom tool is not visible or has been unbound");
  if(schemaFingerprint(ensureCustomSchema(row.schema))!==schemaFingerprint(pinned.get(key)))throw new Error("Custom tool schema has changed, please rebuild the session");return row;
 };
 ctx.customSession={execute:async(key,params,nativeId,signal)=>{const row=await current(key);signal?.throwIfAborted();return executeCustom(pool,row,params,{...ctx,nativeToolCallId:nativeId,signal});}};
 for(const row of rows)registerTool({key:row.key,description:row.description??'',params:{},required:[],schema:pinned.get(row.key),execute:(params,context)=>{
  if(!context.customSession)throw new Error("Custom tool session not assembled");return context.customSession.execute(row.key,params,context.nativeToolCallId,context.signal);
 }});
 const search=async(query:string)=>{const q=query.trim();if(!q)throw new Error('Error: query is required');const matches=[];
  for(const row of rows){if(!deferred.has(row.key))continue;const hay=(row.key+' '+row.description).toLowerCase(),match=q.startsWith('select:')?q.slice(7).split(',').some(token=>token.trim()&&row.key.toLowerCase().includes(token.trim().toLowerCase())):q.toLowerCase().split(/\s+/).every(token=>hay.includes(token));if(!match)continue;await current(row.key);matches.push({name:row.key,description:row.description,input_schema:pinned.get(row.key)});}return matches;
 };
 const execute=async(key:string,params:Record<string,unknown>,nativeId?:string,signal?:AbortSignal)=>{
  await current(key);const result=await runTool(pool,key,params,{...ctx,nativeToolCallId:nativeId,signal:ctx.signal&&signal?AbortSignal.any([ctx.signal,signal]):ctx.signal??signal},{...gate,enforceInterceptScope:true});
  if(result.status!=='executed')throw new Error(result.error??result.status);return result.output;
 };
 const previous=ctx.mcpSession;
 if(deferred.size)ctx.mcpSession={
  call:(...args)=>{if(!previous)throw new Error("MCP session not assembled");return previous.call(...args);},
  invokeSkill:(...args)=>{if(!previous)throw new Error("Skill session not assembled");return previous.invokeSkill(...args);},
  search:async(query)=>[...(previous?await previous.search(query) as any[]:[]),...await search(query)],
  execute:(key,params,nativeId,signal)=>pinned.has(key)?execute(key,params,nativeId,signal):previous?previous.execute(key,params,nativeId,signal):Promise.reject(new Error("Delay tool does not exist"))
 };
 const tools=await assembleTools(pool,rows.filter(row=>!row.deferred).map(row=>row.key),ctx,gate);
 if(deferred.size)tools.push(...await assembleTools(pool,['SearchExtraTools','ExecuteExtraTool'],ctx,gate));
 const shellHints=(await pool.query("SELECT key,description FROM tools WHERE kind='shell' AND enabled=TRUE AND agents @> $1::jsonb ORDER BY key",[JSON.stringify([ctx.agentKey])])).rows.map(row=>'- '+row.key+': '+row.description);
 return {tools,deferred,shellHints};
}
