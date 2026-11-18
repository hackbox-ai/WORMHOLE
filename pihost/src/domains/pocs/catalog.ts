import {createHash} from 'node:crypto';
import {parseDocument} from 'yaml';

export const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
export function canonical(v:unknown):string {
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';
 return JSON.stringify(v)??'null';
}
export const productKey=(v:string)=>v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export function resolveAliases(aliases:Record<string,string>){
 const resolved:Record<string,string>={};for(const key of Object.keys(aliases)){let value=aliases[key]!;const seen=new Set([key]);while(aliases[value]&&aliases[value]!==value){if(seen.has(value))throw new Error("Product aliases cannot form a loop");seen.add(value);value=aliases[value]!;}resolved[key]=value;}return resolved;
}
type Obj=Record<string,any>;
const strings=(v:unknown):string[]=>Array.isArray(v)?v.flatMap(strings):typeof v==='string'?v.split(',').map(s=>s.trim()).filter(Boolean):[];
const text=(v:unknown)=>typeof v==='string'?v: v==null?'':JSON.stringify(v);
// PostgreSQL text/jsonb cannot contain NUL or unpaired surrogates. The unchanged
// upstream bytes remain in the source manifest; display fields use explicit escapes.
const postgresSafe=(v:any):any=>typeof v==='string'?Buffer.from(v).toString('utf8').replaceAll('\0','\\u0000'):Array.isArray(v)?v.map(postgresSafe):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[postgresSafe(k),postgresSafe(x)])):v;
export interface RawEntry {native_id:string;raw:string;metadata?:Obj}
export interface ImportDocument {format:'wormhole-poc-source-v1';key:string;title:string;type:'legacy-python'|'nuclei';provenance:Obj;entries:RawEntry[]}
export interface Entry {
 id:string;revision_id:string;source_key:string;native_id:string;content_hash:string;title:string;products:string[];cves:string[];
 severity:string;kind:string;description:string;conditions:string;refs:string[];requirements:string[];diagnostics:string[];raw:string;metadata:Obj;
}
const generic=new Set('http network tcp dns ssl cve cnvd vuln vulnerabilities tech detect detection exposure misconfig misconfiguration defaultlogin file fuzzing dast intrusive rce sqli xss lfi ssrf oob token cloud aws azure headless javascript discovery audit hardening panel config status disclosure bypass install installer logs backup login auth authenticated unauthenticated'.split(' '));
export function normalizeEntry(source:Pick<ImportDocument,'key'|'type'>,raw:RawEntry,revision:string):Entry {
 if(!raw||typeof raw.native_id!=='string'||!raw.native_id.trim()||raw.native_id.length>512||typeof raw.raw!=='string'||Buffer.byteLength(raw.raw)>16*1024*1024)throw new Error("Invalid entry ID or body (maximum 16 MiB per entry)");
 const diagnostics:string[]=[],requirements:string[]=[];let data:Obj=raw.metadata??{},products:string[]=[],cves:string[]=[],kind='vulnerability',title='',description='',conditions='',refs:string[]=[],severity='unknown',productBasis='legacy-registry/cms';
 if(source.type==='nuclei'){
  const document=parseDocument(raw.raw,{uniqueKeys:true});if(document.errors.length)throw new Error("YAML parsing failed: "+document.errors[0]!.message.slice(0,200));
  data=document.toJS({maxAliasCount:50})??{};if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.id!=='string')throw new Error("Nuclei template is missing id");
  const info=data.info??{},meta=info.metadata??{},classification=info.classification??{};
  title=text(info.name)||data.id;description=text(info.description);severity=text(info.severity).toLowerCase()||'unknown';refs=strings(info.reference);
  cves=strings(classification['cve-id']);const cpes=strings(classification.cpe);products=[...strings(meta.product),...cpes.flatMap(c=>{const p=c.split(':');return p[0]==='cpe'&&p[1]==='2.3'&&p[4]&&!['*','-'].includes(p[4])?[p[4]]:[]})];
  productBasis='metadata/cpe';if(!products.length){productBasis='tags';products=strings(info.tags).filter(t=>!generic.has(productKey(t))&&!/^cve[-_]?\d|^cnvd[-_]?\d|^cwe[-_]?\d|^\d{4}$/i.test(t));diagnostics.push("Product association comes from template tag, specific components, deployment roles and prerequisites must be verified");}
  conditions=text(meta['affected-versions']??meta['affected_versions']??'');
  if(!conditions&&cpes.length)conditions="CPE (source information only, version applicability needs to be checked):"+cpes.join(', ');
  if(data.workflows){kind='workflow';requirements.push('workflow');}
  else if(/(^|\/)technologies\//.test(raw.native_id)||strings(info.tags).some(t=>['tech','detect','technology'].includes(t)))kind='technology';
  for(const key of ['code','javascript','headless','network','tcp','dns','ssl','file','flow'])if(data[key])requirements.push(key);
  if(/interactsh|interact\.sh|interactsh-url/i.test(raw.raw))requirements.push('oob');
  if(data.http||data.requests)requirements.push('http');
  if(strings(info.tags).some(t=>['intrusive','dos','fuzz','fuzzing','bruteforce'].includes(t)))requirements.push('intrusive');
  if(!products.length)diagnostics.push("Missing product identifier that can be reliably associated, explicit retrieval only");
 }else{
  const catalog=data.catalog??{},registry=data.registry??{};
  products=[...strings(registry.product),...(Array.isArray(catalog.targetOptions)?catalog.targetOptions.flatMap((o:Obj)=>strings(o.cms)):[])];
  cves=[...strings(registry.cves),...strings(catalog.vulnNumber?.CVE)];title=text(catalog.name)||raw.native_id;description=text(catalog.desc);
  severity=text(catalog.level??registry.level).toLowerCase()||'unknown';conditions=text(catalog.impactVersion);refs=strings(catalog.refers);
  requirements.push('python-legacy',...strings(registry.unsupported));
  diagnostics.push(registry.unsupported?.length?"Old adapter tag dependency is not supported":"Old registry static tag is runnable without verification by new WORMHOLE execution");
 }
 if(!conditions)diagnostics.push("The source does not provide a structured applicable version; this should not be used to determine whether the version is affected");
 products=[...new Set(products.map(productKey).filter(p=>p.length>=2&&p.length<=160))];
 cves=[...new Set([...cves,...(raw.native_id.match(/CVE-\d{4}-\d{4,}/gi)??[])].map(x=>x.toUpperCase()))];
 const hash=digest(raw.raw),id=digest(canonical([revision,source.key,raw.native_id,hash,raw.metadata??{}]));
 return postgresSafe({id,revision_id:revision,source_key:source.key,native_id:raw.native_id,content_hash:hash,title,products,cves,severity,kind,description,conditions,refs,requirements:[...new Set(requirements)],diagnostics,raw:raw.raw,metadata:source.type==='legacy-python'?data:{filename:raw.native_id,product_basis:productBasis,solution:data.info?.remediation??'',metadata:data.info?.metadata??{},classification:data.info?.classification??{},tags:data.info?.tags??[]}}) as Entry;
}

