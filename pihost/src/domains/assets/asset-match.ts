import {isIP} from 'node:net';
import {RE2JS} from 're2js';
export interface AssetRule {kind:string;pattern:string;note?:string;enabled:boolean;action?:string;[key:string]:unknown}
export const goTrim=(text:string)=>text.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,'');
const lower=(s:string)=>Array.from(s,c=>c==='\u0130'?'i':c.toLowerCase()).join('');
function ipNumber(ip:string):{value:bigint;bits:32|128}|null{
 if(ip.includes("%"))return null;
 const version=isIP(ip);if(!version)return null;
 const v4=(s:string)=>s.split('.').reduce((a,v)=>(a<<8n)+BigInt(v),0n);
 if(version===4)return {value:v4(ip),bits:32};
 if(ip.includes('.')){const i=ip.lastIndexOf(':');const v=v4(ip.slice(i+1));ip=ip.slice(0,i+1)+(v>>16n).toString(16)+':'+(v&65535n).toString(16);}
 const [head,tail]=ip.split('::'),left=head?head.split(':'):[],right=tail?tail.split(':'):[];
 const groups=tail===undefined?left:[...left,...Array(8-left.length-right.length).fill('0'),...right];
 const value=groups.reduce((a,g)=>(a<<16n)+BigInt('0x'+g),0n);
 return {value,bits:128};
}
export function validCIDR(raw:string):boolean{const [ip,prefix,...rest]=raw.split('/');const parsed=ipNumber(ip??'');return !!parsed&&rest.length===0&&prefix!==undefined&&/^\d+$/.test(prefix)&&Number(prefix)<=parsed.bits;}
export function containsCIDR(raw:string,value:string):boolean{
 if(!validCIDR(raw))return false;
 const [address,prefix]=raw.split('/');let base=ipNumber(address!)!,candidate=ipNumber(goTrim(value));if(!candidate)return false;
 let mask=Number(prefix);const mapped=(v:bigint)=>(v>>32n)===65535n;
 // Go net.IPNet.Contains always calls To4 on mapped candidates and derives
 // a 32-bit mask only when the entire mapped IPv4 prefix is masked in.
 if(candidate.bits===128&&mapped(candidate.value))candidate={value:candidate.value&0xffffffffn,bits:32};
 if(base.bits===128&&mapped(base.value)&&mask>=96){base={value:base.value&0xffffffffn,bits:32};mask-=96;}
 if(base.bits!==candidate.bits)return false;
 const shift=BigInt(base.bits-mask);return base.value>>shift===candidate.value>>shift;
}
export function assetRuleMatches(kind:string,pattern:string,type:string,value:string):boolean{
 const p=goTrim(pattern);if(!p)return false;
 switch(kind){
  case 'exact_domain':return type==='domain'&&RE2JS.compile(RE2JS.quote(p),RE2JS.CASE_INSENSITIVE).matcher(goTrim(value)).matches();
  case 'exact_ip':return type==='ip'&&goTrim(value)===p;
  case 'exact_url':return type==='url'&&goTrim(value)===p;
  case 'fuzzy_domain':return type==='domain'&&value!==''&&lower(value).includes(lower(p));
  case 'fuzzy_url':return type==='url'&&value!==''&&lower(value).includes(lower(p));
  case 'fuzzy_ip':return type==='ip'&&value!==''&&value.includes(p);
  case 'cidr':return type==='ip'&&containsCIDR(p,value);
  // Compatibility for rows persisted by early target slices, unavailable to
  // new public requests. Keep their historical interpretation explicit.
  case 'exact_cidr':return type==='ip'&&containsCIDR(p,value);
  case 'domain':return type==='domain'&&(lower(goTrim(value))===lower(p)||lower(goTrim(value)).endsWith('.'+lower(p)));
  case 'ip':return type==='ip'&&lower(goTrim(value))===lower(p);
  case 'url':return type==='url'&&lower(goTrim(value)).includes(lower(p));
  default:return false;
 }
}
const labels:Record<string,string>={exact_domain:"Domain name (congruent)",exact_ip:"IP (congruent)",exact_url:"URL (congruent)",fuzzy_domain:"Domain name (fuzzy)",fuzzy_ip:"IP (blurred)",fuzzy_url:"URL (blurred)",cidr:"CIDR segment"};
export function assetRuleReason(rule:AssetRule):string{return "Hit asset interception rule ["+(labels[rule.kind]??rule.kind)+': '+rule.pattern+']'+(goTrim(rule.note??'')?'（'+goTrim(rule.note??'')+'）':'');}
export function validateAssetRule(input:Record<string,unknown>,task=false):string|undefined{
 for(const key of ['enabled','kind','pattern','note',...(task?['action']:[])])if(input[key]!=null&&typeof input[key]!== (key==='enabled'?'boolean':'string')){const type=Array.isArray(input[key])?'array':typeof input[key]==='object'?'object':typeof input[key];return 'json: cannot unmarshal '+type+' into Go struct field '+(task?'taskInterceptRuleReq.':'assetInterceptRuleReq.')+key+' of type '+(key==='enabled'?'bool':'string');}

 if(task&&input.action!==undefined&&input.action!==null&&input.action!==''&&input.action!=='block'&&input.action!=='allow')return "action must be block or allow";
 const pattern=goTrim(String(input.pattern??'')),kind=String(input.kind??'');if(!pattern)return "pattern cannot be empty";
 if(['exact_domain','exact_url','fuzzy_domain','fuzzy_ip','fuzzy_url'].includes(kind))return;
 if(kind==='exact_ip')return isIP(pattern)&&!pattern.includes('%')?undefined:"exact_ip is not a valid IP address:"+pattern;
 if(kind==='cidr')return validCIDR(pattern)?undefined:"cidr is not a valid network segment (like 192.168.0.0/16):"+pattern;
 return "kind is invalid:"+kind;
}
