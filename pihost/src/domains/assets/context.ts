import type {Pool} from 'pg';
import {isIP} from 'node:net';
import {getDomain} from 'tldts';
import statements from './asset-context-sql.json' with {type:'json'};
import {compileAssetDSL} from './dsl.ts';
import {sourceAssetDTO} from './source-reads.ts';
import {companyNKey,parseScope} from './scope.ts';
import {domainKey} from './source-writes.ts';
const stripHostPort=(v:string)=>{const s=v.trim();const bracket=s.match(/^\[([^\]]+)\]:[^:]+$/);if(bracket)return bracket[1]!;return s.split(':').length===2?s.split(':')[0]!:s;};
/** Original declared scope is distinct from coverage: coverage also includes
 * anchored assets; list_assets must never broaden scope using an anchor. */
export class AssetContextService{
 constructor(private readonly pool:Pool){}
 async list(taskId:number,p:{dsl?:string;type?:string;id?:number;ids?:number[];limit?:number;offset?:number}){
  const ids=(p.id??0)>0?[p.id!]:p.ids?.length?p.ids:null;
  if(!ids&&!p.dsl)throw new Error("dsl cannot be empty when id/ids are not passed: unconditional query of all assets is not allowed, please provide query conditions");
  const args:unknown[]=taskId>0?[taskId]:[],add=(v:unknown)=>{args.push(v);return `$${args.length}`;};
  let condition:string;
  if(ids)condition=`id=ANY(${add(ids)}::bigint[])`;
  else{
   const d=compileAssetDSL(p.dsl!);const base=args.length;condition=d.sql.replace(/\$(\d+)/g,(_,n)=>`$${Number(n)+base}`);args.push(...d.args);
   if(p.type)condition+=` AND type=${add(p.type)}`;
  }
  if(taskId>0)condition+=' AND id IN(SELECT id FROM target)';
  let query=`${taskId>0?'WITH '+statements.scopeTargetCTE+' ':''}SELECT *,last_seen::text last_seen FROM assets WHERE ${condition} ORDER BY assets.last_seen DESC,id DESC`;
  if(!ids)query+=` LIMIT ${add(Math.min((p.limit??0)>0?p.limit!:10,200))} OFFSET ${add(Math.max(p.offset??0,0))}`;
  const rows=(await this.pool.query(query,args)).rows;
  if(taskId>0&&rows.length){const links=(await this.pool.query('SELECT * FROM task_asset_links WHERE task_id=$1 AND asset_id=ANY($2::bigint[])',[taskId,rows.map(r=>r.id)])).rows;const map=new Map(links.map(r=>[r.asset_id,r]));for(const row of rows){const link=map.get(row.id);if(link){row.task_source=link.source;row.task_source_summary=link.source_summary;row.task_source_node_id=link.source_node_id;}}}
  const assets=rows.map(sourceAssetDTO);return {count:assets.length,assets:assets.length?assets:null};
 }
 async untested(taskId:number,type='',page=1,pageSize=10){if(!taskId)throw new Error("list_untested_assets requires task context");page=page>0?page:1;pageSize=pageSize>0?pageSize:10;
  const args:unknown[]=[taskId],filter=type?' AND target.type=$2':'';if(type)args.push(type);
  const base=`WITH ${statements.contextCoverageCTE} `,where=' WHERE target.id NOT IN(SELECT asset_id FROM tested)'+filter;
  const total=Number((await this.pool.query(base+'SELECT count(*) FROM target'+where,args)).rows[0].count);
  args.push(pageSize,Math.max((page-1)*pageSize,0));const rows=(await this.pool.query(base+'SELECT target.id,target.type,target.label FROM target'+where+` ORDER BY target.id LIMIT $${args.length-1} OFFSET $${args.length}`,args)).rows;
  return {assets:rows.map(r=>({...r,id:Number(r.id)})),total,page,page_size:pageSize};
 }
 async coverage(taskId:number){const flag=(await this.pool.query('SELECT coverage_enabled FROM tasks WHERE id=$1',[taskId])).rows[0]?.coverage_enabled;
  const empty={enabled:flag!==false,scope_rows:0,denominator:0,tested:0,pct:null as number|null,by_type:[] as {type:string;total:number;tested:number}[]};if(flag===false)return empty;
  empty.scope_rows=Number((await this.pool.query(`WITH ${statements.directTaskContextCTE} SELECT count(*) FROM task_scope ts JOIN context_tasks ctx ON ctx.task_id=ts.task_id`,[taskId])).rows[0].count);
  empty.by_type=(await this.pool.query(`WITH ${statements.contextCoverageCTE} SELECT target.type,count(*)::int total,count(*) FILTER(WHERE target.id IN(SELECT asset_id FROM tested))::int tested FROM target GROUP BY target.type ORDER BY target.type`,[taskId])).rows;
  for(const r of empty.by_type){empty.denominator+=r.total;empty.tested+=r.tested;}empty.pct=empty.denominator?empty.tested/empty.denominator:null;return empty;
 }
 async graph(taskId:number){const nodes:Record<string,any>[]=[],edges:{src:string;dst:string}[]=[];if(taskId<=0)return {nodes,edges};
  const rows=(await this.pool.query(`WITH ${statements.contextCoverageCTE} SELECT a.*,a.id IN(SELECT asset_id FROM tested) tested FROM assets a JOIN target t ON t.id=a.id ORDER BY a.id`,[taskId])).rows;
  const keys=new Map<string,Record<string,any>>(),roots=new Map<string,string>(),subs=new Map<string,string>(),ips=new Map<string,string>(),services=new Map<string,string>(),hosts=new Map<string,string>(),companies=new Set<number>();
  const add=(n:Record<string,any>)=>{if(keys.has(n.key))return keys.get(n.key)!;nodes.push(n);keys.set(n.key,n);return n;};
  const hostPort=(n:Record<string,any>):[string,number]=>{let host=n.domain??'',port=n.port??0;if(!host&&n.url){try{const u=new URL(n.url);host=u.hostname.replace(/^\[|\]$/g,'');port||=Number(u.port)||(u.protocol==='https:'?443:u.protocol==='http:'?80:0);}catch{}}return [host||n.ip||'',port];};
  for(const r of rows){const n:Record<string,any>={key:`a:${r.id}`,kind:r.type,label:r.url||r.domain||r.ip||r.app_name||r.root_domain||`a:${r.id}`,tested:r.tested,in_scope:true,asset_id:Number(r.id)};
   for(const k of ['company_id','port','status_code'])if(Number(r[k]))n[k]=Number(r[k]);for(const k of ['domain','root_domain','ip','url','service_type','app_name','page_title'])if(r[k])n[k]=r[k];add(n);
   if(r.type==='root_domain'&&r.domain)roots.set(r.domain,n.key);if(r.type==='subdomain'&&r.domain)subs.set(r.domain,n.key);if(r.type==='ip'&&r.ip)ips.set(r.ip,n.key);
   if(r.type==='service'){const [host,port]=hostPort(n);if(host){hosts.set(host,n.key);services.set(`${host}|${port}`,n.key);}}if(n.company_id)companies.add(n.company_id);
  }
  const missing=new Set(nodes.filter(n=>n.kind==='subdomain'&&n.root_domain&&!roots.has(n.root_domain)).map(n=>n.root_domain as string));
  for(const root of missing){const r=(await this.pool.query("SELECT id,company_id FROM assets WHERE type='root_domain' AND domain=$1 LIMIT 1",[root])).rows[0];const n:Record<string,any>={key:r?`a:${r.id}`:`r:${root}`,kind:'root_domain',domain:root,label:root,tested:false,in_scope:false};if(r){n.asset_id=Number(r.id);if(r.company_id){n.company_id=Number(r.company_id);companies.add(n.company_id);}}add(n);roots.set(root,n.key);}
  for(const id of companies){const r=(await this.pool.query('SELECT name FROM companies WHERE id=$1',[id])).rows[0];if(r)add({key:`c:${id}`,kind:'company',company_id:id,label:r.name,tested:false,in_scope:false});}
  const first=(...candidates:(string|undefined)[])=>candidates.find(k=>k&&keys.has(k));const link=(child:string,parent:string|undefined)=>{if(parent&&parent!==child&&keys.has(parent))edges.push({src:child,dst:parent});};
  for(const n of nodes){switch(n.kind){case 'subdomain':link(n.key,roots.get(n.root_domain));break;case 'root_domain':case 'app':case 'ip':if(n.company_id)link(n.key,`c:${n.company_id}`);break;case 'service':link(n.key,first(subs.get(n.domain),ips.get(n.ip),roots.get(n.root_domain)));break;case 'endpoint':{const [host,port]=hostPort(n);link(n.key,first(services.get(`${host}|${port}`),hosts.get(host),subs.get(host),subs.get(n.domain),ips.get(host),ips.get(n.ip),roots.get(n.root_domain)));break;}}}
  return {nodes,edges};
 }
 async scopes(taskId:number){const rows=(await this.pool.query(`WITH ${statements.directTaskContextCTE} SELECT ts.*,ts.net::text net,c.name company_name FROM task_scope ts JOIN context_tasks ctx ON ctx.task_id=ts.task_id LEFT JOIN companies c ON c.id=ts.company_id ORDER BY CASE WHEN ts.task_id=$1 THEN 0 ELSE 1 END,ts.id`,[taskId])).rows;
  return rows.map(r=>({id:Number(r.id),task_id:Number(r.task_id),kind:r.kind,source:r.source,...Object.fromEntries(['company_id','company_name','domain','net','value','reason'].filter(k=>r[k]).map(k=>[k,k==='company_id'?Number(r[k]):r[k]]))}));
 }
 async refs(taskId:number,assetId:number){const rows=(await this.pool.query(`WITH ${statements.directTaskContextCTE} SELECT n.*,ctx.task_id owning_task FROM exploration_anchors a JOIN exploration_nodes n ON n.id=a.node_id JOIN context_tasks ctx ON ctx.exploration_id=n.exploration_id WHERE a.asset_id=$2 AND n.kind IN('intent','fact','finding') AND (ctx.task_id=$1 OR n.kind<>'intent' OR n.state IN('done','blocked','exhausted','stopped')) ORDER BY n.id DESC`,[taskId,assetId])).rows;
  const result:{intents:Record<string,unknown>[];facts:Record<string,unknown>[];findings:Record<string,unknown>[]}={intents:[],facts:[],findings:[]};
  for(const n of rows){const summary=[n.payload.summary,n.payload.text].find(v=>typeof v==='string'&&v.trim())??'';const ref={id:Number(n.id),kind:n.kind,state:n.state,summary,...(Number(n.owning_task)!==taskId?{source_task_id:String(n.owning_task),inherited:true}:{})};result[n.kind==='intent'?'intents':n.kind==='fact'?'facts':'findings'].push(ref);}return result;
 }
 async addScope(taskId:number,kind:string,value:string,reason:string,source='agent'){if(taskId<=0)throw new Error("task_id required");value=value.trim();if(!value)throw new Error("value cannot be empty");
  let company:number|null=null,domain:string|null=null,net:string|null=null,normalized:string|null=null;
  if(kind==='company'){const row=(await this.pool.query(/^[-+]?\d+$/.test(value)?'SELECT id FROM companies WHERE id=$1':'SELECT id FROM companies WHERE nkey=$1',[/^[-+]?\d+$/.test(value)?Number(value):companyNKey(value)])).rows[0];if(!row)throw new Error(`company does not exist: ${value}(Confirm with list_companies first, or build the company)`);company=Number(row.id);}
  else if(kind==='root_domain'||kind==='subdomain'){const host=domainKey(stripHostPort(value));domain=kind==='root_domain'?getDomain(host,{allowPrivateDomains:true})??host:host;if(!domain)throw new Error(`Invalid${kind==='root_domain'?"Root domain":"Subdomain"}: ${value}`);}
  else if(kind==='ip'||kind==='cidr'){const v=value.includes('/')?value:stripHostPort(value),parts=v.split('/'),ver=isIP(parts[0]!);if(!ver||(parts.length>1&&(!/^\d+$/.test(parts[1]!)||Number(parts[1])>(ver===4?32:128))))throw new Error(`Invalid ip/cidr: ${value}`);kind=value.includes('/')?'cidr':'ip';net=value.includes('/')?value:`${v}/${ver===4?32:128}`;}
  else if(kind==='icp'||kind==='keyword')normalized=parseScope({kind,value}).value??null;
  else throw new Error(`Unsupported kind: ${kind}（company/root_domain/subdomain/ip/cidr/icp/keyword）`);
  const storedNet=net?(await this.pool.query('SELECT ($1::inet)::cidr::text net',[net])).rows[0].net:null;
  await this.pool.query("INSERT INTO task_scope(task_id,kind,company_id,domain,net,value,source,reason) VALUES($1,$2,$3,$4,$5::cidr,$6,$7,NULLIF($8,'')) ON CONFLICT DO NOTHING",[taskId,kind,company,domain,storedNet,normalized,source,reason]);
  return {kind,domain:domain??'',net:net??'',value:normalized??'',company_id:company};
 }
}
