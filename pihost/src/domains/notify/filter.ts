/** read-side decoding retains valid fields even when
 * another field has a JSON type error. Write-side validation is separate. */
export interface NotificationFilter {
  min_severity:string;task_ids:number[]|null;asset_ids:number[]|null;
  vulnclass_include:string[]|null;vulnclass_exclude:string[]|null;on_status_change:boolean;
}
export interface NotificationSnapshot {
  kind:string;finding_id:number;task_id:number;vulnclass:string;name:string;
  severity:string;summary:string;asset_ids:number[]|null;from_status?:string;to_status?:string;
}
const ranks:Record<string,number>={low:1,medium:2,high:3,critical:4};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)?v:0;
const string=(v:unknown)=>typeof v==='string'?v:'';
export function parseFilter(raw:unknown):NotificationFilter {
  const f=object(raw);
  const nums=(v:unknown)=>Array.isArray(v)?v.map(integer):null;
  const strs=(v:unknown)=>Array.isArray(v)?v.map(string):null;
  return {min_severity:string(f.min_severity),task_ids:nums(f.task_ids),asset_ids:nums(f.asset_ids),vulnclass_include:strs(f.vulnclass_include),vulnclass_exclude:strs(f.vulnclass_exclude),on_status_change:typeof f.on_status_change==='boolean'?f.on_status_change:false};
}
export function validateFilter(f:NotificationFilter):void {
  if(f.min_severity&&ranks[f.min_severity]===undefined)throw new Error(`Lowest level ${JSON.stringify(f.min_severity)} Invalid, optional: low / medium / high / critical, or leave blank to indicate no limit`);
}
export function snapshot(raw:unknown):NotificationSnapshot {
  const f=object(raw);
  return {kind:string(f.kind),finding_id:integer(f.finding_id),task_id:integer(f.task_id),vulnclass:string(f.vulnclass),name:string(f.name),severity:string(f.severity),summary:string(f.summary),asset_ids:Array.isArray(f.asset_ids)?f.asset_ids.map(integer):null,...(typeof f.from_status==='string'?{from_status:f.from_status}:{}),...(typeof f.to_status==='string'?{to_status:f.to_status}:{})};
}
export function matches(f:NotificationFilter,s:NotificationSnapshot):boolean {
  if(s.kind==='finding_status_changed'&&!f.on_status_change)return false;
  if(f.min_severity&&(ranks[s.severity]??0)<(ranks[f.min_severity]??0))return false;
  if(f.task_ids?.length&&!f.task_ids.includes(s.task_id))return false;
  if(f.asset_ids?.length&&!s.asset_ids?.some(id=>f.asset_ids!.includes(id)))return false;
  const includes=(list:string[])=>list.some(k=>k.trim()&&s.vulnclass.toLowerCase().includes(k.trim().toLowerCase()));
  if(f.vulnclass_exclude?.length&&includes(f.vulnclass_exclude))return false;
  if(f.vulnclass_include?.length&&!includes(f.vulnclass_include))return false;
  return true;
}
/** Go truncateNotifyError: 500 UTF-8 bytes, never a partial code point. */
export function truncateError(message:string):string {
  const b=Buffer.from(message);if(b.length<=500)return message;let cut=500;while(cut>0&&(b[cut]!&0xc0)===0x80)cut--;return b.subarray(0,cut).toString()+'…';
}
