import type {Pool,PoolClient} from 'pg';
import {companyNKey,parseScopes,type ScopeInput,type ParsedScope} from './scope.ts';
import attribution from './asset-attribution-sql.json' with {type:'json'};
export class CompanyError extends Error{constructor(public status:number,message:string){super(message);}}
const companyDTO=(r:any)=>({id:Number(r.id),name:r.name,nkey:r.nkey,...(r.logo?{logo:r.logo}:{}),created_at:r.created_at,updated_at:r.updated_at});
const scopeDTO=(r:any)=>({id:Number(r.id),company_id:Number(r.company_id),kind:r.kind,...(r.domain?{domain:r.domain}:{}),...(r.net?{net:r.net}:{}),...(r.value?{value:r.value}:{}),raw:r.raw??r.scope??'',...(r.reason?{reason:r.reason}:{})});
export class CompaniesService{
 constructor(private pool:Pool){}
 private async transaction<T>(fn:(tx:PoolClient)=>Promise<T>){const tx=await this.pool.connect();try{await tx.query('BEGIN');await tx.query('SELECT pg_advisory_xact_lock($1)',[7337741003]);const value=await fn(tx);await tx.query('COMMIT');return value;}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}}
 private async rebuild(tx:PoolClient){for(const sql of attribution)await tx.query(sql);}
 async reattribute(){await this.transaction(tx=>this.rebuild(tx));}
 private async insert(tx:PoolClient,id:number,rules:ParsedScope[],reason:string){let added=0,skipped=0,rebuild=false;
  for(const r of rules){let net=r.net??null;if(net)net=(await tx.query('SELECT ($1::inet)::cidr::text net',[net])).rows[0].net;
   const scope=`${r.kind}:${r.domain??net??r.value??''}`;
   const row=await tx.query('INSERT INTO company_scope(company_id,scope,kind,domain,net,value,raw,reason) VALUES($1,$2,$3,$4,$5::cidr,$6,$7,$8) ON CONFLICT DO NOTHING',[id,scope,r.kind,r.domain??null,net,r.value??null,r.raw,reason]);
   if(row.rowCount){added++;rebuild||=r.kind!=='keyword';}else skipped++;
  }return {added,skipped,rebuild};
 }
 async create(name:string,logo:string,inputs:ScopeInput[],upsert=false){if(!name.trim())throw new CompanyError(400,'name required');
  let parsed;try{parsed=parseScopes(inputs);}catch(e){throw new CompanyError(400,(e as Error).message);}
  return this.transaction(async tx=>{
   const row=await tx.query(`INSERT INTO companies(name,nkey,logo) VALUES($1,$2,$3) ON CONFLICT(nkey) ${upsert?"DO UPDATE SET name=EXCLUDED.name,logo=COALESCE(EXCLUDED.logo,companies.logo),updated_at=now()":"DO NOTHING"} RETURNING id,(xmax=0) created`,[name.trim(),companyNKey(name),logo||null]);
   if(!row.rowCount)throw new CompanyError(409,"Company name already exists");const id=Number(row.rows[0].id),count=await this.insert(tx,id,parsed.rules,'api');if(count.rebuild)await this.rebuild(tx);
   return {id,created:row.rows[0].created,scope_added:count.added,scope_skipped:count.skipped,scope_invalid:parsed.invalid,...(parsed.errors.length?{scope_errors:parsed.errors}:{})};
  });
 }
 async scope(id:number){return (await this.pool.query('SELECT *,net::text net FROM company_scope WHERE company_id=$1 ORDER BY id',[id])).rows.map(scopeDTO);}
 async get(id:number){const r=await this.pool.query('SELECT *,created_at::text created_at,updated_at::text updated_at FROM companies WHERE id=$1',[id]);if(!r.rowCount)return null;return {company:companyDTO(r.rows[0]),scope:await this.scope(id)};}
 async list(){const rows=(await this.pool.query('SELECT c.*,c.created_at::text created_at,c.updated_at::text updated_at,(SELECT count(*)::int FROM assets a WHERE a.company_id=c.id) asset_count FROM companies c ORDER BY c.name')).rows;if(!rows.length)return null;return Promise.all(rows.map(async r=>({...companyDTO(r),scope:await this.scope(Number(r.id)),asset_count:r.asset_count})));}
 async updateScope(id:number,inputs:ScopeInput[],reason:string,reset=false){let parsed;try{parsed=parseScopes(inputs);}catch(e){throw new CompanyError(400,(e as Error).message);}
  return this.transaction(async tx=>{if(!(await tx.query('SELECT 1 FROM companies WHERE id=$1 FOR UPDATE',[id])).rowCount)throw new CompanyError(404,'company not found');
   if(reset)await tx.query('DELETE FROM company_scope WHERE company_id=$1',[id]);const count=await this.insert(tx,id,parsed.rules,reason);if(reset||count.rebuild)await this.rebuild(tx);
   return {added:count.added,skipped:count.skipped,invalid:parsed.invalid,...(parsed.errors.length?{errors:parsed.errors}:{})};
  });
 }
 async remove(id:number,deleteAssets=false){return this.transaction(async tx=>{if(!(await tx.query('SELECT 1 FROM companies WHERE id=$1 FOR UPDATE',[id])).rowCount)throw new CompanyError(404,'company not found');
  const deleted=deleteAssets?(await tx.query('DELETE FROM assets WHERE company_id=$1',[id])).rowCount??0:0;
  await tx.query('DELETE FROM companies WHERE id=$1',[id]);await this.rebuild(tx);return {deleted:1,assets_deleted:deleted};
 });}
 async malformedWarning(){const rows=(await this.pool.query("SELECT id,ip,count(*) OVER() total FROM assets WHERE ip IS NOT NULL AND ip<>'' AND try_inet(ip) IS NULL AND type IN ('ip','subdomain','service','endpoint') ORDER BY id LIMIT 5")).rows;if(!rows.length)return '';
  const total=Number(rows[0].total);return `${total} The ip field of the asset is not a legal IP, and the IP/CIDR range matching has been skipped (these assets will not be attributed to the enterprise by network segment rules):${rows.map(r=>`#${r.id} ${r.ip}`).join('、')}${total>rows.length?` etc. ${total} Article`:''}`;
 }
}
