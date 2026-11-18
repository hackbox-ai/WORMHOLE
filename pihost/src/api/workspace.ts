import {workspaceGate,safeWorkspacePath} from '../domains/workspace/maintenance.ts';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createReadStream} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import type {AppContext} from './server.ts';
import {WorkspaceError,MAX_UPLOAD} from '../domains/workspace/service.ts';
import {parseUpload} from '../domains/workspace/multipart.ts';
import {saveAttachments,MAX_CHAT_UPLOAD} from '../domains/workspace/attachments.ts';
type Json=(res:ServerResponse,status:number,value:unknown)=>void;
export async function routeWorkspace(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:Json,readJson:(req:IncomingMessage)=>Promise<any>):Promise<boolean>{
  if(url.pathname==='/api/chat/upload'&&req.method==='POST'){await chatUpload(req,res,url,ctx,json);return true;}
  if(!url.pathname.startsWith('/api/workspace/'))return false;
  const rel=url.searchParams.get('path')??'',action=url.pathname.slice('/api/workspace/'.length),method=req.method??'GET';
  try{
    if(action==='resources'&&method==='GET')json(res,200,await ctx.workspace.resources.list(true));
    else if(action==='resource-detail'&&method==='GET')json(res,200,await ctx.workspace.resources.detail(url.searchParams.get('task_id')));
    else if(action==='resource-history'&&method==='GET')json(res,200,await ctx.workspace.resources.history());
    else if(action==='resource-preview'&&method==='POST'){const b=await readJson(req);json(res,200,await ctx.workspace.resources.preview(b.task_id,b.categories));}
    else if(action==='resource-cleanup'&&method==='POST'){const b=await readJson(req);json(res,200,await ctx.workspace.resources.execute(b.token));}
    else if(action==='tasks'&&method==='GET')json(res,200,await ctx.workspace.maintenance.tasks());
    else if(action==='cleanup-history'&&method==='GET')json(res,200,await ctx.workspace.maintenance.history());
    else if((action==='cleanup-preview'||action==='cleanup')&&method==='POST'){
      const body=await readJson(req);
      json(res,200,action==='cleanup-preview'?await ctx.workspace.maintenance.preview(body?.paths):await ctx.workspace.maintenance.execute(body?.token));
    }
    else if(action==='list'&&method==='GET')json(res,200,await ctx.workspace.list(rel));
    else if(action==='read'&&method==='GET')json(res,200,await ctx.workspace.read(rel));
    else if((action==='write'||action==='mkdir')&&method==='POST'){
      const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);const raw=Buffer.concat(chunks).toString('utf8');let body:any;
      if(!raw.trim())throw new WorkspaceError(400,'EOF');
      try{body=JSON.parse(raw);}catch{throw new WorkspaceError(400,'invalid JSON');}
      if(body!=null&&(Array.isArray(body)||typeof body!=='object'))throw new WorkspaceError(400,'invalid JSON object');
      for(const key of ['path',...(action==='write'?['content']:[])])if(body?.[key]!=null&&typeof body[key]!=='string')throw new WorkspaceError(400,`json: cannot unmarshal ${typeof body[key]==='number'?'number':typeof body[key]} into Go struct field .${key} of type string`);
      json(res,200,action==='write'?await ctx.workspace.write(body?.path??'',body?.content??''):await ctx.workspace.makeDir(body?.path??''));
    }else if(action==='delete'&&method==='DELETE')json(res,200,await ctx.workspace.remove(rel));
    else if(action==='upload'&&method==='POST'){
      await ctx.workspace.uploadDirectory(rel);let parsed:Awaited<ReturnType<typeof parseUpload>>;
      try{parsed=await parseUpload(req,MAX_UPLOAD);}catch(e){throw new WorkspaceError(400,"Parsing upload failed or size limit exceeded:"+(e as Error).message);}
      try{json(res,200,await ctx.workspace.upload(rel,parsed.files));}finally{await parsed.cleanup();}
    }else if(action==='download'&&(method==='GET'||method==='HEAD')){
      const file=await ctx.workspace.download(rel),release=workspaceGate.use(file.full);
      res.once('close',release);res.once('finish',release);
      try{await download(req,res,file);}catch(e){release();throw e;}
    }
    else return false;
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')e=new WorkspaceError(404,"Path does not exist");if(res.headersSent)res.destroy(e as Error);else json(res,e instanceof WorkspaceError?e.status:500,{error:(e as Error).message});}
  return true;
}
async function chatUpload(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:Json):Promise<void>{
  const scope=url.searchParams.get('scope')??'',id=url.searchParams.get('id')??'',sub=({task:'tasks',session:'sessions',staging:'drafts'} as Record<string,string>)[scope];
  if(!sub){json(res,400,{error:"scope must be task / session / staging"});return;}
  if(!/^[A-Za-z0-9_-]+$/.test(id)){json(res,400,{error:"Illegal id"});return;}
  let release:(()=>void)|undefined;let fileRelease:(()=>void)|undefined;
  try{
    if(scope==='task'){
      const task=await ctx.pool.query('SELECT id FROM tasks WHERE id::text=$1 AND deleted_at IS NULL',[id]);if(!task.rowCount){json(res,404,{error:'task not found'});return;}
      const admitted=ctx.taskEngine.beginTaskOperation(Number(id));if(!admitted){json(res,409,{error:"The task is being deleted and attachments cannot be uploaded."});return;}release=admitted;
      if(!(await ctx.pool.query('SELECT 1 FROM tasks WHERE id::text=$1 AND deleted_at IS NULL',[id])).rowCount){json(res,404,{error:'task not found'});return;}
    }
    const dir=path.join(ctx.workspace.root,sub,id,'uploads');fileRelease=workspaceGate.use(dir);await safeWorkspacePath(ctx.workspace.root,path.relative(ctx.workspace.root,dir),true);try{await mkdir(dir,{recursive:true,mode:0o755});}catch(e){throw new WorkspaceError(500,"Directory creation failed: "+(e as Error).message);}
    let parsed:Awaited<ReturnType<typeof parseUpload>>;try{parsed=await parseUpload(req,MAX_CHAT_UPLOAD);}catch(e){throw new WorkspaceError(400,"Parsing upload failed or size limit exceeded: "+(e as Error).message);}
    try{if(!parsed.files.length)throw new WorkspaceError(400,"Missing upload file (form field file)");
      let attachments;try{attachments=await saveAttachments(dir,parsed.files);}catch(e){throw new WorkspaceError(500,"Save failed: "+(e as Error).message);}json(res,200,{attachments});
    }finally{await parsed.cleanup();}
  }catch(e){json(res,e instanceof WorkspaceError?e.status:500,{error:(e as Error).message});}finally{fileRelease?.();release?.();}
}
async function download(req:IncomingMessage,res:ServerResponse,file:{full:string;name:string;size:number;mtime:Date}):Promise<void>{
  const name=file.name.replace(/["\\\r\n]/g,''),escaped=encodeURIComponent(file.name).replace(/['()*!]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  // Node rejects non-Latin1 header values; preserve Go's UTF8 wire bytes.
  res.setHeader('Content-Disposition',Buffer.from(`attachment; filename="${name}"; filename*=UTF-8''${escaped}`,'utf8').toString('latin1'));
  res.setHeader('Last-Modified',file.mtime.toUTCString());
  const modified=Math.floor(file.mtime.getTime()/1000)*1000,match=req.headers['if-match'],unmodified=req.headers['if-unmodified-since'];
  if(match&&match.trim()!=='*'||!match&&unmodified&&Date.parse(unmodified)<modified){res.setHeader('Content-Length',0);res.writeHead(412);res.end();return;}
  const noneMatch=req.headers['if-none-match'],since=req.headers['if-modified-since'];
  if(noneMatch?.trim()==='*'||!noneMatch&&since&&Date.parse(since)>=modified){res.writeHead(304);res.end();return;}
  const mime:Record<string,string>={'.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8','.html':'text/html; charset=utf-8','.json':'application/json','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.zip':'application/zip','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
  let contentType=mime[path.extname(file.name).toLowerCase()];
  if(!contentType){const fh=await open(file.full,'r');try{const buffer=Buffer.alloc(512),{bytesRead}=await fh.read(buffer,0,512,0);const bytes=buffer.subarray(0,bytesRead);contentType=bytes.some(b=>b<=8||b===11||b>=14&&b<=26||b>=28&&b<=31)?'application/octet-stream':'text/plain; charset=utf-8';}finally{await fh.close();}}
  res.setHeader('Content-Type',contentType);res.setHeader('Accept-Ranges','bytes');
  let range=req.headers.range;const ifRange=req.headers['if-range'];if(ifRange&&(typeof ifRange!=='string'||Date.parse(ifRange)!==Math.floor(file.mtime.getTime()/1000)*1000))range=undefined;
  let ranges:{start:number;end:number}[]=[];
  if(range){
    if(!range.startsWith('bytes='))return invalidRange(false);
    let noOverlap=false;
    const parse=(value:string):number|undefined=>{
      if(!/^\+?\d+$/.test(value))return;
      try{const n=BigInt(value);if(n>9223372036854775807n)return;return Number(n);}catch{return;}
    };
    for(const raw of range.slice(6).split(',')){
      const item=raw.trim();if(!item)continue;
      const dash=item.indexOf('-');if(dash<0)return invalidRange(false);
      const first=item.slice(0,dash).trim(),last=item.slice(dash+1).trim();
      if(!first){const n=parse(last);if(n===undefined)return invalidRange(false);ranges.push({start:Math.max(0,file.size-n),end:file.size-1});}
      else{const start=parse(first);if(start===undefined)return invalidRange(false);if(start>=file.size){noOverlap=true;continue;}
        const parsed=last?parse(last):file.size-1;if(parsed===undefined||parsed<start)return invalidRange(false);
        ranges.push({start,end:Math.min(file.size-1,parsed)});
      }
    }
    if(noOverlap&&!ranges.length&&file.size)return invalidRange(true);
    if(ranges.reduce((n,r)=>n+r.end-r.start+1,0)>file.size)ranges=[];
  }
  if(ranges.length>1){const boundary='pihost-'+Math.random().toString(16).slice(2);const chunks=ranges.map(r=>Buffer.from(`--${boundary}\r\nContent-Range: bytes ${r.start}-${r.end}/${file.size}\r\nContent-Type: ${contentType}\r\n\r\n`)),end=Buffer.from(`--${boundary}--\r\n`);
    const size=chunks.reduce((n,c,i)=>n+c.length+ranges[i]!.end-ranges[i]!.start+1+2,0)+end.length;
    res.setHeader('Content-Type',`multipart/byteranges; boundary=${boundary}`);res.setHeader('Content-Length',size);res.writeHead(206);
    if(req.method==='HEAD'){res.end();return;}
    for(let i=0;i<ranges.length;i++){await write(chunks[i]!);const stream=createReadStream(file.full,ranges[i]);try{for await(const chunk of stream)await write(chunk as Buffer);}finally{stream.destroy();}await write(Buffer.from('\r\n'));}res.end(end);return;
  }
  const r=ranges[0];if(r)res.setHeader('Content-Range',`bytes ${r.start}-${r.end}/${file.size}`);
  res.setHeader('Content-Length',r?r.end-r.start+1:file.size);res.writeHead(r?206:200);if(req.method==='HEAD'||(r&&r.end<r.start)){res.end();return;}
  const stream=createReadStream(file.full,r);res.on('close',()=>stream.destroy());stream.on('error',e=>res.destroy(e));stream.pipe(res);
  function invalidRange(noOverlap:boolean){const body=noOverlap?'invalid range: failed to overlap\n':'invalid range\n';
    if(noOverlap)res.setHeader('Content-Range','bytes */'+file.size);res.removeHeader('Accept-Ranges');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Content-Length',Buffer.byteLength(body));
    res.writeHead(416);res.end(req.method==='HEAD'?undefined:body);
  }
  async function write(bytes:Buffer){if(res.destroyed)throw new Error('download disconnected');if(!res.write(bytes))await new Promise<void>((resolve,reject)=>{const drain=()=>{res.off('close',close);resolve();},close=()=>{res.off('drain',drain);reject(new Error('download disconnected'));};res.once('drain',drain);res.once('close',close);});}
}
