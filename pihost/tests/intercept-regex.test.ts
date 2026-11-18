import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {Pool} from 'pg';
import {RE2JS} from 're2js';
import {loadConfig} from '../src/config.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {InterceptService} from '../src/domains/intercept/service.ts';
import {evaluateRules,runTool,registerTool} from '../src/domains/tools/gate.ts';

test('Go regexp full default rule corpus and syntax boundaries; default gate loads and actually blocks',async()=>{
 const base=loadConfig(),schema=`codex_regex_${process.pid}_${Date.now()}`,admin=new Pool({connectionString:base.database.dsn});
 await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});
 try{
  await runMigrations(pool);const svc=new InterceptService(pool,'/tmp/regex-fixture-unused');
  const rules=await svc.listRules();assert.equal(rules.filter(r=>String(r.name).startsWith('[内置]')).length,20);
  const subjects=["rm -rf /", "RM -RF /tmp/x", "rm --recursive /etc", "mkfs /dev/vdb", "dd if=x of=/dev/sda", "reboot", "kill -9 -1", "DROP TABLE records", "drop database fixture", "TRUNCATE TABLE rows", "client.delete(\"/thing\")", "curl -XDELETE http://local/rows", "redis FLUSHALL", "GET /clear/", "echo harmless", "AbCDEF", "abcDEF", "abc\nDEF", "中文É", "abc123", "A\nB"];
  const syntax=["(?i)abc", "(?i:abc)DEF", "(?m)^B$", "(?s)a.b", "(?P<cmd>abc)", "[[:alpha:]]+", "\\p{Han}+", "\\Aabc\\z", "a{0,1000}", "(?U)a+", "(?=a)", "(?<=a)b", "(a)\\1", "a{1001}", "[", "*"];
  const cases=[...rules.map(r=>String(r.pattern)),...syntax].map(Pattern=>({Pattern,Subjects:subjects}));
  const original=await new Promise<any[]>((resolve,reject)=>{const child=spawn('/usr/local/go/bin/go',['run','tests/fixtures/go-regexp-probe.go'],{cwd:process.cwd()});let out='',err='';child.stdout.setEncoding('utf8');child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{try{if(code)reject(new Error(err));else resolve(JSON.parse(out));}catch(error){reject(error);}});child.stdin.end(JSON.stringify(cases));});
  const target=cases.map(c=>{try{const re=RE2JS.compile(c.Pattern);return {matches:c.Subjects.map(s=>re.test(s))};}catch(error){return {error:(error as Error).message};}});
  assert.deepEqual(target,original,'every default + custom pattern, every subject, including compiler errors');
  const compiled=await svc.gateRules();assert.equal(compiled.length,rules.filter(r=>r.enabled).length,'disabled defaults remain excluded');
  assert.equal(evaluateRules(compiled,'Bash',{command:'RM -RF /tmp/x'}).action,'block');
  assert.equal(evaluateRules(compiled,'Bash',{command:'echo harmless'}).action,'allow');
  let effects=0;registerTool({key:'Bash',description:'no shell fixture',params:{command:'string'},required:['command'],execute:async()=>++effects});
  const result=await runTool(pool,'Bash',{command:'rm -rf /'}, {businessKind:'fixture',businessId:'default-regex',agentKey:'worker'}, {rules:compiled});
  assert.equal(result.status,'blocked');assert.equal(effects,0);
  await pool.query("INSERT INTO intercept_rules(name,match_target,match_type,pattern,action,enabled) VALUES('legacy-invalid','tool_input','regex','[','deny',true)");
  assert.equal((await svc.gateRules()).length,compiled.length,'invalid legacy row skipped, valid rules retained');
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

test('approved valid-type edits and late cancellation never change the reviewed side effect',async()=>{
 const base=loadConfig(),schema=`codex_gate_boundary_${process.pid}_${Date.now()}`,admin=new Pool({connectionString:base.database.dsn});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:base.database.dsn,options:`-c search_path=${schema}`});
 try{
  await runMigrations(pool);let effects=0;registerTool({key:'review-boundary',description:'probe',params:{value:'string'},required:['value'],execute:async()=>++effects});
  const ctx={businessKind:'fixture',businessId:'boundary',agentKey:'worker'},params={value:'approved-original'};
  const changed=await runTool(pool,'review-boundary',params,ctx,{rules:[{toolPattern:/^review-boundary$/,action:'ask'}],requestApproval:async()=>{params.value='unreviewed-effect';return 'approved';}});
  assert.equal(changed.status,'blocked');assert.match(changed.error!,/参数已变更/);assert.equal(effects,0);
  const ctrl=new AbortController(),cancelled=await runTool(pool,'review-boundary',{value:'safe'},{...ctx,signal:ctrl.signal,beforeExecute:async()=>{ctrl.abort();}},{rules:[]});
  assert.equal(cancelled.status,'blocked');assert.match(cancelled.error!,/取消/);assert.equal(effects,0);
  const calls=(await pool.query('SELECT is_error,error_text FROM tool_calls ORDER BY id')).rows;assert.equal(calls.length,2);assert.ok(calls.every(c=>c.is_error));
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
