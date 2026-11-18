/** Seven original host operations: actual files/catalog records, never prompt-only shims. */
import type {Pool} from 'pg';
import {registerTool} from './gate.ts';
import {ToolsService,type ToolRecord} from './service.ts';
import type {SkillsService} from '../skills/service.ts';
import type {McpService,McpServerRecord} from '../mcp/service.ts';
import {goTrim} from '../assets/asset-match.ts';
import seeds from './platform-tool-seeds.json' with {type:'json'};
export const PLATFORM_MANAGEMENT=seeds.filter(s=>['create_skill','update_skill_file','create_custom_tool','update_custom_tool','create_mcp','update_mcp','delete_assets_by_host'].includes(s.key));
export function registerPlatformManagement(pool:Pool,skills:SkillsService,mcp:McpService,dlqPath:string):void{
 const tools=new ToolsService(pool,dlqPath);
 for(const seed of PLATFORM_MANAGEMENT)registerTool({key:seed.key,description:seed.description,schema:seed.schema,params:{},required:[],execute:async p=>{
  if(seed.key==='create_skill')return skills.createForAgent(String(p.name??''),String(p.description??''),String(p.instructions??''));
  if(seed.key==='update_skill_file')return skills.writeForAgent(String(p.name??''),String(p.file??''),String(p.content??''));
  if(seed.key==='create_custom_tool'||seed.key==='update_custom_tool'){
   const key=seed.key==='create_custom_tool'?goTrim(String(p.key??'')):String(p.key??'');
   if(seed.key==='create_custom_tool'&&!/^[a-z][a-z0-9_]*$/.test(key))throw new Error("key must start with a lowercase letter and only contain lowercase letters/numbers/underscores");
   if(seed.key==='update_custom_tool'){const row=(await pool.query('SELECT system FROM tools WHERE key=$1',[key])).rows[0];if(!row||row.system)throw new Error("Only custom tools can be modified: "+key);}
   if(!['shell','command','script','http'].includes(String(p.kind)))throw new Error("kind needs to be shell / command / script / http");
   const input={...p,key,enabled:p.enabled??true} as Partial<ToolRecord>;
   const result=seed.key==='create_custom_tool'?await tools.createCustom(input):await tools.updateCustom(key,input);
   if(!result.ok){if('status'in result&&result.status===409)throw new Error("The key already exists: "+key);throw new Error('error'in result?result.error:"Custom tool operation failed");}
   await tools.registerGateTools();return 'custom tool '+(seed.key==='create_custom_tool'?'created':'updated')+': '+key;
  }
  if(seed.key==='create_mcp'||seed.key==='update_mcp'){
   if(seed.key==='create_mcp'&&(!goTrim(String(p.name??''))||!goTrim(String(p.transport??''))))throw new Error("name / transport required");
   if(seed.key==='update_mcp'&&!Number(p.id))throw new Error("id required");
   const record={...p,id:seed.key==='create_mcp'?0:Number(p.id),enabled:p.enabled??true,insecure:p.insecure??false} as unknown as McpServerRecord;
   const id=await mcp.save(record,{discover:false});return seed.key==='create_mcp'?`mcp created: id=${id} name=${p.name}`:`mcp updated: id=${id}`;
  }
  const host=String(p.host??'');if(!goTrim(host))throw new Error("host cannot be empty");
  // Exact source DeleteByHost predicate, including root-domain descendant linkage.
  // Native execution enters B06 first; tests use owned isolated schemas only.
  const normalized=Array.from(goTrim(host),c=>c==='\u0130'?'i':c.toLowerCase()).join('').replace(/\.$/,'');
  if(!normalized)throw new Error("Delete failed: host is required");
  try{const rows=(await pool.query('DELETE FROM assets WHERE domain=$1 OR root_domain=$1 OR ip=$1 RETURNING type',[normalized])).rows;
   const counts:Record<string,number>={};for(const row of rows)counts[row.type]=(counts[row.type]??0)+1;return {host,deleted:rows.length,deleted_by_type:counts};
  }catch(error){throw new Error("Delete failed: "+(error instanceof Error?error.message:String(error)));}
 }});
}
