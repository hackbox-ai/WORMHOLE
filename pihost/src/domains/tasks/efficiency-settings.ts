import type {Pool} from 'pg';
import {efficiencyOptions, type EfficiencyOptions} from './efficiency.ts';

export const EFFICIENCY_KEY = 'settings.task_efficiency';
/** Read on every supervision check / new session. No process restart required. */
export async function readEfficiencyOptions(pool: Pick<Pool, 'query'>, fallback?: Partial<EfficiencyOptions>): Promise<EfficiencyOptions> {
  const value = (await pool.query('SELECT value FROM app_settings WHERE key=$1', [EFFICIENCY_KEY])).rows[0]?.value;
  const stored = value ? JSON.parse(String(value)) : {};
  return efficiencyOptions({...fallback, ...stored});
}

export function validateEfficiencyPatch(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return "task_efficiency should be a configuration object";
  const defaults = efficiencyOptions();
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(defaults,key)) return `Unknown task budget item ${key}`;
    if (key === 'enabled') {
      if (typeof v !== 'boolean') return "enabled should be a boolean";
    } else if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return `${key} Requires a non-negative safe integer`;
  }
  return null;
}
