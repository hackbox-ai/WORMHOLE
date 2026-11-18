import {availableToolKeys} from '../extensions/availability.ts';
import type {Pool} from 'pg';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {getTool,runTool,type ToolContext,type GateOptions} from './gate.ts';
const policies=new WeakMap<ToolDefinition[],{ctx:ToolContext;gate:GateOptions}>();
export function bindToolPolicy(tools:ToolDefinition[],ctx:ToolContext,gate:GateOptions):ToolDefinition[]{policies.set(tools,{ctx,gate});return tools;}
export function toolPolicy(tools:ToolDefinition[]){return policies.get(tools);}

/** The editable catalog changes prose/defaults/bindings, never handler types.
 * Builtin tools use the same documentation overlay. */
function decorate(base:Record<string,unknown>, docs:Record<string,unknown>):Record<string,unknown>{
  const result={...base};for(const k of ['description','default'])if(k in docs)result[k]=docs[k];
  const props=base.properties as Record<string,Record<string,unknown>>|undefined;
  if(props)result.properties=Object.fromEntries(Object.entries(props).map(([k,v])=>[k,decorate(v,((docs.properties as Record<string,Record<string,unknown>>|undefined)?.[k])??{})]));
  if(base.items&&typeof base.items==='object')result.items=decorate(base.items as Record<string,unknown>,(docs.items??{}) as Record<string,unknown>);
  return result;
}
export async function assembleTools(pool:Pool, keys:string[], ctx:ToolContext, gate:GateOptions):Promise<ToolDefinition[]>{
  gate={...gate,enforceInterceptScope:true};
  keys=await availableToolKeys(keys,ctx.taskId);
  if(ctx.taskId&&keys.includes('list_untested_assets')){
    const task=(await pool.query('SELECT coverage_enabled FROM tasks WHERE id=$1',[ctx.taskId])).rows[0];
    if(task?.coverage_enabled===false)keys=keys.filter(k=>k!=='list_untested_assets');
  }
  const records=await pool.query('SELECT key,enabled,agents,description,schema FROM tools WHERE key=ANY($1::text[])',[keys]);
  const rows=new Map(records.rows.map(r=>[r.key,r]));
  const tools=keys.flatMap(key=>{
    const tool=getTool(key);if(!tool)return [];
    const row=rows.get(key);if(row&&(!row.enabled||!(row.agents as string[]).includes(ctx.agentKey)))return [];
    const original=tool.schema??{type:'object',properties:Object.fromEntries(Object.entries(tool.params).map(([k,v])=>[k,{type:v}])),required:tool.required};
    const schema=decorate(original,row?.schema??{});
    return [{name:key,label:key,description:row?.description||tool.description,parameters:schema,
      execute:async(nativeToolCallId:string,raw:unknown,signal?:AbortSignal)=>{
        const params={...raw as Record<string,unknown>};
        for(const [k,p] of Object.entries((schema.properties??{}) as Record<string,Record<string,unknown>>))
          if((params[k]===undefined||params[k]===null||params[k]==='')&&['string','number','integer','boolean'].includes(String(p.type))&&p.default!==undefined)params[k]=p.default;
        const combined=ctx.signal&&signal?AbortSignal.any([ctx.signal,signal]):ctx.signal??signal;
        const result=await runTool(pool,key,params,{...ctx,signal:combined,nativeToolCallId},gate);
        if(result.status!=='executed')throw new Error(result.error??result.status);
        const rich=result.output as {content?:unknown[];structuredContent?:unknown}|undefined;
        // MCP text/image/resource blocks remain tool results, never JSON strings.
        const content=Array.isArray(rich?.content)?rich.content.map((block:any)=>
          block.type==='text'||block.type==='image'?block:{type:'text',text:JSON.stringify(block)}):[{type:'text',text:typeof result.output==='string'?result.output:JSON.stringify(result.output??null)}];
        return {content,details:{toolCallId:result.toolCallId,...(rich?.structuredContent!==undefined?{structuredContent:rich.structuredContent}:{})}};
      }
    } as unknown as ToolDefinition];
  });
  return bindToolPolicy(tools,ctx,gate);
}
