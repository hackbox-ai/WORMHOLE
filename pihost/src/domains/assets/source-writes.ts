/** Eight typed upsert SQL variants with asset normalization and derived writes. */
import type {Pool,PoolClient} from 'pg';
import {isIP} from 'node:net';
import {getDomain} from 'tldts';
import statements from './asset-upsert-sql.json' with {type:'json'};
export interface SourceAssetInput {
  type:string;domain?:string;icp?:string;ip?:string;service_ip?:string;
  bound_domains?:string[];open_ports?:{port:number;service?:string}[];
  record_type?:string;record_value?:string[];bundle_id?:string;app_name?:string;
  category?:string;description?:string;app_icp?:string;company_id?:number|null;
  url?:string;port?:number;service_name?:string;technologies?:string[];
  status_code?:number;content_length?:number;page_title?:string;favicon_mmh3?:string;
  auth?:Record<string,unknown>[];method?:string;params?:Record<string,unknown>[];
  task_id?:number|null;source?:string;
  /** Host-only metadata, overwritten by the tool wrapper. */
  owner_node_id?:number;
}
export const domainKey=(v:string)=>v.trim().toLowerCase().replace(/\.$/,'');
const rootDomain=(host:string)=>{const value=domainKey(host);return isIP(value)?value:getDomain(value,{allowPrivateDomains:true})??value;};
const nullString=(v:unknown)=>v===undefined||v===null||v===''?null:String(v);
const arrayJson=(v:unknown[]|undefined)=>(v??[]).map(value=>JSON.stringify(value));
const normalizeICP=(v:string)=>v.toLowerCase().replace(/\s+/gu,'');
export function normalizeAssetURL(raw:string):string{
  // WHATWG URL removes explicit :80/:443, which Go net/url preserves.
  const match=raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/);
  if(!match)return raw;
  const auth=match[2]!,at=auth.lastIndexOf('@'),authority=at<0?auth.toLowerCase():auth.slice(0,at+1)+auth.slice(at+1).toLowerCase();
  const suffix=match[3]==='/'?'':match[3];return `${match[1]!.toLowerCase()}://${authority}${suffix}`;
}
function parseURL(raw:string){try{const url=new URL(raw);return {domain:url.hostname.replace(/^\[|\]$/g,'').toLowerCase(),port:Number(url.port)||(url.protocol==='https:'?443:url.protocol==='http:'?80:0),service:url.protocol.slice(0,-1).toUpperCase()};}catch{return {domain:'',port:0,service:''};}}
function requireValue(value:unknown,error:string){if(value===undefined||value===null||value==='')throw new Error(error);}

