import type {Pool} from 'pg';
import {directExplorationScope} from '../exploration/scope.ts';
import {nodeDTO} from '../exploration/service.ts';
import {CAUSAL_RELATIONS,markFindingPaths} from '../exploration/paths.ts';

export class FindingLineage {
 constructor(private pool:Pool){}
 async read(findingId:number){
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const finding=(await c.query('SELECT id,name,task_id,node_id,created_at FROM findings WHERE id=$1',[findingId])).rows[0];
   if(!finding){await c.query('COMMIT');return null;}
   const empty=(reason:string)=>({finding,nodes:[],edges:[],reason});
   if(!finding.task_id||!finding.node_id){await c.query('COMMIT');return empty('unlinked');}
   const nodes=(await c.query(`WITH RECURSIVE ${directExplorationScope}, visible AS (
    SELECT n.*,s.task_id AS owner_task_id,s.inherited FROM exploration_nodes n JOIN scopes s USING(exploration_id)
    WHERE NOT s.inherited OR n.kind<>'intent' OR n.state IN('done','blocked','exhausted','stopped')
   ), ancestors(id) AS (
    SELECT id FROM visible WHERE id=$2 AND kind='finding' AND NOT inherited
    UNION
    SELECT e.src_id FROM ancestors a JOIN exploration_edges e ON e.dst_id=a.id
    JOIN scopes s ON s.exploration_id=e.exploration_id JOIN visible p ON p.id=e.src_id
    WHERE e.rel=ANY($3::text[])
   ) SELECT n.* FROM visible n JOIN ancestors a USING(id) ORDER BY n.id`,[finding.task_id,finding.node_id,CAUSAL_RELATIONS])).rows;
   if(!nodes.length){await c.query('COMMIT');return empty('node_unavailable');}
   const ids=nodes.map(n=>n.id);
   const edges=(await c.query(`WITH ${directExplorationScope} SELECT e.* FROM exploration_edges e JOIN scopes s USING(exploration_id)
    WHERE src_id=ANY($2::bigint[]) AND dst_id=ANY($2::bigint[]) AND rel=ANY($3::text[]) ORDER BY src_id,dst_id,rel`,[finding.task_id,ids,CAUSAL_RELATIONS])).rows;
   const graph=markFindingPaths(nodes.map(n=>nodeDTO({...n,task_id:n.owner_task_id,source_task_id:n.inherited?n.owner_task_id:undefined})),edges.map(e=>({src:String(e.src_id),dst:String(e.dst_id),rel:e.rel})));
   await c.query('COMMIT');return {finding,...graph};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
}
