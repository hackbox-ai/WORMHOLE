import {createReadStream} from 'node:fs';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AppContext} from './server.ts';
import {goLocalTime} from '../domains/findings/reads.ts';
export async function routeTraffic(req:IncomingMessage,res:ServerResponse,url:URL,ctx:AppContext,json:(res:ServerResponse,status:number,value:unknown)=>void,readJson:(req:IncomingMessage)=>Promise<any>):Promise<boolean>{
  const known=['/api/traffic','/api/traffic/hosts','/api/traffic/exchange','/api/traffic/blob','/api/traffic/all'];
  if(!known.includes(url.pathname))return false;
  const runtime=ctx.traffic,store=runtime?.store;
  if(!store){json(res,req.method==='GET'&&['/api/traffic','/api/traffic/hosts'].includes(url.pathname)?200:404,
    url.pathname==='/api/traffic'&&req.method==='GET'?{enabled:false,exchanges:[]}:url.pathname==='/api/traffic/hosts'&&req.method==='GET'?{hosts:[]}:{error:'traffic disabled'});return true;}
  const integer=(key:string,fallback:number)=>{const raw=url.searchParams.get(key);return raw!==null&&/^[+-]?\d+$/.test(raw)?Number(raw):fallback;};
  if(url.pathname==='/api/traffic'&&req.method==='GET'){
    const page=integer('page',0),size=integer('size',100),result=store.page(url.searchParams,page,size);
    json(res,200,{enabled:runtime.enabled(),proxy:runtime.route().proxy,count:store.count(),total:result.total,page,size,
      exchanges:result.exchanges.map(r=>({id:r.id,ts:goLocalTime(new Date(r.ts*1000).toISOString()),host:r.host,method:r.method,url:r.url,status:r.status,content_type:r.content_type,resp_len:r.resp_len}))});return true;
  }
  if(url.pathname==='/api/traffic/hosts'&&req.method==='GET'){json(res,200,{hosts:store.hosts()});return true;}
  if(url.pathname==='/api/traffic/exchange'&&req.method==='GET'){
    const id=url.searchParams.get('id')??'';if(!id){json(res,400,{error:'missing id'});return true;}
    try{json(res,200,store.get(id));}catch(e){json(res,404,{error:(e as Error).message});}return true;
  }
  if(url.pathname==='/api/traffic/blob'&&req.method==='GET'){
    const hash=(url.searchParams.get('hash')??'').trim();if(!hash){json(res,400,{error:'missing hash'});return true;}
    try{const b=store.blobFile(hash);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':b.size,'Content-Disposition':`attachment; filename="${hash}.bin"`});
      const stream=createReadStream(b.file);res.on('close',()=>stream.destroy());stream.on('error',e=>res.destroy(e));stream.pipe(res);
    }catch(e){json(res,404,{error:(e as Error).message});}return true;
  }
  if(url.pathname==='/api/traffic'&&req.method==='DELETE'){
    const host=(url.searchParams.get('host')??'').trim();if(!host){json(res,400,{error:'missing host'});return true;}
    json(res,200,{deleted:store.deleteHosts([host],false)});return true;
  }
  if(url.pathname==='/api/traffic/hosts'&&req.method==='DELETE'){
    let body:any;try{body=await readJson(req);}catch{json(res,400,{error:'invalid body'});return true;}
    if(body?.hosts!=null&&(!Array.isArray(body.hosts)||body.hosts.some((x:unknown)=>typeof x!=='string'))){json(res,400,{error:'invalid body'});return true;}
    const hosts=(body?.hosts??[]).map((s:string)=>s.trim()).filter(Boolean);if(!hosts.length){json(res,400,{error:'missing hosts'});return true;}
    json(res,200,{deleted:store.deleteHosts(hosts,true)});return true;
  }
  if(url.pathname==='/api/traffic/all'&&req.method==='DELETE'){json(res,200,store.deleteAll());return true;}
  json(res,405,{error:'method not allowed'});return true;
}
