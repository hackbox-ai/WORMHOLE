/** Strict comparison for same-source fixtures. No implicit ID, clock or business-value ignores. */
export interface Diff {path:string;kind:'missing-in-pihost'|'extra-in-pihost'|'type'|'value';baseline?:unknown;pihost?:unknown}
const typeOf=(value:unknown)=>value===null?'null':Array.isArray(value)?'array':typeof value;
export function compareJson(baseline:unknown,pihost:unknown,path='$',out:Diff[]=[]):Diff[]{
 const a=typeOf(baseline),b=typeOf(pihost);if(a!==b){out.push({path,kind:'type',baseline:a,pihost:b});return out;}
 if(a==='array'){
  const left=baseline as unknown[],right=pihost as unknown[];
  if(left.length!==right.length)out.push({path,kind:'value',baseline:`array(${left.length})`,pihost:`array(${right.length})`});
  for(let i=0;i<Math.max(left.length,right.length);i++){
   if(i>=left.length)out.push({path:`${path}[${i}]`,kind:'extra-in-pihost',pihost:right[i]});
   else if(i>=right.length)out.push({path:`${path}[${i}]`,kind:'missing-in-pihost',baseline:left[i]});
   else compareJson(left[i],right[i],`${path}[${i}]`,out);
  }
 }else if(a==='object'){
  const left=baseline as Record<string,unknown>,right=pihost as Record<string,unknown>;
  for(const key of new Set([...Object.keys(left),...Object.keys(right)])){
   if(!Object.hasOwn(left,key))out.push({path:`${path}.${key}`,kind:'extra-in-pihost',pihost:right[key]});
   else if(!Object.hasOwn(right,key))out.push({path:`${path}.${key}`,kind:'missing-in-pihost',baseline:left[key]});
   else compareJson(left[key],right[key],`${path}.${key}`,out);
  }
 }else if(!Object.is(baseline,pihost))out.push({path,kind:'value',baseline,pihost});
 return out;
}