export function quarantineEntry(source:string,raw:RawEntry,revision:string,reason:string):Entry {
 const hash=digest(raw.raw);
 return postgresSafe({id:digest(canonical([revision,source,raw.native_id,hash,raw.metadata??{}])),revision_id:revision,source_key:source,native_id:raw.native_id,content_hash:hash,title:raw.native_id,products:[],cves:[],severity:'unknown',kind:'unparsed',description:"The source entry has not passed static analysis. It is only for viewing the original text and does not participate in automatic association.",conditions:"Parsing failed, applicable conditions are unknown",refs:[],requirements:['unparsed'],diagnostics:[reason],raw:raw.raw,metadata:raw.metadata??{}}) as Entry;
}

/** Only explicitly configured numeric constraints are decisive. Unparsed text stays unknown. */
export function versionApplicability(version:string,range:string):'matched'|'excluded'|'unknown' {
 if(!range.trim()||!/^\d+(?:\.\d+)*$/.test(version.trim()))return 'unknown';
 const cmp=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){if((x[i]??0)!==(y[i]??0))return (x[i]??0)<(y[i]??0)?-1:1;}return 0;};
 const terms=range.trim().split(/\s+/);let ok=true;
 for(const term of terms){const m=/^(<=|>=|<|>|=)?(\d+(?:\.\d+)*)(\.x)?$/i.exec(term);if(!m)return 'unknown';if(m[3]){if(m[1])return 'unknown';ok=ok&&(version===m[2]||version.startsWith(m[2]+'.'));continue;}
  const n=cmp(version,m[2]!);ok=ok&&({'<':n<0,'>':n>0,'<=':n<=0,'>=':n>=0,'=':n===0}[m[1]??'=']??false);
 }return ok?'matched':'excluded';
}
export function validRange(range:string){return !range||versionApplicability('1.0',range)!=='unknown';}
