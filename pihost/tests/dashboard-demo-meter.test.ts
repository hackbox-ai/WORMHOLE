import assert from 'node:assert/strict';
import {test} from 'node:test';
import {demoTokenUsage} from '../../web/src/lib/mock/token-meter.ts';
test('dashboard demo keeps aggregates, filters and call details compatible with the ledger API',()=>{
 const q=(v:string)=>new URLSearchParams(v);
 const all:any=demoTokenUsage(q('days=7'));
 assert.equal(all.daily.length,7);assert.equal(all.summary.calls,60);
 assert.equal(all.daily.reduce((n:number,r:any)=>n+r.total_tokens,0),all.summary.total_tokens);
 const selected:any=demoTokenUsage(q('days=7&profile=profile:2&source=modeling'));
 const detail:any=demoTokenUsage(q('days=7&profile=profile:2&source=modeling&page_size=100'),true);
 assert.equal(detail.items.reduce((n:number,r:any)=>n+r.total_tokens,0),selected.summary.total_tokens);
 assert.ok(detail.items.every((r:any)=>r.profile_key==='profile:2'&&r.source==='modeling'));
 const empty:any=demoTokenUsage(q('days=7&profile=profile:999'));assert.equal(empty.summary.total_tokens,0);
});
