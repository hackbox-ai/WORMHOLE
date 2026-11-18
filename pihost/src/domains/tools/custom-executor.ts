import {targetSpawn} from '../network/sandbox.ts';
import {currentNetwork} from '../network/context.ts';
import {mkdir,writeFile,unlink,readFile} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {createGunzip} from 'node:zlib';
import type {Pool} from 'pg';
import {createBashTool} from '@earendil-works/pi-coding-agent';
import {targetRoute,targetEnvironment,proxyAgent} from '../traffic/network.ts';
import type {ToolContext} from './gate.ts';
export interface CustomRecord {key:string;kind:string;exec:unknown;schema?:unknown;description?:string;agents?:string[];enabled?:boolean;deferred?:boolean}
const specOf=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
export function hasSchemaProps(value:unknown){return Object.keys(specOf(specOf(value).properties)).length>0;}
export function ensureCustomSchema(value:unknown):Record<string,unknown>{return hasSchemaProps(value)?specOf(value):{type:'object',properties:{args:{type:'string',description:"Command/Parameter (free text)"}}};}
function sorted(value:any):any{return Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;}
export const goJSON=(value:unknown)=>JSON.stringify(sorted(value)).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
export const schemaFingerprint=(value:unknown)=>JSON.stringify(sorted(value));
export function valueToString(value:unknown):string{return value==null?'':typeof value==='object'?goJSON(value):String(value);}
export function renderCustomTemplate(template:string,params:Record<string,unknown>,quote=false){let out=template;for(const [name,value]of Object.entries(params)){const text=valueToString(value);out=out.replaceAll('{'+name+'}',quote?"'"+text.replaceAll("'","'\\''")+"'":text);}return out;}
const content=(text:string)=>({content:[{type:'text' as const,text}]});
export async function captureCustomOutput(cwd:string,text:string,persist=true){
 const bytes=Buffer.from(text);if(bytes.length<=30000)return text;if(!persist)return bytes.subarray(0,15000).toString('utf8')+'\n\n... ['+(bytes.length-30000)+' characters truncated] ...\n\n'+bytes.subarray(bytes.length-15000).toString('utf8');const dir=path.join(cwd,'cmd-output');await mkdir(dir,{recursive:true});const file=path.join(dir,'output-'+Math.floor(Date.now()/1000)+'-'+randomUUID()+'.txt');await writeFile(file,bytes,{mode:0o644});
 return bytes.subarray(0,30000).toString('utf8')+'\n\n... <persisted-output>[Output too large: full '+bytes.length+' bytes / '+(text.split('\n').length)+' lines.Full output saved to  '+path.relative(cwd,file)+' </persisted-output>';
}
export async function executeCustom(pool:Pool,t:CustomRecord,params:Record<string,unknown>,ctx:ToolContext):Promise<{content:{type:'text';text:string}[]}>{
 const spec=specOf(t.exec),cwd=ctx.cwd??process.cwd();await mkdir(cwd,{recursive:true});ctx.signal?.throwIfAborted();
 if(t.kind==='command'){
  if(typeof spec.command!=='string'||!spec.command.trim())throw new Error("command is empty");
  const command=renderCustomTemplate(spec.command,params,true),signal=Number(spec.timeout_ms)>0?AbortSignal.any([...(ctx.signal?[ctx.signal]:[]),AbortSignal.timeout(Number(spec.timeout_ms))]):ctx.signal;
  try{
   const tool=createBashTool(cwd,{spawnHook:s=>targetSpawn(s)});
   const result=ctx.generalSession?await ctx.generalSession.execute('Bash',{command},ctx.nativeToolCallId,signal):await tool.execute(ctx.nativeToolCallId??randomUUID(),{command},signal);
   const output=result as {content:{type:'text';text:string}[];details?:{fullOutputPath?:string}};
   const text=output.details?.fullOutputPath?await readFile(output.details.fullOutputPath,'utf8'):output.content.map(c=>c.text).join('');
   return content(await captureCustomOutput(cwd,text,!ctx.manualInvocation));
  }catch(error){throw new Error((error instanceof Error?error.message:String(error)).replace(/Command exited with code (\d+)/g,'[exit code $1]'));}

 }
 if(t.kind==='script'){
  if(typeof spec.code!=='string'||!spec.code.trim())throw new Error("script code is empty");
  const configured=(await pool.query("SELECT value FROM app_settings WHERE key IN ('settings.python_interpreter','python_interpreter') ORDER BY CASE WHEN key='settings.python_interpreter' THEN 0 ELSE 1 END LIMIT 1")).rows[0]?.value;
  const interpreter=String(configured??'').trim()||(existsSync('/usr/bin/python3')?'/usr/bin/python3':'');if(!interpreter)throw new Error("The python interpreter is not configured and not detected (set in system configuration)");
  const dir=path.join(cwd,'.tools');await mkdir(dir,{recursive:true,mode:0o755});const file=path.join(dir,t.key+'-'+randomUUID()+'.py');await writeFile(file,spec.code,{mode:0o600,flag:'wx'});
  try{
   const env={...process.env,...targetEnvironment()};for(const [key,value]of Object.entries(params))if(value===null||typeof value!=='object')env['TOOL_'+key.toUpperCase()]=valueToString(value);
   const output=await new Promise<string>((resolve)=>{
    const sandbox=currentNetwork()?.mode==='jump'?targetSpawn({command:[interpreter,file].map(v=>"'"+v.replaceAll("'","'\\''")+"'").join(' '),cwd,env}):undefined;
    const child=spawn(sandbox?'bash':interpreter,sandbox?['-c',sandbox.command]:[file],{cwd,env:sandbox?.env??env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']}),chunks:Buffer[]=[];let timedOut=false,spawnError:string|undefined;
    child.stdout.on('data',chunk=>chunks.push(Buffer.from(chunk)));child.stderr.on('data',chunk=>chunks.push(Buffer.from(chunk)));
    const kill=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
    const timer=setTimeout(()=>{timedOut=true;kill();},Number(spec.timeout_ms)>0?Number(spec.timeout_ms):120000);ctx.signal?.addEventListener('abort',kill,{once:true});
    child.on('error',error=>spawnError=error.message);child.stdin.on('error',()=>{});
    child.on('close',(code,signal)=>{clearTimeout(timer);ctx.signal?.removeEventListener('abort',kill);let body=Buffer.concat(chunks).toString('utf8');
     if(timedOut)body+="\n... [Timeout terminated] ...";else if(spawnError||code!==0)body+='\n[exit: '+(spawnError??(signal?'signal: killed':'exit status '+code))+']';resolve(body);
    });
    if(ctx.signal?.aborted)kill();child.stdin.end(goJSON(params));
   });return content(await captureCustomOutput(cwd,output,!ctx.manualInvocation));
  }finally{await unlink(file).catch(()=>{});}
 }
 if(t.kind==='http'){
  const raw=typeof spec.url==='string'?renderCustomTemplate(spec.url,params):'';if(!raw.trim())throw new Error("http url is empty");const method=String(spec.method??'').trim().toUpperCase()||'GET',body=typeof spec.body==='string'&&spec.body?renderCustomTemplate(spec.body,params):undefined;
  const route=currentNetwork()?.mode==='jump'||spec.use_recording_proxy?targetRoute():{proxy:String(spec.proxy??'').trim(),caFile:''},tls=route.caFile?{ca:readFileSync(route.caFile)}:{},url=new URL(raw),signal=AbortSignal.any([...(ctx.signal?[ctx.signal]:[]),AbortSignal.timeout(Number(spec.timeout_ms)>0?Number(spec.timeout_ms):30000)]);
  const headers=Object.fromEntries(Object.entries(specOf(spec.headers)).map(([k,v])=>[k,Buffer.from(renderCustomTemplate(String(v),params),'utf8').toString('latin1')]));
  if(body!==undefined&&!Object.keys(headers).some(k=>k.toLowerCase()==='content-length'))headers['Content-Length']=String(Buffer.byteLength(body));
  const automaticGzip=!Object.keys(headers).some(k=>['accept-encoding','range'].includes(k.toLowerCase()))&&method!=='HEAD';
  if(automaticGzip)headers['Accept-Encoding']='gzip';
  const output=await request(url,0,method,body);return content(await captureCustomOutput(cwd,goJSON(output),!ctx.manualInvocation));
  async function request(url:URL,redirects:number,requestMethod:string,requestBody:string|undefined):Promise<{status:number;body:string}>{
   signal.throwIfAborted();const agent=route.proxy?proxyAgent(route.proxy,url.protocol==='https:',tls):false;
   try{return await new Promise((resolve,reject)=>{
    const requestHeaders={...headers};if(requestBody===undefined)for(const key of Object.keys(requestHeaders))if(key.toLowerCase()==='content-length')delete requestHeaders[key];
    const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:requestMethod,headers:requestHeaders,agent,...tls,signal},res=>{
     if(res.headers['x-wormhole-network-error']){res.resume();reject(new Error(decodeURIComponent(String(res.headers['x-wormhole-network-error']))));return;}
     if([301,302,303,307,308].includes(res.statusCode??0)&&res.headers.location){res.resume();if(redirects>=10){reject(new Error("Request failed: stopped after 10 redirects"));return;}const change=[301,302,303].includes(res.statusCode??0)&&requestMethod!=='HEAD';resolve(request(new URL(res.headers.location!,url),redirects+1,change?'GET':requestMethod,change?undefined:requestBody));return;}
     let total=0;const chunks:Buffer[]=[];let ended=false;
     const finish=()=>{if(ended)return;ended=true;const bytes=Buffer.concat(chunks);resolve({status:res.statusCode??0,body:bytes.subarray(0,1<<20).toString('utf8')});};
     const decoded=automaticGzip&&res.headers['content-encoding']==='gzip'?res.pipe(createGunzip()):res;
     decoded.on('data',chunk=>{const bytes=Buffer.from(chunk);chunks.push(bytes.subarray(0,Math.max(0,(1<<20)-total)));total+=bytes.length;if(total>=1<<20){finish();decoded.destroy();res.destroy();}});
     decoded.on('end',finish);decoded.on('error',finish);res.on('error',finish);
    });req.on('error',error=>reject(new Error("Request failed: "+error.message)));req.end(requestBody===undefined?undefined:Buffer.from(requestBody,'utf8'));
   });}finally{if(agent)agent.destroy();}
  }
 }
 throw new Error("Unknown custom tool type: "+t.kind);
}
