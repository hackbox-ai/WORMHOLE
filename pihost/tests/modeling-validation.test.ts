import assert from'node:assert/strict';
import{test}from'node:test';
import{validateDocument,skeleton}from'../src/domains/modeling/document.ts';
test('modeling validation points to the missing response description without discarding content',()=>{
 const document={...skeleton('fixture','http://fixture.test'),paths:{'/health':{get:{
   description:'operation description is not a response description',
   responses:{'200':{content:{'application/json':{schema:{type:'object'}}}},summary:'wrong level'},
 }}}};
 const errors=validateDocument(document);
 assert.ok(errors.some(e=>e.includes('GET /health.responses["200"].description 必须是字符串')));
 assert.ok(errors.some(e=>e.includes('responses["summary"] 键须为 HTTP 状态码')));
 const response=document.paths['/health'].get.responses['200'] as any;
 response.description='成功';delete (document.paths['/health'].get.responses as any).summary;
 assert.deepEqual(validateDocument(document,true),[]);
 assert.ok(response.content['application/json'].schema);
});
