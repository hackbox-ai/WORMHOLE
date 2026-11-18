// Synthetic ledger for the existing demo mode; production uses the server meter.
export function demoTokenUsage(q:URLSearchParams,detail=false){
 const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const end=new Date(today+"T00:00:00+08:00").getTime(),days=Number(q.get("days")??30),start=end-(days?days-1:2)*86400000;
 const rows=Array.from({length:60},(_,i)=>{
  const profile=i%2+1,source=["task","modeling","conversation"][i%3];
  const input_tokens=1000+i*10,output_tokens=80+i,cache_read_tokens=2000+i*20,cache_write_tokens=i%5?0:100;
  return {id:i+1,ts:new Date(end-i%3*86400000+3600000+i*1000).toISOString(),profile_id:profile,profile_key:"profile:"+profile,
   profile_name:profile===1?"Default configuration":"Alternate Configuration",model:"demo-model-"+profile,source,task_id:source==="conversation"?null:String(profile),
   task_name:source==="conversation"?null:"Demonstration Task "+profile,worker:source==="modeling"?"modeler":"worker",status:i===0?"error":"ok",
   input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens:input_tokens+output_tokens+cache_read_tokens+cache_write_tokens};
 });
 const selected=rows.filter(r=>new Date(r.ts).getTime()>=start&&(!q.get("profile")||q.get("profile")==="all"||r.profile_key===q.get("profile"))&&(!q.get("source")||q.get("source")==="all"||r.source===q.get("source"))&&(!q.get("task")||r.task_id===q.get("task")));
 const count=(items:typeof rows)=>({
  input_tokens:items.reduce((n,r)=>n+r.input_tokens,0),output_tokens:items.reduce((n,r)=>n+r.output_tokens,0),
  cache_read_tokens:items.reduce((n,r)=>n+r.cache_read_tokens,0),cache_write_tokens:items.reduce((n,r)=>n+r.cache_write_tokens,0),
  total_tokens:items.reduce((n,r)=>n+r.total_tokens,0),calls:items.length,tasks:new Set(items.map(r=>r.task_id).filter(Boolean)).size,failed_calls:items.filter(r=>r.status==="error").length,
 });
 if(detail){const page=Number(q.get("page")??1),size=Number(q.get("page_size")??25);return {items:selected.slice((page-1)*size,page*size),total:selected.length,page,page_size:size};}
 const date=(stamp:number)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(stamp));
 const daily=Array.from({length:days||3},(_,i)=>{const day=start+i*86400000;return {date:date(day),...count(selected.filter(r=>date(new Date(r.ts).getTime())===date(day)))};});
 const profiles=[{key:"profile:1",name:"Default configuration",profile_id:1},{key:"profile:2",name:"Alternate Configuration",profile_id:2}];
 return {summary:count(selected),daily,by_profile:profiles.map(p=>({...count(selected.filter(r=>r.profile_key===p.key)),profile_key:p.key,profile_name:p.name,profile_id:p.profile_id})),
  by_source:["task","modeling","conversation"].map(source=>({source,...count(selected.filter(r=>r.source===source))})),profiles,
  tasks:[{id:"1",name:"Demonstration Task 1"},{id:"2",name:"Demonstration Task 2"}],period:{start:date(start),end:today,days,timezone:"Asia/Shanghai",available_since:date(end-2*86400000)}};
}
