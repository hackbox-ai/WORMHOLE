import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
import {notificationService,channelDTO,deliveryDTO,NotificationRequestError} from '../domains/notify/service.ts';
type Json=(r:ServerResponse,status:number,value:unknown)=>void;
export async function routeNotify(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:Json):Promise<boolean>{
  if(!url.pathname.startsWith('/api/notify/'))return false;const service=notificationService(ctx.pool),path=url.pathname;
  const body=async()=>{try{return await readObject(req,1024*1024,true);}catch(e){throw new NotificationRequestError(400,"The request body is not valid JSON: "+(e as Error).message);}};
  const int=(name:string,def:number)=>{const v=url.searchParams.get(name);return v!==null&&/^[+-]?\d+$/.test(v)?Number(v):def;};
  try{
    if(path==='/api/notify/email-alerts'&&req.method==='GET'){json(res,200,await service.emailAlerts());return true;}
    if(path==='/api/notify/email-alerts'&&req.method==='PUT'){json(res,200,await service.saveEmailAlerts(await body()));return true;}
    if(path==='/api/notify/meta'&&req.method==='GET'){json(res,200,await service.meta());return true;}
    if(path==='/api/notify/channels'&&req.method==='GET'){json(res,200,{channels:(await service.store.channels()).map(channelDTO)});return true;}
    if(path==='/api/notify/channels'&&req.method==='POST'){json(res,200,{id:await service.create(await body())});return true;}
    const channel=path.match(/^\/api\/notify\/channels\/([^/]+)(\/test)?$/);
    if(channel){const id=Number(channel[1]);if(!/^[+-]?\d+$/.test(channel[1]!)||!Number.isSafeInteger(id)){json(res,400,{error:"Channel id is invalid"});return true;}
      if(!channel[2]&&req.method==='PATCH'){json(res,200,{id:await service.update(id,await body())});return true;}
      if(!channel[2]&&req.method==='DELETE'){await service.store.removeChannel(id);json(res,200,{ok:true});return true;}
      if(channel[2]&&req.method==='POST'){const controller=new AbortController(),closed=()=>{if(!res.writableEnded)controller.abort();};res.once('close',closed);try{json(res,200,await service.test(id,controller.signal));}finally{res.off('close',closed);}return true;}
    }
    if(path==='/api/notify/deliveries'&&req.method==='GET'){const positive=(name:string,def:number)=>{const n=int(name,def);return Number.isSafeInteger(n)&&n>0?n:def;};const page=positive('page',1),page_size=positive('page_size',50),r=await service.store.list({channel_id:int('channel_id',0),state:url.searchParams.get('state')??undefined,event_kind:url.searchParams.get('event_kind')??undefined},page,page_size);json(res,200,{deliveries:r.deliveries.map(deliveryDTO),total:r.total,page,page_size});return true;}
    const retry=path.match(/^\/api\/notify\/deliveries\/([^/]+)\/retry$/);if(retry&&req.method==='POST'){const id=Number(retry[1]);if(!/^[+-]?\d+$/.test(retry[1]!)||!Number.isSafeInteger(id)){json(res,400,{error:"Invalid delivery id"});return true;}try{await service.store.retry(id);}catch(e){throw new NotificationRequestError(400,(e as Error).message);}json(res,200,{ok:true});return true;}
    // Legacy target extension; original UI never invokes this endpoint.
    if(path==='/api/notify/dispatch'&&req.method==='POST'){const before=await service.store.stats();await service.dispatcher.step();const after=await service.store.stats();json(res,200,{sent:Math.max(0,after.sent_today!-before.sent_today!),pending:after.pending,failed:after.failed});return true;}
  }catch(e){json(res,e instanceof NotificationRequestError?e.status:(e as Error).message==="Notification channel does not exist"?404:500,{error:(e as Error).message});return true;}
  return false;
}
