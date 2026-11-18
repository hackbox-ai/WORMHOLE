/** Optional real supplier smoke; credentials remain in runtime files, all business writes are isolated. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {Type} from 'typebox';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {createHostedSession,resetPiRuntime,setCallRecorder} from '../src/pi/session-host.ts';
import {LlmRecords} from '../src/domains/observability/records.ts';
import {expandRecordBodies} from '../src/storage/record-body.ts';
import {registerTool,runTool} from '../src/domains/tools/gate.ts';
test('真实供应商：Pi tool_use→最终门→本地echo→结果回模型→usage与原文持久化', {skip:process.env.RUN_REAL_MODEL_FIXTURE!=='1'}, async()=>{
 const base=loadConfig(),runtime=JSON.parse(await readFile(process.env.WORMHOLE_REAL_CONFIG??'/var/lib/wormhole/config.json','utf8'));
 const sourceModels=JSON.parse(await readFile(runtime.pi.modelsPath,'utf8')),provider=String(runtime.pi.provider),modelId=String(runtime.pi.modelId);assert.ok(sourceModels.providers?.[provider],'configured supplier exists');
 const suffix=`${process.pid}_${Date.now()}`,schema=`codex_real_model_${suffix}`,admin=new Pool({connectionString:base.database.dsn}),dir=await mkdtemp(path.join(tmpdir(),'wormhole-real-model-'));let pool:Pool|undefined,host:Awaited<ReturnType<typeof createHostedSession>>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});await runMigrations(pool);
  const agentDir=path.join(dir,'agent');await mkdir(agentDir);const modelsPath=path.join(agentDir,'models.json');await writeFile(modelsPath,JSON.stringify({providers:{[provider]:sourceModels.providers[provider]}}),{mode:0o600});
  await pool.query("INSERT INTO app_settings(key,value) VALUES('settings.llm_record','true')");const writer=new LlmRecords(pool);setCallRecorder((entry,on)=>writer.recordCall(entry,on,entry.businessKind));resetPiRuntime();
  const nonce='REAL_LOOP_'+suffix;let count=0;registerTool({key:'fixture_echo',description:'本地验证：返回nonce，无外部副作用',schema:Type.Object({nonce:Type.String()}),params:{nonce:'string'},required:['nonce'],execute:async params=>{assert.equal(params.nonce,nonce);count++;return {nonce};}});
  const config={...base,dataDir:dir,pi:{agentDir,modelsPath,provider,modelId}};
  host=await createHostedSession(pool,config,{kind:'chat',businessId:'real-model-'+suffix,systemPrompt:'执行一次本地工具测试。必须调用fixture_echo一次，然后直接回答工具返回的nonce。',customTools:[{name:'fixture_echo',label:'fixture_echo',description:'返回给定nonce',parameters:Type.Object({nonce:Type.String()}),execute:async(nativeId,params,signal)=>{const result=await runTool(pool!,'fixture_echo',params,{businessKind:'chat',businessId:'real-model-'+suffix,agentKey:'auto',nativeToolCallId:nativeId,signal});if(result.status!=='executed')throw new Error(result.status);return {content:[{type:'text',text:JSON.stringify(result.output)}],details:{toolCallId:result.toolCallId}};}}]});
  timer=setTimeout(()=>void host?.session.abort(),45000);await host.session.prompt(`调用fixture_echo，nonce必须是${nonce}。工具只调用一次。`);await host.flushEvents();if(host.modelFailure)throw new Error(host.modelFailure);
  assert.equal(count,1);const final=host.session.messages.filter(m=>m.role==='assistant').at(-1);assert.ok(final);assert.match(JSON.stringify(final.content),new RegExp(nonce));
  const usage=(await pool.query('SELECT input_tokens,output_tokens,status FROM llm_usage')).rows,records=await Promise.all((await pool.query('SELECT * FROM llm_records')).rows.map(expandRecordBodies)),audit=(await pool.query("SELECT native_tool_call_id,is_error FROM tool_calls WHERE tool_key='fixture_echo'")).rows;
  assert.ok(usage.length>=2);assert.equal(records.length,usage.length);assert.ok(records.every(r=>r.raw_request&&r.raw_response));assert.ok(records.some(r=>r.raw_request.includes('tool_result')&&r.raw_request.includes(nonce)));assert.equal(audit.length,1);assert.ok(audit[0].native_tool_call_id);assert.equal(audit[0].is_error,false);
  console.log(JSON.stringify({provider,model:modelId,toolExecutions:count,usageCalls:usage.length,recordings:records.length,inputTokens:usage.reduce((n,r)=>n+Number(r.input_tokens),0),outputTokens:usage.reduce((n,r)=>n+Number(r.output_tokens),0)}));
 }finally{if(timer)clearTimeout(timer);await host?.dispose();setCallRecorder(null);resetPiRuntime();await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();await rm(dir,{recursive:true,force:true});}
});
