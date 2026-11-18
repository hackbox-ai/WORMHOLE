import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {readObject} from './json-body.ts';
import {ChannelError} from '../domains/network/channels.ts';
export async function routeNetworkChannels(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(r:ServerResponse,s:number,v:unknown)=>void){
 const root=url.pathname==='/api/network/channels',match=url.pathname.match(/^\/api\/network\/channels\/(\d+)(?:\/(connector|probe))?$/),task=url.pathname.match(/^\/api\/tasks\/(\d+)\/network$/);
 if(!root&&!match&&!task)return false;
 const service=ctx.networkChannels;if(!service){json(res,503,{error:"Network channel service not started"});return true;}
 try{
  if(task&&req.method==='GET'){
   const row=(await ctx.pool.query('SELECT network_mode,network_channel_id,network_version FROM tasks WHERE id=$1 AND deleted_at IS NULL',[task[1]])).rows[0];
   if(!row)throw new ChannelError("Task does not exist",404);
   json(res,200,{...row,channel:row.network_mode==='jump'?await service.forTask(Number(row.network_channel_id),Number(row.network_version)):null});return true;
  }
  if(root&&req.method==='GET'){json(res,200,{channels:await service.list()});return true;}
  if(root&&req.method==='POST'){json(res,201,await service.create(await readObject(req,32768)));return true;}
  if(match){
   const id=Number(match[1]);if(!Number.isSafeInteger(id)||id<=0)throw new ChannelError("Invalid channel");
   if(!match[2]&&req.method==='PATCH'){json(res,200,await service.update(id,await readObject(req,32768)));return true;}
   if(match[2]==='connector'&&req.method==='GET'){const platform=url.searchParams.get('platform')??'linux_amd64';const zip=await service.connector(id,platform);res.writeHead(200,{'Content-Type':'application/zip','Cache-Control':'no-store','Content-Disposition':`attachment; filename="wormhole-connector-${id}-${platform}.zip"`});res.end(zip);return true;}
   if(match[2]==='probe'&&req.method==='POST'){const input=await readObject(req,4096);json(res,200,await service.probe(id,String(input.target??''),AbortSignal.timeout(10000)));return true;}
  }
  json(res,405,{error:"Unsupported operation"});
 }catch(e){json(res,e instanceof ChannelError?e.status:500,{error:e instanceof ChannelError?e.message:"Network channel operation failed, please check the service log"});}
 return true;
}
