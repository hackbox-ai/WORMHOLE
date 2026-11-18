import {targetSpawn} from '../network/sandbox.ts';
import {createRequire} from 'node:module';
import {spawn as spawnPty,type IPty} from 'node-pty';
import type {Terminal as TerminalType} from '@xterm/headless';
import {RE2JS} from 're2js';
import type {Pool} from 'pg';
import type {AgentSession,ToolDefinition} from '@earendil-works/pi-coding-agent';
import {goTrim} from '../assets/asset-match.ts';
import {targetEnvironment} from '../traffic/network.ts';
import {goJSON} from './custom-executor.ts';
import {registerTool,type ToolContext,type GateOptions} from './gate.ts';
import {assembleTools} from './assembly.ts';
import seeds from './shell-tool-seeds.json' with {type:'json'};
const {Terminal}=createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');
const RING=256<<10;
const truth=(value:unknown)=>['1','true','yes','on'].includes(goTrim(String(value??'')).toLowerCase());
export const interactiveDisabled=()=>truth(process.env.AGENT_CORE_DISABLE_INTERACTIVE_SHELL);
const milliseconds=(value:unknown,fallback:number)=>Number(value)>0?Number(value):fallback;
const named:Record<string,string>={enter:'\r',return:'\r',tab:'\t',esc:'\x1b',escape:'\x1b',backspace:'\x7f',space:' ',up:'\x1b[A',down:'\x1b[B',right:'\x1b[C',left:'\x1b[D',home:'\x1b[H',end:'\x1b[F',pageup:'\x1b[5~',pagedown:'\x1b[6~',delete:'\x1b[3~',insert:'\x1b[2~'};
export function shellKeyBytes(key:string):Buffer|undefined{key=goTrim(key).toLowerCase();if(named[key]!==undefined)return Buffer.from(named[key]!);if(key.startsWith('ctrl+')&&key.length===6){const ch=key.charCodeAt(5);if(ch>=97&&ch<=122)return Buffer.from([ch&31]);if(ch===91)return Buffer.from([27]);if(ch===92)return Buffer.from([28]);}return undefined;}
export function shellHexBytes(items:string[]):Buffer{return Buffer.from(items.flatMap(raw=>{const text=goTrim(raw).toLowerCase().replace(/^0x/,'');return /^\+?[0-9a-f]+$/.test(text)&&parseInt(text,16)<=255?[parseInt(text,16)]:[]}));}
interface Entry{id:string;command:string;rows:number;cols:number;mode:string;prompt?:RE2JS;pty:IPty;buf:Buffer;total:number;readCursor:number;state:'running'|'exited'|'closed';exitCode:number|null;lastOut:number;exitedAt:number;emu?:TerminalType;screenTail:Promise<void>;listeners:Set<()=>void>;exitPromise:Promise<void>;finishExit():void;watch?:{pattern:string;regex:RE2JS;fired:boolean}[]}
interface Note{session_id:string;kind:'bash'|'monitor';status:'running'|'completed';summary:string}
const short=(value:string)=>{const bytes=Buffer.from(goTrim(value).replaceAll('\n',' '));return bytes.length>60?bytes.subarray(0,57).toString('utf8')+'...':bytes.toString('utf8');};
export class ShellManager{
 private entries=new Map<string,Entry>();private sequence=0;private disposed=false;private root=new AbortController();private agent?:AgentSession;private notes:Note[]=[];private ownerAbort=()=>void this.dispose();
 constructor(private cwd:string,private owner:ToolContext){owner.signal?.addEventListener('abort',this.ownerAbort,{once:true});}
 attach(agent:AgentSession){this.agent=agent;for(const note of this.notes.splice(0))this.publish(note);}
 private publish(note:Note){if(this.disposed)return;if(!this.agent){this.notes.push(note);return;}void this.agent.sendCustomMessage({customType:'shell-notification',display:true,content:'<task-notification>\n  <task-id>'+note.session_id+'</task-id>\n  <task-type>'+note.kind+'</task-type>\n  <status>'+note.status+'</status>\n  <output-file></output-file>\n  <summary>'+note.summary+'</summary>\n</task-notification>',details:note},{triggerTurn:false}).catch(error=>console.warn('[shell] note failed',String(error)));}
 private entry(id:string){const s=this.entries.get(id);if(!s)throw new Error("Session does not exist: "+id);return s;}
 private notify(s:Entry){for(const listener of [...s.listeners])listener();}
 private since(s:Entry,cursor:number,maxLines:number,maxBytes:number,drain:boolean){const start=s.total-s.buf.length;if(cursor>=s.total)return {output:'',cursor:s.total,omitted:false};const from=Math.max(cursor,start),omitted=cursor<start;let bytes=s.buf.subarray(from-start);
  if(!drain){if(maxBytes>0&&bytes.length>maxBytes)bytes=bytes.subarray(0,maxBytes);if(maxLines>0){let count=0;for(let i=0;i<bytes.length;i++)if(bytes[i]===10&&++count===maxLines){bytes=bytes.subarray(0,i+1);break;}}}
  return {output:bytes.toString('utf8'),cursor:from+bytes.length,omitted};
 }
 private tail(s:Entry,bytes:number){return s.buf.subarray(Math.max(0,s.buf.length-bytes)).toString('utf8');}
 private running(s:Entry){return s.state==='running';}
 private async wait(s:Entry,quiet:number,grace:number,timeout:number,prompt?:RE2JS,signal?:AbortSignal):Promise<'exited'|'timeout'|'prompt'|'quiet'>{
  if(!this.running(s))return 'exited';if(this.root.signal.aborted||signal?.aborted)return 'timeout';
  return new Promise(resolve=>{let done=false;const combined=signal?AbortSignal.any([this.root.signal,signal]):this.root.signal;
   const finish=(reason:'exited'|'timeout'|'prompt'|'quiet')=>{if(done)return;done=true;clearTimeout(hard);clearTimeout(silent);s.listeners.delete(onData);combined.removeEventListener('abort',abort);resolve(reason);};
   let silent=setTimeout(()=>finish('quiet'),Math.max(grace,quiet));const hard=setTimeout(()=>finish('timeout'),timeout),abort=()=>finish('timeout');
   const onData=()=>{if(!this.running(s)){finish('exited');return;}if(prompt?.matcher(this.tail(s,4096)).find()){finish('prompt');return;}clearTimeout(silent);silent=setTimeout(()=>finish('quiet'),quiet);};
   s.listeners.add(onData);combined.addEventListener('abort',abort,{once:true});
  });
 }
 private kill(s:Entry){if(s.state==='closed')return;s.state='closed';this.notify(s);try{if(process.platform!=='win32')process.kill(-s.pty.pid,'SIGKILL');else s.pty.kill();}catch{try{s.pty.kill();}catch{}}s.emu?.dispose();}
 private reap(){const now=Date.now();for(const [id,s]of this.entries){if(s.state==='exited'?now-s.exitedAt>300000:now-s.lastOut>1800000){this.kill(s);this.entries.delete(id);}}}
 private open(command:string,rows:number,cols:number,mode:string,prompt?:RE2JS){
  if(process.platform==='win32')throw new Error("Failed to open session: interactive shell (PTY) is not supported on the current platform");
  this.reap();rows=rows>0?rows:24;cols=cols>0?cols:80;let pty:IPty;
  try{const launch=targetSpawn({command,cwd:this.cwd,env:{...process.env}});pty=spawnPty('bash',['-c',launch.command],{cwd:this.cwd,rows,cols,name:process.env.TERM||'xterm-256color',env:launch.env,encoding:null});}catch(error){throw new Error("Failed to open session: "+(error instanceof Error?error.message:String(error)));}
  let finishExit!:()=>void;const exitPromise=new Promise<void>(r=>finishExit=r),s:Entry={id:'sh_'+(++this.sequence),command,rows,cols,mode,prompt,pty,buf:Buffer.alloc(0),total:0,readCursor:0,state:'running',exitCode:null,lastOut:Date.now(),exitedAt:0,screenTail:Promise.resolve(),listeners:new Set(),exitPromise,finishExit};
  this.entries.set(s.id,s);
  pty.onData(raw=>{if(s.state==='closed')return;const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw);s.buf=Buffer.concat([s.buf,bytes]);s.total+=bytes.length;if(s.buf.length>RING)s.buf=s.buf.subarray(s.buf.length-RING);s.lastOut=Date.now();
   if(s.emu)s.screenTail=new Promise<void>(r=>s.emu!.write(bytes,r));this.notify(s);
   for(const watch of s.watch??[])if(!watch.fired&&watch.regex.matcher(this.tail(s,8192)).find()){watch.fired=true;this.publish({session_id:s.id,kind:'monitor',status:'running',summary:"Listening session "+s.id+" hit /"+watch.pattern+'/：\n'+this.tail(s,8192)});}
  });
  pty.onExit(({exitCode,signal})=>{if(s.state!=='closed')s.state='exited';s.exitCode=signal?-1:exitCode;s.exitedAt=Date.now();this.notify(s);s.finishExit();
   if(s.mode==='monitor')this.publish({session_id:s.id,kind:'monitor',status:'completed',summary:"Listening session "+s.id+'（'+short(s.command)+") has ended (exit "+s.exitCode+')。\n'+this.tail(s,4096)});
  });return s;
 }
 async execute(name:string,p:Record<string,any>,signal?:AbortSignal):Promise<unknown>{
  if(interactiveDisabled())throw new Error("The interactive shell has been globally disabled (AGENT_CORE_DISABLE_INTERACTIVE_SHELL)");
  if(truth(process.env.AGENT_CORE_DISABLE_BACKGROUND_TASKS))throw new Error("Interactive shell requires background task manager (not enabled)");
  if(this.disposed||this.root.signal.aborted)throw new Error("Interactive shell session closed");
  if(name==='shell_open'){
   const command=String(p.command??'');if(!command)throw new Error("command required");const mode=String(p.mode??'')||'hands-free';
   if(!['hands-free','interactive','dispatch','monitor'].includes(mode))throw new Error("mode needs to be interactive | hands-free | dispatch | monitor");
   const watches:{pattern:string;regex:RE2JS;fired:boolean}[]=[];
   if(mode==='monitor'){if(!p.watch?.length)throw new Error("The monitor mode must be given to watch (keywords/regulars to be watched)");for(const pattern of p.watch){try{watches.push({pattern,regex:RE2JS.compile(pattern),fired:false});}catch(error){throw new Error("watch regex is invalid "+pattern+': '+(error as Error).message);}}}
   let prompt:RE2JS|undefined;if(p.prompt_regex)try{prompt=RE2JS.compile(p.prompt_regex);}catch(error){throw new Error("prompt_regex is invalid: "+(error as Error).message);}
   const s=this.open(command,Number(p.rows)||0,Number(p.cols)||0,mode,prompt);s.watch=watches.length?watches:undefined;
   const quiet=milliseconds(p.quiet_ms,8000),grace=milliseconds(p.startup_grace_ms,15000);
   if(mode==='interactive'){const by=await this.wait(s,quiet,grace,120000,prompt,signal),out=this.since(s,0,0,32768,false);return {session_id:s.id,state:'running',done_by:by,output:out.output,cursor:out.cursor,running:this.running(s)};}
   if(mode==='dispatch')void this.wait(s,quiet,grace,120000,prompt).then(by=>this.publish({session_id:s.id,kind:'bash',status:'completed',summary:"Interactive session "+s.id+'（'+short(s.command)+'）'+by+". Use shell_read(session_id=\""+s.id+"\") continue, or shell_close ends.\n"+this.tail(s,4096)}));
   return {session_id:s.id,state:'running',...(mode==='dispatch'?{dispatched:true}:mode==='monitor'?{monitoring:watches.length}:{})};
  }
  if(name==='shell_list'){this.reap();return {sessions:[...this.entries.values()].map(s=>({session_id:s.id,command:s.command,state:s.state,mode:s.mode,idle_ms:Date.now()-s.lastOut}))};}
  const s=this.entry(String(p.session_id??''));
  if(name==='shell_close'){const exit=s.exitCode;this.kill(s);this.entries.delete(s.id);return {closed:s.id,exit_code:exit};}
  if(name==='shell_read'){
   if(p.view==='screen'){
    if(!s.emu){s.emu=new Terminal({cols:s.cols,rows:s.rows,scrollback:0,allowProposedApi:true});s.screenTail=new Promise<void>(r=>s.emu!.write(s.buf,r));}await new Promise<void>((resolve,reject)=>{const combined=signal?AbortSignal.any([this.root.signal,signal]):this.root.signal;const cancel=()=>reject(new Error("Interactive shell session closed"));if(combined.aborted){cancel();return;}combined.addEventListener('abort',cancel,{once:true});s.screenTail.then(()=>{combined.removeEventListener('abort',cancel);resolve();},reject);});
    const buffer=s.emu.buffer.active;let screen='';for(let y=0;y<s.rows;y++)screen+=(buffer.getLine(buffer.baseY+y)?.translateToString(true)??'').replace(/ +$/,'')+'\n';
    return {view:'screen',screen,rows:s.rows,cols:s.cols,cursor:{row:buffer.cursorY,col:buffer.cursorX},running:this.running(s)};
   }
   const from=p.since_cursor==null?s.readCursor:Number(p.since_cursor),out=this.since(s,from,p.max_lines===undefined||p.max_lines===0?200:Number(p.max_lines),p.max_bytes===undefined||p.max_bytes===0?8192:Number(p.max_bytes),!!p.drain);s.readCursor=out.cursor;
   return {view:'stream',...out,running:this.running(s),...(s.exitCode===null?{}:{exit_code:s.exitCode})};
  }
  if(name==='shell_send'){
   if(!this.running(s))throw new Error("Session ended (exit "+(s.exitCode??'?')+"), read the tail output with shell_read or shell_close");
   const before=s.total,parts:Buffer[]=[];if(p.text)parts.push(Buffer.from(p.text));if(p.submit)parts.push(Buffer.from('\r'));for(const key of p.keys??[]){const bytes=shellKeyBytes(key);if(!bytes)throw new Error("Unknown key: "+key);parts.push(bytes);}if(p.hex?.length)parts.push(shellHexBytes(p.hex));if(p.paste)parts.push(Buffer.from('\x1b[200~'+p.paste+'\x1b[201~'));
   const input=Buffer.concat(parts);if(!input.length)throw new Error("No input to send (text/submit/keys/hex/paste give at least one)");
   try{s.pty.write(input);}catch(error){throw new Error("Write failed: "+(error as Error).message);}if(p.wait===false)return {session_id:s.id,sent:input.length,running:this.running(s)};
   let prompt=s.prompt;if(p.prompt_regex)try{prompt=RE2JS.compile(p.prompt_regex);}catch{}
   const by=await this.wait(s,milliseconds(p.quiet_ms,8000),0,milliseconds(p.timeout_ms,120000),prompt,signal),out=this.since(s,before,0,8192,false);
   return {session_id:s.id,...out,done_by:by,running:this.running(s)};
  }
  throw new Error("Unknown interactive tool: "+name);
 }
 async dispose(){if(this.disposed)return;this.disposed=true;this.owner.signal?.removeEventListener('abort',this.ownerAbort);this.root.abort();const entries=[...this.entries.values()];for(const s of entries)this.kill(s);this.entries.clear();
  let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([Promise.all(entries.map(s=>s.exitPromise)),new Promise(r=>timer=setTimeout(r,3000))]);}finally{if(timer)clearTimeout(timer);}
 }
}
for(const seed of seeds)registerTool({key:seed.name,description:seed.description,params:{},required:[],schema:seed.schema,execute:(params,ctx)=>{if(!ctx.interactiveShellSession)throw new Error("Interactive shell requires background task manager (not enabled)");return ctx.interactiveShellSession.execute(seed.name,params,ctx.signal);}});
export async function interactiveShellTools(pool:Pool,cwd:string,ctx:ToolContext,gate:GateOptions){
 const enabled=(await pool.query('SELECT interactive_shell FROM agents WHERE key=$1',[ctx.agentKey])).rows[0]?.interactive_shell;
 if(!enabled||interactiveDisabled())return undefined;const manager=new ShellManager(cwd,ctx);ctx.interactiveShellSession={execute:async(name,p,signal)=>({content:[{type:'text',text:goJSON(await manager.execute(name,p,signal))}]})};
 const tools=await assembleTools(pool,seeds.map(seed=>seed.name),ctx,gate);for(const tool of tools)tool.executionMode='sequential';
 return {tools,attach:(session:AgentSession)=>manager.attach(session),dispose:()=>manager.dispose()};
}
