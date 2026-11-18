import {registerTool} from '../tools/gate.ts';
import type {PlatformDeps} from '../tools/platform.ts';
/** Controls are scoped to the host's current task, never a model-supplied id. */
export function registerCurrentTaskControls(deps:Pick<PlatformDeps,'pool'|'tasks'|'taskOperation'>):void {
  for(const action of ['pause','stop'] as const)registerTool({
    key:action==='pause'?'pause_current_task':'stop_current_task',
    description:action==='pause'?"Pause planning and execution of the current task, retaining the main Agent conversation to summarize existing findings.":"Stops all planning and execution of the current mission, retaining the findings and evidence produced so that they can be read and summarized later.",
    schema:{type:'object',properties:{},additionalProperties:false},params:{},required:[],
    execute:async(_params,ctx)=>{
      if(ctx.agentKey!=='mainagent'||ctx.businessKind!=='task'||!Number.isSafeInteger(ctx.taskId)||!ctx.taskId||ctx.taskId<=0)
        throw new Error("This operation is only available to the master Agent of the current task");
      const id=ctx.taskId,release=deps.taskOperation?.(id);
      if(deps.taskOperation&&!release)throw new Error("Task is being deleted and cannot be controlled");
      try{
        const row=(await deps.pool.query('SELECT status,paused FROM tasks WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
        if(!row)throw new Error("Task does not exist");
        if(['done','failed','timeout'].includes(row.status))return {task_id:String(id),already_terminal:true,status:row.status};
        if(action==='pause'&&row.paused)return {task_id:String(id),paused:true,already_paused:true};
        const result=await deps.tasks.control(id,action);if(!result.ok)throw new Error(result.error??"Mission control failed");
        return {task_id:String(id),action,execution_stopped:true,can_summarize:true};
      }finally{release?.();}
    },
  });
}
