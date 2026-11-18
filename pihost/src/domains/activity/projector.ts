/** coalesced steps and final-result de-duplication.
 * Each input is a durable Pi event. Projection + state + receipt commit together.
 * Ordinals hold a run at a missing DLQ event, without blocking unrelated runs.
 */
import type {Pool} from 'pg';
import {backgroundPool} from '../../db/pool.ts';
export interface ActivityContext {taskId?:number;conversationId?:number;nodeId?:number;worker:string;mainSeg?:number;userRecorded?:boolean}
export const capturedEvents=new Set(['agent_start','message_end','tool_execution_start','tool_execution_end','agent_end']);
export function firstLine(value:unknown,max:number):string {const s=String(value??'').trim().split('\n')[0]!;return Array.from(s).length>max?Array.from(s).slice(0,max).join('')+'…':s;}
const text=(content:any)=>typeof content==='string'?content:(Array.isArray(content)?content.filter(b=>b.type==='text').map(b=>b.text??'').join('\n'):'');
interface Capture {pending?:string;input:number;output:number;cacheRead:number;cacheWrite:number;error?:string}
export interface ProjectionOptions {runId?:string;maxEvents?:number}
export async function projectActivity(pool:Pool,options:ProjectionOptions={}):Promise<number> {
 pool=backgroundPool(pool);
 const c=await pool.connect();let count=0;
 try {await c.query('BEGIN');
  // A busy projector must never stall task control or a model's next tool.
  const locked=(await c.query("SELECT pg_try_advisory_xact_lock(hashtext('pi_activity_projection')) AS acquired")).rows[0]?.acquired;
  if(!locked){await c.query('ROLLBACK');return 0;}
  await c.query("SET LOCAL statement_timeout = '5s'");
  const maxEvents=Math.max(1,Math.min(2000,options.maxEvents??200));
  while(count<maxEvents){const events=(await c.query(`WITH pending AS MATERIALIZED (
    SELECT seq,ts,payload FROM business_events
    WHERE payload ? '_activity' AND NOT activity_projected
    ${options.runId ? "AND (payload->'_activity'->>'runId')=$1" : ''}
   ) SELECT e.seq,e.ts,e.payload FROM pending e
    LEFT JOIN pi_activity_capture s ON s.run_id=e.payload->'_activity'->>'runId'
    WHERE NOT EXISTS(SELECT 1 FROM pi_activity_projected p WHERE p.event_seq=e.seq)
    AND (e.payload->'_activity'->>'ordinal')::integer=COALESCE(s.next_ordinal,0)
    ORDER BY e.seq LIMIT ${Math.min(200,maxEvents-count)}`,options.runId?[options.runId]:[])).rows;let progressed=0;
   for(const row of events){const ev=row.payload,ctx=ev._activity as ActivityContext&{runId:string;ordinal:number};
    await c.query('INSERT INTO pi_activity_capture(run_id) VALUES($1) ON CONFLICT DO NOTHING',[ctx.runId]);
    const saved=(await c.query('SELECT * FROM pi_activity_capture WHERE run_id=$1',[ctx.runId])).rows[0];
    if(ctx.ordinal!==saved.next_ordinal)continue;
    let state:Capture={input:0,output:0,cacheRead:0,cacheWrite:0,...saved.state};
    const task=ctx.taskId?(await c.query('SELECT exploration_id FROM tasks WHERE id=$1 AND deleted_at IS NULL',[ctx.taskId])).rows[0]:undefined;
    const conversation=ctx.conversationId?(await c.query('SELECT id FROM conversations WHERE id=$1',[ctx.conversationId])).rows[0]:undefined;
    // Deleted tasks cannot be resurrected by projection. Receipts still advance.
    const emit=async(kind:string,detail='',opts:Record<string,unknown>={})=>{
     if(conversation){
      await c.query(`INSERT INTO conversation_activities(conversation_id,seq,worker,kind,tool,tool_use_id,is_error,summary,detail,
        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at)
        VALUES($1,COALESCE((SELECT MAX(seq)+1 FROM conversation_activities WHERE conversation_id=$1),1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [conversation.id,ctx.worker,kind,opts.tool??null,opts.tool_use_id??null,opts.is_error??false,
         opts.summary??firstLine(detail,kind==='result'?400:200),detail,opts.input_tokens??null,opts.output_tokens??null,
         opts.cache_read_tokens??null,opts.cache_write_tokens??null,row.ts]);
      // A pentest chat also has an owning task; project into both read models.
      if(!task?.exploration_id)return;
     }
     if(!task?.exploration_id)return;
     await c.query(`INSERT INTO activity(exploration_id,node_id,worker,kind,tool,tool_use_id,is_error,summary,detail,metadata,
       input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,created_at,main_seg)
       VALUES($1,(SELECT id FROM exploration_nodes WHERE id=$2 AND exploration_id=$1),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
       [task.exploration_id,ctx.nodeId??null,conversation?'mainagent':ctx.worker,kind,opts.tool??null,opts.tool_use_id??null,opts.is_error??false,
        opts.summary??firstLine(detail,kind==='result'?400:200),detail,JSON.stringify({...opts.metadata as Record<string,unknown>,...(conversation?{source_agent:ctx.worker,source_conversation_id:conversation.id}:{})}),
        opts.input_tokens??null,opts.output_tokens??null,opts.cache_read_tokens??null,opts.cache_write_tokens??null,row.ts,conversation?0:ctx.mainSeg??null]);
    };
    const usage=()=>({input_tokens:state.input,output_tokens:state.output,cache_read_tokens:state.cacheRead,cache_write_tokens:state.cacheWrite});
    const flush=async()=>{if(state.pending)await emit('text',state.pending);delete state.pending;};
    switch(ev.type){
     case 'agent_start':await flush();state={input:0,output:0,cacheRead:0,cacheWrite:0};break;
     case 'message_end':{
      const m=ev.message;if(m?.role==='user'){if((ctx.worker==='mainagent'||ctx.conversationId)&&!ctx.userRecorded)await emit('user',text(m.content));break;}
      if(m?.role!=='assistant')break;
      await flush();
      for(const block of m.content??[])if(block.type==='thinking'&&String(block.thinking??'').trim())await emit('thinking',block.thinking.trim());
      state.pending=text(m.content).trim()||undefined;
      const u=m.usage??{};state.input+=Number(u.input)||0;state.output+=Number(u.output)||0;state.cacheRead+=Number(u.cacheRead)||0;state.cacheWrite+=Number(u.cacheWrite)||0;
      if(m.errorMessage)state.error=String(m.errorMessage);else delete state.error;
      await emit('usage','',usage());break;
     }
     case 'tool_execution_start':await flush();{const detail=JSON.stringify(ev.args??{});await emit('tool_use',detail,{tool:ev.toolName,tool_use_id:ev.toolCallId,summary:ev.toolName+' '+firstLine(detail,200)});}break;
     case 'tool_execution_end':await flush();await emit('tool_result',text(ev.result?.content??ev.result),{tool:ev.toolName,tool_use_id:ev.toolCallId,is_error:!!ev.isError});break;
     case 'agent_end':{
      const last=(ev.messages??[]).filter((m:any)=>m.role==='assistant').at(-1);
      const final=text(last?.content).trim();if(state.pending===final)delete state.pending;await flush();
      const error=last?.errorMessage??state.error,aborted=last?.stopReason==='aborted';
      await emit('result',final||(error?String(error):aborted?"Execution aborted":"(No text output)"),{...usage(),is_error:!!error&&!aborted});break;
     }
    }
    await c.query('UPDATE pi_activity_capture SET next_ordinal=next_ordinal+1,state=$2 WHERE run_id=$1',[ctx.runId,JSON.stringify(state)]);
    await c.query('INSERT INTO pi_activity_projected(event_seq) VALUES($1)',[row.seq]);count++;progressed++;
    await c.query('UPDATE business_events SET activity_projected=true WHERE seq=$1',[row.seq]);
   }
   if(!progressed)break;
  }
  await c.query('COMMIT');return count;
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export function startActivityProjection(pool:Pool):()=>void {
 let pending=false;const timer=setInterval(()=>{if(pending)return;pending=true;void projectActivity(pool).catch(e=>console.error('[activity] projection deferred',e)).finally(()=>{pending=false;});},1000);timer.unref();return ()=>clearInterval(timer);
}
