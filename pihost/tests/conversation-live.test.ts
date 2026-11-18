import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {Type} from 'typebox';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {ConversationsService} from '../src/domains/conversations/service.ts';
import {AgentsService} from '../src/domains/agents/service.ts';
import {ObservabilityService} from '../src/domains/observability/service.ts';
import {projectActivity} from '../src/domains/activity/projector.ts';
import {resetPiRuntime} from '../src/pi/session-host.ts';
import {registerTool,runTool} from '../src/domains/tools/gate.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';

test('F02 real Pi chat: live tool card while blocked, native IDs/errors, two resumed turns and result totals without double counting',async()=>{
 const base=loadConfig(),schema=`codex_conv_live_${process.pid}_${Date.now()}`;
 const admin=new Pool({connectionString:base.database.dsn}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-conv-live-'));
 await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});
 const agentDir=path.join(dir,'agent');await mkdir(agentDir);const modelsPath=path.join(agentDir,'models.json');await writeFile(modelsPath,JSON.stringify({providers:{}}));
 const config={...base,dataDir:dir,pi:{...base.pi,agentDir,modelsPath}};let release!:()=>void;let entered=0;
 const barrier=new Promise<void>(resolve=>release=resolve);
 const mock=await startMockAnthropic(0,{marker:'CHAT_NATIVE',tool:b=>{
  const last=(b.messages as any[]).at(-1);return last?.content.some((c:any)=>c.type==='tool_result')?undefined:{name:'fixture_chat_echo',input:{value:'isolated-native-proof'}};
 }});const port=(mock.server.address() as {port:number}).port;
 const conversations=new ConversationsService(pool,config,new AgentsService(pool,path.join(dir,'dlq')),path.join(dir,'dlq'),async(agentKey,context)=>[{
  name:'fixture_chat_echo',label:'echo',description:'fixture only local echo',parameters:Type.Object({value:Type.String()}),
  execute:async(nativeId,params,signal)=>{
   const r=await runTool(pool,'fixture_chat_echo',params,{...context,agentKey,nativeToolCallId:nativeId,signal});
   return {content:[{type:'text',text:JSON.stringify(r.output)}],details:{toolCallId:r.toolCallId}};
  },
 }]);
 async function wait(check:()=>Promise<boolean>){const until=Date.now()+20_000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('chat fixture condition timed out');}
 try{
  await runMigrations(pool);await pool.query("INSERT INTO llm_profiles(name,format,model,base_url,api_key,is_default) VALUES('mock','anthropic','mock-1',$1,'fixture-key',TRUE)",[`http://127.0.0.1:${port}`]);resetPiRuntime();
  registerTool({key:'fixture_chat_echo',description:'local fixture',schema:Type.Object({value:Type.String()}),params:{value:'string'},required:['value'],execute:async p=>{entered++;await barrier;return {proof:p.value};}});
  const c=await conversations.create('auto','新对话',null);assert.ok(c.ok);const id=Number(c.conv.id);
  assert.equal((await conversations.send(id,'TURN_A 中文\n保留正文')).status,202);
  const user=(await pool.query("SELECT worker,summary,detail FROM conversation_activities WHERE conversation_id=$1 AND kind='user'",[id])).rows;
  assert.deepEqual(user,[{worker:'auto',summary:'TURN_A 中文',detail:'TURN_A 中文\n保留正文'}],'human activity is durable before 202');
  assert.equal((await conversations.send(id,'busy')).status,409);
  await wait(async()=>entered===1);
  await wait(async()=>{await projectActivity(pool);return !!(await pool.query("SELECT 1 FROM conversation_activities WHERE conversation_id=$1 AND kind='tool_use'",[id])).rowCount;});
  const live=(await conversations.messages(id,0))!.items;assert.ok(live.some(a=>a.kind==='tool_use'&&a.tool==='fixture_chat_echo'&&a.tool_use_id));assert.ok(!live.some(a=>a.kind==='result'));assert.ok(conversations.isRunning(id));
  release();await wait(async()=>!conversations.isRunning(id));
  assert.equal((await conversations.send(id,'TURN_B')).status,202);await wait(async()=>!conversations.isRunning(id));
  const rows=(await pool.query('SELECT * FROM conversation_activities WHERE conversation_id=$1 ORDER BY id',[id])).rows;
  assert.equal(rows.filter(a=>a.kind==='user').length,2);assert.equal(rows.filter(a=>a.kind==='result').length,2);
  assert.equal(rows.filter(a=>a.kind==='tool_use').length,2);assert.equal(rows.filter(a=>a.kind==='tool_result').length,2);
  assert.ok(rows.every(a=>a.worker==='auto'));assert.ok(!rows.some(a=>a.kind==='assistant'));
  for(const call of rows.filter(a=>a.kind==='tool_use')){const result=rows.find(a=>a.kind==='tool_result'&&a.tool_use_id===call.tool_use_id);assert.ok(result);assert.match(result.detail,/isolated-native-proof/);assert.equal(result.is_error,false);assert.ok(await conversations.detail(id,Number(call.id)));}
  const results=rows.filter(a=>a.kind==='result');assert.deepEqual(results.map(a=>[a.input_tokens,a.output_tokens,a.cache_read_tokens,a.cache_write_tokens]),[[22,14,0,0],[22,14,0,0]]);
  const totals=await new ObservabilityService(pool).usageByConversation();assert.deepEqual([totals[0]!.input_tokens,totals[0]!.output_tokens],[44,28]);
  assert.equal(mock.state.calls.length,4);assert.ok(JSON.stringify(mock.state.calls[2]!.body).includes('TURN_A 中文'),'second turn resumes context');
  assert.equal((await pool.query("SELECT COUNT(*)::int n FROM tool_calls WHERE business_kind='chat' AND business_id=$1 AND native_tool_call_id<>''",[`conv-${id}`])).rows[0].n,2);
  assert.equal(await projectActivity(pool),0,'repeated projection is idempotent');
 }finally{release();await conversations.shutdown();resetPiRuntime();mock.server.closeAllConnections();await new Promise<void>(r=>mock.server.close(()=>r()));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});}
});
