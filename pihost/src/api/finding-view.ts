import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {FindingView,findingDTO} from '../domains/findings/view.ts';
import {FINDING_STATUSES} from '../domains/findings/status.ts';
import {readObject} from './json-body.ts';
import {findingFilename,findingMarkdown,findingsMarkdown,findingsCSV,reportTime} from '../domains/findings/report.ts';
import {trafficSummary} from '../domains/findings/evidence.ts';
import {zipSync,unzipSync} from 'fflate';
const pagination=(raw:string|null,fallback:number,max=0)=>{const n=raw!==null&&/^[+-]?\d+$/.test(raw)?Number(raw):fallback;return !Number.isSafeInteger(n)||n<=0?fallback:max?Math.min(max,n):n;};
export async function routeFindingView(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void):Promise<boolean>{
 const base='/api/exploration/findings',detail=/^\/api\/exploration\/findings\/([^/]+)$/.exec(url.pathname),name=url.pathname;
 if(req.method!=='GET'&&(!detail||!['PATCH','DELETE'].includes(req.method??'')))return false;
 if(![base,base+'/stats',base+'/groups',base+'/asset-tree',base+'/export'].includes(name)&&!detail)return false;
 if(detail&&req.method==='GET'&&['stats','groups','asset-tree','export'].includes(detail[1]!)){}else if(detail){const id=Number(detail[1]);if(!/^[+]?[0-9]+$/.test(detail[1]!)||!Number.isSafeInteger(id)||id<=0){json(res,400,{error:'bad finding id'});return true;}}
 const view=new FindingView(ctx.pool),q=url.searchParams;
 try{
  if(detail&&req.method==='DELETE'){const id=Number(detail[1]);if(!await ctx.findings.remove(id)){json(res,404,{error:'finding not found'});return true;}json(res,200,{deleted:true,id});return true;}
  if(detail&&req.method==='PATCH'){
   const id=Number(detail[1]);let body:Record<string,any>;try{body=await readObject(req,Number.MAX_SAFE_INTEGER);for(const k of ['status','severity','name','vulnclass'])if(body[k]!=null&&typeof body[k]!=='string')throw new Error('invalid '+k);}catch(e){json(res,400,{error:'bad json: '+(e as Error).message});return true;}
   if(['status','severity','name','vulnclass'].every(k=>body[k]==null)){json(res,400,{error:'nothing to update: provide status/severity/name/vulnclass'});return true;}
   // Preserve source order/partial-commit behavior across independent fields.
   if(body.status!=null){if(!FINDING_STATUSES.includes(body.status)){json(res,400,{error:'bad status: '+body.status});return true;}const r=await ctx.findings.changeStatus(id,body.status);if(!r.ok){json(res,r.status,{error:'finding not found'});return true;}}
   for(const k of ['severity','name','vulnclass'] as const){if(body[k]==null)continue;if(k==='severity'&&!['critical','high','medium','low'].includes(body[k])){json(res,400,{error:'bad severity: '+body[k]});return true;}if(!await ctx.findings.setColumn(id,k,k==='severity'?body[k]:body[k].trim())){json(res,404,{error:'finding not found'});return true;}}
   json(res,200,await view.detail(id));return true;
  }
  if(name===base){if(q.get('task')){json(res,200,await view.task(Number(q.get('task'))||0));return true;}if(!q.get('page')&&!q.get('limit')){json(res,200,(await view.list(q)).items);return true;}const page=pagination(q.get('page'),1),size=pagination(q.get('limit'),20,200);json(res,200,{...await view.list(q,page,size),page,page_size:size});return true;}
  if(name===base+'/stats'){json(res,200,await view.stats());return true;}
  if(name===base+'/groups'){json(res,200,await view.groups(q,pagination(q.get('page'),1),pagination(q.get('limit'),10,100)));return true;}
  if(name===base+'/asset-tree'){json(res,200,await view.tree(q));return true;}
  if(name===base+'/export'){
   const ids:string[]=[],scope=q.get('scope')??'',format=q.get('format')??'';
   if(scope==='selected'){for(const part of (q.get('ids')??'').split(',')){const raw=part.trim();if(!raw)continue;if(!/^[+]?[0-9]+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<=0){json(res,400,{error:'bad finding id: '+raw});return true;}ids.push(String(Number(raw)));}if(!ids.length){json(res,400,{error:'no findings selected'});return true;}}
   else if(!['all','filtered',''].includes(scope)){json(res,400,{error:'bad scope: '+scope});return true;}
   const store=ctx.findings.evidenceStore;if(!store){json(res,503,{error:"Traffic evidence storage is unavailable"});return true;}
   const exportQuery=scope==='all'?new URLSearchParams():q,now=new Date(),stamp=reportTime(now).replaceAll('-','').replaceAll(':','').replace(' ','-');
   // Evidence lock freezes report+versions+bindings and verifies private body
   // copies before any download header. No ZIP worker reads disposable traffic.
   const staged=await store.transaction(async c=>{const rows=await view.exportRows(exportQuery,ids,c),bodies=new Map<string,Buffer>();for(const f of rows){const list=await store.listTx(c,Number(f.id));f.evidence_version=list.version;f.report_evidence_version=list.report_version;f.traffic_bindings=list.bindings;f.traffic_count=list.bindings.length;for(const b of format==='md-zip'?list.bindings:[])for(const side of ['request','response']){const h=side==='request'?b.snapshot.req_hash:b.snapshot.resp_hash;if(!bodies.has(h))bodies.set(h,store.body(b.snapshot,side));}}return{rows,bodies,assets:await view.assets(rows,c)};});
   let bytes:Buffer,type:string,suffix:string;
   if(format==='json'){bytes=Buffer.from(JSON.stringify(staged.rows.map(f=>findingDTO({...f,traffic_bindings:trafficSummary({finding_id:String(f.id),version:f.evidence_version,report_version:f.report_evidence_version,bindings:f.traffic_bindings}).bindings},staged.assets)),null,2)+'\n');type='application/json; charset=utf-8';suffix='json';}
   else if(format==='csv'){bytes=Buffer.from(findingsCSV(staged.rows));type='text/csv; charset=utf-8';suffix='csv';}
   else if(format==='md-single'){bytes=Buffer.from(findingsMarkdown(staged.rows,now));type='text/markdown; charset=utf-8';suffix='md';}
   else if(format==='md-zip'){const entries:Record<string,Uint8Array>={},used=new Map<string,number>();for(const f of staged.rows){const filename=findingFilename(f),n=used.get(filename)??0;used.set(filename,n+1);entries[n?filename.slice(0,-3)+'-'+(n+1)+'.md':filename]=Buffer.from(findingMarkdown(f,now));for(const b of f.traffic_bindings){const prefix=`evidence/${f.id}/${b.id}/`;entries[prefix+'manifest.json']=Buffer.from(JSON.stringify(b)+'\n');for(const side of ['request','response']){const h=side==='request'?b.snapshot.req_hash:b.snapshot.resp_hash,head=side==='request'?b.snapshot.req_head??'':b.snapshot.resp_head??'',body=staged.bodies.get(h)!;entries[prefix+side+'.bin']=body;entries[prefix+side+'.http']=Buffer.concat([Buffer.from(head.replace(/[\r\n]+$/,'')+'\n\n'),body]);}}}bytes=Buffer.from(zipSync(entries));const verified=unzipSync(bytes);for(const [key,body] of Object.entries(entries))if(!Buffer.from(verified[key]??[]).equals(Buffer.from(body)))throw new Error('export ZIP validation failed');type='application/zip';suffix='zip';}
   else{json(res,400,{error:'bad format: '+format});return true;}
   res.writeHead(200,{'Content-Type':type,'Content-Disposition':`attachment; filename="findings-${stamp}.${suffix}"`,'Content-Length':bytes.length});res.end(bytes);return true;
  }
  if(detail){const id=Number(detail[1]),f=await view.detail(id);if(!f){json(res,404,{error:'finding not found'});return true;}const context=q.get('context_task')?.trim();if(context){const store=ctx.findings.evidenceStore;if(!store){json(res,503,{error:"Traffic evidence storage is unavailable"});return true;}const denied=await store.access(id,Number(context),false);if(denied){json(res,404,{error:denied});return true;}if(String(f.task_id)!==String(Number(context))){f.source_task_id=f.task_id;f.inherited=true;}else f.source_task_id=String(Number(context));}json(res,200,f);return true;}
 }catch(e){json(res,500,{error:(e as Error).message});return true;}return false;
}
