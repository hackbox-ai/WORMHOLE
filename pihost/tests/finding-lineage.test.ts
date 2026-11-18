import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runMigrations} from '../src/db/migrate.ts';
import {loadConfig} from '../src/config.ts';
import {ExplorationService} from '../src/domains/exploration/service.ts';
import {findingPaths,markFindingPaths,pathEdgeKey} from '../src/domains/exploration/paths.ts';
import {FindingLineage} from '../src/domains/findings/lineage.ts';
import {FindingsService} from '../src/domains/findings/service.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {AuthService,authKeyPath} from '../src/auth/service.ts';
import {routeRequest,type AppContext} from '../src/api/server.ts';

test('finding ancestry is causal, multi-parent and cycle-safe, without pulling siblings, proofs or digest members',()=>{
 const nodes=['root','a','b','c','target','sibling','goal','digest','covered'].map(id=>({id,type:id==='target'||id==='sibling'?'finding':'fact'}));
 const edge=(src:string,dst:string,rel='derived_from')=>({src,dst,rel});
 const edges=[edge('root','a'),edge('root','b'),edge('a','c'),edge('b','c'),edge('c','target','yields'),edge('c','a'),edge('b','sibling','yields'),edge('target','goal','proves'),edge('digest','a','covers'),edge('covered','goal','proves')];
 const result=findingPaths(nodes,edges,['target']);assert.deepEqual(result.nodeIds,new Set(['root','a','b','c','target']));assert.equal(result.edgeKeys.size,6);
 assert.ok(!result.edgeKeys.has(pathEdgeKey(edges[6]!)));assert.ok(!result.nodeIds.has('digest'));
 const marked=markFindingPaths(nodes,edges);assert.ok(marked.nodes.find(n=>n.id==='sibling')?.finding_path);assert.ok(!marked.nodes.find(n=>n.id==='covered')?.finding_path);
});

