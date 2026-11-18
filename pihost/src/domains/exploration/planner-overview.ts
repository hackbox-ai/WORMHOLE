/** Planner-facing read model from frozen agent/tools.go, tools_digest.go.
 * Related tasks are direct live sources; their frontier never becomes claimable. */
import type {Pool} from 'pg';
import contextSql from '../assets/asset-context-sql.json' with {type:'json'};
import hostSql from './source-hosts-sql.json' with {type:'json'};
import {goTrim} from '../assets/asset-match.ts';
type Row=Record<string,any>;
const terminal=(s:string)=>['done','blocked','exhausted','stopped'].includes(s);
const compact=(n:Row)=>({id:Number(n.id),state:n.state,summary:n.payload?.summary??null});
const lower=(text:string)=>Array.from(text,c=>c==='\u0130'?'i':c.toLowerCase()).join('');
function goFmt(value:any):string{
 if(value==null)return '<nil>';if(typeof value==='number'){if(Object.is(value,-0))return '-0';const exponential=value.toExponential(),exponent=Number(exponential.split('e')[1]);return exponent < -4||exponent>=6?exponential.replace(/e([+-])(\d)$/,(_m,sign,digit)=>'e'+sign+'0'+digit):String(value);}
 if(Array.isArray(value))return '['+value.map(goFmt).join(' ')+']';
 if(typeof value==='object')return 'map['+Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(key=>key+':'+goFmt(value[key])).join(' ')+']';return String(value);
}
class TextBudget{
 truncated=false;constructor(private remaining:number){}
 take(value:any,limit:number):string{const text=goTrim(value==null?'':goFmt(value));if(!text)return '';if(this.remaining<=0||limit<=0){this.truncated=true;return '';}
  let chars=Array.from(text);limit=Math.min(limit,this.remaining);if(chars.length>limit){this.truncated=true;chars=limit===1?['…']:[...chars.slice(0,limit-1),'…'];}this.remaining-=chars.length;return chars.join('');}
}
export class PlannerOverview{
 constructor(readonly pool:Pool){}
 private async load(exploration:number){
  const nodes=(await this.pool.query('SELECT * FROM exploration_nodes WHERE exploration_id=$1 ORDER BY id DESC',[exploration])).rows as Row[],edges=(await this.pool.query('SELECT src_id,dst_id,rel FROM exploration_edges WHERE exploration_id=$1',[exploration])).rows as Row[];
  const parents=new Map<number,number[]>(),children=new Map<number,number[]>(),yields=new Map<number,number[]>(),from=new Map<number,number>();const push=(map:Map<number,number[]>,key:number,v:number)=>map.set(key,[...(map.get(key)??[]),v]);
  const byId=new Map(nodes.map(n=>[Number(n.id),n])),hot=new Set<number>(),causalParents=new Map<number,number[]>();
  for(const [i,e] of edges.entries()){const src=Number(e.src_id),dst=Number(e.dst_id);if(i<5000){if(['derived_from','spawns'].includes(e.rel))push(parents,dst,src);if(e.rel==='yields'){push(yields,src,dst);from.set(dst,src);}}
   if(e.rel!=='covers'&&byId.has(src)&&byId.has(dst)){push(causalParents,dst,src);push(children,src,dst);}}
  const live=nodes.filter(n=>n.kind==='intent'&&['open','running','paused'].includes(n.state)).map(n=>Number(n.id)),stack=[...live];while(stack.length){const id=stack.pop()!;if(hot.has(id))continue;hot.add(id);stack.push(...(causalParents.get(id)??[]));}for(const id of live)for(const child of children.get(id)??[])hot.add(child);
  const active=nodes.filter(n=>n.kind==='digest'&&n.state==='active').sort((a,b)=>Number(a.id)-Number(b.id)),members=new Map<number,number[]>(),covered=new Set<number>();
  for(const d of active){const list=edges.filter(e=>e.rel==='covers'&&Number(e.src_id)===Number(d.id)).map(e=>Number(e.dst_id)).sort((a,b)=>a-b);members.set(Number(d.id),list);for(const id of list)covered.add(id);}
  const hidden=(id:number)=>covered.has(id)&&!hot.has(id),digests=(cap:number)=>{const ordered=active.map(d=>({id:Number(d.id),body:typeof d.payload?.body==='string'?d.payload.body:'',member_count:members.get(Number(d.id))!.length,freshness:members.get(Number(d.id))!.at(-1)??0})).sort((a,b)=>b.freshness-a.freshness);
   return {shown:ordered.slice(0,cap).map(({freshness,...entry})=>entry),more:ordered.slice(cap).map(d=>d.id)};};
  const intents=(list:Row[],source=0)=>list.map(n=>{const p=n.payload??{},id=Number(n.id),assets=p.asset_ids??p.target_ids??(p.target_id!=null&&p.target_id!==''?[p.target_id]:undefined);return {...compact(n),...(source?{inherited:true,source_task_id:source}:{}),...(assets!=null?{asset_ids:assets}:{}),...(parents.get(id)?.length?{parents:parents.get(id)}:{}),...(yields.get(id)?.length?{yields:yields.get(id)}:{})};});
  return {nodes,edges,byId,from,hidden,digests,intents};
 }
 private async coverage(taskId:number,single=false){
  const own='context_tasks AS (SELECT id AS task_id,exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL)',cte=single?contextSql.contextCoverageCTE.replace(contextSql.directTaskContextCTE,own):contextSql.contextCoverageCTE;
  const by_type=(await this.pool.query('WITH '+cte+' SELECT target.type,count(*)::int total,count(*) FILTER(WHERE target.id IN(SELECT asset_id FROM tested))::int tested FROM target GROUP BY target.type ORDER BY target.type',[taskId])).rows;
  const denominator=by_type.reduce((n,r)=>n+Number(r.total),0),tested=by_type.reduce((n,r)=>n+Number(r.tested),0);return {denominator,tested,pct:denominator?tested/denominator:null,by_type};
 }
 private async hostCount(taskId:number){const rows=(await this.pool.query('WITH '+contextSql.directTaskContextCTE+','+hostSql.contextAssets.replace("SELECT COALESCE(a.domain,''), COALESCE(a.ip,''), COALESCE(a.url,'')","SELECT COALESCE(a.domain,'') AS domain, COALESCE(a.ip,'') AS ip, COALESCE(a.url,'') AS url"),[taskId])).rows,hosts=new Set<string>();const add=(v:string)=>{v=goTrim(lower(v));if(v)hosts.add(v);};for(const row of rows){add(row.coalesce??row.domain??'');add(row.ip??'');if(row.url)try{add(new URL(String(row.url).startsWith('//')?'http:'+row.url:row.url).hostname.replace(/^\[|\]$/g,''));}catch{}}return hosts.size;}
 async read(taskId:number,includeCoverage=true):Promise<Row>{
  const task=(await this.pool.query('SELECT * FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskId])).rows[0];if(!task)throw new Error("Task does not exist");const g=await this.load(Number(task.exploration_id)),byKind=(kind:string,limit:number)=>g.nodes.filter(n=>n.kind===kind).slice(0,limit);
  const traffic=(await this.pool.query("SELECT value FROM app_settings WHERE key='settings.agent_traffic_binding'")).rows[0]?.value==='true',allIntents=byKind('intent',300),finished=allIntents.filter(n=>['done','blocked','exhausted'].includes(n.state)&&!g.hidden(Number(n.id))),facts=byKind('fact',1000),findings=byKind('finding',1000),root=(await this.pool.query('SELECT description,goal FROM explorations WHERE id=$1',[task.exploration_id])).rows[0];
  const out:Row={goals:byKind('goal',100).map(n=>({id:Number(n.id),state:n.state,text:n.payload?.text??null,...(n.payload?.resolution?{resolution:n.payload.resolution}:{}),...(n.payload?.objective_type?{objective_type:n.payload.objective_type}:{})})),hints:byKind('hint',50).map(n=>({id:Number(n.id),state:n.state,text:n.payload?.text??null,...(traffic&&n.payload?.traffic_refs!=null?{traffic_refs:n.payload.traffic_refs}:{})})),
   open_intents:g.intents(g.nodes.filter(n=>n.kind==='intent'&&n.state==='open').sort((a,b)=>Number(b.priority)-Number(a.priority)||Number(a.id)-Number(b.id)).slice(0,30)),running_intents:g.intents(allIntents.filter(n=>n.state==='running')),recent_done_intents:g.intents(finished.slice(0,12)),
   done_intents_total:g.nodes.filter(n=>n.kind==='intent'&&['done','blocked','exhausted'].includes(n.state)).length,frontier_open:g.nodes.filter(n=>n.kind==='intent'&&n.state==='open').length,facts:facts.length,findings_total:findings.length,
   finding_list:findings.slice(0,10).map(n=>({id:Number(n.id),summary:n.payload?.summary??null,...(g.from.get(Number(n.id))?{from_intent:g.from.get(Number(n.id))}:{})})),
   recent_facts:facts.filter(n=>!g.hidden(Number(n.id))).slice(0,20).map(n=>({...compact(n),...(g.from.get(Number(n.id))?{from_intent:g.from.get(Number(n.id))}:{}),...(typeof n.payload?.confidence==='string'&&n.payload.confidence!==''?{confidence:n.payload.confidence}:{})})),
   ...(root?{task:root}:{}),related_tasks:await this.related(taskId)};
  const digest=g.digests(15);if(digest.shown.length){out.cold_digests=digest.shown;if(digest.more.length)out.cold_digests_more=digest.more;}
  if(includeCoverage){const coverage:Row=task.coverage_enabled===false?{}:{...await this.coverage(taskId),note:"Coverage asset test coverage (including various related assets such as interfaces), rough estimate, for reference only: includes the scope and fact anchor of the current task and directly related tasks; the related scope is read-only. Container-type assets/a large number of enumerations will make it low, so do not assume that the test has been completed; you can use add_task_scope to supplement the scope of this task and list_untested_assets to see untested assets [usually do not call list_untested_assets, just advance according to the task];"};if(task.coverage_enabled!==false&&!coverage.denominator)coverage.status="Range not anchored";coverage.host_count=await this.hostCount(taskId);out.coverage=coverage;}
  return out;
 }
 private async related(taskId:number):Promise<Row[]>{
  const sources=(await this.pool.query('SELECT t.* FROM task_relations r JOIN tasks t ON t.id=r.source_task_id AND t.deleted_at IS NULL JOIN tasks owner ON owner.id=r.task_id AND owner.deleted_at IS NULL WHERE owner.id=$1 ORDER BY r.created_at,t.id LIMIT 8',[taskId])).rows,per=sources.length?Math.min(8000,Math.floor(48000/sources.length)):0,out:Row[]=[];
  for(const source of sources){const sid=Number(source.id),g=await this.load(Number(source.exploration_id)),budget=new TextBudget(per),stats:Row={},own=(kind:string,cap:number)=>g.nodes.filter(n=>n.kind===kind).slice(0,cap),mark=(row:Row)=>({...row,inherited:true,source_task_id:sid});for(const n of g.nodes)stats[n.kind]=(stats[n.kind]??0)+1;
   const goals=own('goal',8),hints=own('hint',6),facts=own('fact',12),findings=own('finding',6);if((stats.goal??0)>goals.length||(stats.hint??0)>hints.length||(stats.fact??0)>facts.length||(stats.finding??0)>findings.length)budget.truncated=true;
   const item:Row={source_task_id:sid,inherited:true,task:{description:budget.take(source.description,800),goal:budget.take(source.goal,800),status:source.status},
    goals:goals.map(n=>mark({id:Number(n.id),state:n.state,text:budget.take(n.payload?.text,400)})),hints:hints.map(n=>mark({id:Number(n.id),state:n.state,text:budget.take(n.payload?.text,400)})),facts:stats.fact??0,findings:stats.finding??0,node_stats:stats};
   item.recent_findings=findings.map(n=>mark({...compact(n),summary:budget.take(n.payload?.summary,400),...(n.payload?.vulnclass!=null&&n.payload.vulnclass!==''?{vulnclass:n.payload.vulnclass}:{}),...(n.payload?.severity!=null&&n.payload.severity!==''?{severity:n.payload.severity}:{})}));
   const terminalInFirst300=new Set(own('intent',300).filter(n=>terminal(n.state)).map(n=>Number(n.id)));
   item.recent_facts=facts.filter(n=>!g.hidden(Number(n.id))).map(n=>mark({...compact(n),summary:budget.take(n.payload?.summary,400),...(g.from.get(Number(n.id))&&terminalInFirst300.has(g.from.get(Number(n.id))!)?{from_intent:g.from.get(Number(n.id))}:{}),...(typeof n.payload?.confidence==='string'&&n.payload.confidence!==''?{confidence:n.payload.confidence}:{})}));
   const rawDone=g.nodes.filter(n=>n.kind==='intent'&&terminal(n.state)).slice(0,8).filter(n=>!g.hidden(Number(n.id)));item.recent_intent_results=g.intents(rawDone,sid);for(const [i,n] of rawDone.entries()){const entry=item.recent_intent_results[i];entry.summary=budget.take(entry.summary,400);const rows=(await this.pool.query("SELECT a.kind,a.summary FROM activity a JOIN exploration_nodes n ON n.id=a.node_id AND n.exploration_id=a.exploration_id WHERE a.exploration_id=$1 AND a.node_id=$2 AND n.kind='intent' AND n.state IN('done','blocked','exhausted','stopped') AND a.kind NOT IN('thinking','usage') ORDER BY a.id DESC LIMIT 20",[source.exploration_id,n.id])).rows.reverse();let result='',fallback='';for(const row of rows){if(row.kind==='result')result=row.summary??'';if(row.kind==='text')fallback=row.summary??'';}if(result||fallback)entry.result_summary=budget.take(result||fallback,800);}
   const digest=g.digests(6);if(digest.shown.length){item.cold_digests=digest.shown.map(mark);if(digest.more.length)item.cold_digests_more=digest.more;}
   const scopes=(await this.pool.query('SELECT *,net::text net FROM task_scope WHERE task_id=$1 ORDER BY id',[sid])).rows;if(scopes.length){item.asset_scope_count=scopes.length;if(scopes.length>12)budget.truncated=true;item.asset_scope=scopes.slice(0,12).map(s=>({kind:s.kind,source:budget.take(s.source,300),...(s.domain?{value:budget.take(s.domain,400)}:s.net?{value:budget.take(s.net,400)}:s.value?{value:budget.take(s.value,400)}:s.company_id!=null?{company_id:Number(s.company_id)}:{})}));}
   item.asset_coverage=await this.coverage(sid,true);if(budget.truncated)item.summary_truncated=true;out.push(item);
  }return out;
 }
 async expand(taskId:number,id:number):Promise<Row>{
  const row=(await this.pool.query(`SELECT n.*,t.id AS owning_task FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id AND t.deleted_at IS NULL WHERE n.id=$2 AND n.kind='digest' AND (t.id=$1 OR t.id IN(SELECT source_task_id FROM task_relations WHERE task_id=$1))`,[taskId,id])).rows[0];if(!row)return {error:`#${id} is not a digest node (not found in this task or directly related tasks)`};
  const members=(await this.pool.query("SELECT e.dst_id,n.id,n.state,n.payload FROM exploration_edges e LEFT JOIN exploration_nodes n ON n.id=e.dst_id AND n.exploration_id=e.exploration_id WHERE e.exploration_id=$1 AND e.src_id=$2 AND e.rel='covers' ORDER BY e.dst_id",[row.exploration_id,id])).rows,source=Number(row.owning_task)!==taskId?Number(row.owning_task):0;
  return {id,state:row.state,body:typeof row.payload?.body==='string'?row.payload.body:'',members:members.map(n=>({...(!n.id?{id:Number(n.dst_id),missing:true}:{...compact(n),...(typeof n.payload?.confidence==='string'&&n.payload.confidence!==''?{confidence:n.payload.confidence}:{})}),...(source?{inherited:true,source_task_id:source}:{})})),...(source?{inherited:true,source_task_id:source}:{})};
 }
}
