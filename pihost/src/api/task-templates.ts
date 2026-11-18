import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {readObject} from './json-body.ts';
import {validateAssetRule} from '../domains/assets/asset-match.ts';

const dto=(r:Record<string,any>)=>({...r,id:Number(r.id),description:r.description??'',goal:r.goal??'',category_id:r.category_id==null?null:Number(r.category_id),intercept_rules:Array.isArray(r.intercept_rules)?r.intercept_rules:[]});
function fields(body:Record<string,unknown>,partial=false){
 const out:Record<string,unknown>={};
 for(const key of ['name','description','goal','category']){
  if(partial&&body[key]===undefined)continue;
  if(body[key]!=null&&typeof body[key]!=='string')throw new Error(key+" Must be a string");
  out[key]=String(body[key]??'');
 }
 if(out.name!==undefined){out.name=String(out.name).trim();if(!out.name)throw new Error("name cannot be empty");}
 if(!partial||body.category_id!==undefined){
  const id=body.category_id;
  if(id!=null&&(!Number.isSafeInteger(id)||Number(id)<=0))throw new Error("Invalid classification number");
  out.category_id=id??null;
 }
 if(!partial||body.intercept_rules!==undefined){
  const rules=body.intercept_rules??[];
  if(!Array.isArray(rules)||rules.length>100)throw new Error("Template rules must be an array of up to 100 items");
  out.intercept_rules=rules.map(rule=>{
   if(!rule||typeof rule!=='object'||Array.isArray(rule))throw new Error("Template rules must be rule objects");
   const error=validateAssetRule(rule,true);if(error)throw new Error(error);
   return {action:rule.action??'block',kind:rule.kind,pattern:rule.pattern,note:rule.note??'',enabled:rule.enabled!==false};
  });
 }
 return out;
}
export async function routeTaskTemplates(req:IncomingMessage,res:ServerResponse,url:URL,pool:Pool,json:(r:ServerResponse,s:number,v:unknown)=>void):Promise<boolean>{
 if(!/^\/api\/task-templates(?:\/\d+)?$/.test(url.pathname))return false;
 const id=url.pathname.match(/\/(\d+)$/)?.[1];
 try{
  if(!id&&req.method==='GET'){const r=await pool.query('SELECT * FROM task_templates ORDER BY id');json(res,200,{templates:r.rows.map(dto)});return true;}
  if(!id&&req.method==='POST'){
   const p=fields(await readObject(req,65536));
   const r=await pool.query('INSERT INTO task_templates(name,description,goal,category,category_id,intercept_rules) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(name) DO UPDATE SET description=EXCLUDED.description,goal=EXCLUDED.goal,category=EXCLUDED.category,category_id=EXCLUDED.category_id,intercept_rules=EXCLUDED.intercept_rules,updated_at=now() RETURNING *',[p.name,p.description,p.goal,p.category,p.category_id,JSON.stringify(p.intercept_rules)]);
   json(res,200,dto(r.rows[0]));return true;
  }
  if(id&&req.method==='PATCH'){
   const p=fields(await readObject(req,65536),true),keys=Object.keys(p);
   if(!keys.length)throw new Error("No template fields to update");
   const values=keys.map(k=>k==='intercept_rules'?JSON.stringify(p[k]):p[k]);
   const set=keys.map((k,i)=>k+'=$'+(i+2)+(k==='intercept_rules'?'::jsonb':'')).join(',');
   const r=await pool.query('UPDATE task_templates SET '+set+',updated_at=now() WHERE id=$1 RETURNING *',[id,...values]);
   json(res,r.rowCount?200:404,r.rowCount?dto(r.rows[0]):{error:"Template does not exist"});return true;
  }
  if(id&&req.method==='DELETE'){
   const r=await pool.query('DELETE FROM task_templates WHERE id=$1',[id]);json(res,r.rowCount?200:404,r.rowCount?{deleted:Number(id),status:'ok'}:{error:"Template does not exist"});return true;
  }
  json(res,405,{error:"Unsupported operation"});
 }catch(error){
  const e=error as Error&{code?:string};
  json(res,e.code==='23505'?409:400,{error:e.code==='23505'?"Template name already exists":e.code==='23503'?"Template category does not exist":e.message});
 }
 return true;
}
