import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
export async function routeFindingReports(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void){
 const match=/^\/api\/exploration\/findings\/([1-9]\d*)\/report(?:\/(retry|cancel|versions\/([1-9]\d*)))?$/.exec(url.pathname);
 const bulk=url.pathname==='/api/finding-reports/backfill';
 if(!match&&!bulk)return false;
 if(!ctx.findingReports){json(res,503,{error:"Reporting job service is unavailable"});return true;}
 try{
  if(bulk&&req.method==='POST'){const b=await readObject(req,16000);if(!Array.isArray(b.finding_ids))throw new Error("finding_ids must be an array");json(res,200,await ctx.findingReports.backfill(b.finding_ids.map(Number),b.dry_run!==false));return true;}
  if(!match)return false;const id=Number(match[1]),action=match[2];
  if(!await ctx.findings.get(id)){json(res,404,{error:"Found not to exist"});return true;}
  if(req.method==='GET'&&!action)json(res,200,await ctx.findingReports.detail(id));
  else if(req.method==='GET'&&match[3]){const row=(await ctx.pool.query('SELECT id,body,evidence_version,created_at FROM finding_report_versions WHERE finding_id=$1 AND id=$2',[id,match[3]])).rows[0];json(res,row?200:404,row??{error:"Version does not exist"});}
  else if(req.method==='POST'&&action==='retry')json(res,202,await ctx.findingReports.request(id,true));
  else if(req.method==='POST'&&action==='cancel')json(res,200,await ctx.findingReports.cancel(id));
  else return false;
 }catch(e){json(res,(e as {status?:number}).status??400,{error:(e as Error).message});}
 return true;
}
