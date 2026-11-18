import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeTokenUsage } from '../../web/src/lib/token-usage.ts';

test('dashboard: cache-heavy live usage retains uncached input and counts all tokens exactly once', () => {
  const usage = summarizeTokenUsage({input: 5759019, output: 1038412, cacheRead: 17185536, cacheWrite: 0});
  assert.equal(usage.input, 5759019);
  assert.equal(usage.totalInput, 22944555);
  assert.equal(usage.total, 23982967);
  assert.equal(usage.cacheHitPercent, 75);
  assert.equal(usage.input + usage.cacheRead + usage.cacheWrite + usage.output, usage.total);
});

test('dashboard: cache creation is a separate input category, not a cache hit', () => {
  const usage = summarizeTokenUsage({input: 100, output: 20, cacheRead: 300, cacheWrite: 200});
  assert.equal(usage.totalInput, 600);
  assert.equal(usage.total, 620);
  assert.equal(usage.cacheHitPercent, 50);
  assert.equal(usage.input, 100);
});

test('dashboard: empty, cache-only and no-cache usage have finite, bounded percentages', () => {
  for (const [input, output, cacheRead, cacheWrite, total, rate] of [
    [0, 0, 0, 0, 0, 0], [0, 20, 300, 0, 320, 100], [100, 20, 0, 0, 120, 0],
  ]) {
    const usage = summarizeTokenUsage({input, output, cacheRead, cacheWrite});
    assert.equal(usage.total, total);
    assert.equal(usage.cacheHitPercent, rate);
  }
});
