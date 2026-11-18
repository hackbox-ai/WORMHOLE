/** Original list_findings/node_detail read side. Finding IDs and graph IDs differ. */
import type {Pool} from 'pg';
import {directExplorationScope as scope} from '../exploration/scope.ts';
const enriched=`SELECT n.*,s.task_id owning_task,s.inherited,s.ordinal,
 to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_iso,
 f.id finding_id,(SELECT count(*) FROM finding_traffic_bindings b WHERE b.finding_id=f.id)::integer traffic_count,
 lineage.src_id intent_id
 FROM exploration_nodes n JOIN scopes s ON s.exploration_id=n.exploration_id
 LEFT JOIN findings f ON f.node_id=n.id
 LEFT JOIN LATERAL (
 SELECT e.src_id FROM exploration_edges e
 WHERE e.exploration_id=n.exploration_id AND e.dst_id=n.id AND e.rel='yields' AND n.kind='finding'
 AND (NOT s.inherited OR EXISTS(SELECT 1 FROM exploration_nodes i WHERE i.id=e.src_id AND i.exploration_id=e.exploration_id AND i.kind='intent' AND i.state IN('done','blocked','exhausted','stopped')))
 ORDER BY e.src_id DESC LIMIT 1
 ) lineage ON TRUE`;
export class FindingReads {
 constructor(private pool:Pool){}
 async exists(taskId:number):Promise<boolean>{return !!(await this.pool.query('SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskId])).rowCount;}
 async list(taskId:number):Promise<Record<string,unknown>[]> {
  const rows=(await this.pool.query(`WITH ${scope}, ranked AS (
   ${enriched.replace('SELECT n.*','SELECT row_number() OVER(PARTITION BY n.exploration_id ORDER BY n.id DESC) rn,n.*')}
   WHERE n.kind='finding'
  ) SELECT * FROM ranked WHERE rn<=500 ORDER BY ordinal,id DESC`,[taskId])).rows;
  return rows.map(n=>{
   const p=n.payload??{},m:Record<string,unknown>={id:Number(n.id),state:n.state,summary:p.summary??null,task_id:Number(n.owning_task)};
   for(const key of ['vulnclass','severity'])if(p[key]!=null&&p[key]!=='')m[key]=p[key];
   if(n.inherited){m.source_task_id=Number(n.owning_task);m.inherited=true;}
   if(n.finding_id){m.finding_id=Number(n.finding_id);m.finding_node_id=Number(n.id);m.traffic_count=n.traffic_count;}
   if(n.intent_id)m.intent_id=Number(n.intent_id);return m;
  });
 }
 async node(taskId:number,id:number):Promise<Record<string,unknown>|null>{
  const n=(await this.pool.query(`WITH ${scope} ${enriched}
   WHERE n.id=$2 AND (NOT s.inherited OR n.kind<>'intent' OR n.state IN('done','blocked','exhausted','stopped'))`,[taskId,id])).rows[0];
  if(!n)return null;
  const out:Record<string,unknown>={id:Number(n.id),kind:n.kind,payload:n.payload,priority:n.priority,state:n.state,
    created_at:goLocalTime(String(n.created_iso))};
  for(const key of ['origin','owner','blocked_reason','delete_reason'])if(n[key])out[key]=n[key];
  if(n.inherited){out.source_task_id=Number(n.owning_task);out.inherited=true;}
  if(n.kind==='finding'&&n.finding_id){out.finding_id=Number(n.finding_id);out.finding_node_id=Number(n.id);if(n.traffic_count)out.traffic_count=n.traffic_count;}
  return out;
 }
}
/** Preserve PostgreSQL microseconds and Go time.Local RFC3339Nano rendering. */
export function goLocalTime(utc:string):string {
 const d=new Date(utc),pad=(n:number,w=2)=>String(n).padStart(w,'0'),fraction=(utc.match(/\.(\d+)Z$/)?.[1]??'').replace(/0+$/,''),offset=-d.getTimezoneOffset();
 const zone=offset===0?'Z':(offset<0?'-':'+')+pad(Math.floor(Math.abs(offset)/60))+':'+pad(Math.abs(offset)%60);
 return `${pad(d.getFullYear(),4)}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${fraction?'.'+fraction:''}${zone}`;
}
export const findingIDGuidance="\n\n**Vulnerability numbering convention**: finding_id is the independent vulnerability record ID; finding_node_id is the exploration node ID. The id of list_findings / list_task_findings / node_detail / get_task_node_detail is retained as the discovery node ID, independent numbers should be read from the same returned finding_id. get_finding_traffic / bind_finding_traffic with independent finding_id. The finding_id parameter of the old update_finding_report still passes finding_node_id. Do not use the number in the first line of report_finding for evidence tools, nor do you encounter a numbering error and then guess a different number.";
