import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {lookup,type LookupAllOptions} from 'node:dns';
import {isIP} from 'node:net';
import {createGunzip} from 'node:zlib';
import {proxyAgent} from '../traffic/network.ts';
import {notificationProxy} from './environment.ts';
import {checkDialAddress,validateHTTPURL} from './config.ts';
import {PermanentNotificationError} from './dispatcher.ts';
import {oneLine} from './render.ts';
const redact=(raw:string)=>{try{const u=new URL(raw);return u.protocol+'//'+u.host+'/…';}catch{return "(Address cannot be resolved)";}};
const redactText=(s:string)=>s.replace(/https?:\/\/[^\s"']+/g,redact);
export const guardedLookup:typeof lookup=((hostname:string,options:any,callback:any)=>{
  lookup(hostname,{...options,all:true} as LookupAllOptions,(error,addresses)=>{
    if(error)return callback(error);try{for(const a of addresses)checkDialAddress(a.address);}catch(e){return callback(e);}
    if(options?.all)return callback(null,addresses);const a=addresses[0];if(!a)return callback(new Error("DNS returned empty address"));callback(null,a.address,a.family);
  });
}) as typeof lookup;
interface Response {status:number;location?:string;body:Buffer;}
function once(method:string,u:URL,headers:Record<string,string>,body:Buffer|undefined,signal:AbortSignal):Promise<Response>{
  return new Promise((resolve,reject)=>{
    const host=u.hostname.replace(/^\[|\]$/g,'');
    // Literal addresses bypass DNS lookup in Node and must also be checked.
    if(isIP(host))try{checkDialAddress(host);}catch(e){reject(e);return;}
    let agent:ReturnType<typeof proxyAgent>|undefined,proxy:string;try{proxy=notificationProxy(u);if(proxy){const p=new URL(proxy),host=p.hostname.replace(/^\[|\]$/g,'');if(isIP(host))checkDialAddress(host);agent=proxyAgent(p.protocol==='socks5:'?proxy.replace(/^socks5:/,'socks5h:'):proxy,u.protocol==='https:',{lookup:guardedLookup,signal,timeout:10000});}}catch(e){reject(e);return;}
    const gzip=method!=='HEAD'&&!Object.keys(headers).some(k=>['accept-encoding','range'].includes(k.toLowerCase())),outgoing=gzip?{...headers,'Accept-Encoding':'gzip'}:headers;
    const req=(u.protocol==='https:'?httpsRequest:httpRequest)(u,{method,headers:outgoing,lookup:guardedLookup,signal,timeout:10000,agent},res=>{
      const chunks:Buffer[]=[];let size=0,done=false;
      const stream=gzip&&res.headers['content-encoding']==='gzip'?res.pipe(createGunzip()):res;
      const cleanup=()=>{agent?.destroy();};
      const finish=()=>{if(done)return;done=true;cleanup();resolve({status:res.statusCode??0,location:res.headers.location,body:Buffer.concat(chunks,size)});};
      stream.on('data',(b:Buffer)=>{const chunk=b.subarray(0,8192-size);chunks.push(chunk);size+=chunk.length;if(size>=8192){finish();stream.destroy();res.destroy();}});stream.on('end',finish);stream.on('error',e=>{if(!done){done=true;cleanup();reject(e);}});res.on('error',e=>{if(!done){done=true;stream.destroy();cleanup();reject(e);}});
    });req.on('timeout',()=>req.destroy(new Error("Connection timeout")));req.on('error',e=>{agent?.destroy();reject(e);});if(body)req.end(body);else req.end();
  });
}
/** Same-host redirect ceiling, finite responses and retry/permanent HTTP split.
 * Caller cancellation and the original 15 s total include all redirect hops. */
export async function notificationHTTP(method:string,url:string,headers:Record<string,string>,body:Buffer|undefined,signal:AbortSignal):Promise<Buffer>{
  let current:URL;try{validateHTTPURL(url);current=new URL(url);}catch(e){throw new PermanentNotificationError(`The request address is illegal: ${redact(url)} (${(e as Error).message})`);}
  const originalHost=current.host,deadline=AbortSignal.any([signal,AbortSignal.timeout(15000)]);let hops=0;
  const hdr={...headers};if(body&&!Object.keys(hdr).some(k=>k.toLowerCase()==='content-type'))hdr['Content-Type']='application/json; charset=utf-8';
  for(;;){let result:Response;try{result=await once(method,current,hdr,body,deadline);}catch(e){throw new Error(`Request failed: ${method} ${current.host}: ${redactText((e as Error).message)}`);}
    if([301,302,303,307,308].includes(result.status)&&result.location){if(++hops>=5)throw new Error("Request failed: Too many redirects");let next:URL;try{next=new URL(result.location,current);}catch{throw new Error("Request failed: Redirect address cannot be resolved");}if(next.host!==originalHost)throw new Error(`Request failed: Cross-host redirect denied (${originalHost} → ${next.host}）`);if(!['http:','https:'].includes(next.protocol))throw new Error("Request failed: Redirect protocol not supported");if([301,302,303].includes(result.status)&&method!=='GET'&&method!=='HEAD'){method='GET';body=undefined;}current=next;continue;}
    const snippet=oneLine(result.body.toString(),200);
    if(result.status>=200&&result.status<300)return result.body;
    if(result.status===429||result.status===408)throw new Error(`The other party's current limit or timeout (HTTP ${result.status}): ${snippet}`);
    if(result.status>=500)throw new Error(`The other party's service is abnormal (HTTP ${result.status}): ${snippet}`);
    throw new PermanentNotificationError(`Request rejected by the other party (HTTP ${result.status}): ${snippet}`);
  }
}