export class SourceAssetWrites {
  constructor(private readonly pool:Pool){}
  async upsert(input:SourceAssetInput):Promise<{asset:Record<string,unknown>;insertedNew:boolean}>{
    const tx=await this.pool.connect();
    try{await tx.query('BEGIN');await tx.query('SELECT pg_advisory_xact_lock($1)',[7337741003]);
      const result=await this.write(tx,input);
      if(input.source==='agent'&&input.task_id){
        if(input.owner_node_id){
          const own=await tx.query('SELECT 1 FROM exploration_nodes n JOIN tasks t ON t.exploration_id=n.exploration_id WHERE n.id=$1 AND t.id=$2 AND t.deleted_at IS NULL',[input.owner_node_id,input.task_id]);
          if(!own.rowCount)throw new Error("Asset anchor must belong to current task");
          await tx.query('INSERT INTO exploration_anchors(node_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.owner_node_id,result.asset.id]);
        }
        await tx.query("UPDATE task_asset_links SET source='agent',source_summary=$3,source_node_id=COALESCE($4,source_node_id),updated_at=now() WHERE task_id=$1 AND asset_id=$2",[input.task_id,result.asset.id,input.owner_node_id?`Worker Intent #${input.owner_node_id} Register via insert_assets`:"Agent registration via insert_assets",input.owner_node_id??null]);
        await this.autoScope(tx,input);
      }
      await tx.query('COMMIT');return result;
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
  }
  private async autoScope(tx:PoolClient,input:SourceAssetInput){
    let kind='',domain='',net='';
    if(['root_domain','subdomain'].includes(input.type)){kind=input.type;domain=domainKey(input.domain??'');if(!domain)return;}
    else if(['service','endpoint'].includes(input.type)){
      domain=domainKey(input.domain||parseURL(input.url??'').domain);
      if(domain&&!isIP(domain))kind='subdomain';else domain='';
    }
    if(!kind&&['service','endpoint','ip'].includes(input.type)){
      const ip=input.service_ip||input.ip;if(ip&&isIP(ip)){kind='ip';net=`${ip}/${isIP(ip)===4?32:128}`;}
    }
    if(kind)await tx.query('INSERT INTO task_scope(task_id,kind,domain,net) VALUES($1,$2,$3,$4::cidr) ON CONFLICT DO NOTHING',[input.task_id,kind,domain||null,net||null]);
  }
  private async company(tx:PoolClient,root:string,ip:string,icp:string):Promise<number|null>{
    if(root){const r=await tx.query("SELECT company_id FROM company_scope WHERE kind='domain' AND domain=$1 ORDER BY length(domain) DESC,company_id LIMIT 1",[root]);if(r.rowCount)return Number(r.rows[0].company_id);}
    if(ip&&isIP(ip)){const r=await tx.query("SELECT company_id FROM company_scope WHERE kind IN ('ip','cidr') AND net >>= $1::inet ORDER BY masklen(net) DESC,company_id LIMIT 1",[ip]);if(r.rowCount)return Number(r.rows[0].company_id);}
    const normalized=normalizeICP(icp);if(normalized){const r=await tx.query("SELECT company_id FROM company_scope WHERE kind='icp' AND value=$1 ORDER BY company_id LIMIT 1",[normalized]);if(r.rowCount)return Number(r.rows[0].company_id);}
    return null;
  }
  private async network(tx:PoolClient,ip:string):Promise<string|null>{return ip?String((await tx.query('SELECT network(set_masklen($1::inet,$2))::cidr::text value',[ip,isIP(ip)===4?24:48])).rows[0].value):null;}
  private async host(tx:PoolClient,domain:string,root:string,input:SourceAssetInput){
    if(root)await this.write(tx,{type:'root_domain',domain:root,task_id:input.task_id});
    if(domain&&domain!==root&&!isIP(domain))await this.write(tx,{type:'subdomain',domain,task_id:input.task_id});
  }
  private async write(tx:PoolClient,input:SourceAssetInput):Promise<{asset:Record<string,unknown>;insertedNew:boolean}>{
    const taskIds=input.task_id&&input.task_id>0?[input.task_id]:[];
    let ip=input.ip??'',domain=domainKey(input.domain??''),root=rootDomain(domain),args:unknown[]=[],sql='',post:()=>Promise<void>=async()=>{};
    if(ip&&!isIP(ip))throw new Error(`invalid asset ip: ip must be an IPv4/IPv6 address, received ${JSON.stringify(ip)}. If this is the host name, please use type=subdomain instead and fill in the domain field; if you really want to register the address, please parse out the A/AAAA record first, and then fill in the ip with the parsed address`);
    switch(input.type){
      case 'root_domain':{
        requireValue(domain,'domain is required');sql=statements.UpsertRootDomain[0]!;
        args=[domain,nullString(input.icp),await this.company(tx,domain,'',input.icp??''),taskIds];break;
      }
      case 'ip':{
        requireValue(ip,'ip is required');sql=statements.UpsertIP[0]!;
        args=[ip,await this.network(tx,ip),input.bound_domains??[],arrayJson((input.open_ports??[]).map(p=>({port:p.port,service:p.service??''}))),await this.company(tx,'',ip,''),taskIds];break;
      }
      case 'subdomain':{
        requireValue(domain,'domain is required');root=rootDomain(domain);
        ip=''; // Source subdomain IP is derived exclusively from A/AAAA records.
        let company=await this.company(tx,root,'',input.icp??'');
        await this.write(tx,{type:'root_domain',domain:root,task_id:input.task_id});
        if(['A','AAAA'].includes(input.record_type??''))for(const value of input.record_value??[])for(const part of value.split(',')){const candidate=part.trim();if(isIP(candidate)){ip=ip||candidate;await this.write(tx,{type:'ip',ip:candidate,bound_domains:[domain],task_id:input.task_id});}}
        if(company===null&&ip)company=await this.company(tx,'',ip,'');
        sql=statements.UpsertSubdomain[0]!;args=[domain,root,input.record_type??'',input.record_value??[],nullString(ip),await this.network(tx,ip),nullString(input.icp),company,taskIds];break;
      }
      case 'app':{
        requireValue(input.app_name,'app name is required');const company=input.company_id??await this.company(tx,'','',input.app_icp??''),source=input.company_id!==undefined&&input.company_id!==null?'explicit':'scope';
        if(input.bundle_id){sql=statements.UpsertApp[0]!;args=[input.bundle_id,input.app_name,nullString(input.category),nullString(input.description),nullString(input.app_icp),company,source,taskIds];}
        else {sql=statements.UpsertApp[1]!;args=[input.app_name,nullString(input.category),nullString(input.description),nullString(input.app_icp),company,source,taskIds];}break;
      }
      case 'service':{
        if(input.url){const url=normalizeAssetURL(input.url),parsed=parseURL(url);domain=parsed.domain;root=rootDomain(domain);ip=input.service_ip||ip;if(ip&&!isIP(ip))throw new Error('invalid asset ip');sql=statements.UpsertHTTPService[0]!;
          args=[url,parsed.service,nullString(domain),nullString(ip),parsed.port||null,root,await this.network(tx,ip),nullString(input.favicon_mmh3),input.technologies??[],input.status_code??null,input.content_length??null,nullString(input.page_title),arrayJson(input.auth),await this.company(tx,root,ip,''),taskIds];
          post=async()=>{await this.host(tx,domain,root,input);if(ip)await this.write(tx,{type:'ip',ip,bound_domains:domain?[domain]:[],open_ports:parsed.port?[{port:parsed.port,service:parsed.service}]:[],task_id:input.task_id});};
        }else{
          if(!domain&&!ip)throw new Error('domain or ip is required');requireValue(input.port,'port is required');requireValue(input.service_name,'service_name is required');const service=input.service_name!.trim().toLowerCase();
          sql=statements.UpsertOtherService[0]!;args=[service,nullString(domain),nullString(ip),input.port,nullString(root),await this.network(tx,ip),arrayJson(input.auth),await this.company(tx,root,ip,''),taskIds];
          post=async()=>{if(ip)await this.write(tx,{type:'ip',ip,bound_domains:domain?[domain]:[],open_ports:[{port:input.port!,service}],task_id:input.task_id});await this.host(tx,domain,root,input);};
        }break;
      }
      case 'endpoint':{
        requireValue(input.url,'url is required');requireValue(input.method,'method is required');const url=normalizeAssetURL(input.url!),parsed=parseURL(url);domain=parsed.domain;root=rootDomain(domain);ip=input.service_ip||ip;
        if(ip&&!isIP(ip))throw new Error('invalid asset ip');
        sql=statements.UpsertEndpoint[0]!;args=[url,input.method!.toUpperCase(),nullString(domain),nullString(ip),parsed.port||null,nullString(root),arrayJson(input.params),await this.company(tx,root,ip,''),taskIds,await this.network(tx,ip)];
        post=async()=>{await this.host(tx,domain,root,input);if(ip)await this.write(tx,{type:'ip',ip,task_id:input.task_id});};break;
      }
      default:throw new Error(`unknown type: ${input.type}`);
    }
    const row=(await tx.query(sql,args)).rows[0],insertedNew=Boolean(row.inserted_new);delete row.inserted_new;
    const value=input.type==='service'||input.type==='endpoint'?row.url??row.domain??row.ip??'':input.type==='app'?row.app_name??'':row.domain??row.ip??'';
    await tx.query('UPDATE assets SET value=$2,task_id=COALESCE($3,task_id),source=COALESCE($4,source),updated_at=now() WHERE id=$1',[row.id,String(value),input.task_id??null,input.source??null]);row.value=String(value);
    if(input.task_id)await tx.query('INSERT INTO task_assets(task_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.task_id,row.id]);
    await post();return {asset:row,insertedNew};
  }
}
