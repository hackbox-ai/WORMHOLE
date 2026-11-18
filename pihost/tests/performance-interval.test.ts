import assert from 'node:assert/strict';
import {test} from 'node:test';
import {performanceInterval} from '../src/domains/observability/performance-interval.ts';
test('growth baselines preserve exact large counters, signed compaction and task/time boundaries',()=>{
  const before={format:'wormhole-task-performance',version:1,task:{id:'1'},capturedAt:'2026-10-18T00:00:00Z',
    model:{calls:'2',input_tokens:'9007199254740993123',output_tokens:'20'},tools:{calls:'4'},
    storage:{events:{rows:'100',live_payload_field_bytes:'2000'},archives:{frame_bytes:'100'},recordings:{packed_field_bytes:'100'}},artifacts:{unique_stored_bytes:'300'}};
  const after=structuredClone(before);after.capturedAt='2026-10-18T00:30:00Z';after.model.calls='5';after.model.input_tokens='9007199254740993124';after.storage.events.live_payload_field_bytes='1000';
  const report=performanceInterval(before,after);assert.equal(report.delta.inputTokens,'1');assert.equal(report.delta.eventPayloadFieldBytes,'-1000');assert.equal(report.approximateRatesPerHour.modelCalls,6);
  assert.throws(()=>performanceInterval(before,before),/capture times/);assert.throws(()=>performanceInterval(before,{...after,task:{id:'2'}}),/same task/);
  assert.throws(()=>performanceInterval(before,{...after,model:{}}),/counter/);assert.throws(()=>performanceInterval({},after),/unsupported/);
});
