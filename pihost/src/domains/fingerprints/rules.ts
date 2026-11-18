import {createHash} from 'node:crypto';
import {parse,stringify} from 'yaml';
export const FAMILIES=['ehole','goby','wappalyzer','fingers','fingerprinthub','arl'] as const;
export type Family=typeof FAMILIES[number];
export interface FingerprintRule{id:string;family:Family;name:string;raw:Record<string,unknown>}
export interface Diagnostic{id:string;status:'ready'|'partial'|'unsupported';reason?:string}
export interface FingerprintMatch{rule_id:string;family:Family;product:string;version?:string;locations:string[];evidence:string;state:string}
export const sha256=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export function canonical(v:unknown):string{if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';return JSON.stringify(v)??'null';}
export function familyValue(raw:unknown):Family{if(!FAMILIES.includes(raw as Family))throw new Error("Unknown fingerprint database");return raw as Family;}
export function importRules(family:Family,document:unknown):FingerprintRule[]{
 const parsed=typeof document==='string'?(family==='arl'?parse(document,{maxAliasCount:0}):JSON.parse(document)):document;
 if(parsed&&typeof parsed==='object'&&(parsed as Record<string,unknown>).format==='wormhole-fingerprint-rules-v1'){
  const bundle=parsed as {family:unknown;rules:FingerprintRule[]};if(bundle.family!==family||!Array.isArray(bundle.rules)||bundle.rules.length>50000)throw new Error("Fingerprint package source does not match or there are too many rules");
  return [...new Map(bundle.rules.flatMap(r=>importRules(family,family==='ehole'?{fingerprint:[r.raw]}:family==='wappalyzer'?{apps:{[r.name]:r.raw}}:[r.raw])).map(r=>[r.id,r])).values()];
 }
 let items:unknown[];
 if(family==='ehole')items=(parsed as {fingerprint?:unknown[]})?.fingerprint??[];
 else if(family==='wappalyzer'){const apps=(parsed as {apps?:Record<string,unknown>})?.apps;if(!apps||typeof apps!=='object'||Array.isArray(apps))throw new Error("Wappalyzer requires apps object");items=Object.entries(apps).map(([name,raw])=>({...(raw as object),name}));}
 else items=parsed as unknown[];
 if(!Array.isArray(items)||!items.length||items.length>50000)throw new Error("Fingerprint file must contain 1–50000 rules");
 return [...new Map(items.map(item=>{if(!item||typeof item!=='object'||Array.isArray(item))throw new Error("Fingerprint rules must be objects");const raw={...(item as Record<string,unknown>)};
  const value=family==='ehole'?raw.cms:family==='fingerprinthub'?(raw.info as Record<string,unknown>)?.name:raw.name;const name=typeof value==='string'?value.trim():'';if(!name||name.length>500)throw new Error("Fingerprint name cannot be empty or exceed 500 characters");
  if(family==='wappalyzer')delete raw.name;
  if(family==='goby'&&(typeof raw.logic!=='string'||!Array.isArray(raw.rule)))throw new Error("Goby requires logic and rule");
  if(family==='fingers'&&!Array.isArray(raw.rule))throw new Error("Fingers requires rule array");
  if(family==='fingerprinthub'&&(!raw.id||!Array.isArray(raw.http)))throw new Error("FingerPrintHub requires id and http");
  if(family==='arl'&&typeof raw.rule!=='string')throw new Error("ARL requires rule expression");
  if(family==='ehole'&&(!Array.isArray(raw.keyword)||!raw.method||!raw.location))throw new Error("EHole is missing method/location/keyword");
  const id=sha256(canonical({family,name,raw}));return [id,{id,family,name,raw}] as const;
 })).values()];
}
export function exportRules(family:Family,rules:FingerprintRule[]):unknown{
 if(family==='ehole')return {fingerprint:rules.map(r=>r.raw)};
 if(family==='wappalyzer')return {apps:Object.fromEntries(rules.map(r=>[r.name,r.raw]))};
 return rules.map(r=>r.raw);
}
export function serializeRules(family:Family,rules:FingerprintRule[]):string{const data=exportRules(family,rules);return family==='arl'?stringify(data):JSON.stringify(data,null,2);}
