import {isIP} from 'node:net';
import {domainToASCII} from 'node:url';
import {getPublicSuffix} from 'tldts';
export interface ScopeInput{kind?:string;value:string}
export interface ParsedScope{kind:string;domain?:string;net?:string;value?:string;raw:string}
const trim=(v:string)=>v.trim(),normalizeKeyword=(v:string)=>trim(v).toLowerCase().replace(/\s+/gu,' ');
export const normalizeICP=(v:string)=>trim(v).toLowerCase().replace(/\s+/gu,'');
export const companyNKey=normalizeKeyword;
function lookingIP(v:string){if(v.includes('://')||/\s/u.test(v))return false;if(v.split(':').length>=3){const parts=v.split(':');let valid=0;for(const part of parts){if(!part){if(valid||v.startsWith('::'))return true;continue;}if(!/^[a-f\d]{1,4}$/i.test(part))return false;if(++valid>=2)return true;}return false;}return v.includes('.')&&/^[\d.]+$/.test(v);}
function ipCIDR(raw:string):string|null{const ver=isIP(raw);return ver?`${raw}/${ver===4?32:128}`:null;}
function strict(raw:string):ParsedScope{
 const r:ParsedScope={kind:'',raw};if(!raw)throw new Error("Blank line");
 const slash=raw.lastIndexOf('/'),address=raw.slice(0,slash),prefix=raw.slice(slash+1),ver=isIP(address);
 if(slash>0&&ver&&/^\d+$/.test(prefix)&&Number(prefix)<=(ver===4?32:128)){
  if(Number(prefix)<(ver===4?16:32))throw new Error(`The network segment is too wide (IPv${ver} Requires >= /${ver===4?16:32}): ${raw}`);
  return {...r,kind:'cidr',net:`${address}/${Number(prefix)}`};
 }
 const net=ipCIDR(raw);if(net)return {...r,kind:'ip',net};
 let host='';try{const parsed=new URL(raw.startsWith('//')?`http:${raw}`:raw.includes('://')?raw:`http://${raw}`);host=parsed.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'');}catch{throw new Error(`Unrecognized as a valid domain name/IP/CIDR: ${raw}`);}
 const hostnet=ipCIDR(host);if(hostnet)return {...r,kind:'ip',net:hostnet};
 host=domainToASCII(host).toLowerCase();
 if(lookingIP(host))throw new Error(`Invalid IP: ${raw}`);
 if(host.length>253||host.split('.').length<2||host.split('.').some(p=>!p||p.length>63||!/^([a-z\d]|[a-z\d][a-z\d-]*[a-z\d])$/.test(p)))throw new Error(`Unrecognized as a valid domain name/IP/CIDR: ${raw}`);
 if(raw.includes('-')&&raw.split('.').length-1>=6)throw new Error(`Please use CIDR to represent the IP segment (such as 1.2.3.0/24): ${raw}`);
 // Original rejects ICANN suffixes, while allowing private PSL domains.
 if(getPublicSuffix(host,{allowPrivateDomains:false})===host)throw new Error(`Cannot use naked TLD as scope: ${raw}`);
 return {...r,kind:'domain',domain:host};
}
export function parseScope(input:ScopeInput):ParsedScope{
 const kind=(input.kind??'').trim().toLowerCase(),raw=input.value.trim();
 if(kind){if(['domain','ip','cidr'].includes(kind)){const result=strict(raw);if(result.kind!==kind)throw new Error(`"${raw}" is not valid ${kind} Scope`);return result;}
  if(kind==='icp'||kind==='keyword'){const value=kind==='icp'?normalizeICP(raw):normalizeKeyword(raw);if(!value)throw new Error(kind==='icp'?"ICP cannot be empty":"Enterprise keyword cannot be empty");return {kind,value,raw};}
  throw new Error(`Unsupported range type: ${kind}`);
 }
 if(!raw)throw new Error("Blank line");const slash=raw.lastIndexOf('/');
 if(slash>0&&(isIP(raw.slice(0,slash))||lookingIP(raw.slice(0,slash)))){if(!/^\d+$/.test(raw.slice(slash+1))||Number(raw.slice(slash+1))>(isIP(raw.slice(0,slash))===4?32:128))throw new Error(`Invalid CIDR: ${raw}`);return strict(raw);}
 if(isIP(raw))return strict(raw);if(lookingIP(raw))throw new Error(`Invalid IP: ${raw}`);
 if(raw.includes('://')||(raw.includes('.')&&!/\s/u.test(raw)))return strict(raw);
 return parseScope({kind:!/[.．。]/.test(raw)&&(/icp/i.test(raw)||raw.includes("Filing"))?'icp':'keyword',value:raw});
}
export function scopeInputs(raw:unknown):ScopeInput[]{
 if(raw===undefined||raw===null)return [];if(!Array.isArray(raw))throw new Error('scope must be an array');
 return raw.map((item,i)=>{if(typeof item==='string'||item===null)return {value:item??''};if(typeof item!=='object'||Array.isArray(item)||typeof(item.value??'')!=='string'||typeof(item.kind??'')!=='string')throw new Error(`scope[${i}] must be a string or {kind,value}`);return {kind:item.kind??'',value:item.value??''};});
}
export function parseScopes(inputs:ScopeInput[]){const rules:ParsedScope[]=[],errors:string[]=[];
 for(const [i,input] of inputs.entries()){if([...input.value].length>1024)throw new Error(`Enterprise Scope No. ${i+1} Original value too long: 1024 characters maximum`);}
 for(const input of inputs){try{rules.push(parseScope(input));}catch(e){errors.push(`${input.value}: ${(e as Error).message}`);}}
 return {rules,invalid:errors.length,errors};
}
