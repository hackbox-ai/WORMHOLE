import type {Pool} from 'pg';

export interface FindingTaskHost {
  beginTaskOperation(id:number):(()=>void)|null;
  admitFollowUp(id:number):Promise<boolean>;
}
export type FollowUpResult={ok:false;status:number;error:string}|{ok:true;status:200;body:{task_id:string;intent_id:string;state:string;queued:boolean}};
const unavailable='finding origin task or node is no longer available';

/** Finding follow-up intents remain owned by the associated task. */
export async function deepenFinding(pool:Pool,host:FindingTaskHost|undefined,findingId:number,raw:string):Promise<FollowUpResult>{
  const description=raw.trim();
  if(!Number.isSafeInteger(findingId)||findingId<=0)return {ok:false,status:400,error:'bad finding id'};
  if(!description)return {ok:false,status:400,error:'description is required'};
  if([...description].length>4000)return {ok:false,status:400,error:'description must be at most 4000 characters'};
  const f=(await pool.query('SELECT task_id,node_id FROM findings WHERE id=$1',[findingId])).rows[0];
  if(!f)return {ok:false,status:404,error:'finding not found'};
  if(!f.task_id||!f.node_id)return {ok:false,status:409,error:unavailable};
  const taskId=Number(f.task_id),nodeId=Number(f.node_id);
  if(!(await pool.query('SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL',[taskId])).rowCount)return {ok:false,status:409,error:'finding origin task is no longer available'};
  if(!host)return {ok:false,status:503,error:'task runtime is not available'};
  const release=host.beginTaskOperation(taskId);if(!release)return {ok:false,status:409,error:'task is being deleted'};
  let intentId:number|undefined,explorationId:number|undefined;
  try{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const live=(await c.query(`SELECT n.id,t.exploration_id FROM findings f
        JOIN tasks t ON t.id=f.task_id JOIN exploration_nodes n ON n.id=f.node_id AND n.exploration_id=t.exploration_id
        WHERE f.id=$1 AND f.node_id=$2 AND t.id=$3 AND t.deleted_at IS NULL AND n.kind='finding' FOR SHARE OF f,t,n`,[findingId,nodeId,taskId])).rows[0];
      if(!live){await c.query('ROLLBACK');return {ok:false,status:409,error:unavailable};}
      explorationId=Number(live.exploration_id);
      const assets=(await c.query('SELECT asset_id FROM exploration_anchors WHERE node_id=$1 ORDER BY asset_id',[nodeId])).rows.map(r=>Number(r.asset_id));
      const payload={summary:description,source_finding_id:findingId,source_finding_node_id:nodeId,...(assets.length?{asset_ids:assets}:{})};
      const n=(await c.query(`INSERT INTO exploration_nodes(task_id,exploration_id,kind,title,payload,priority,state,origin)
        VALUES($1,$2,'intent',$3,$4::jsonb,10,'open','human') RETURNING id`,[taskId,explorationId,description,JSON.stringify(payload)])).rows[0];intentId=Number(n.id);
      await c.query('INSERT INTO exploration_anchors(node_id,asset_id) SELECT $1,asset_id FROM exploration_anchors WHERE node_id=$2 ON CONFLICT DO NOTHING',[intentId,nodeId]);
      await c.query("INSERT INTO exploration_edges(exploration_id,src_id,rel,dst_id) VALUES($1,$2,'derived_from',$3)",[explorationId,nodeId,intentId]);
      await c.query("INSERT INTO activity(exploration_id,node_id,worker,kind,summary,detail,metadata) VALUES($1,$2,'system','text',$3,$4,'{}')",[explorationId,intentId,`Manually submit vulnerability in-depth exploitation intention #${intentId}`,description]);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    let queued:boolean;
    try{queued=await host.admitFollowUp(taskId);}
    catch(e){
      // Original DiscardOpenIntent: never discard claimed or unrelated work.
      const c=await pool.connect();try{await c.query('BEGIN');
        const n=(await c.query("SELECT id FROM exploration_nodes WHERE id=$1 AND exploration_id=$2 AND kind='intent' AND state='open' FOR UPDATE",[intentId,explorationId])).rows[0];
        if(!n)throw new Error(`open intent ${intentId} was not available for admission rollback`);
        await c.query('DELETE FROM activity WHERE exploration_id=$1 AND node_id=$2',[explorationId,intentId]);
        await c.query('DELETE FROM exploration_nodes WHERE id=$1',[intentId]);await c.query('COMMIT');
      }catch(rollback){await c.query('ROLLBACK');throw new AggregateError([e,rollback],'follow-up admission and compensation failed');}finally{c.release();}
      throw e;
    }
    const state=(await pool.query('SELECT state FROM exploration_nodes WHERE id=$1',[intentId])).rows[0]?.state??'open';
    return {ok:true,status:200,body:{task_id:String(taskId),intent_id:String(intentId),state,queued}};
  }finally{release();}
}
