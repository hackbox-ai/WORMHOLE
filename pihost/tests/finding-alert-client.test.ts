import assert from 'node:assert/strict';import {test} from 'node:test';
import {emptyAlerts,loadAlerts,mergeAlerts,soundMatches,type FindingNotice} from '../../web/src/lib/finding-alerts.ts';
const notice=(id:string,severity='high'):FindingNotice=>({id,finding_id:id,task_id:'4',name:'new',severity,task_name:'task',created_at:new Date().toISOString()});
test('dedup persists across reload; late lower IDs remain new; preserves preferences and read state',()=>{
 const a=mergeAlerts({...emptyAlerts,sound:true},[notice('5')],'a');a.state.items[0]!.read=true;
 const loaded=loadAlerts(JSON.stringify(a.state)),b=mergeAlerts(loaded,[notice('5'),notice('3'),notice('3')],'b');
 assert.deepEqual(b.fresh.map(i=>i.finding_id),['3']);assert.equal(b.state.items[1]!.read,true);assert.equal(b.state.sound,true);assert.equal(b.state.cursor,'b');
 assert.equal(mergeAlerts(loadAlerts(JSON.stringify(b.state)),[notice('3')],'c').fresh.length,0);
});
test('batch retention is bounded and sound threshold filters the whole batch',()=>{
 const state=mergeAlerts(emptyAlerts,Array.from({length:2500},(_,i)=>notice(String(i))),'c').state;
 assert.equal(state.items.length,100);assert.equal(state.seen.length,2000);assert.equal(state.items[0]!.finding_id,'2499');
 assert.equal(soundMatches([notice('1','low')],'high'),false);assert.equal(soundMatches([notice('1','low'),notice('2','critical')],'high'),true);
});
test('corrupted preferences load safely',()=>{
 assert.equal(loadAlerts('invalid').sound,false);assert.equal(loadAlerts('{"volume":22,"minSound":"bad"}').volume,1);assert.equal(loadAlerts('{"minSound":"bad"}').minSound,'all');
});
