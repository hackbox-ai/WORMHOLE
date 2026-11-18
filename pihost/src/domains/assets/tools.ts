import type {Pool} from 'pg';
import {registerTool} from '../tools/gate.ts';
import seeds from '../tools/business-tool-seeds.json' with {type:'json'};
import {AssetContextService} from './context.ts';
import {CompaniesService} from './companies.ts';
export const ASSET_TOOLS={planner:['list_companies','list_assets','add_company_scope','add_task_scope','list_untested_assets'],worker:['list_assets'],mainagent:['list_assets','add_company_scope','add_task_scope','list_untested_assets']};
export function registerAssetTools(pool:Pool){const context=new AssetContextService(pool),companies=new CompaniesService(pool);
 const register=(key:string,execute:Parameters<typeof registerTool>[0]['execute'])=>{const seed=seeds.find(s=>s.Key===key)!;registerTool({key,description:seed.Desc,schema:seed.Schema,params:{},required:[],execute});};
 register('list_assets',async(p,ctx)=>{try{return await context.list(ctx.taskId??0,p);}catch(e){const message=(e as Error).message;if(message.startsWith("id/ids not passed"))throw e;throw new Error("DSL error: "+message);}});
 register('list_untested_assets',async(p,ctx)=>context.untested(ctx.taskId??0,String(p.type??'').trim(),Number(p.page)||1,Number(p.page_size)||10));
 register('add_task_scope',async(p,ctx)=>{if(!ctx.taskId)throw new Error("add_task_scope requires task context (currently no task)");const items=Array.isArray(p.entries)&&p.entries.length?p.entries:[p];const added:Record<string,unknown>[]=[],errors:Record<string,string>={};
  for(const [i,item] of items.entries()){try{added.push(await context.addScope(ctx.taskId,String(item.kind??'').trim(),String(item.value??''),String(p.reason??'')));}catch(e){errors[String(i)]=(e as Error).message;}}
  return {added:added.length?added:null,...(Object.keys(errors).length?{errors}:{})};
 });
 register('list_companies',async p=>{const q=String(p.search??'').trim().toLowerCase(),rows=(await companies.list())??[];const result=rows.filter(r=>!q||r.name.toLowerCase().includes(q)).map(r=>({id:r.id,name:r.name,asset_count:r.asset_count,scope:r.scope.map(s=>s.raw)}));return {count:result.length,companies:result};});
 register('add_company_scope',async p=>{const name=String(p.company??'');if(!name.trim())throw new Error("company cannot be empty");let company;try{company=await companies.create(name,String(p.logo??''),[],true);}catch(e){throw new Error("Failed to create/get company: "+(e as Error).message);}
  const lines=String(p.scope??'').split('\n').map(value=>value.trim()).filter(Boolean).map(value=>({value}));const result=await companies.updateScope(company.id,lines,String(p.reason??''));return {company_id:company.id,...result};
 });
}
