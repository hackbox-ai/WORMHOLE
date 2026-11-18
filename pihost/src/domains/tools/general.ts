import {taskToolEnvironment} from '../workspace/resource-paths.ts';
import {targetSpawn,checkTaskFile} from '../network/sandbox.ts';
/** Builtin tool schemas, hosted by Pi with one final execution gate.
 * Handler registry never closes over cwd, task id or a session's background jobs. */
import {readFile,readdir,stat,rename,writeFile,glob,mkdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {createReadToolDefinition,createWriteToolDefinition,createEditToolDefinition,createBashToolDefinition,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import seeds from './general-tool-seeds.json' with {type:'json'};
import {registerTool,type ToolContext,type GateOptions} from './gate.ts';
import {assembleTools} from './assembly.ts';
import {targetEnvironment} from '../traffic/network.ts';

for(const seed of seeds)registerTool({key:seed.name,description:seed.description,params:{},required:[],schema:seed.schema,execute:(p,ctx)=>{
  for(const key of ['path','file_path'])if(p[key]!==undefined)checkTaskFile(ctx.cwd??process.cwd(),p[key]);
  if(!ctx.generalSession)throw new Error("Base tool session not assembled");return ctx.generalSession.execute(seed.name,p,ctx.nativeToolCallId,ctx.signal);
}});
const text=(value:string)=>({content:[{type:'text',text:value}]});
const locks=new Map<string,Promise<unknown>>();
async function serialized<T>(file:string,fn:()=>Promise<T>):Promise<T>{const prior=locks.get(file)??Promise.resolve();const next=prior.catch(()=>{}).then(fn);locks.set(file,next);try{return await next;}finally{if(locks.get(file)===next)locks.delete(file);}}
interface Job {id:string;command:string;status:'running'|'completed'|'failed'|'stopped';output:string;file:string;abort:AbortController;promise:Promise<unknown>;error?:string}
export async function generalTools(pool:Pool,cwd:string,ctx:ToolContext,gate:GateOptions):Promise<{tools:ToolDefinition[];dispose():Promise<void>}>{
  await mkdir(cwd,{recursive:true});
  const taskEnv=ctx.taskId?await taskToolEnvironment(cwd):{};
  const jobs=new Map<string,Job>(),controllers=new Set<AbortController>(),operations=new Set<Promise<unknown>>();let disposed=false;
  const excluded=ctx.agentKey==='worker'?new Set(['MultiEdit','Glob','Grep']):new Set<string>();
  const allowed=new Set(seeds.map(t=>t.name).filter(name=>!excluded.has(name)));
  const resolve=(file:unknown)=>path.resolve(cwd,String(file??'.'));
  const runPi=async(tool:Pick<ToolDefinition<any,any,any>,'execute'>,params:Record<string,unknown>,nativeId?:string,signal?:AbortSignal,onUpdate?:any)=>(tool.execute as any)(nativeId??randomUUID(),params,signal,onUpdate);
  const multiEdit=async(p:Record<string,unknown>,signal?:AbortSignal)=>serialized(resolve(p.file_path),async()=>{
    const file=resolve(p.file_path),original=await readFile(file,'utf8');let content=original;
    const edits=(p.edits??[{old_string:p.old_string,new_string:p.new_string,replace_all:p.replace_all}]) as {old_string:string;new_string:string;replace_all?:boolean}[];
    if(!edits.length)throw new Error('Error: no edits provided');
    for(const edit of edits){signal?.throwIfAborted();if(!edit.old_string)throw new Error('old_string must not be empty');if(edit.old_string===edit.new_string)throw new Error('new_string must differ from old_string');const count=content.split(edit.old_string).length-1;if(!count||(!edit.replace_all&&count!==1))throw new Error(`old_string must match ${edit.replace_all?'at least':'exactly'} once (found ${count})`);content=edit.replace_all?content.replaceAll(edit.old_string,edit.new_string):content.replace(edit.old_string,edit.new_string);}
    signal?.throwIfAborted();
    // SDK Write owns creation and I/O; one commit follows all in-memory matches.
    await runPi(createWriteToolDefinition(cwd),{path:file,content},undefined,signal);return text(`Edited ${String(p.file_path)}.`);
  });
  const shell=async(p:Record<string,unknown>,nativeId?:string,signal?:AbortSignal)=>{
    const command=String(p.command),abort=new AbortController(),combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    const file=path.join(cwd,`.shell-${randomUUID()}.log`);
    const job:Job={id:'',command,status:'running',output:'',file,abort,promise:Promise.resolve()};controllers.add(abort);
    const background=()=>{if(!job.id){job.id=`task_${jobs.size+1}`;jobs.set(job.id,job);}return text(`Command running in background with ID: ${job.id}\nOutput file: ${file}`);};
    job.promise=runPi(createBashToolDefinition(cwd,{spawnHook:context=>targetSpawn({...context,env:{...context.env,...taskEnv}},{envKeys:Object.keys(taskEnv)})}),{command},nativeId,combined,(update:any)=>{job.output=(update.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');writeFileSync(file,job.output);}).then(output=>{job.status='completed';job.output=(output.content??[]).map((c:any)=>c.text??'').join('\n');writeFileSync(file,job.output);return output;},error=>{job.status=abort.signal.aborted||signal?.aborted?'stopped':'failed';job.error=String(error);job.output+=`\n${String(error)}`;writeFileSync(file,job.output);throw error;}).finally(()=>controllers.delete(abort));
    operations.add(job.promise);job.promise.finally(()=>operations.delete(job.promise)).catch(()=>{});
    if(p.run_in_background)return background();
    const timeout=Math.min(600_000,Number(p.timeout_ms)||120_000);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([job.promise,new Promise(resolve=>{timer=setTimeout(()=>{
      // WORMHOLE preserves foreground jobs on timeout, except sleep commands.
      if(/^\s*sleep\b/.test(command))abort.abort();
      resolve(background());
    },timeout);})]);}finally{clearTimeout(timer);}
  };
  const sessionCtx:ToolContext={...ctx,cwd,generalSession:{execute:async(name,p,nativeId,signal)=>{
    if(disposed||!allowed.has(name))throw new Error("Basic tools are not available");signal?.throwIfAborted();
    switch(name){
      case 'Read':{
        const result=await runPi(createReadToolDefinition(cwd),{path:String(p.file_path),offset:Number(p.offset)||1,limit:Number(p.limit)||2000},nativeId,signal);
        let line=Number(p.offset)||1;result.content=result.content.map((c:any)=>c.type==='text'?{...c,text:c.text.split('\n').map((s:string)=>`${line++}\t${s}`).join('\n')}:c);return result;
      }
      case 'Write':return runPi(createWriteToolDefinition(cwd),{path:String(p.file_path),content:String(p.content)},nativeId,signal);
      case 'Edit':if(p.replace_all)return multiEdit(p,signal);return runPi(createEditToolDefinition(cwd),{path:String(p.file_path),edits:[{oldText:String(p.old_string),newText:String(p.new_string)}]},nativeId,signal);
      case 'MultiEdit':return multiEdit(p,signal);
      case 'Bash':return shell(p,nativeId,signal);
      case 'sleep':{
        const seconds=Math.min(3600,Math.max(1,Number(p.seconds)||1));
        await new Promise<void>((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',cancel);resolve();};const timer=setTimeout(done,seconds*1000);const cancel=()=>{clearTimeout(timer);reject(signal?.reason??new Error('cancelled'));};signal?.addEventListener('abort',cancel,{once:true});});return text(`slept ${seconds}s`);
      }
      case 'LS':{
        const root=resolve(p.path),entries=await readdir(root,{withFileTypes:true});entries.sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name));
        const lines=[];for(const entry of entries){signal?.throwIfAborted();lines.push(entry.isDirectory()?`${entry.name}/`:`${entry.name}\t${(await stat(path.join(root,entry.name))).size} bytes`);}return text(lines.join('\n')||'(empty directory)');
      }
      case 'Glob':{
        const root=resolve(p.path),matches=[];
        for await(const file of glob(String(p.pattern),{cwd:root,exclude:['**/node_modules/**','**/.git/**','**/vendor/**']})){signal?.throwIfAborted();const info=await stat(path.join(root,file));if(info.isFile())matches.push({file,mtime:info.mtimeMs});}
        matches.sort((a,b)=>b.mtime-a.mtime||a.file.localeCompare(b.file));return text(matches.map(m=>m.file).join('\n')||'No matches found.');
      }
      case 'Grep':{
        const pattern=String(p.pattern);if(/\(\?[=!<]|\\[1-9]/.test(pattern))throw new Error('pattern is not a RE2 expression');
        const root=resolve(p.path),info=await stat(root),files: string[]=[],output:string[]=[],mode=String(p.output_mode??'files_with_matches');
        if(info.isFile())files.push(root);else for await(const file of glob(String(p.glob??(p.type?`**/*.${p.type}`:'**/*')),{cwd:root,exclude:['**/node_modules/**','**/.git/**','**/vendor/**']})){const target=path.join(root,file);if((await stat(target)).isFile())files.push(target);}
        const regex=new RegExp(pattern,p.multiline?(p['-i']?'is':'s'):(p['-i']?'i':''));
        for(const file of files){signal?.throwIfAborted();const bytes=await readFile(file);if(bytes.includes(0))continue;const body=bytes.toString('utf8'),lines=body.split('\n'),indices=lines.flatMap((line,i)=>regex.test(line)?[i]:[]);
          if(p.multiline&&!regex.test(body))continue;
          const found=p.multiline?regex.test(body):indices.length>0;if(!found)continue;
          if(mode==='files_with_matches')output.push(file);
          else if(mode==='count')output.push(`${file}:${p.multiline?(body.match(new RegExp(pattern,p['-i']?'gis':'gs'))??[]).length:indices.length}`);
          else {const before=Number(p['-B']??p['-C']??0),after=Number(p['-A']??p['-C']??0),selected=new Set<number>();for(const i of indices)for(let n=Math.max(0,i-before);n<=Math.min(lines.length-1,i+after);n++)selected.add(n);for(const i of [...selected].sort((a,b)=>a-b))output.push(`${file}${p['-n']===false?'':':'+(i+1)}:${lines[i]}`);}
        }
        const offset=Math.max(0,Number(p.offset)||0),limit=p.head_limit===0?output.length:Number(p.head_limit)||250;return text(output.slice(offset,offset+limit).join('\n')||'No matches found.');
      }
      case 'TaskList':return text([...jobs.values()].map(j=>`${j.id} [bash] ${j.status}  ${j.command}`).join('\n')||'No background tasks.');
      case 'TaskStop':{
        if(p.task_id){const job=jobs.get(String(p.task_id));if(!job)throw new Error('Error: unknown task');job.abort.abort();await job.promise.catch(()=>{});return text(`Stopped task ${job.id}.`);}
        const running=[...jobs.values()].filter(j=>j.status==='running');for(const job of running)job.abort.abort();await Promise.allSettled(running.map(j=>j.promise));return text(`Stopped ${running.length} running task(s).`);
      }
      case 'TaskOutput':{
        const job=jobs.get(String(p.task_id));if(!job)throw new Error('Error: unknown task');
        if(p.block&&job.status==='running'){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([job.promise.catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,Number(p.timeout_ms)||30000);})]);}finally{clearTimeout(timer);}}
        return text(`[task ${job.id} | ${job.status}]\n${job.output.slice(-(Number(p.max_bytes)||30000))}`);
      }
      default:throw new Error("Base tool has no executor");
    }
  }}};
  const cancelJobs = () => { for (const controller of controllers) controller.abort(); };
  ctx.signal?.addEventListener("abort", cancelJobs, { once: true });
  ctx.generalSession=sessionCtx.generalSession;
  return {tools:await assembleTools(pool,[...allowed],sessionCtx,gate),dispose:async()=>{disposed=true;ctx.signal?.removeEventListener("abort",cancelJobs);cancelJobs();await Promise.allSettled([...operations]);}};
}
