import {BlockList,isIP} from 'node:net';
import {domainToASCII} from 'node:url';
export type NotificationProxyResolver=(url:URL)=>string;
/** Follow Go standard-library ProxyFromEnvironment semantics. Uppercase
 * variables take priority; ALL_PROXY and WORMHOLE's global proxy
 * are intentionally unrelated. Snapshot once, like Go's environmentProxyFunc. */
export function environmentProxy(env:NodeJS.ProcessEnv):NotificationProxyResolver{
 const http=env.HTTP_PROXY||env.http_proxy||'',https=env.HTTPS_PROXY||env.https_proxy||'',no=env.NO_PROXY||env.no_proxy||'',cgi=!!env.REQUEST_METHOD;
 const parse=(raw:string)=>{if(!raw)return '';try{return new URL(raw).host?new URL(raw).href:new URL('http://'+raw).href;}catch{try{return new URL('http://'+raw).href;}catch{return '';}}};
 const proxies={http:parse(http),https:parse(https)},loopback=new BlockList();loopback.addSubnet('127.0.0.0',8,'ipv4');loopback.addAddress('::1','ipv6');
 const rules=no.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).map(raw=>{
  if(raw==='*')return {all:true};
  const cidr=raw.match(/^(.+)\/(\d+)$/);if(cidr){const family=isIP(cidr[1]!),bits=Number(cidr[2]);if(family&&bits>=0&&bits<=(family===4?32:128)){const block=new BlockList();block.addSubnet(cidr[1]!,bits,family===4?'ipv4':'ipv6');return {block};}}
  let host=raw,port='';const split=raw.match(/^\[([^\]]+)\]:(.*)$/)??raw.match(/^([^:]*):(.*)$/);if(split){host=split[1]!;port=split[2]!;if(!host)return {ignore:true};}
  if(isIP(host)){const block=new BlockList();block.addAddress(host,isIP(host)===4?'ipv4':'ipv6');return {block,port};}
  if(host.startsWith('*.'))host=host.slice(1);const exact=!host.startsWith('.');if(exact)host='.'+host;return {host:domainToASCII(host)||host,port,exact};
 });
 return u=>{const proxy=u.protocol==='http:'?proxies.http:u.protocol==='https:'?proxies.https:'';if(!proxy)return '';if(u.protocol==='http:'&&cgi)throw new Error('refusing to use HTTP_PROXY value in CGI environment; see golang.org/s/cgihttpproxy');
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase(),port=u.port||(u.protocol==='https:'?'443':'80'),family=isIP(host);if(host==='localhost'||family&&loopback.check(host,family===4?'ipv4':'ipv6'))return '';
  for(const rule of rules){if(rule.ignore)continue;if(rule.all)return '';if(rule.port&&rule.port!==port)continue;if(rule.block){if(family&&rule.block.check(host,family===4?'ipv4':'ipv6'))return '';}else if(!family&&rule.host&&(host.endsWith(rule.host)||rule.exact&&host===rule.host.slice(1)))return '';}
  return proxy;
 };
}
let snapshot:NotificationProxyResolver|undefined;
export function notificationProxy(u:URL):string{snapshot??=environmentProxy({...process.env});return snapshot(u);}
