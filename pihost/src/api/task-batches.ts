import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
import {TaskBatches,parseBatchTargets} from '../domains/tasks/batches.ts';
import {withTaskReport} from '../domains/tasks/report.ts';
export async function routeTaskBatches(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void){
 if(!url.pathname.startsWith('/api/task-batches'))return false;
 const p=url.pathname.slice('/api/task-batches'.length);
 const service=new TaskBatches(ctx.pool,ctx.tasks,async()=>({fingerprint:ctx.fingerprints&&await ctx.fingerprints.enabled()?await ctx.fingerprints.snapshot():undefined,poc:ctx.pocs&&await ctx.pocs.enabled()?await ctx.pocs.snapshot():undefined}));
 try{
  if(p==='/options'&&req.method==='GET'){json(res,200,await service.options());return true;}
  if(p==='/preview'&&req.method==='POST'){const b=await readObject(req,2*1024*1024);json(res,200,parseBatchTargets(b.targets));return true;}
  if(p===''&&req.method==='GET'){json(res,200,{items:await service.list()});return true;}
  if(p===''&&req.method==='POST'){const result=await service.create(await readObject(req,2*1024*1024));void ctx.taskEngine.pumpQueue().catch(e=>console.error('[batch] queue',e));json(res,201,result);return true;}
  const m=p.match(/^\/([\da-f-]{36})(\/control)?$/i);if(!m){json(res,404,{error:"Batch interface does not exist"});return true;}
  const detail=await service.detail(m[1]!);if(!detail){json(res,404,{error:"Batch does not exist"});return true;}
  if(!m[2]&&req.method==='GET'){json(res,200,detail);return true;}
  if(m[2]&&req.method==='POST'){
   const body=await readObject(req,4096),action=String(body.action);if(!['pause_queue','pause_all','resume','cancel_waiting','stop_all'].includes(action))throw new Error("Invalid batch operation");
   // Persist the batch gate before controlling children; admission rechecks it.
   if(['pause_queue','pause_all','stop_all'].includes(action))await ctx.pool.query('UPDATE task_batches SET paused=true WHERE id=$1',[m[1]]);
   if(action==='resume')await ctx.pool.query('UPDATE task_batches SET paused=false WHERE id=$1',[m[1]]);
   const current=(await service.detail(m[1]!))!;const results=[];
   for(const t of current.tasks){if(['done','failed','timeout'].includes(t.status))continue;
    const waiting=t.queued||!t.first_run_at;
    if(action==='cancel_waiting'||(action==='stop_all'&&waiting)){if(waiting){const changed=await withTaskReport(ctx.pool,Number(t.id),"The user cancels the queue and saves the existing results",c=>c.query("UPDATE tasks SET status='failed',queued=false,paused=false,completed_at=now(),stopped_reason='User canceled queue' WHERE id=$1 AND (queued OR first_run_at IS NULL) AND status IN('created','running','paused')",[t.id]));results.push({id:t.id,ok:!!changed.rowCount});}continue;}
    if(action==='pause_queue'&&!waiting)continue;
    const control=action==='resume'?'resume':action==='stop_all'?'stop':'pause';
    if(control==='resume'&&!t.paused)continue;if(control==='pause'&&t.paused)continue;
    try{results.push({id:t.id,...await ctx.tasks.control(Number(t.id),control)});}catch(e){results.push({id:t.id,ok:false,error:String(e)});}
   }
   // Initial business modeling belongs to the target's lifecycle. Never stop a
   // model run still needed by an active task outside this batch.
   const models=(await ctx.pool.query(`SELECT DISTINCT child.id,child.queued,child.paused,child.first_run_at FROM task_business_models link JOIN tasks parent ON parent.id=link.task_id JOIN tasks child ON child.id=link.modeling_task_id WHERE parent.batch_id=$1 AND child.status IN('created','running','paused') AND child.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM task_business_models other JOIN tasks p ON p.id=other.task_id WHERE other.modeling_task_id=child.id AND p.batch_id IS DISTINCT FROM $1::uuid AND p.status IN('created','running','paused') AND p.deleted_at IS NULL)`,[m[1]])).rows;
   for(const model of models){
    if(action==='pause_queue'&&!model.queued)continue;
    if(action==='cancel_waiting'&&(await ctx.pool.query("SELECT 1 FROM task_business_models m JOIN tasks p ON p.id=m.task_id WHERE m.modeling_task_id=$1 AND p.status IN('created','running','paused') AND p.deleted_at IS NULL",[model.id])).rowCount)continue;
    const control=action==='resume'?'resume':action==='stop_all'||action==='cancel_waiting'?'stop':'pause';
    if(control==='resume'&&!model.paused||control==='pause'&&model.paused)continue;
    try{results.push({id:model.id,...await ctx.tasks.control(Number(model.id),control)});}catch(e){results.push({id:model.id,ok:false,error:String(e)});}
   }
   void ctx.taskEngine.pumpQueue().catch(console.error);json(res,200,{items:results});return true;
  }
  json(res,405,{error:"Unsupported operation"});
 }catch(e){json(res,400,{error:e instanceof Error?e.message:String(e)});}return true;
}
