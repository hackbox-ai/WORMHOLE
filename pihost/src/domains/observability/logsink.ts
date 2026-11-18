/** bounded ring, subscribers and DB queue. */
import {format} from 'node:util';
import type {Pool} from 'pg';
import type {IncomingMessage,ServerResponse} from 'node:http';

export interface LogLine {seq:number;db_id?:number;ts:string;level:'info'|'warn'|'error';tag:string;text:string}
const timestamp=(value:Date|string|number)=>new Date(value).toISOString().replace(/\.\d{3}Z$/,'Z');
export function parseLog(line:string):LogLine {
 let text=line.replace(/\n+$/,'');
 if(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/.test(text))text=text.slice(19).trim();
 const low=text.toLowerCase(),error=['fatal','panic','error','err:',"Failure","Discard","Reject",'✕',"Unreachable"].some(k=>low.includes(k)),warn=['warn','disabled',"Disabled",'skip','stopped','⚠',"Try again"].some(k=>low.includes(k));
 const end=text.indexOf(']'),tag=text.startsWith('[')&&end>1?text.slice(1,end):'';
 return {seq:0,ts:timestamp(Date.now()),level:error?'error':warn?'warn':'info',tag,text};
}
type Subscriber={callback:(line:LogLine)=>void|Promise<void>;queue:LogLine[];active:boolean;draining:boolean};
export class LogSink {
 private ring:LogLine[]=[];private seq=0;private subs=new Set<Subscriber>();
 private queue:LogLine[]=[];private pool:Pool|null=null;private drainPromise:Promise<void>|null=null;
 private restoreConsole:(()=>void)|null=null;
 constructor(private readonly report:(message:string)=>void=message=>{process.stderr.write(message+'\n');}){}
 install(){
  if(this.restoreConsole)return;
  const originals={log:console.log,warn:console.warn,error:console.error},wrappers={} as typeof originals;
  for(const key of ['log','warn','error'] as const){wrappers[key]=(...args:unknown[])=>{
   originals[key](...args);const line=format(...args);if(line.trim())this.add(parseLog(line));
  };console[key]=wrappers[key];}
  this.restoreConsole=()=>{for(const key of ['log','warn','error'] as const)if(console[key]===wrappers[key])console[key]=originals[key];};
 }
 async attach(pool:Pool){
  if(this.pool)return;this.pool=pool;
  try{const rows=(await pool.query('SELECT seq AS db_id,ts,level,tag,text FROM server_logs ORDER BY seq DESC LIMIT 100')).rows;
   const restored=rows.reverse().map(r=>({seq:++this.seq,db_id:Number(r.db_id),ts:timestamp(r.ts),level:r.level,tag:r.tag??'',text:r.text??''} as LogLine));
   // Preserve the original startup-history prepend behavior (including its seq ordering).
   this.ring=[...restored,...this.ring].slice(-3000);
  }catch(error){this.report('[logsink] restore: '+String(error));}
  this.drain();
 }
 private drain(){
  if(this.drainPromise||!this.pool||!this.queue.length)return;
  this.drainPromise=(async()=>{while(this.queue.length&&this.pool){const line=this.queue.shift()!;
   try{const row=(await this.pool.query('INSERT INTO server_logs(level,tag,text) VALUES($1,$2,$3) RETURNING seq AS id',[line.level,line.tag,line.text])).rows[0];
    const hit=this.ring.find(r=>r.seq===line.seq);if(hit&&row)hit.db_id=Number(row.id);
   }catch(error){this.report('[logsink] db write: '+String(error));}
  }})().finally(()=>{this.drainPromise=null;this.drain();});
 }
 async flush(){while(this.drainPromise||this.queue.length){this.drain();if(!this.drainPromise)break;await this.drainPromise;}}
 async stop(){this.restoreConsole?.();this.restoreConsole=null;await this.flush();this.pool=null;for(const sub of this.subs){sub.active=false;sub.queue=[];}this.subs.clear();}
 add(input:LogLine){
  const line={...input,seq:++this.seq};this.ring.push(line);if(this.ring.length>3000)this.ring.shift();
  // Go's full channel drops the incoming line, not the oldest pending write.
  if(this.pool&&this.queue.length<2000){this.queue.push(line);this.drain();}
  for(const sub of this.subs){if(sub.queue.length<256){sub.queue.push({...line});this.drainSubscriber(sub);}}
 }
 private drainSubscriber(sub:Subscriber){
  if(sub.draining||!sub.active)return;sub.draining=true;
  queueMicrotask(()=>{void(async()=>{try{while(sub.active&&sub.queue.length){try{await sub.callback(sub.queue.shift()!);}catch{ /* isolated subscriber */ }}}finally{sub.draining=false;}})();});
 }
 recent(since:number,limit:number):{lines:LogLine[]|null;cursor:number}{
  if(limit<=0||limit>3000)limit=3000;const lines=this.ring.filter(l=>l.seq>since).slice(-limit);
  return {lines:lines.length?lines:null,cursor:this.seq};
 }
 subscribe(callback:Subscriber['callback']){
  const sub:Subscriber={callback,queue:[],active:true,draining:false};this.subs.add(sub);
  return ()=>{sub.active=false;sub.queue=[];this.subs.delete(sub);};
 }
}
export const logSink=new LogSink();
/** strconv.Atoi-compatible defaults: explicit zero is not a missing value. */
export function logInteger(value:string|null,fallback:number){if(value===null||!/^[-+]?\d+$/.test(value))return fallback;const n=Number(value);return Number.isSafeInteger(n)?n:fallback;}
export async function recentDbLogs(pool:Pool,before:number,limit:number):Promise<{items:LogLine[];has_more:boolean}>{
 if(limit>500)limit=500;
 const rows=(before>0?await pool.query('SELECT seq AS db_id,ts,level,tag,text FROM server_logs WHERE seq<$1 ORDER BY seq DESC LIMIT $2',[before,limit]):await pool.query('SELECT seq AS db_id,ts,level,tag,text FROM server_logs ORDER BY seq DESC LIMIT $1',[limit])).rows;
 return {items:rows.reverse().map(r=>({seq:0,db_id:Number(r.db_id),ts:timestamp(r.ts),level:r.level,tag:r.tag??'',text:r.text??''})),has_more:rows.length===limit};
}
/** Subscribe before replay; socket backpressure is bounded by the 256-line subscriber queue. */
export function streamLogs(req:IncomingMessage,res:ServerResponse,sink:LogSink=logSink,pingMs=20000){
 let since=logInteger(new URL(req.url??'/', 'http://localhost').searchParams.get('since'),0),closed=false;
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
 const frame=async(text:string)=>{if(closed)return;if(res.write(text))return;await new Promise<void>(resolve=>{
  const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);
 });};
 let replayDone!:()=>void;const replay=new Promise<void>(resolve=>{replayDone=resolve;});
 const unsubscribe=sink.subscribe(async(line)=>{await replay;if(closed||line.seq<=since)return;since=line.seq;await frame(`data: ${JSON.stringify(line)}\n\n`);});
 const ping=setInterval(()=>{if(!closed&&!res.writableNeedDrain)res.write(': ping\n\n');},pingMs);ping.unref();
 const close=()=>{closed=true;clearInterval(ping);unsubscribe();replayDone();};res.once('close',close);
 void(async()=>{try{const initial=sink.recent(since,1000);for(const line of initial.lines??[])await frame(`data: ${JSON.stringify(line)}\n\n`);since=Math.max(since,initial.cursor);}catch(error){res.destroy(error as Error);}finally{replayDone();}})();
}
