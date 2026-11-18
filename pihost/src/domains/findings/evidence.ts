/** Immutable evidence store. The advisory lock spans
 * filesystem installation and SQL references, including readers and GC. */
import type {Pool,PoolClient} from 'pg';
import {saveTaskReport} from '../tasks/report.ts';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,openSync,writeSync,fsyncSync,closeSync,existsSync,readFileSync,renameSync,unlinkSync,utimesSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {isUtf8} from 'node:buffer';
import type {TrafficStore} from '../traffic/store.ts';
import {directExplorationScope} from '../exploration/scope.ts';
import {goUTF8} from './utf8.ts';
export const EVIDENCE_LOCK=7337741004;
export const conflict="The traffic evidence has changed, please refresh and try again",archiveConflict='task archive state does not allow this operation';
export interface TrafficRef {traffic_id:string;role:string;note:string}
export interface Snapshot {id:string;source_traffic_id:string;captured_at:number;url:string;method:string;status:number;content_type:string;req_head?:string;resp_head?:string;req_hash:string;resp_hash:string;req_len:number;resp_len:number;created_at:string}
export interface Binding {id:string;finding_id:string;snapshot_id:string;role:string;note:string;position:number;created_at:string;snapshot:Snapshot}
export interface FindingTraffic {finding_id:string;version:number;report_version:number;bindings:Binding[]}
const roles=['baseline','proof','verification','supporting'];
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const clean=(s:string)=>Buffer.from(s.replaceAll('\0','')).toString('utf8');
export function normalizeRefs(raw:unknown):TrafficRef[]{
  if(raw==null)return [];if(!Array.isArray(raw))throw new Error("traffic_refs must be an array");
  const seen=new Set<string>(),out:TrafficRef[]=[];
  for(const item of raw){const r=item??{};if(typeof r!=='object'||Array.isArray(r)||r.traffic_id!=null&&typeof r.traffic_id!=='string'||r.role!=null&&typeof r.role!=='string'||r.note!=null&&typeof r.note!=='string')throw new Error('invalid traffic ref');
    const id=(r.traffic_id??'').trim(),role=r.role||'supporting';if(!id)throw new Error("traffic_id cannot be empty");if(!roles.includes(role))throw new Error(`Invalid traffic usage ${JSON.stringify(role)}`);
    if(!seen.has(id)){seen.add(id);out.push({traffic_id:id,role,note:r.note??''});}
  }return out;
}
/** Go encoding/json struct order/omitempty/HTML escaping are part of this ID. */
export function snapshotID(s:Snapshot):string{
 const reqHead=clean(s.req_head??''),respHead=clean(s.resp_head??'');
 const value={id:'',source_traffic_id:clean(s.source_traffic_id),captured_at:s.captured_at,url:clean(s.url),method:clean(s.method),status:s.status,content_type:clean(s.content_type),
  ...(reqHead?{req_head:reqHead}:{}),...(respHead?{resp_head:respHead}:{}),req_hash:s.req_hash,resp_hash:s.resp_hash,req_len:s.req_len,resp_len:s.resp_len,created_at:'0001-01-01T00:00:00Z'};
 return hash(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
}
export function trafficSummary(v:FindingTraffic):FindingTraffic{return {...v,bindings:v.bindings.map(b=>{const {req_head:_r,resp_head:_p,...snapshot}=b.snapshot;return {...b,snapshot};})};}
export class EvidenceStore {
 constructor(readonly pool:Pool,readonly traffic:TrafficStore,readonly dir:string){}
 async transaction<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock($1)',[EVIDENCE_LOCK]);const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 bodyPath(h:string){if(!/^[0-9a-f]{64}$/.test(h))throw new Error('invalid evidence hash');return path.join(this.dir,'blobs',h.slice(0,2),h+'.bin');}
 private verify(file:string,h:string,n:number){const b=readFileSync(file);if(b.length!==n||hash(b)!==h)throw new Error("Evidence text verification failed: "+h);return b;}
 private writeBody(b:Buffer,n:number,expected:string){if(b.length!==n)throw new Error(`Incomplete text: expected ${n} Byte, read ${b.length} Bytes`);const h=hash(b);if(expected&&h!==expected)throw new Error("Raw traffic body hash mismatch");
  const staging=path.join(this.dir,'.staging');mkdirSync(staging,{recursive:true,mode:0o700});const temp=path.join(staging,'body-'+randomUUID());let fd:number|undefined;
  try{fd=openSync(temp,'wx',0o600);let pos=0;while(pos<b.length)pos+=writeSync(fd,b,pos,b.length-pos);fsyncSync(fd);closeSync(fd);fd=undefined;
   const target=this.bodyPath(h);if(existsSync(target)){this.verify(target,h,n);const now=new Date();utimesSync(target,now,now);}else{mkdirSync(path.dirname(target),{recursive:true,mode:0o700});renameSync(temp,target);const d=openSync(path.dirname(target),'r');try{fsyncSync(d);}finally{closeSync(d);}}return h;
  }finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))unlinkSync(temp);}
 }
 prepare(refs:unknown):{ref:TrafficRef;snapshot:Snapshot}[]{
  // Complete body lookup+durable copy is synchronous: no in-process capture
  // deletion can interleave between SQLite lookup and the filesystem copy.
  return normalizeRefs(refs).map(ref=>{const e=this.traffic.readEvidence(ref.traffic_id),req=this.writeBody(e.reqBody,e.req_len,e.req_hash),resp=this.writeBody(e.respBody,e.resp_len,e.resp_hash);
   const snapshot:Snapshot={id:'',source_traffic_id:clean(e.id),captured_at:e.ts,url:clean(e.url),method:clean(e.method),status:e.status,content_type:clean(e.content_type),req_head:clean(e.reqHead),resp_head:clean(e.respHead),req_hash:req,resp_hash:resp,req_len:e.req_len,resp_len:e.resp_len,created_at:''};snapshot.id=snapshotID(snapshot);return{ref,snapshot};});
 }
 async lockTask(c:PoolClient,id:number){if(!id)return;const t=(await c.query('SELECT deleted_at FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!t)throw new Error('task not found');if(t.deleted_at)throw new Error(archiveConflict);
  // Original archive subsystem is optional until its migration is installed.
  const table=(await c.query("SELECT to_regclass('task_archives') AS name")).rows[0]?.name;if(table){const a=(await c.query('SELECT state FROM task_archives WHERE task_id=$1',[id])).rows[0];if(a&&a.state!=='failed')throw new Error(archiveConflict);}
 }
 async lockFinding(c:PoolClient,id:number,version?:number){const f=(await c.query('SELECT task_id FROM findings WHERE id=$1',[id])).rows[0];if(!f)throw new Error("The vulnerability does not exist");await this.lockTask(c,Number(f.task_id)||0);const r=(await c.query('SELECT evidence_version FROM findings WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!r)throw new Error("The vulnerability does not exist");if(version!==undefined&&Number(r.evidence_version)!==version)throw new Error(conflict);}
 async add(c:PoolClient,id:number,prepared:ReturnType<EvidenceStore['prepare']>){let position=Number((await c.query('SELECT COALESCE(MAX(position)+1,0) AS n FROM finding_traffic_bindings WHERE finding_id=$1',[id])).rows[0].n),changed=false;
  for(const {ref,snapshot:s} of prepared){if(s.id!==snapshotID(s))throw new Error("Evidence snapshot metadata hash mismatch");await c.query(`INSERT INTO traffic_evidence_snapshots(id,source_traffic_id,captured_at,url,method,status,content_type,req_head,resp_head,req_hash,resp_hash,req_len,resp_len) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,[s.id,s.source_traffic_id,s.captured_at,s.url,s.method,s.status,s.content_type,s.req_head??'',s.resp_head??'',s.req_hash,s.resp_hash,s.req_len,s.resp_len]);
   await c.query('UPDATE traffic_evidence_snapshots SET unreferenced_at=NULL WHERE id=$1',[s.id]);const r=await c.query('INSERT INTO finding_traffic_bindings(finding_id,snapshot_id,role,note,position) VALUES($1,$2,$3,$4,$5) ON CONFLICT(finding_id,snapshot_id) DO NOTHING',[id,s.id,ref.role,ref.note,position]);if(r.rowCount){changed=true;position++;}}
  if(changed)await c.query('UPDATE findings SET evidence_version=evidence_version+1 WHERE id=$1',[id]);
 }
 async listTx(c:PoolClient,id:number):Promise<FindingTraffic>{const f=(await c.query('SELECT evidence_version,report_evidence_version FROM findings WHERE id=$1',[id])).rows[0];if(!f)throw new Error("The vulnerability does not exist");
  const rows=(await c.query(`SELECT b.*,b.created_at::text AS binding_time,s.*,s.created_at::text AS snapshot_time,b.id AS binding_id FROM finding_traffic_bindings b JOIN traffic_evidence_snapshots s ON s.id=b.snapshot_id WHERE b.finding_id=$1 ORDER BY b.position,b.id`,[id])).rows;
  const ts=(v:string)=>v.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00').replace(/\+00:00$/,'Z').replace(/(\.\d*?[1-9])0+(?=Z|[+-])/,'$1').replace(/\.0+(?=Z|[+-])/,'');return{finding_id:String(id),version:Number(f.evidence_version),report_version:Number(f.report_evidence_version),bindings:rows.map(r=>({id:String(r.binding_id),finding_id:String(id),snapshot_id:r.snapshot_id,role:r.role,note:r.note,position:r.position,created_at:ts(r.binding_time),snapshot:{id:r.snapshot_id,source_traffic_id:r.source_traffic_id,captured_at:Number(r.captured_at),url:r.url,method:r.method,status:r.status,content_type:r.content_type,...(r.req_head?{req_head:r.req_head}:{}),...(r.resp_head?{resp_head:r.resp_head}:{}),req_hash:r.req_hash,resp_hash:r.resp_hash,req_len:Number(r.req_len),resp_len:Number(r.resp_len),created_at:ts(r.snapshot_time)}}))};
 }
 list(id:number){return this.transaction(c=>this.listTx(c,id));}
 bind(id:number,refs:unknown){return this.transaction(async c=>{await this.lockFinding(c,id);await this.add(c,id,this.prepare(refs));return this.listTx(c,id);});}
 edit(id:number,bid:number,version:number,opts:{role?:string;note?:string;remove?:boolean;order?:string[]}){if(opts.role!==undefined&&!roles.includes(opts.role))throw new Error("Invalid traffic usage");return this.transaction(async c=>{await this.lockFinding(c,id,version);
  if(opts.order!==undefined){const current=await this.listTx(c,id);const ids=new Set(current.bindings.map(b=>b.id));if(opts.order.length!==ids.size)throw new Error(conflict);for(const [position,b] of opts.order.entries()){if(!ids.delete(b))throw new Error(conflict);await c.query('UPDATE finding_traffic_bindings SET position=$1 WHERE finding_id=$2 AND id=$3',[position,id,b]);}}
  else{const r=opts.remove?await c.query('DELETE FROM finding_traffic_bindings WHERE finding_id=$1 AND id=$2',[id,bid]):await c.query('UPDATE finding_traffic_bindings SET role=COALESCE($3,role),note=COALESCE($4,note) WHERE finding_id=$1 AND id=$2',[id,bid,opts.role??null,opts.note??null]);if(!r.rowCount)throw new Error("Traffic evidence does not exist");}
  await c.query('UPDATE findings SET evidence_version=evidence_version+1 WHERE id=$1',[id]);return this.listTx(c,id);
 });}
 binding(id:number,bid:number){return this.transaction(async c=>{const b=(await this.listTx(c,id)).bindings.find(b=>b.id===String(bid));if(!b)throw new Error("Traffic evidence does not exist");return b;});}
 body(s:Snapshot,side:string){if(side!=='request'&&side!=='response')throw new Error("side must be request or response");const h=side==='request'?s.req_hash:s.resp_hash,n=side==='request'?s.req_len:s.resp_len;return this.verify(this.bodyPath(h),h,n);}
 preview(s:Snapshot,side:string,offset=0,length=8192){if(offset<0||length<0)throw new Error("offset / length cannot be negative");if(!length||length>8192)length=8192;const bytes=this.body(s,side),total=bytes.length;if(offset>total)throw new Error("offset exceeds text length");let raw=bytes.subarray(offset,offset+length);
  if(offset+raw.length<total&&raw.length>=4){let start=raw.length-1;while(start>0&&(raw[start]!&0xc0)===0x80)start--;const lead=raw[start]!,need=lead>=0xf0&&lead<=0xf4?4:lead>=0xe0&&lead<=0xef?3:lead>=0xc2&&lead<=0xdf?2:1;if(need>raw.length-start)raw=raw.subarray(0,start);}
  const binary=raw.includes(0)||offset===0&&!isUtf8(raw);return{content:binary?`[binary text,${total} Bytes; please download and view]`:goUTF8(raw),offset,total,next_offset:offset+raw.length,truncated:offset+raw.length<total,binary};
 }
 async updateReport(node:number,report:string,version?:number){if(!report.trim())throw new Error("Report content cannot be empty");return this.transaction(async c=>{const f=(await c.query('SELECT id,task_id FROM findings WHERE node_id=$1',[node])).rows[0];if(!f)return 0;await this.lockFinding(c,Number(f.id),version);await c.query('UPDATE findings SET report=$2,report_status=\'completed\',report_updated_at=now(),report_evidence_version=COALESCE($3::bigint,CASE WHEN evidence_version=0 THEN 0 ELSE -1 END) WHERE id=$1',[f.id,report,version??null]);const saved=(await c.query('SELECT phase,reason FROM task_reports WHERE task_id=$1',[f.task_id])).rows[0];if(saved)await saveTaskReport(c,Number(f.task_id),saved.phase,saved.reason);return 1;});}
 async access(id:number,task:number|undefined,write:boolean):Promise<string|null>{const f=(await this.pool.query('SELECT task_id FROM findings WHERE id=$1',[id])).rows[0];if(!f)return 'finding not found';if(task!==undefined){if(!(await this.pool.query('SELECT 1 FROM tasks WHERE id=$1 AND deleted_at IS NULL',[task])).rowCount)return 'context task not found';const s=(await this.pool.query(`WITH ${directExplorationScope} SELECT inherited FROM scopes WHERE task_id=$2 ORDER BY inherited LIMIT 1`,[task,f.task_id])).rows[0];if(!s)return 'finding not available in task context';if(write&&s.inherited)return "The inheritance vulnerability is read-only, please modify it in the source task";}return null;}
 async collect(now=new Date()){return this.transaction(async c=>{await c.query('UPDATE traffic_evidence_snapshots s SET unreferenced_at=$1 WHERE unreferenced_at IS NULL AND NOT EXISTS(SELECT 1 FROM finding_traffic_bindings b WHERE b.snapshot_id=s.id)',[now]);await c.query('DELETE FROM traffic_evidence_snapshots s WHERE unreferenced_at<$1 AND NOT EXISTS(SELECT 1 FROM finding_traffic_bindings b WHERE b.snapshot_id=s.id)',[new Date(now.getTime()-86400000)]);
  const refs=new Set((await c.query('SELECT req_hash AS hash FROM traffic_evidence_snapshots UNION SELECT resp_hash AS hash FROM traffic_evidence_snapshots')).rows.map(r=>r.hash));let deleted=0;
  const walk=(root:string)=>{if(!existsSync(root))return;for(const e of readdirSync(root,{withFileTypes:true})){const file=path.join(root,e.name);if(e.isDirectory())walk(file);else if(e.isFile()&&!refs.has(e.name.replace(/\.bin$/,''))&&now.getTime()-statSync(file).mtimeMs>=86400000){unlinkSync(file);deleted++;}}};walk(path.join(this.dir,'blobs'));walk(path.join(this.dir,'.staging'));return deleted;
 });}
}
