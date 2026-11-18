import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pool} from 'pg';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {initialTaskName} from '../src/domains/tasks/name.ts';
import {TaskService} from '../src/domains/tasks/service.ts';
import {registerTaskOrchestration} from '../src/domains/tools/task-orchestration.ts';
import {getTool} from '../src/domains/tools/gate.ts';

test('task names are immediate: explicit name, description, goal, and empty creation fallback', () => {
  assert.equal(initialTaskName({name:'  用户指定名称  ',description:'description',goal:'goal'}), '用户指定名称');
  assert.equal(initialTaskName({name:' ',description:'  Web/API 测试  ',goal:'long goal'}), 'Web/API 测试');
  assert.equal(initialTaskName({description:'未命名任务',goal:' 验证服务\n并记录结果 '}), '验证服务 并记录结果');
  assert.equal(initialTaskName({name:'',goal:'仅提供目标'}), '仅提供目标');
  assert.equal(initialTaskName({}), '新任务');
  const title=initialTaskName({description:'🔍'.repeat(61)});
  assert.equal(Array.from(title).length,60);
  assert.equal(title,'🔍'.repeat(59)+'…');
});

test('spawn_task persists a name before launch and creation event; queued API creation also has a name', async () => {
  const config=loadConfig(),schema=`task_name_${process.pid}_${Date.now()}`;
  const admin=new Pool({connectionString:config.database.dsn});
  await admin.query('CREATE SCHEMA '+schema);
  const pool=new Pool({connectionString:config.database.dsn,options:'-c search_path='+schema});
  const launches:number[]=[];
  try {
    await runMigrations(pool);
    const tasks=new TaskService(pool,`/tmp/${schema}.dlq`,id=>launches.push(id));
    registerTaskOrchestration({pool,tasks} as any);
    const result=await getTool('spawn_task')!.execute({description:'立即命名的受控测试',goal:'仅测试创建，不运行模型'},
      {agentKey:'auto',businessKind:'chat',businessId:'naming-fixture'});
    const id=Number(String(result).split(': ').at(-1));
    assert.deepEqual(launches,[id]);
    assert.equal((await tasks.get(id))!.name,'立即命名的受控测试');
    assert.equal((await tasks.list({id,archived:null}))[0]!.name,'立即命名的受控测试');
    const event=(await pool.query("SELECT payload FROM business_events WHERE event_type='task_created' AND business_id=$1",[String(id)])).rows[0];
    assert.equal(event.payload.name,'立即命名的受控测试');
    const queued=await tasks.create({name:'',goal:'排队时即可看到名称',queued:true});
    assert.ok(queued.ok);
    assert.equal(queued.task.name,'排队时即可看到名称');
    assert.equal(queued.task.status,'created');
    assert.deepEqual(launches,[id]);
  } finally {
    await pool.end();
    await admin.query('DROP SCHEMA '+schema+' CASCADE');
    await admin.end();
  }
});
