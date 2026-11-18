import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEntry,productKey,versionApplicability,type RawEntry} from '../src/domains/pocs/catalog.ts';
const source={key:'fixture',type:'nuclei' as const};
const raw=(body:string):RawEntry=>({native_id:'fixture.yaml',raw:body});
test('numeric version boundaries preserve strict comparisons, missing and unsupported ranges remain unknown',()=>{
 assert.equal(versionApplicability('2.0','<2.0'),'excluded');assert.equal(versionApplicability('2.0','<=2.0'),'matched');assert.equal(versionApplicability('1.5','>=1.0 <2.0'),'matched');assert.equal(versionApplicability('5.1','5.x'),'matched');assert.equal(versionApplicability('','<2.0'),'unknown');assert.equal(versionApplicability('1.0','all releases before foo'),'unknown');assert.equal(versionApplicability('1.0rc1','<2.0'),'unknown');
});
test('static normalization retains source code and separates technology, workflows and protocol requirements',()=>{
 const e=normalizeEntry(source,raw('id: nginx-test\ninfo:\n  name: Controlled technology\n  severity: info\n  tags: tech\n  metadata:\n    product: nginx\nhttp:\n  - method: GET\n    path: ["{{BaseURL}}/"]\n'),'a');assert.deepEqual(e.products,['nginx']);assert.equal(e.kind,'technology');assert.ok(e.requirements.includes('http'));assert.ok(e.diagnostics.some(d=>d.includes('结构化')));
 const workflow=normalizeEntry(source,raw('id: workflow-test\ninfo: {name: workflow}\nworkflows: [{template: test.yaml}]'),'a');assert.equal(workflow.kind,'workflow');assert.ok(workflow.requirements.includes('workflow'));
 assert.equal(productKey('H3C'),'h3c');assert.notEqual(productKey('h3c'),productKey('h'));assert.equal(productKey('Apache Tomcat'),'apachetomcat');
});
test('duplicate YAML fields, missing identity, oversized content and alias bombs fail without running code',()=>{
 assert.throws(()=>normalizeEntry(source,raw('id: a\nid: b'),'a'),/YAML/);assert.throws(()=>normalizeEntry(source,raw('info: {name: no-id}'),'a'),/id/);
 assert.throws(()=>normalizeEntry(source,{native_id:'x',raw:'x'.repeat(16*1024*1024+1)},'a'),/16 MiB/);
 const python='import os\nos.system("MUST NEVER EXECUTE")';const e=normalizeEntry({key:'legacy',type:'legacy-python'},{native_id:'fixture/check',raw:python,metadata:{registry:{product:'fixture',unsupported:['blind_test']},catalog:{name:'Fixture'}}},'a');assert.equal(e.raw,python);assert.ok(e.requirements.includes('blind_test'));
});
