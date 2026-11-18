import type {Pool} from 'pg';
import {compileAssetDSL} from './dsl.ts';
/** Original db.Asset JSON shape. Internal Pi/legacy columns do not leak. */
export function sourceAssetDTO(row:Record<string,unknown>):Record<string,unknown>{
 const result:Record<string,unknown>={id:Number(row.id),type:row.type,task_ids:(row.task_ids as unknown[]??[]).map(Number),last_seen:row.last_seen};
 for(const key of ['domain','root_domain','ip','c_segment','icp','record_type','bundle_id','app_name','category','app_description','app_icp','url','service_type','service_name','favicon_mmh3','page_title','method','task_source','task_source_summary'])if(row[key])result[key]=row[key];
 for(const key of ['company_id','port','status_code','content_length','task_source_node_id'])if(row[key]!==null&&row[key]!==undefined)result[key]=Number(row[key]);
 for(const key of ['bound_domains','open_ports','record_value','technologies','auth','params'])if(Array.isArray(row[key])&&(row[key] as unknown[]).length)result[key]=row[key];
 const fingerprintTech=Array.isArray(row.fingerprint_technologies)?row.fingerprint_technologies as string[]:[];
 if(fingerprintTech.length){result.technologies=[...new Set([...(row.technologies as string[]??[]),...fingerprintTech])];result.fingerprint_technologies=fingerprintTech;}
 if(row.extra&&Object.keys(row.extra).length)result.extra=row.extra;return result;
}
export class SourceAssetReads{
 constructor(private pool:Pool){}
 async page(q:{type?:string;dsl?:string;company_id?:number;task_id?:number;limit?:number;offset?:number}){
  const compiled=compileAssetDSL(q.dsl??''),args=compiled.args,where=[`(${compiled.sql})`];const add=(v:unknown)=>{args.push(v);return `$${args.length}`;};
  let task=0;
  if(q.dsl){if(q.type)where.push(`type=${add(q.type)}`);if((q.task_id??0)>0){task=q.task_id!;where.push(`${add(task)}=ANY(task_ids)`);}}
  else {if((q.company_id??0)>0)where.push(`company_id=${add(q.company_id)}`);else if((q.task_id??0)>0){task=q.task_id!;where.push(`${add(task)}=ANY(task_ids)`);}const type=q.type||(!q.company_id&&!q.task_id?'root_domain':'');if(type)where.push(`type=${add(type)}`);}
  const condition=where.join(' AND '),total=Number((await this.pool.query(`SELECT count(*) FROM assets WHERE ${condition}`,args)).rows[0].count);
  const limit=Math.min((q.limit??0)>0?q.limit!:50,200),offset=Math.max(q.offset??0,0);if(offset>=total)return {assets:[],count:0,total};
  const rows=(await this.pool.query(`SELECT *,last_seen::text AS last_seen FROM assets WHERE ${condition} ORDER BY assets.last_seen DESC,id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`,args)).rows;
  if(task){const links=(await this.pool.query('SELECT asset_id,source,source_summary,source_node_id FROM task_asset_links WHERE task_id=$1 AND asset_id=ANY($2::bigint[])',[task,rows.map(r=>r.id)])).rows;const map=new Map(links.map(r=>[r.asset_id,r]));for(const row of rows){const link=map.get(row.id);if(link){row.task_source=link.source;row.task_source_summary=link.source_summary;row.task_source_node_id=link.source_node_id;}}}
  return {assets:rows.map(sourceAssetDTO),count:rows.length,total};
 }
 async counts(task=0){return Object.fromEntries((await this.pool.query(`SELECT type,count(*)::int count FROM assets ${task>0?'WHERE $1=ANY(task_ids)':''} GROUP BY type`,task>0?[task]:[])).rows.map(r=>[r.type,r.count]));}
 async remove(ids:number[]){return (await this.pool.query('DELETE FROM assets WHERE id=ANY($1::bigint[])',[ids])).rowCount??0;}
}
