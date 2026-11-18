import type {Pool} from 'pg';
import {firstLine} from './projector.ts';
// Terminal eligibility is checked by the same statement as the activity read.
// Only direct sources count; local details retain original thinking visibility.
const scope=`WITH owners AS (
 SELECT id,exploration_id,false AS inherited FROM tasks WHERE id=$1 AND deleted_at IS NULL
 UNION ALL SELECT s.id,s.exploration_id,true FROM task_relations r JOIN tasks s ON s.id=r.source_task_id
 JOIN tasks owner ON owner.id=r.task_id AND owner.deleted_at IS NULL
 WHERE r.task_id=$1 AND s.deleted_at IS NULL
), visible AS (
 SELECT a.*,o.id AS owning_task,o.inherited FROM owners o JOIN activity a ON a.exploration_id=o.exploration_id
 LEFT JOIN exploration_nodes n ON n.id=a.node_id AND n.exploration_id=a.exploration_id
 WHERE NOT o.inherited OR (n.kind='intent' AND n.state IN('done','blocked','exhausted','stopped') AND a.kind NOT IN('thinking','usage'))
)`;
const iso=(v:Date|string)=>new Date(v).toISOString().replace(/\.\d{3}Z$/,'Z');
export function activityDTO(a:any):Record<string,unknown>{return {
 seq:Number(a.id),...(a.node_id!=null?{intent_id:String(a.node_id)}:{}),worker:a.worker??'',ts:iso(a.created_at),kind:a.kind??'',
 ...(a.tool?{tool:a.tool}:{}),...(a.tool_use_id?{tool_use_id:a.tool_use_id}:{}),is_error:!!a.is_error,summary:a.summary??'',
 ...(!a.inherited&&a.metadata!=null?{metadata:a.metadata}:{}),
 ...(a.inherited?{inherited:true,source_task_id:String(a.owning_task)}:{}),
 ...(!a.inherited&&a.main_seg!=null?{main_seg:a.main_seg}:{}),
 ...Object.fromEntries(['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'].filter(k=>a[k]!=null).map(k=>[k,a[k]])),
};}
export const inherited=(a:any)=>a.inherited?{inherited:true,source_task_id:Number(a.owning_task)}:{};
export class ActivityService {
 constructor(readonly pool:Pool){}
 async task(id:number):Promise<any>{return (await this.pool.query('SELECT id,exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];}
 async intent(taskId:number,id:number):Promise<any>{return (await this.pool.query(`SELECT n.*,n.task_id AS owning_task,n.task_id<>$1 AS inherited
 FROM exploration_nodes n JOIN tasks t ON t.id=n.task_id AND t.deleted_at IS NULL
 WHERE n.id=$2 AND n.kind='intent' AND (t.id=$1 OR t.id IN(SELECT source_task_id FROM task_relations WHERE task_id=$1))`,[taskId,id])).rows[0];}
 async max(taskId:number):Promise<number>{return Number((await this.pool.query('SELECT COALESCE(MAX(a.id),0) AS n FROM activity a JOIN tasks t ON t.exploration_id=a.exploration_id WHERE t.id=$1',[taskId])).rows[0].n);}
 async list(taskId:number,intent:number|null,since=0,limit=300,localOnly=false):Promise<{items:Record<string,unknown>[];cursor:number}>{
  const rows=(await this.pool.query(scope+` SELECT * FROM visible WHERE id>$2 AND ($3::bigint IS NULL OR node_id=$3)
   AND ($3::bigint IS NOT NULL OR NOT inherited) ${localOnly?'AND NOT inherited':''} ORDER BY id LIMIT $4`,[taskId,since,intent,limit>0?limit:300])).rows;
  return {items:rows.map(activityDTO),cursor:rows.length?Number(rows.at(-1).id):since};
 }
 async detail(taskId:number,id:number):Promise<string>{return (await this.pool.query(scope+' SELECT detail FROM visible WHERE id=$2',[taskId,id])).rows[0]?.detail??'';}
 async outputRows(taskId:number,id:number):Promise<any[]>{return (await this.pool.query(scope+' SELECT * FROM visible WHERE node_id=$2 ORDER BY id LIMIT 1000',[taskId,id])).rows;}
 async tokens(taskId:number):Promise<Record<string,unknown>>{
  const sums=['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'].map(k=>`COALESCE(SUM(a.${k}),0)::bigint AS ${k}`).join(',');
  const joins='FROM activity a JOIN tasks t ON t.exploration_id=a.exploration_id',cond="WHERE t.id=$1 AND a.kind='result'";
  const workers=(await this.pool.query(`SELECT COALESCE(a.worker,'') AS worker,${sums} ${joins} ${cond} GROUP BY a.worker ORDER BY a.worker`,[taskId])).rows;
  const sessions=(await this.pool.query(`SELECT CASE WHEN COALESCE(a.worker,'')='mainagent' THEN 'main:'||COALESCE(a.main_seg,0)::text
   WHEN COALESCE(a.worker,'')='planner' THEN 'plan' WHEN n.id IS NOT NULL THEN 'intent:'||n.id::text ELSE '' END AS session,${sums}
   ${joins} LEFT JOIN exploration_nodes n ON n.id=a.node_id AND n.exploration_id=a.exploration_id AND n.kind='intent'
   ${cond} AND (COALESCE(a.worker,'') IN('mainagent','planner') OR n.id IS NOT NULL) GROUP BY session ORDER BY session`,[taskId])).rows;
  const total=(await this.pool.query(`SELECT ${sums} ${joins} ${cond}`,[taskId])).rows[0];
  const numeric=(r:any)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k.endsWith('_tokens')?Number(v):v]));
  return {workers:workers.map(numeric),sessions:sessions.map(numeric),total:numeric(total)};
 }
 async trace(taskId:number,intent:number|null,q='',limit=0,exclude=0):Promise<any[]>{return (await this.pool.query(scope+` SELECT * FROM visible
 WHERE kind NOT IN('thinking','usage') AND node_id IS NOT NULL AND ($2::bigint IS NULL OR node_id=$2)
 AND (inherited OR node_id<>$5) AND ($3='' OR summary ILIKE '%'||$3||'%' OR detail ILIKE '%'||$3||'%')
 ORDER BY id LIMIT $4`,[taskId,intent,q,limit>0?limit:q.trim()?100:500,exclude])).rows;}
 async byIDs(taskId:number,ids:number[]):Promise<any[]>{return (await this.pool.query(scope+" SELECT * FROM visible WHERE id=ANY($2::bigint[]) AND kind<>'thinking' ORDER BY id",[taskId,ids])).rows;}
 async currentMain(taskId:number):Promise<number>{return Number((await this.pool.query('SELECT COALESCE(MAX(m.seq),0) AS n FROM main_sessions m JOIN tasks t ON t.exploration_id=m.exploration_id WHERE t.id=$1',[taskId])).rows[0].n);}
 async mainSessions(taskId:number):Promise<Record<string,unknown>[]> {const rows=(await this.pool.query('SELECT m.seq,m.created_at FROM main_sessions m JOIN tasks t ON t.exploration_id=m.exploration_id WHERE t.id=$1 ORDER BY m.seq DESC',[taskId])).rows;return [...rows.map(r=>({seq:r.seq,created_at:iso(r.created_at)})),{seq:0,created_at:'0001-01-01T00:00:00Z'}];}
 async newMain(taskId:number):Promise<Record<string,unknown>> {
  const c=await this.pool.connect();try{await c.query('BEGIN');const t=(await c.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[taskId])).rows[0];if(!t?.exploration_id)throw new Error('task not found');
   const r=(await c.query(`INSERT INTO main_sessions(exploration_id,seq) VALUES($1,COALESCE((SELECT MAX(seq) FROM main_sessions WHERE exploration_id=$1),0)+1) RETURNING seq,created_at`,[t.exploration_id])).rows[0];await c.query('COMMIT');return {seq:r.seq,created_at:iso(r.created_at)};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async history(taskId:number,session:string,before=0,limit=200):Promise<Record<string,unknown>>{
  let filter='NOT inherited',param:unknown=null;
  if(session===''||session==='main'||/^main:\d+$/.test(session)){param=session.startsWith('main:')?Number(session.slice(5)):await this.currentMain(taskId);filter+=" AND worker='mainagent' AND COALESCE(main_seg,0)=$2";}
  else if(session==='plan')filter+=" AND worker='planner' AND $2::bigint IS NULL";
  else if(/^intent:-?\d+$/.test(session)){param=Number(session.slice(7));const n=await this.intent(taskId,Number(param));if(!n||(n.inherited&&!['done','blocked','exhausted','stopped'].includes(n.state)))throw new Error('session not found');filter='node_id=$2';}
  else throw new Error('bad session');
  limit=limit>0?Math.min(500,limit):200;
  // Snapshot precedes the page: any subsequent insert is replayed by SSE. The
  // page can overlap that tail and UI de-dups by stable seq, so nothing is lost.
  const snapshot=await this.max(taskId);
  const rows=(await this.pool.query(scope+` SELECT * FROM visible WHERE ${filter} AND ($3::bigint<=0 OR id<$3) ORDER BY id DESC LIMIT $4`,[taskId,param,before,limit+1])).rows;
  const hasMore=rows.length>limit,items=rows.slice(0,limit).reverse();
  return {items:items.map(activityDTO),snapshot_cursor:snapshot,earliest_cursor:items.length?Number(items[0].id):before,has_more:hasMore};
 }
 async works(taskId:number,q='',limit=50):Promise<any[]> {
  const nodes=(await this.pool.query(`SELECT n.*,t.id AS owning_task,t.id<>$1 AS inherited FROM exploration_nodes n JOIN tasks t ON t.id=n.task_id
   WHERE t.deleted_at IS NULL AND (t.id=$1 OR t.id IN(SELECT source_task_id FROM task_relations WHERE task_id=$1)) AND n.kind='intent'
   ORDER BY CASE WHEN t.id=$1 THEN 0 ELSE 1 END,(SELECT created_at FROM task_relations WHERE task_id=$1 AND source_task_id=t.id),t.id,n.id DESC`,[taskId])).rows;
  // Original ListByKindWithSources caps each exploration at 500 before filtering.
  const seen=new Map<string,number>();return nodes.filter(n=>{const key=String(n.exploration_id),count=seen.get(key)??0;seen.set(key,count+1);return count<500;})
   .filter(n=>['running','done','exhausted','blocked','stopped'].includes(n.state)&&(!n.inherited||n.state!=='running')&&(!q.trim()||String(n.payload?.summary??'').toLowerCase().includes(q.trim().toLowerCase())))
   .slice(0,limit>0?limit:50).map(n=>({intent_id:Number(n.id),summary:n.payload?.summary??'',state:n.state,...inherited(n)}));
 }
}
export const traceStep=(a:any)=>({step_id:Number(a.id),kind:a.kind??'',tool:a.tool??'',is_error:!!a.is_error,summary:firstLine(a.summary,100),...inherited(a)});
