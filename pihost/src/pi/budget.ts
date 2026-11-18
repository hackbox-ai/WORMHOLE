import type {AgentSession} from '@earendil-works/pi-coding-agent';
export interface RunBudget {maxTurns:number;runSeconds:number;settlement?:{prompt:string;maxTurns:number;disabledTools:string[];timeoutPrompt?:string;runSeconds?:number}}
export interface BudgetExit {reason:'max_turns'|'timeout';mainTurns:number;settlementTurns:number;settled:boolean}
/** Adapter over public Pi hooks. Never rewrites SDK loop state or checkpoints. */
export function budgetSession(native:AgentSession,load:()=>Promise<RunBudget>,externallyCancelled:()=>boolean,completed:()=>void=()=>{}){
 const prompt=native.prompt.bind(native),abort=native.abort.bind(native);let running=false,disposed=false,cancelled=false,lastExit:BudgetExit|undefined,cancelEpoch=0,phase:'main'|'settlement'='main';
 const call:AgentSession['prompt']=async(...args)=>{
  if(running)return prompt(...args); // Preserve native busy/steering contract.
  lastExit=undefined;const epoch=cancelEpoch,budget=await load();if(epoch!==cancelEpoch||externallyCancelled())return;if(disposed)throw new Error('session disposed');
  if(!budget.maxTurns&&!budget.runSeconds)return prompt(...args);
  running=true;cancelled=false;lastExit=undefined;phase='main';let mainTurns=0,settlementTurns=0,reason:BudgetExit['reason']|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const previous=native.agent.finishTurn,tools=native.getActiveToolNames();
  native.agent.finishTurn=async(context,signal)=>{
   if(phase==='main')mainTurns++;else settlementTurns++;
   const max=phase==='main'?budget.maxTurns:budget.settlement?.maxTurns??0;
   const continuing=context.message.content.some(part=>part.type==='toolCall');
   if(max>0&&(phase==='main'?mainTurns:settlementTurns)>=max&&continuing){if(phase==='main')reason='max_turns';return {action:'end'};}
   const decision=await previous?.(context,signal);if(decision)return decision;
  };
  try{
   if(budget.runSeconds>0){
    const deadline=Date.now()+budget.runSeconds*1000;
    const tick=()=>{const remaining=deadline-Date.now();if(remaining<=0){reason='timeout';void abort();}
      else timer=setTimeout(tick,Math.min(remaining,2147483647));};
    tick();
   }
   let failure:unknown;try{await prompt(...args);}catch(error){failure=error;}
   if(timer){clearTimeout(timer);timer=undefined;}
   if(!reason){if(failure)throw failure;return;}
   lastExit={reason,mainTurns,settlementTurns:0,settled:false};
   if(!budget.settlement||cancelled||disposed||externallyCancelled())return;
   phase='settlement';native.setActiveToolsByName(tools.filter(name=>!budget.settlement!.disabledTools.includes(name)));
   // Settlement itself must not start another unbounded loop.
   timer=setTimeout(()=>{cancelled=true;void abort();},Math.max(1,budget.settlement.runSeconds??60)*1000);
   await prompt(reason==='timeout'&&budget.settlement.timeoutPrompt?budget.settlement.timeoutPrompt:budget.settlement.prompt,{expandPromptTemplates:false});
   const last=native.messages.filter(message=>message.role==='assistant').at(-1);
   lastExit={reason,mainTurns,settlementTurns,settled:!cancelled&&!externallyCancelled()&&!!last&&!['error','aborted','length'].includes(last.stopReason)};
  }finally{
   if(timer)clearTimeout(timer);native.agent.finishTurn=previous;
   if(!disposed)native.setActiveToolsByName(tools);try{completed();}finally{running=false;}
  }
 };
 const session=new Proxy(native,{get(target,key){if(key==='prompt')return call;if(key==='abort')return async()=>{cancelled=true;cancelEpoch++;await abort();};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 return {session,get active(){return running;},get phase(){return phase;},get exit(){return lastExit;},dispose(){disposed=true;cancelled=true;cancelEpoch++;}};
}

/** Original agent/taskclock.go: zero means unlimited; past deadline floors at 1s. */
export function clampRunSeconds(deadlineMs:number,ownSeconds:number,now=Date.now()){
 if(!(deadlineMs>0))return {seconds:ownSeconds,clamped:false};
 const remaining=Math.max(1,(deadlineMs-now)/1000),clamped=ownSeconds<=0||remaining<=ownSeconds;
 return {seconds:ownSeconds>0?Math.min(ownSeconds,remaining):remaining,clamped};
}