const dsn=process.env.WORMHOLE_POC_TEST_DSN;
if(!dsn){test('finding lineage integration requires isolated database',{skip:true},()=>{});}else{
 if(!new URL(dsn).pathname.startsWith('/wormhole_poc_test'))throw new Error('isolated database required');
 const admin=new Pool({connectionString:dsn}),schema='lineage_'+process.pid;let pool:Pool,graph:ExplorationService,findings:FindingsService,reader:FindingLineage,dir:string,token:string,origin:string;
 const server=createServer((req,res)=>void routeRequest(req,res,ctx));let ctx:AppContext;
 before(async()=>{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:dsn,options:'-c search_path='+schema});await runMigrations(pool);dir=await mkdtemp(path.join(tmpdir(),'wormhole-lineage-'));graph=new ExplorationService(pool);findings=new FindingsService(pool,path.join(dir,'dlq'));reader=new FindingLineage(pool);const auth=new AuthService(pool,authKeyPath(dir));const initialized=await auth.init('lineage-fixture-20261021');assert.ok(initialized.ok);token=initialized.token;ctx={pool,config:{...loadConfig(),dataDir:dir},auth,taskEngine:{notify:()=>{}}} as unknown as AppContext;await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;});
 after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await rm(dir,{recursive:true,force:true});});
 async function task(){const r=await new TaskService(pool,path.join(dir,'dlq'),()=>{}).create({goal:'lineage fixture',queued:true});const id=Number(r.task.id);await graph.ensure(id);return id;}
 async function api(url:string){const r=await fetch(origin+url,{headers:{Authorization:'Bearer '+token}});return {status:r.status,data:await r.json()};}
 test('finding API resolves the independent finding ID to its exact graph node and returns only that ancestry',async()=>{
  const id=await task(),first=await graph.addIntent(id,{summary:'entry check'}),fact=await graph.recordFact(id,{summary:'entry evidence'},'worker',first),second=await graph.addIntent(id,{summary:'follow evidence',parent_ids:[fact]}),siblingIntent=await graph.addIntent(id,{summary:'unrelated branch'});
  const a=await findings.record({task_id:id,intent_id:second,vulnclass:'fixture',name:'Finding A',severity:'low',summary:'verified fixture A'}),b=await findings.record({task_id:id,intent_id:siblingIntent,vulnclass:'fixture',name:'Finding B',severity:'low',summary:'verified fixture B'});
  assert.notEqual(a.finding_id,a.finding_node_id);
  const response=await api('/api/exploration/findings/'+a.finding_id+'/lineage');assert.equal(response.status,200);const g=response.data;assert.equal(String(g.finding.node_id),a.finding_node_id);assert.equal(g.nodes.length,5);assert.equal(g.edges.length,4);assert.ok(g.nodes.every((n:any)=>n.finding_path));assert.ok(!g.nodes.some((n:any)=>n.id===b.finding_node_id||n.id===String(siblingIntent)));
  const total=(await api('/api/exploration/graph?task='+id)).data;assert.ok(total.nodes.find((n:any)=>n.id===b.finding_node_id).finding_path);assert.ok(total.edges.every((e:any)=>e.finding_path));
  const before=await pool.query('SELECT count(*)::int n FROM exploration_edges');await reader.read(Number(a.finding_id));assert.deepEqual((await pool.query('SELECT count(*)::int n FROM exploration_edges')).rows,before.rows);
 });
 test('task graph highlights all discovery branches while leaving non-discovery branches neutral',async()=>{
  const id=await task(),hit=await graph.addIntent(id,{summary:'successful direction'}),miss=await graph.addIntent(id,{summary:'negative direction'});const negative=await graph.recordFact(id,{summary:'negative evidence'},'worker',miss);await findings.record({task_id:id,intent_id:hit,vulnclass:'fixture',severity:'low',summary:'finding'});
  const g=(await api('/api/exploration/graph?task='+id)).data;assert.ok(g.nodes.find((n:any)=>n.id===String(hit)).finding_path);assert.ok(!g.nodes.find((n:any)=>n.id===String(miss)).finding_path);assert.ok(!g.nodes.find((n:any)=>n.id===String(negative)).finding_path);assert.ok(!g.edges.find((e:any)=>e.dst===String(miss)).finding_path);
 });
 test('lineage follows visible direct source evidence, rejects unrelated tasks and does not invent missing parents',async()=>{
  const id=await task(),source=await task(),foreign=await task(),srcIntent=await graph.addIntent(source,{summary:'source intent'}),srcFact=await graph.recordFact(source,{summary:'shared evidence'},'worker',srcIntent),foreignFact=await graph.recordFact(foreign,{summary:'foreign evidence'});
  await pool.query("UPDATE exploration_nodes SET state='done' WHERE id=$1",[srcIntent]);await pool.query('INSERT INTO task_relations(task_id,source_task_id) VALUES($1,$2)',[id,source]);const current=await graph.addIntent(id,{summary:'use shared evidence',parent_ids:[srcFact]});const finding=await findings.record({task_id:id,intent_id:current,vulnclass:'fixture',severity:'low',summary:'shared path'});
  const eid=(await pool.query('SELECT exploration_id FROM tasks WHERE id=$1',[id])).rows[0].exploration_id;await pool.query("INSERT INTO exploration_edges(exploration_id,src_id,rel,dst_id) VALUES($1,$2,'derived_from',$3)",[eid,foreignFact,current]);
  const g=(await reader.read(Number(finding.finding_id)))!;assert.ok(g.nodes.some(n=>n.id===String(srcFact)&&'inherited' in n));assert.ok(!g.nodes.some(n=>n.id===String(foreignFact)));assert.ok(g.nodes.some(n=>n.id===String(current)));
  const detached=await findings.record({task_id:id,vulnclass:'fixture',severity:'low',summary:'no recorded intent'});const d=(await reader.read(Number(detached.finding_id)))!;assert.equal(d.nodes.length,1);assert.equal(d.edges.length,0);
  const manual=await findings.create({task_id:id,name:'manual unlinked'});const empty=await api('/api/exploration/findings/'+manual.finding!.id+'/lineage');assert.equal(empty.status,200);assert.deepEqual(empty.data.nodes,[]);assert.equal(empty.data.reason,'unlinked');assert.equal((await api('/api/exploration/findings/99999999/lineage')).status,404);
 });
 test('a finding beyond the task overview node cap still has its complete path',async()=>{
  const id=await task();await pool.query(`INSERT INTO exploration_nodes(task_id,exploration_id,kind,payload,state) SELECT $1,t.exploration_id,'fact',jsonb_build_object('summary','unrelated '||i),'confirmed' FROM tasks t CROSS JOIN generate_series(1,2010) i WHERE t.id=$1`,[id]);const intent=await graph.addIntent(id,{summary:'late discovery'});const finding=await findings.record({task_id:id,intent_id:intent,vulnclass:'fixture',severity:'low',summary:'late finding'});const g=(await reader.read(Number(finding.finding_id)))!;assert.equal(g.nodes.length,3);assert.equal(g.edges.length,2);assert.ok(g.nodes.some(n=>n.id===finding.finding_node_id));
 });
}
