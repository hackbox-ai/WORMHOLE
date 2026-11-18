import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compareJson} from '../scripts/equiv-core.ts';
test('G15 full nested arrays beyond index20; business values, root scalars and missing keys never masked',()=>{
 const a={records:Array.from({length:105},(_,i)=>({id:i,messages:[{content:'same',count:i}],ts:'2026-10-11T00:00:00Z'})),count:105},b=structuredClone(a);
 b.records[104]!.messages[0]!.content='different';b.records[87]!.id=999;b.records[77]!.ts='2026-10-12T00:00:00Z';b.count=104;
 const diff=compareJson(a,b);assert.deepEqual(diff.map(d=>d.path),['$.records[77].ts','$.records[87].id','$.records[104].messages[0].content','$.count']);
 assert.equal(compareJson(1,2).length,1);assert.equal(compareJson({x:null},{x:[]})[0]!.kind,'type');assert.equal(compareJson({value:1},{})[0]!.kind,'missing-in-pihost');assert.equal(compareJson(a,structuredClone(a)).length,0);
});
test('G15 stores every difference; array tail/length, null and false are distinct',()=>{
 const left=Array.from({length:400},(_,i)=>i),right=left.map(i=>i+1);assert.equal(compareJson(left,right).length,400);
 assert.equal(compareJson(left,left.slice(0,350)).length,51);assert.equal(compareJson(null,false)[0]!.kind,'type');
});
