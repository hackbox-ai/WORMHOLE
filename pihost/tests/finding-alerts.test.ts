import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FindingAlerts} from '../src/domains/notify/alerts.ts';
import {AuthService,authKeyPath} from '../src/auth/service.ts';
import {routeRequest} from '../src/api/server.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
const config=loadConfig(),schema=`codex_alerts_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:config.database.dsn});await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:config.database.dsn,options:`-c search_path=${schema}`});
const dir=await mkdtemp(path.join(tmpdir(),'wormhole-alerts-test-'));await mkdir(path.join(dir,'data'));config.dataDir=path.join(dir,'data');
await runMigrations(pool);const feed=new FindingAlerts(pool,randomBytes(32));
const task=(await pool.query("INSERT INTO tasks(name,goal,status,paused) VALUES('提醒验收','test','paused',true) RETURNING id")).rows[0].id;
async function add(name:string,db:Pick<Pool,'query'>=pool){return (await db.query('INSERT INTO findings(task_id,name,severity) VALUES($1,$2,\'high\') RETURNING id::text',[task,name])).rows[0].id as string;}
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});});
test('initial baseline suppresses history; new committed insert once; update/rollback/global finding remain silent',async()=>{
 await add('historical');const base=await feed.feed();assert.deepEqual(base.items,[]);
 const id=await add('new'),next=await feed.feed(base.cursor);assert.deepEqual(next.items.map(r=>r.finding_id),[id]);assert.equal(next.items[0].task_name,'提醒验收');
 await pool.query("UPDATE findings SET name='edited',status='confirmed' WHERE id=$1",[id]);
 const c=await pool.connect();try{await c.query('BEGIN');await add('rollback',c);await c.query('ROLLBACK');}finally{c.release();}
 await pool.query("INSERT INTO findings(name,severity) VALUES('unattached','low')");
 assert.deepEqual((await feed.feed(next.cursor)).items,[]);
});
test('late lower sequence ID commit is delivered after a higher ID was already acknowledged',async()=>{
 const baseline=await feed.feed(),a=await pool.connect();try{
  await a.query('BEGIN');const lower=await add('late',a),higher=await add('fast');
  const first=await feed.feed(baseline.cursor);assert.deepEqual(first.items.map(r=>r.finding_id),[higher]);
  await a.query('COMMIT');const second=await feed.feed(first.cursor);assert.deepEqual(second.items.map(r=>r.finding_id),[lower]);
  assert.deepEqual((await feed.feed(second.cursor)).items,[]);
 }finally{await a.query('ROLLBACK');a.release();}
});
test('pagination holds a fixed snapshot; commits between pages appear in the next cycle',async()=>{
 const baseline=await feed.feed();const expected=[];for(let i=0;i<115;i++)expected.push(await add('batch-'+i));
 const p1=await feed.feed(baseline.cursor);assert.equal(p1.items.length,50);assert.equal(p1.more,true);
 const later=await add('after-page-1');const p2=await feed.feed(p1.cursor),p3=await feed.feed(p2.cursor);
 assert.equal(p2.items.length,50);assert.equal(p3.items.length,15);assert.equal(p3.more,false);
 assert.deepEqual([...p1.items,...p2.items,...p3.items].map(i=>i.finding_id),expected);
 assert.deepEqual((await feed.feed(p3.cursor)).items.map(i=>i.finding_id),[later]);
});
test('signed cursor rejects tampering and key changes without replaying history',async()=>{
 const base=await feed.feed();for(const cursor of ['bad',base.cursor+'x','x'.repeat(13000)]){const result=await feed.feed(cursor);assert.equal(result.reset,true);assert.deepEqual(result.items,[]);}
 assert.equal((await new FindingAlerts(pool,randomBytes(32)).feed(base.cursor)).reset,true);
});
test('API enforces auth and GET, disables caching, and returns real trigger event',async()=>{
 const auth=new AuthService(pool,authKeyPath(config.dataDir));const ctx={pool,config,auth} as any;
 const server=createServer((req,res)=>void routeRequest(req,res,ctx));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}/api/alerts/findings`;
 try{
  assert.equal((await fetch(base)).status,401);const token=await auth.signTokenForTest(3600),headers={authorization:`Bearer ${token}`};
  assert.equal((await fetch(base,{method:'POST',headers})).status,405);
  const first=await fetch(base,{headers});assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');const cursor=(await first.json()).cursor;
  const id=await add('API new');const body=await (await fetch(base+'?cursor='+encodeURIComponent(cursor),{headers})).json();assert.deepEqual(body.items.map((i:any)=>i.finding_id),[id]);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('task report_finding service creates the global alert even if external outbox insertion fails',async()=>{
 await new ExplorationService(pool).ensure(Number(task));
 const baseline=await feed.feed();
 await pool.query("CREATE FUNCTION reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test external outbox failure'; END $$; CREATE TRIGGER reject_notification BEFORE INSERT ON notification_events FOR EACH ROW EXECUTE FUNCTION reject_notification()");
 try{const service=new FindingsService(pool,path.join(dir,'dlq.jsonl'));const saved=await service.record({task_id:Number(task),name:'任务登记发现',vulnclass:'Test',severity:'high',summary:'isolated fixture'});
  assert.deepEqual((await feed.feed(baseline.cursor)).items.map(i=>i.finding_id),[saved.finding_id]);
 }finally{await pool.query('DROP TRIGGER reject_notification ON notification_events;DROP FUNCTION reject_notification()');}
});
