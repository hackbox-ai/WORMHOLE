import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {TaskBrowsers,BrowserTargetError} from '../src/domains/browser/task-browser.ts';
import {registerTaskBrowserTool} from '../src/domains/browser/tools.ts';
import {ModelingService} from '../src/domains/modeling/service.ts';
import {taskWebTargets,initialModelingTargets,discoveryModelingTarget} from '../src/domains/tasks/targets.ts';
import {runTool} from '../src/domains/tools/gate.ts';

const config=loadConfig();assert.match(new URL(config.database.dsn).pathname,/test/i);
const admin=new Pool({connectionString:config.database.dsn});
const schema='web_targets_'+process.pid+'_'+Date.now();
await admin.query('CREATE SCHEMA '+schema);
const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});
await runMigrations(pool);
const tmp=await mkdtemp('/tmp/wormhole-web-targets-');
const tasks=new TaskService(pool,tmp+'/events.jsonl',()=>{});
const models=new ModelingService(pool);
after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
const brief='仅验证 http://10.10.10.125:40180/health ，POST http://10.10.10.125:40180/api/echo 并用浏览器登录 http://10.10.10.125:40180/login 。禁止扫描和访问其他资产。';
async function create(goal=brief,extra:Record<string,unknown>={}){
 const result=await tasks.create({name:'normal UI intake',description:'two-hop acceptance',goal,queued:true,...extra});
 assert.ok(result.ok);
 const id=Number(result.task.id);
 await pool.query("UPDATE tasks SET status='running',queued=false WHERE id=$1",[id]);
 return await tasks.get(id) as any;
}
test('ordinary long task briefing persists browser targets without explicit modeling input',async()=>{
 const task=await create();
 assert.equal(task.target_input,'');assert.deepEqual(task.modeling_targets,[]);
 assert.equal(task.web_targets.length,3);
 assert.deepEqual(initialModelingTargets(task),['http://10.10.10.125:40180/health']);
 const browsers=new TaskBrowsers(pool,{} as any,{} as any,()=>{});
 await (browsers as any).allowed(Number(task.id),'http://10.10.10.125:40180');
 await assert.rejects((browsers as any).allowed(Number(task.id),'http://10.10.10.125:40580'),BrowserTargetError);
 await assert.rejects((browsers as any).allowed(Number(task.id),'http://10.10.9.176:18887'),BrowserTargetError);
 // Existing rows have no persisted targets: they retain the same intake semantics.
 await pool.query("UPDATE tasks SET web_targets='[]' WHERE id=$1",[task.id]);
 await (browsers as any).allowed(Number(task.id),'http://10.10.10.125:40180');
});
test('explicit entries bound browser origins and preserve distinct application roots',async()=>{
 const task=await create('测试 https://other.test/ （仅参考，不作为入口）',{modeling_targets:['https://apps.test/app-a','https://apps.test/app-b']});
 assert.deepEqual(taskWebTargets(task),['https://apps.test/app-a','https://apps.test/app-b']);
 assert.equal(discoveryModelingTarget(task,'https://apps.test/app-a/api/orders'),'https://apps.test/app-a');
 assert.equal(discoveryModelingTarget(task,'https://apps.test/app-b/api/users'),'https://apps.test/app-b');
 assert.equal(discoveryModelingTarget(task,'https://apps.test/app-c'),'https://apps.test/app-c');
 await models.initializeTask(Number(task.id));
 assert.equal((await models.list(Number(task.id))).length,2);
 const browsers=new TaskBrowsers(pool,{} as any,{} as any,()=>{});
 await assert.rejects((browsers as any).allowed(Number(task.id),'https://other.test'),BrowserTargetError);
});
test('initial URLs and later discoveries share one job despite asynchronous goal extraction',async()=>{
 const task=await create();const id=Number(task.id);
 await Promise.all([models.initializeTask(id),models.initializeTask(id)]);
 const first=(await models.list(id))[0];assert.ok(first);assert.equal((await models.list(id)).length,1);
 await pool.query("INSERT INTO task_constraints(task_id,kind,text,origin) VALUES($1,'deny','禁止扫描和访问其他资产','goals')",[id]);
 const repeated=await models.request({target:'http://10.10.10.125:40180/login',task_id:id,trigger:'discovery',queued:true});
 assert.equal(repeated.task_id,Number(first.task_id));assert.equal(repeated.created,false);
 assert.equal((await pool.query('SELECT count(*)::int n FROM business_model_runs WHERE source_task_id=$1',[id])).rows[0].n,1);
 // Actual authorization changes still get a separate scope/run.
 await pool.query("INSERT INTO task_constraints(task_id,kind,text,origin) VALUES($1,'deny','禁止提交表单','human')",[id]);
 const changed=await models.request({target:'http://10.10.10.125:40180/login',task_id:id,trigger:'discovery',queued:true});
 assert.notEqual(changed.task_id,repeated.task_id);
});
test('worker native browser tool accepts fill and returns a terminal blocked outcome for missing targets',async()=>{
 const task=await create();let observed:any;
 const fake={execute:async(_ctx:any,params:any)=>{observed=params;if(params.url==='https://outside.test')throw new BrowserTargetError('target not registered');return {filled:true};}};
 await registerTaskBrowserTool(pool,fake as any);
 const ctx={businessKind:'worker',businessId:'browser-native-regression',agentKey:'worker',taskId:Number(task.id),manualInvocation:false};
 const fill=await runTool(pool,'task_browser',{action:'fill',selector:'input[name=user]',text:'manual-user'},ctx);
 assert.equal(fill.status,'executed');assert.equal(observed.text,'manual-user');
 const blocked=await runTool(pool,'task_browser',{action:'open',url:'https://outside.test'},ctx);
 assert.equal(blocked.status,'executed');assert.deepEqual(blocked.output,{status:'blocked',code:'BROWSER_TARGET_NOT_REGISTERED',retryable:false,message:'target not registered'});
});
