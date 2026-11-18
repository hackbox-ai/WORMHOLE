import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {Pool} from 'pg';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {generalTools} from '../src/domains/tools/general.ts';
import {assembleTools} from '../src/domains/tools/assembly.ts';
import {LlmService} from '../src/domains/llm/service.ts';
import {createHostedSession,resetPiRuntime} from '../src/pi/session-host.ts';
import {startMockAnthropic} from './fixtures/mock-anthropic.ts';

const base=loadConfig(),schema=`codex_general_${process.pid}_${Date.now()}`,admin=new Pool({connectionString:base.database.dsn});await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});await runMigrations(pool);
const dir=await mkdtemp(path.join(tmpdir(),'wormhole-general-')),a=path.join(dir,'a'),b=path.join(dir,'b');await mkdir(a);await mkdir(b);
const ctx={businessKind:'chat',businessId:'files',agentKey:'mainagent'},gate={},tools=await generalTools(pool,a,ctx,gate);
const invoke=async(name:string,params:unknown,signal?:AbortSignal)=>(tools.tools.find(t=>t.name===name)!.execute as any)(`general-${name}`,params,signal);
after(async()=>{await tools.dispose();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

test('Norma file schemas through gate: Pi read/write/edit and atomic MultiEdit failure',async()=>{
  await invoke('Write',{file_path:'test.txt',content:'alpha\nbeta\n'});
  assert.match((await invoke('Read',{file_path:'test.txt',offset:2,limit:1})).content[0].text,/2\tbeta/);
  await invoke('Edit',{file_path:'test.txt',old_string:'alpha',new_string:'first'});
  await assert.rejects(invoke('MultiEdit',{file_path:'test.txt',edits:[{old_string:'first',new_string:'changed'},{old_string:'missing',new_string:'never'}]}),/match/);
  assert.equal(await readFile(path.join(a,'test.txt'),'utf8'),'first\nbeta\n');
  await invoke('MultiEdit',{file_path:'test.txt',edits:[{old_string:'first',new_string:'updated'},{old_string:'beta',new_string:'second'}]});
  assert.equal(await readFile(path.join(a,'test.txt'),'utf8'),'updated\nsecond\n');
  assert.match((await invoke('LS',{})).content[0].text,/test.txt/);
  assert.match((await invoke('Glob',{pattern:'**/*.txt'})).content[0].text,/test.txt/);
  assert.match((await invoke('Grep',{pattern:'second',output_mode:'content'})).content[0].text,/test.txt:2:second/);
});

test('SDK Bash respects session cwd, pending approval, cancellation and session-owned jobs',async()=>{
  const other=await generalTools(pool,b,{...ctx,businessId:'other',agentKey:'worker'},{});
  try{
    assert.ok(!other.tools.some(t=>['MultiEdit','Glob','Grep'].includes(t.name)));
    const pwd=await invoke('Bash',{command:'pwd'});assert.equal(pwd.content[0].text.trim(),a);
    const denied=await generalTools(pool,a,{...ctx,businessId:'denied'},{rules:[{toolPattern:/^Bash$/,action:'ask'}],requestApproval:async()=> 'denied'});
    try{await assert.rejects((denied.tools.find(t=>t.name==='Bash')!.execute as any)('denied',{command:'touch denied.txt'}),/denied/);await assert.rejects(readFile(path.join(a,'denied.txt')));}finally{await denied.dispose();}
    const bg=await invoke('Bash',{command:'sleep 20',run_in_background:true});assert.match(bg.content[0].text,/task_1/);
    const others=await (other.tools.find(t=>t.name==='TaskList')!.execute as any)('other',{});assert.equal(others.content[0].text,'No background tasks.');
    await invoke('TaskStop',{task_id:'task_1'});assert.match((await invoke('TaskOutput',{task_id:'task_1'})).content[0].text,/stopped/);
    const abort=new AbortController(),pending=invoke('Bash',{command:'sleep 20'},abort.signal);setTimeout(()=>abort.abort(),80);await assert.rejects(pending,/abort|cancel/i);
  }finally{await other.dispose();}
});

test('real Pi session receives gated basic tools, writes/reads file and audits native call ids',async()=>{
  const sequence=[{name:'Write',input:{file_path:'pi.txt',content:'PI_FILE_EVIDENCE'}},{name:'Read',input:{file_path:'pi.txt'}}];
  const mock=await startMockAnthropic(0,{marker:'GENERAL_DONE',tool:(_body,n)=>sequence[n-1]});
  const config={...base,dataDir:dir,pi:{...base.pi,agentDir:path.join(dir,'agent'),modelsPath:path.join(dir,'models.json')}};await mkdir(config.pi.agentDir);
  const llm=new LlmService(pool,path.join(dir,'dlq'),config.pi.modelsPath);
  const p=await llm.createProfile({name:'general-mock',format:'anthropic',model:'mock-1',base_url:`http://127.0.0.1:${(mock.server.address() as {port:number}).port}`,api_key:'fixture'});
  assert.ok(p.ok);await llm.activate(Number(p.profile!.id));await llm.compileToPiRuntime();resetPiRuntime();
  let h:Awaited<ReturnType<typeof createHostedSession>>|undefined;
  try{
    h=await createHostedSession(pool,config,{kind:'worker',businessId:'native-files',cwd:b,systemPrompt:'Use Write then Read.',provider:`profile-${p.profile!.id}`,modelId:'mock-1',customTools:await assembleTools(pool,[],{...ctx,agentKey:'worker',businessId:'native-files'},gate)});
    await h.session.prompt('Write evidence, then read it.');await h.flushEvents();assert.equal(await readFile(path.join(b,'pi.txt'),'utf8'),'PI_FILE_EVIDENCE');
    assert.ok(h.session.messages.some((m:any)=>m.role==='toolResult'&&m.toolName==='Read'&&m.content.some((c:any)=>c.text.includes('PI_FILE_EVIDENCE'))));
    const calls=await pool.query("SELECT tool_key,native_tool_call_id,is_error FROM tool_calls WHERE business_id='native-files' ORDER BY id");assert.deepEqual(calls.rows.map(r=>r.tool_key),['Write','Read']);assert.ok(calls.rows.every(r=>r.native_tool_call_id&&!r.is_error));
  }finally{await h?.dispose();mock.server.closeAllConnections();await new Promise<void>(resolve=>mock.server.close(()=>resolve()));}
});
