import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Pool} from 'pg';
const config=JSON.parse(fs.readFileSync('/var/lib/wormhole/config.json','utf8'));
const pool=new Pool({connectionString:config.database.dsn});
try{
 const active=Number((await pool.query("SELECT count(*) FROM tasks WHERE status='running' AND paused=FALSE AND deleted_at IS NULL")).rows[0].count);
 const duplicate={};
 const checks={root_domain:"type='root_domain' GROUP BY domain",ip:"type='ip' GROUP BY ip",subdomain:"type='subdomain' GROUP BY domain,COALESCE(record_type,'')",app_bundle:"type='app' AND bundle_id IS NOT NULL GROUP BY bundle_id",app_name:"type='app' AND bundle_id IS NULL GROUP BY app_name",service_http:"type='service' AND service_type='http' GROUP BY url",service_other:"type='service' AND service_type='other' GROUP BY COALESCE(domain,''),COALESCE(ip,''),port,service_name"};
 for(const [name,sql] of Object.entries(checks))duplicate[name]=Number((await pool.query(`SELECT count(*) FROM (SELECT 1 FROM assets WHERE ${sql} HAVING count(*)>1) d`)).rows[0].count);
 const endpointColumns=(await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='assets' AND column_name='method'")).rowCount;
 if(endpointColumns)duplicate.endpoint=Number((await pool.query("SELECT count(*) FROM (SELECT 1 FROM assets WHERE type='endpoint' GROUP BY url,method HAVING count(*)>1) d")).rows[0].count);
 duplicate.companies=Number((await pool.query("SELECT count(*) FROM (SELECT 1 FROM companies GROUP BY lower(regexp_replace(trim(name),'[[:space:]]+',' ','g')) HAVING count(*)>1) d")).rows[0].count);
 const legacyScopes=Number((await pool.query('SELECT count(*) FROM company_scope')).rows[0].count);
 console.log(JSON.stringify({active,duplicate,legacyScopes}));
 if(active||Object.values(duplicate).some(n=>n))throw new Error('preflight blocks deployment; do not merge/delete data');
 if(process.argv.includes('--backup')){
  const u=new URL(config.database.dsn),file='/root/wormhole-handoff-20261010/before-0028-0030.dump';
  const result=spawnSync('pg_dump',['-Fc','-h',u.hostname,'-p',u.port||'5432','-U',decodeURIComponent(u.username),'-d',decodeURIComponent(u.pathname.slice(1)),'-f',file],{env:{...process.env,PGPASSWORD:decodeURIComponent(u.password)},encoding:'utf8'});
  if(result.status!==0)throw new Error('pg_dump failed');fs.chmodSync(file,0o600);console.log('backup ready: '+file);
 }
}finally{await pool.end();}
