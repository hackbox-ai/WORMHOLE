import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
import type {AgentCreateInput} from "../domains/agents/creation.ts";
import {promptDefaults} from '../domains/agents/service.ts';
type Json=(res:ServerResponse,status:number,value:unknown)=>void;
function failure(message:string,status=400):never{throw Object.assign(new Error(message),{status});}
const numeric=['max_turns','run_seconds','trigger_max_parallel'];
async function visibility(ctx:AppContext,key:string){
 const rows=(await ctx.pool.query("SELECT resource_kind,resource_id FROM agent_visibility WHERE agent_key=$1 ORDER BY resource_id",[key])).rows;
 const mcp=rows.filter(r=>r.resource_kind==='mcp').map(r=>Number(r.resource_id)).filter(Number.isFinite).sort((a,b)=>a-b);
 return {mcp:mcp.length?mcp:null,skill:rows.filter(r=>r.resource_kind==='skill').map(r=>String(r.resource_id))};
}
function dto(raw:Record<string,any>,list=false){
 const {wrapup_prompt,wrapup_max_turns,task_timeout_wrapup_prompt,task_timeout_wrapup_max_turns,...agent}=raw;
 return {...agent,id:String(agent.id),llm_profile_id:agent.llm_profile_id==null?null:Number(agent.llm_profile_id),mcp_count:list?Number(agent.mcp_count??0):0,skill_count:list?Number(agent.skill_count??0):0,tool_count:list?Number(agent.tool_count??0):0};
}
export async function routeAgents(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:Json):Promise<boolean>{
 const match=/^\/api\/agents(?:\/([^/]+)(\/.*)?)?$/.exec(url.pathname);if(!match)return false;
 try{
  if(!match[1]){
   if(req.method==='GET'){json(res,200,{agents:(await ctx.agents.list()).map(a=>dto(a,true))});return true;}
   if(req.method==='POST'){
    const body=await readObject(req,Number.MAX_SAFE_INTEGER,true);
    for(const field of ['key','name','description'])if(body[field]!=null&&typeof body[field]!=='string')failure('json: cannot unmarshal '+typeof body[field]+' into Go struct field .'+field+' of type string');
    const r=await ctx.agents.create(body as AgentCreateInput);
    json(res,r.ok?200:r.status,r.ok?dto(r.agent):{error:r.error});return true;
   }
   return false;
  }
  if(match[1]==='create-options'){
    const defaults=promptDefaults.wrapup.custom!;
    if(req.method==='GET'&&!match[2]){
     const profiles=(await ctx.pool.query("SELECT id,name,model,is_default FROM llm_profiles ORDER BY id")).rows.map(p=>({...p,id:Number(p.id)}));
     json(res,200,{agent:{id:"",key:"",name:"",description:"",role:"assistant",builtin:false,enabled:true,max_turns:0,run_seconds:1200,web_search:false,interactive_shell:false,trigger_run_mode:"serial",trigger_merge_mode:"all",trigger_max_parallel:5},
      prompt:promptDefaults.assistant,variables:await ctx.agents.catalog(""),versions:[],visibility:{mcp:[],skill:[]},llm_profiles:profiles,
      wrapup_default:defaults.prompt,wrapup_max_turns_default:defaults.turns,task_timeout_wrapup_supported:!!defaults.task_timeout,task_timeout_wrapup_default:defaults.task_timeout,task_timeout_wrapup_max_turns_default:defaults.turns});return true;
    }
    if(req.method==='POST'&&match[2]==='/preview'){
     const body=await readObject(req,Number.MAX_SAFE_INTEGER,true);
     if(body.template!=null&&typeof body.template!=='string')failure("template must be text");
     json(res,200,await ctx.agents.previewPrompt("",body.template||promptDefaults.assistant));return true;
    }
    json(res,405,{error:"method not allowed"});return true;
  }
  const key=decodeURIComponent(match[1]),sub=match[2]??'',raw=await ctx.agents.raw(key);
  if(!raw){json(res,404,{error:'agent not found'});return true;}
  const defaults=promptDefaults.wrapup[key]??promptDefaults.wrapup.custom!;
  const versions=async()=>(await ctx.agents.prompts(key)).map((p:any)=>({version:Number(p.version),template_text:p.prompt,...(p.note?{note:p.note}:{}),ts:p.created_at??p.updated_at}));
  if(!sub&&req.method==='GET'){
   const profiles=(await ctx.pool.query("SELECT id,name,model,is_default FROM llm_profiles ORDER BY id")).rows.map(p=>({...p,id:Number(p.id)}));
   json(res,200,{agent:dto(raw),prompt:await ctx.agents.latestPrompt(key),variables:await ctx.agents.catalog(key),versions:await versions(),visibility:await visibility(ctx,key),llm_profiles:profiles,
    wrapup_prompt:raw.wrapup_prompt,wrapup_default:defaults.prompt,wrapup_max_turns:raw.wrapup_max_turns,wrapup_max_turns_default:defaults.turns,
    task_timeout_wrapup_supported:!!defaults.task_timeout,task_timeout_wrapup_prompt:raw.task_timeout_wrapup_prompt,task_timeout_wrapup_default:defaults.task_timeout,task_timeout_wrapup_max_turns:raw.task_timeout_wrapup_max_turns,task_timeout_wrapup_max_turns_default:defaults.turns});return true;
  }
  if(!sub&&req.method==='DELETE'){const r=await ctx.agents.remove(key);json(res,r.ok?200:r.status,r.ok?{deleted:key}:{error:r.error});return true;}
  if(!sub&&req.method==='PATCH'){
   if(raw.builtin)failure("The name/description of the built-in agent cannot be modified");const body=await readObject(req,Number.MAX_SAFE_INTEGER,true);
   if(body.name!=null&&typeof body.name!=='string'||body.description!=null&&typeof body.description!=='string')failure('name/description must be strings');
   const name=String(body.name??'').trim();if(!name)failure("Name cannot be empty");
   await ctx.agents.update(key,{name,description:body.description??''});json(res,200,{ok:true});return true;
  }
  if(sub==='/config'&&req.method==='PUT'){
   const body=await readObject(req,Number.MAX_SAFE_INTEGER,true),patch:Record<string,any>={},response:Record<string,unknown>={ok:true};
   for(const field of numeric)if(body[field]!=null){if(!Number.isSafeInteger(body[field]))failure(field+" Format error");patch[field]=Math.max(0,body[field]);if(field!=='trigger_max_parallel')response[field]=body[field];}
   for(const field of ['web_search','interactive_shell'])if(body[field]!=null){if(typeof body[field]!=='boolean')failure(field+" Format error");patch[field]=body[field];}
   if(Object.hasOwn(body,'llm_profile_id')){
    const id=body.llm_profile_id;if(id!=null&&!Number.isSafeInteger(id))failure("llm_profile_id format error");
    if(id!=null&&!((await ctx.pool.query("SELECT id FROM llm_profiles WHERE id=$1 AND trim(api_key)<>''",[id])).rowCount))failure("The specified LLM configuration does not exist or is invalid");
    patch.llm_profile_id=id;
   }
   for(const field of ['trigger_run_mode','trigger_merge_mode'])if(body[field]!=null){if(typeof body[field]!=='string')failure(field+" Format error");patch[field]=body[field];}
   if(patch.trigger_run_mode!==undefined&&!['serial','parallel'].includes(patch.trigger_run_mode))patch.trigger_run_mode='serial';
   if(patch.trigger_merge_mode!==undefined&&!['by_task','all','none'].includes(patch.trigger_merge_mode))patch.trigger_merge_mode='by_task';
   await ctx.agents.update(key,patch);json(res,200,response);return true;
  }
  if(sub==='/prompts'&&req.method==='GET'){json(res,200,{versions:await versions()});return true;}
  if(sub==='/variables'&&req.method==='GET'){json(res,200,{variables:await ctx.agents.catalog(key)});return true;}
  if(sub==='/prompt'&&req.method==='PUT'){
   const body=await readObject(req,Number.MAX_SAFE_INTEGER,true);
   for(const field of ['template','note'])if(body[field]!=null&&typeof body[field]!=='string')failure(field+' must be a string');
   const template=body.template??'',error=await ctx.agents.validatePrompt(key,template);if(error)failure(error);
   const r=await ctx.agents.putPrompt(key,template,body.note??'');json(res,200,{version:r.version});return true;
  }
  if(sub==='/prompt/preview'&&req.method==='POST'){
   let body:Record<string,any>={};try{body=await readObject(req,Number.MAX_SAFE_INTEGER,true);}catch{}
   const sample=body.sample&&typeof body.sample==='object'&&!Array.isArray(body.sample)?Object.fromEntries(Object.entries(body.sample).filter(([,v])=>typeof v==='string')) as Record<string,string>:{};
   json(res,200,await ctx.agents.previewPrompt(key,typeof body.template==='string'?body.template:'',sample));return true;
  }
  if(sub==='/prompt/reset'&&req.method==='POST'){const r=await ctx.agents.resetPrompt(key);json(res,200,{version:r.version});return true;}
  if(sub==='/visibility'){
   if(req.method==='GET'){json(res,200,await visibility(ctx,key));return true;}
   if(req.method==='PUT'){
    const body=await readObject(req,Number.MAX_SAFE_INTEGER,true),mcp=body.mcp??[],skill=body.skill??[];
    if(!Array.isArray(mcp)||!mcp.every(x=>x===null||Number.isSafeInteger(x)))failure('mcp must be an integer array');
    if(!Array.isArray(skill)||!skill.every(x=>x===null||typeof x==='string'))failure('skill must be a string array');
    const c=await ctx.pool.connect();try{await c.query('BEGIN');await c.query("DELETE FROM agent_visibility WHERE agent_key=$1 AND resource_kind IN ('mcp','skill')",[key]);
     for(const [kind,ids] of [['mcp',mcp.map(x=>String(x??0))],['skill',skill.map(x=>x??'')]] as const)for(const id of ids)await c.query("INSERT INTO agent_visibility(agent_key,resource_kind,resource_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[key,kind,id]);await c.query('COMMIT');
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    json(res,200,{ok:true});return true;
   }
  }
  if(sub==='/triggers'){
   if(req.method==='GET'){json(res,200,{triggers:await ctx.agents.triggers(key)});return true;}
   if(req.method==='POST'){json(res,200,await ctx.agents.addTrigger(key,await readObject(req,Number.MAX_SAFE_INTEGER,true)));return true;}
  }
  if((sub==='/wrapup'||sub==='/wrapup/task-timeout')&&req.method==='PUT'){
   const body=await readObject(req,Number.MAX_SAFE_INTEGER,true);
   if(body.prompt!=null&&typeof body.prompt!=='string')failure('prompt must be a string');
   if(body.max_turns!=null&&!Number.isSafeInteger(body.max_turns))failure('max_turns must be an integer');
   const timeout=sub.endsWith('task-timeout'),prefix=timeout?'task_timeout_wrapup_':'wrapup_';
   await ctx.agents.update(key,{[prefix+'prompt']:body.prompt??'',...(body.max_turns==null?{}:{[prefix+'max_turns']:Math.max(0,body.max_turns)})});json(res,200,{ok:true});return true;
  }
  if((sub==='/wrapup/reset'||sub==='/wrapup/task-timeout/reset')&&req.method==='POST'){
   const timeout=sub.includes('task-timeout'),prefix=timeout?'task_timeout_wrapup_':'wrapup_';
   await ctx.agents.update(key,{[prefix+'prompt']:'',[prefix+'max_turns']:0});
   json(res,200,{ok:true,[prefix+'default']:timeout?defaults.task_timeout:defaults.prompt,[prefix+'max_turns_default']:defaults.turns});return true;
  }
  return false;
 }catch(error){const e=error as Error&{status?:number};if(e.status||error instanceof SyntaxError){json(res,e.status??400,{error:e.message});return true;}throw error;}
}

