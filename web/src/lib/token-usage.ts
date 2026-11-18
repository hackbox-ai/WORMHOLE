/**
 * Session activity and the call ledger both store disjoint usage counters:
 * input is uncached input; cache reads and cache writes are separate categories.
 */
export function summarizeTokenUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}) {
  const count = (value: number) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  const totalInput = input + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalInput,
    total: totalInput + output,
    cacheHitPercent: totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0,
  };
}
