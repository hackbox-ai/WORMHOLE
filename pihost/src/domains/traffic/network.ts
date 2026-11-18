import {currentNetwork,taskNetworkScope} from '../network/context.ts';
import {HttpProxyAgent} from 'http-proxy-agent';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {SocksProxyAgent} from 'socks-proxy-agent';
import {request as httpRequest,type IncomingHttpHeaders} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {checkServerIdentity,type PeerCertificate} from 'node:tls';
import {readFileSync} from 'node:fs';
import {decodeTargetBody,decodeTargetBytes} from './decode.ts';
import {randomUUID} from 'node:crypto';
import {CONTEXT_HEADER,issueCapture,revokeCapture,type CaptureContext} from './context.ts';
import type {CapturedExchange} from './store.ts';
export interface TargetRoute {reverseProxyId?:string;proxy:string;caFile:string;capture?:{record(x:CapturedExchange):string;receipt(requestId:string,view:string):string|undefined}}
let resolver:()=>TargetRoute=()=>({proxy:'',caFile:''});
export function bindTargetRoute(fn:(()=>TargetRoute)|null){resolver=fn??(()=>({proxy:'',caFile:''}));}
export function targetRoute():TargetRoute{
 const scoped=currentNetwork();
 if(scoped?.mode==='jump'){if(!scoped.taskId||!scoped.route)throw new Error("Springboard mode needs to be associated with test tasks");return scoped.route;}
 return resolver();
}
export function validateGlobalProxy(raw:string):string|null{
  raw=raw.trim();if(!raw)return null;
  const scheme=/^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw)?.[1]??'';
  if(!scheme)return `Agent ${JSON.stringify(raw)} Missing protocol (usehttp://、https://or socks5://)`;
  if(!['http','https','socks5'].includes(scheme))return `Unsupported proxy protocol ${JSON.stringify(scheme)}(use http, https or socks5)`;
  if(!raw.startsWith(scheme+'://')||!raw.slice(scheme.length+3).split(/[/?#]/)[0])return `Agent ${JSON.stringify(raw)} Missing host address`;
  try{const u=new URL(raw);if(!u.hostname)return `Agent ${JSON.stringify(raw)} Missing host address`;}catch{return `Resolve proxy address ${JSON.stringify(raw)}: Invalid proxy address`;}
  return null;
}
export function proxyAgent(proxy:string,secure:boolean,options:Record<string,unknown>={}){
  const u=new URL(proxy);if(['socks5:','socks5h:','socks:'].includes(u.protocol))return new SocksProxyAgent(u,options);
  if(!['http:','https:'].includes(u.protocol))throw new Error('unsupported upstream proxy protocol');
  return secure?new HttpsProxyAgent(u,options):new HttpProxyAgent(u,options);
}
export function targetEnvironment():NodeJS.ProcessEnv{
  const {proxy,caFile}=targetRoute();if(!proxy)return{};
  return{http_proxy:proxy,HTTP_PROXY:proxy,https_proxy:proxy,HTTPS_PROXY:proxy,all_proxy:proxy,ALL_PROXY:proxy,
    no_proxy:'',NO_PROXY:'',...(caFile?{SSL_CERT_FILE:caFile,CURL_CA_BUNDLE:caFile,REQUESTS_CA_BUNDLE:caFile,NODE_EXTRA_CA_CERTS:caFile}:{})};
}
/** Only target traffic uses this route. Provider/DB/notification transports never inherit it. */
/** The original response can only receive this many bytes: ordinary detection should not read the entire installation package into memory。 */
const MAX_RAW_RESPONSE_BYTES=16*1024*1024;

export async function targetRequest(url:string,method:string,body:string|undefined,signal:AbortSignal,proxyOverride?:string,context?:Omit<CaptureContext,'requestId'|'view'>,headers:Record<string,string>={},routeOverride?:TargetRoute):Promise<{status:number;headers:IncomingHttpHeaders;body:string;bytes:Buffer;request_id?:string;capture_id?:string;wire_capture_id?:string;truncated?:boolean;undecoded?:boolean;decode_error?:string}>{
  const scoped=(context?.taskId?await taskNetworkScope(context.taskId):undefined)??currentNetwork();
  if(scoped?.mode==='jump'&&!scoped.route)throw new Error("The springboard task cannot currently initiate network access");
  const u=new URL(url),route=routeOverride??scoped?.route??targetRoute(),proxy=proxyOverride||route.proxy,tls=route.caFile?{ca:readFileSync(route.caFile),checkServerIdentity:(_host:string,cert:PeerCertificate)=>checkServerIdentity(u.hostname.replace(/^\[|\]$/g,''),cert)}:{},agent=proxy&&!proxyOverride?proxyAgent(proxy,u.protocol==='https:',tls):false;
  const requestId=randomUUID(),wire:CaptureContext={...context,requestId,view:'wire',reverse:!!proxyOverride};
  const ticket=route.capture&&context?.taskId?issueCapture(wire):'';
  const outgoing={'user-agent':'WORMHOLE-SecurityTest/1.0',...headers,...(body!==undefined?{'content-length':String(Buffer.byteLength(body))}:{}),...(ticket?{[CONTEXT_HEADER]:ticket}:{})};
  try{return await new Promise((resolve,reject)=>{
    // Managed crypto proxies consume an absolute URI, including HTTPS targets; CONNECT would hide the plaintext.
    const send=proxyOverride?httpRequest:u.protocol==='https:'?httpsRequest:httpRequest;
    const req=send(proxyOverride?new URL(proxyOverride):u,{method,...(proxyOverride?{path:u.href,agent:false}:{agent,...tls}),signal,headers:outgoing},res=>{
      const chunks:Buffer[]=[];let size=0,truncated=false;
      res.on('data',(c:Buffer)=>{
        if(size+c.length>MAX_RAW_RESPONSE_BYTES){
          truncated=true;const room=Math.max(0,MAX_RAW_RESPONSE_BYTES-size);
          if(room>0)chunks.push(c.subarray(0,room));
          size=MAX_RAW_RESPONSE_BYTES;
          // That’s enough: actively stop receiving to avoid reading the large packet
          res.removeAllListeners('data');res.destroy();
          deliver();               // destroy After end will not be triggered again, and the restricted prefix will be returned directly here
          return;
        }
        size+=c.length;chunks.push(c);
      });
      // Active truncation session destroy Stream，end Will not trigger again: the ending must be done only once and called directly from the truncated branch
      let settled=false;
      const deliver=()=>{if(settled)return;settled=true;try{
        if(res.headers['x-wormhole-network-error'])throw new Error(decodeURIComponent(String(res.headers['x-wormhole-network-error'])));
        const raw=Buffer.concat(chunks),encoding=String(res.headers['content-encoding']??'');
        let bytes: Buffer<ArrayBufferLike> = raw,text='',undecoded=false,decodeError:string|undefined;
        if(truncated&&encoding){
          // The truncated compressed stream is inherently incomplete, and decompression will only result in an incomprehensible error.
          undecoded=true;
        }else{
          try{bytes=decodeTargetBytes(raw,encoding);text=decodeTargetBody(bytes,'',String(res.headers['content-type']??''));}
          catch(e){undecoded=true;decodeError=String((e as Error)?.message??e).slice(0,200);}
        }
        const status=res.statusCode??0,wireId=route.capture?.receipt(requestId,'wire');let plainId:string|undefined;
        if(proxyOverride&&route.capture&&context?.taskId&&!wireId)throw new Error("The reverse request has not gone through MITM and cannot be used as collected inspection evidence; please check the adapter and routing");
        if(proxyOverride&&route.capture&&context?.taskId)plainId=route.capture.record({url,method,status,requestType:headers['content-type']??'',contentType:String(res.headers['content-type']??''),reqHead:method+' '+u.pathname+u.search+'\n'+Object.entries(outgoing).filter(([k])=>k!==CONTEXT_HEADER).map(([k,v])=>k+': '+v).join('\n'),respHead:'HTTP '+status+'\n'+Object.entries(res.headers).map(([k,v])=>k+': '+v).join('\n'),reqBody:Buffer.from(body??''),respBody:bytes,context:{...wire,view:'plaintext'}});
        resolve({status,headers:res.headers,body:text,bytes,request_id:requestId,capture_id:plainId??wireId,wire_capture_id:wireId,
          ...(truncated?{truncated:true}:{}),...(undecoded?{undecoded:true}:{}),...(decodeError?{decode_error:decodeError}:{})});
      }catch(e){reject(e);}};   // settled has been set at the entrance. It is directly rejected here and can no longer be blocked by conditions.
      res.on('error',e=>{if(settled)return;settled=true;reject(e);});
      res.on('end',deliver);
    });req.on('error',reject);req.end(body);
  });}finally{if(agent)agent.destroy();if(ticket)revokeCapture(ticket);}
}
