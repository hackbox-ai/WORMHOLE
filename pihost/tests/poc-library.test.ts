import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {runMigrations} from '../src/db/migrate.ts';
import {PocService} from '../src/domains/pocs/service.ts';
import {TaskService} from '../src/domains/tasks/service.ts';

const dsn=process.env.WORMHOLE_POC_TEST_DSN;
if(!dsn){test('unified library requires isolated database',{skip:true},()=>{});}else{
 if(!new URL(dsn).pathname.startsWith('/wormhole_poc_test'))throw new Error('isolated database required');
 const admin=new Pool({connectionString:dsn}),schema='library_'+process.pid;let pool:Pool,service:PocService;
 const raw=(id:string,product='unified-product')=>`id: ${id}\ninfo:\n  name: Library ${id}\n  severity: info\n  metadata:\n    product: ${product}\nhttp:\n  - method: GET\n    path: ["{{BaseURL}}/"]\n`;
 before(async()=>{await admin.query('CREATE SCHEMA '+schema);pool=new Pool({connectionString:dsn,options:'-c search_path='+schema});await runMigrations(pool);service=new PocService(pool);});
 after(async()=>{await pool?.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 test('unified listing searches every active package by product and paginates deterministically',async()=>{
  await service.add({type:'nuclei',raw:raw('one')});await service.add({type:'legacy-python',name:'Python reference',product:'second-product',raw:'raise RuntimeError("never execute")'});
  assert.equal((await service.list()).total,2);assert.equal((await service.list('','secondproduct')).total,1);assert.equal((await service.list('','unifiedproduct')).total,1);assert.deepEqual((await service.list()).items.map(x=>x.id),(await service.list()).items.map(x=>x.id));
 });
 test('parallel additions preserve existing entries, overrides and pinned task contents',async()=>{
  const entry=(await service.list('','Library one')).items[0]!;await service.override(entry.id,{enabled:false,version_range:'<2.0',notes:'preserved'});
  const created=await new TaskService(pool,'/tmp/wormhole-library-test-dlq',()=>{}).create({goal:'library snapshot fixture',queued:true});const taskId=Number(created.task.id);await service.pin(taskId);const before=await service.snapshot();
  await Promise.all([service.add({type:'nuclei',raw:raw('two')}),service.add({type:'nuclei',raw:raw('three')})]);assert.equal((await service.list()).total,4);
  assert.notEqual(await service.snapshot(),before);assert.equal((await service.detail(entry.id,{taskId})).override?.notes,'preserved');const added=(await service.list('','Library two')).items[0]!;await assert.rejects(service.detail(added.id,{taskId}),/固定/);assert.equal((await service.list('','Library one')).items[0].enabled,false);
 });
 test('repeated addition and export/import are idempotent and do not replace active entries',async()=>{
  const a=await service.add({type:'nuclei',raw:raw('two')}),b=await service.add({type:'nuclei',raw:raw('two')});assert.equal(a.id,b.id);
  const before=await service.snapshot();const bundle=await service.exportLibrary();await service.importLibrary(bundle);assert.equal(await service.snapshot(),before);assert.equal((await service.list()).total,4);
  const document={format:'wormhole-poc-source-v1',key:'fixture',title:'Imported fixture',type:'nuclei',provenance:{},entries:[{native_id:'five.yaml',raw:raw('five')}]};await service.importLibrary(document);await service.importLibrary(document);assert.equal((await service.list()).total,5);
 });
 test('invalid additions are rejected without writing and invalid bundles validate before import',async()=>{
  const before=await service.snapshot();await assert.rejects(service.add({type:'nuclei',raw:'id: a\nid: b'}),/YAML/);await assert.rejects(service.add({type:'legacy-python',raw:'pass'}),/名称/);
  await assert.rejects(service.importLibrary({format:'wormhole-poc-library-v1',documents:[{format:'wormhole-poc-source-v1',key:'valid',title:'valid',type:'nuclei',entries:[{native_id:'a',raw:raw('not-written')}]},{invalid:true}]}),/无效/);assert.equal(await service.snapshot(),before);
 });
}
