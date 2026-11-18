import {openSync,readSync,closeSync} from 'node:fs';
import type {Pool} from 'pg';
import {registerTool} from '../tools/gate.ts';
import {assembleTools,toolPolicy} from '../tools/assembly.ts';
import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {TrafficRuntime} from './runtime.ts';
import seeds from './tool-seeds.json' with {type:'json'};
let runtime:(()=>TrafficRuntime|null)=()=>null;
export const TRAFFIC_TOOL_NAMES=seeds.map(s=>s.key);
export function trafficCaptureEnabled():boolean{return runtime()?.enabled()??false;}
export function bindTrafficRuntime(fn:(()=>TrafficRuntime|null)|null){runtime=fn??(()=>null);}
const clip=(s:string,max:number)=>{const b=Buffer.from(s);return b.length<=max?s:b.subarray(0,max).toString('utf8')+`
... [truncated, total ${b.length} Bytes; complete in traffic file tree] ...`;};
export function registerTrafficTools(){
  for(const seed of seeds)registerTool({key:seed.key,description:seed.description,schema:seed.schema,params:{},required:[],execute:async (p,ctx)=>{
    const store=runtime()?.store;if(!store)throw new Error('traffic disabled');
    switch(seed.key){
      case 'traffic_search':{const rows=store.search(String(p.host??''),String(p.contains??''),String(p.body_contains??''),Number(p.page)||0,Number(p.limit)||0,ctx.taskId);
        return rows.length?JSON.stringify(rows.map(r=>({id:r.id,method:r.method,url:r.url,status:r.status,resp_len:r.resp_len}))):"No matching traffic.";}
      case 'traffic_get':{if(ctx.taskId&&store.context(String(p.id))?.taskId!==ctx.taskId)throw new Error("Traffic does not belong to the current task");const raw=store.get(String(p.id??''));return '=== REQUEST ===\n'+clip(raw.req,2500)+'\n\n=== RESPONSE ===\n'+clip(raw.resp,4000);}
      case 'traffic_blob':{
        if(ctx.taskId&&!store.hasBlob(ctx.taskId,String(p.hash??'')))throw new Error("The text does not belong to the current task");
        const offset=Number(p.offset)||0,length=Number(p.length)>0&&Number(p.length)<=8192?Number(p.length):8192,b=store.blobFile(String(p.hash??''));
        const start=Math.max(0,offset),count=Math.min(length,Math.max(0,b.size-start));if(!count)return `Offset ${offset} Content length exceeded (total length ${b.size} bytes).`;
        const bytes=Buffer.alloc(count),fd=openSync(b.file,'r');try{readSync(fd,bytes,0,count,start);}finally{closeSync(fd);}
        const header=`[offset=${offset} This time=${bytes.length} Total length =${b.size}]\n`;return header+(bytes.subarray(0,512).includes(0)?"Binary content, showing first 512 bytes in hexadecimal:\n"+bytes.subarray(0,512).toString('hex'):bytes.toString('utf8'));
      }
      default:throw new Error('unknown traffic tool');
    }
  }});
}
export async function sessionTrafficTools(pool:Pool,existing:ToolDefinition[]):Promise<ToolDefinition[]>{
  const policy=toolPolicy(existing);if(!policy||!runtime()?.enabled())return[];
  return assembleTools(pool,TRAFFIC_TOOL_NAMES.filter(name=>!existing.some(t=>t.name===name)),policy.ctx,policy.gate);
}
