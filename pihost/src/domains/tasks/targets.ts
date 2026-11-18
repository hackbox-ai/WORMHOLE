import {normalizeTarget,targetsInText} from '../modeling/document.ts';
type TargetTask = {
  web_targets?:unknown; modeling_targets?:unknown; target_input?:unknown;
  goal?:unknown; description?:unknown;
};
function normalized(values:unknown):string[] {
  if(!Array.isArray(values))return [];
  return [...new Set(values.flatMap(v=>{
    if(typeof v!=='string'||/\s/.test(v.trim()))return [];
    try{return [normalizeTarget(v)];}catch{return [];}
  }))].slice(0,20);
}
/** Persisted user input wins; legacy tasks use the same extraction as intake.
 * Assets discovered by a Worker never grant additional browser origins. */
export function taskWebTargets(task:TargetTask):string[] {
  const declared=normalized(task.web_targets);
  if(declared.length)return declared;
  const explicit=normalized(task.modeling_targets);
  if(explicit.length)return explicit;
  const target=normalized(typeof task.target_input==='string'?[task.target_input]:[]);
  if(target.length)return target;
  return targetsInText(String(task.goal??'')+'\n'+String(task.description??''));
}
/** Auto-detected URLs are entry hints for one service per origin.
 * Explicit application roots remain distinct and are never coalesced. */
export function initialModelingTargets(task:TargetTask):string[] {
  const explicit=normalized(task.modeling_targets);
  if(explicit.length)return explicit;
  const seen=new Set<string>();
  return taskWebTargets(task).filter(t=>{
    const origin=new URL(t).origin;
    if(seen.has(origin))return false;
    seen.add(origin);return true;
  });
}
export function discoveryModelingTarget(task:TargetTask,target:string):string {
  const url=new URL(target),explicit=normalized(task.modeling_targets);
  const candidates=initialModelingTargets(task).filter(t=>{
    const base=new URL(t);if(base.origin!==url.origin)return false;
    return !explicit.length||base.pathname==='/'||url.pathname===base.pathname||
      url.pathname.startsWith(base.pathname.replace(/\/$/,'')+'/');
  });
  return candidates.sort((a,b)=>new URL(b).pathname.length-new URL(a).pathname.length)[0]??target;
}
