import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {ActivityService} from '../domains/activity/service.ts';
export async function routeActivity(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(res:ServerResponse,status:number,data:unknown)=>void):Promise<boolean>{
 const path=url.pathname,method=req.method??'GET';
 const isActivity=path.startsWith('/api/exploration/activity'),isMain=['/api/exploration/main-sessions','/api/exploration/main-session/new'].includes(path);
 if(!isActivity&&!isMain&&path!=='/api/exploration/tokens')return false;
 const service=new ActivityService(ctx.pool);
 const taskId=url.searchParams.has('task')?Number(url.searchParams.get('task')):Number((await ctx.pool.query("SELECT id FROM tasks WHERE kind='pentest' AND deleted_at IS NULL AND archived=FALSE ORDER BY id DESC LIMIT 1")).rows[0]?.id??0);
 const task=await service.task(taskId),num=(k:string,fallback:number)=>/^-?\d+$/.test(url.searchParams.get(k)??'')?Number(url.searchParams.get(k)):fallback;
 const intent=url.searchParams.has('intent')&&/^-?\d+$/.test(url.searchParams.get('intent')!)?Number(url.searchParams.get('intent')):null;
 if(path==='/api/exploration/tokens'&&method==='GET'){json(res,200,await service.tokens(taskId));return true;}
 if(!task){if(path==='/api/exploration/activity'&&method==='GET')json(res,200,{items:[],cursor:0});else json(res,404,{error:/\/\d+$/.test(path)?'no task':'task not found'});return true;}
 if(method==='GET'&&path==='/api/exploration/activity'){json(res,200,await service.list(taskId,intent,num('since',0),num('limit',300)));return true;}
 if(method==='GET'&&path==='/api/exploration/activity/history'){
  try{json(res,200,await service.history(taskId,url.searchParams.get('session')??'',num('before',0),num('limit',200)));}catch(e){const message=(e as Error).message;if(['bad session','session not found'].includes(message))json(res,message==='bad session'?400:404,{error:message});else throw e;}return true;
 }
 const detail=path.match(/^\/api\/exploration\/activity\/(\d+)$/);
 if(detail&&method==='GET'){json(res,200,{detail:await service.detail(taskId,Number(detail[1]))});return true;}
 if(method==='GET'&&path==='/api/exploration/main-sessions'){const sessions=await service.mainSessions(taskId);json(res,200,{sessions,current:sessions[0]?.seq??0});return true;}
 if(method==='POST'&&path==='/api/exploration/main-session/new'){
  if(ctx.taskEngine?.isDeleting(taskId)){json(res,409,{error:"The task is being deleted and a new session cannot be created."});return true;}
  const session=await service.newMain(taskId);json(res,200,{...session,current:session.seq});return true;
 }
 if(method==='GET'&&path==='/api/exploration/activity/stream'){
  const last=req.headers['last-event-id'];let cursor=typeof last==='string'&&/^-?\d+$/.test(last)?Number(last):num('since',0),closed=false;
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
  res.on('close',()=>{closed=true;});let lastPing=Date.now();
  const write=async(value:string)=>{if(!closed&&!res.write(value))await new Promise<void>(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});};
  try{while(!closed){const page=await service.list(taskId,intent,cursor,500,true);for(const item of page.items){if(closed)break;await write(`id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`);}cursor=page.cursor;
   if(page.items.length===500)continue;
   if(Date.now()-lastPing>=20_000){await write(': ping\n\n');lastPing=Date.now();}
   await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);res.off('close',done);resolve();};const timer=setTimeout(done,250);res.once('close',done);});
  }}catch(error){console.error('[activity/stream] replay failed, reconnect from last delivered id',error);}
  res.end();return true;
 }
 json(res,404,{error:'not_found',path});return true;
}
