import {requestDiscoveryFinish} from '../tasks/continuous.ts';
import {FindingReads} from '../findings/reads.ts';
import {completeAchievedTask} from '../tasks/completion.ts';
import type {Pool} from 'pg';
import {registerTool,type ToolContext,type ToolSchema} from '../tools/gate.ts';
import {ExplorationService,type GraphPayload} from './service.ts';
const str={type:'string'},integer={type:'integer'},id={anyOf:[{type:'integer'},{type:'string',pattern:'^[0-9]+$'}]},idArray={type:'array',items:integer};
const obj=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,...(required.length?{required}:{})});
export const GRAPH_TOOLS={
  planner:['graph_overview','list_facts','node_detail','list_goals','add_intent','prove_goal','resolve_goal','goal_met','finish_discovery','expand_digest'],
  worker:['record_fact','node_detail'],
  mainagent:['graph_overview','list_facts','node_detail','add_hint','add_intent','set_goals','set_constraints','record_fact','resolve_goal','expand_digest'],
  goals:['set_goals','set_constraints'],
};
export function registerGraphTools(pool:Pool,graph:ExplorationService,notify:(taskId:number)=>void,revive?:(taskId:number)=>Promise<void>,completed?:(taskId:number)=>void):void{
  const task=(ctx:ToolContext)=>{if(!ctx.taskId)throw new Error("Task context required");return ctx.taskId;};
  const specs:ToolSchema[]=[];
  const add=(key:string,description:string,schema:Record<string,unknown>,execute:ToolSchema['execute'])=>specs.push({key,description,schema,params:{},required:[],execute});
  const intentFields={summary:str,asset_ids:idArray,parent_ids:idArray,priority:integer,test_key:str,hypothesis:str,stop_condition:str,new_evidence_ids:idArray,fingerprint_observation_ids:{...idArray,maxItems:20},poc_candidate_ids:{...idArray,maxItems:20},business_system_id:integer};
  const factFields={summary:str,detail:str,evidence:str,confidence:str,intent_id:id,asset_ids:idArray,poc_candidate_ids:{...idArray,maxItems:20},hunt_source_ids:{type:'array',maxItems:20,items:{type:'string',pattern:'^[0-9a-fA-F-]{36}$'}}};
  const batch=(key:string,fields:Record<string,unknown>,required:string[],fn:(taskId:number,p:GraphPayload,ctx:ToolContext)=>Promise<number>,message:(id:number)=>string)=>
    async(p:GraphPayload,ctx:ToolContext)=>{
      const taskId=task(ctx),items=Array.isArray(p[key])&&p[key].length?p[key] as GraphPayload[]:[p];
      const isBatch=Array.isArray(p[key])&&(p[key] as unknown[]).length>0,ids:number[]=[],errors:Record<string,string>={};
      for(let i=0;i<items.length;i++){if(ctx.signal?.aborted)throw new Error("Run canceled");try{ids.push(await fn(taskId,{...(p.intent_id?{intent_id:p.intent_id}:{}),...items[i]!},ctx));}catch(e){ids.push(0);errors[String(i)]=e instanceof Error?e.message:String(e);}}
      if(!isBatch){if(errors['0'])throw new Error(errors['0']);return message(ids[0]!);}
      return {ids,...(Object.keys(errors).length?{errors}:{})};
    };
  const batched=(field:string,fields:Record<string,unknown>,required:string[])=>obj({...fields,[field]:{type:'array',items:obj(fields,required)}});
  add('add_intent',"Generate exploration direction and connect to frontier. parent_ids only allows facts/findings of this task or directly related tasks; leave blank to connect origin fact.",batched('intents',intentFields,['summary']),async(p,ctx)=>{
    const result=await batch('intents',intentFields,['summary'],(t,v)=>graph.addIntent(t,v,{viaAgent:true,allowCompleted:ctx.agentKey==='mainagent'}),n=>`intent created: ${n}`)(p,ctx);
    if(ctx.agentKey==='mainagent'){await revive?.(task(ctx));notify(task(ctx));}return result;
  });
  add('record_fact',"Record real exploration conclusions, evidence and confidence, intent → yields → fact.",batched('facts',factFields,['summary']),batch('facts',factFields,['summary'],(t,p,ctx)=>graph.recordFact(t,p,ctx.agentKey,Number(p.intent_id)||ctx.intentId||0),n=>`fact recorded: ${n}`));
  const goalFields={text:str,vulnclass:str,objective_type:{type:'string',enum:['coverage','finding']}};
  add('set_goals',"Added final verifiable target. The goal is not an attack step, call prove_goal to prove achievement with facts/findings.",batched('goals',goalFields,['text']),async(p,ctx)=>{
    const result=await batch('goals',goalFields,['text'],(t,v,c)=>graph.addGoal(t,v,c.agentKey==='mainagent'?'human':c.agentKey),n=>`goal created: ${n}`)(p,ctx);
    if(ctx.agentKey==='mainagent')await revive?.(task(ctx));return result;
  });
  const constraints={text:str,type:{type:'string',enum:['allow','deny']}};
  add('set_constraints',"Only register allow/deny operational constraints explicitly specified by the user.",batched('constraints',constraints,['text']),batch('constraints',constraints,['text'],(t,v,c)=>graph.addConstraint(t,v,c.agentKey),n=>`constraint created: ${n}`));
  const hintFields={text:str,asset_ids:idArray,traffic_refs:{type:'array',items:obj({traffic_id:str,role:{type:'string',enum:['baseline','proof','verification','supporting']},note:str},['traffic_id'])}};
  add('add_hint',"Hook human strategy cues to exploration maps and wake up planners.",batched('hints',hintFields,['text']),async(p,c)=>graph.addHints(task(c),p,c.signal));
  add('prove_goal',"Facts/vulnerabilities prove a target, connect proves and place met; normal tasks are automatically completed when all targets are met; continuous mining tasks continue in other directions.",obj({goal_id:id,evidence_id:id,reason:str},['goal_id','evidence_id']),async(p,ctx)=>{
    const t=task(ctx),r=await graph.proveGoal(t,Number(p.goal_id),Number(p.evidence_id));
    if(r.completed)completed?.(t);
    return `goal ${p.goal_id} marked met${r.completed?`;All in this task ${r.goals} All goals have been achieved, and the task is automatically determined to be completed.`:r.allMet?"; The stage goal has been marked; Continuous mining tasks continue to be covered, and ordinary tasks wait for knowledge review to be completed.":''}`;
  });
  add('resolve_goal',"Documenting negative tests or insufficient conditions must cite actual facts; do not mark the vulnerability as confirmed.",obj({goal_id:integer,evidence_id:integer,outcome:{type:'string',enum:['tested_negative','blocked']},reason:str},['goal_id','evidence_id','outcome','reason']),async(p,ctx)=>{
    await graph.resolveGoal(task(ctx),Number(p.goal_id),Number(p.evidence_id),String(p.outcome),String(p.reason));
    return {goal_id:p.goal_id,outcome:p.outcome,achieved:false};
  });
  add('goal_met',"End the entire mission immediately. It is only used when all goals are truly achieved and is not used to end this round of planning.",obj({reason:str},['reason']),async(p,ctx)=>{
    if((await pool.query('SELECT execution_mode FROM tasks WHERE id=$1',[task(ctx)])).rows[0]?.execution_mode==='continuous')throw new Error("Continuous mining tasks cannot be ended with goal_met; continue coverage or submit evidential coverage review with finish_discovery");
    const done=await completeAchievedTask(pool,task(ctx));if(done)completed?.(task(ctx));notify(task(ctx));return done?'acknowledged: goal marked met':'completion deferred: waiting for fingerprint / PoC queue or review';
  });
  add('finish_discovery',"When the continuous mining task confirms that there is no new direction to execute, the coverage review is submitted; the host reviews the knowledge base and checks that there is no new work, and then ends.",obj({reason:str,evidence_ids:idArray,coverage:{type:'array',items:obj({area:str,outcome:{type:'string',enum:['tested','blocked','not_applicable']},reason:str},['area','outcome','reason'])}},['reason','evidence_ids','coverage']),async(p,ctx)=>{await requestDiscoveryFinish(pool,task(ctx),String(p.reason??''),p.evidence_ids as number[],p.coverage);notify(task(ctx));return "Coverage review has been submitted; the host will determine the end of this round after successfully completing and checking the knowledge review.";});
  add('graph_overview',"Mission objectives, prompts, opening/executing intent, conclusion, and lineage overview.",obj({}),async(_p,c)=>graph.overview(task(c)));
  add('list_goals',"List the target node and open/met status of this task.",obj({}),async(_p,c)=>graph.nodes(task(c),'goal'));
  add('list_facts',"List this task and directly related task facts in pages, and return facts/total/has_more/next_before.",obj({limit:integer,before:integer,q:str}),async(p,c)=>graph.facts(task(c),p));
  add('node_detail',"Read the complete content according to the exploration node id, and the directly associated task is read-only.",obj({id},['id']),async(p,c)=>{
    if(Number(p.id)<=0)throw new Error("id required");
    const n=await new FindingReads(pool).node(task(c),Number(p.id));if(!n)throw new Error(`Exploration node not found ${p.id}. If you want to check assets, please use list_assets / asset_neighbors (assets and exploration nodes are in different id spaces, and asset ids cannot be passed to node_detail).`);return n;
  });
  add('expand_digest',"Expand the members and complete nodes of the cold zone digest.",obj({id},['id']),async(p,c)=>graph.expandDigest(task(c),Number(p.id)));
  for(const s of specs)registerTool(s);
}
