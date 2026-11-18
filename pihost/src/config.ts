import { readFileSync } from "node:fs";
import type {EfficiencyOptions} from './domains/tasks/efficiency.ts';
import {storagePolicy,type StoragePolicy} from './storage/policy.ts';
import type {CodeIntelOptions} from './domains/codeintel/service.ts';
import type {HuntingOptions} from './domains/hunting/service.ts';

export interface PiRuntimeConfig {
  /** Pi models.json Path (independent of old WORMHOLE of ~/.pi/agent） */
  modelsPath: string;
  /** Pi agentDir（skills/extensions Wait for resource root; do not read old WORMHOLE Environment） */
  agentDir: string;
  provider: string;
  modelId: string;
}

export interface PihostConfig {
  storage?:Partial<StoragePolicy>;
  efficiency?:Partial<EfficiencyOptions>;
  /** Target code index and static audit (white box product) access parameters */
  codeIntel?:Partial<CodeIntelOptions>;
  hunting?:Partial<HuntingOptions>;
  listen: { host: string; port: number };
  database: { dsn: string };
  dataDir: string;
  pi: PiRuntimeConfig;
}

/**
 * Configuration loading. Priority: environment variables WORMHOLE_CONFIG Specified JSON File，
 * Next this directory config.local.json，Finally built in default value. Database credentials are only placed in
 * Not stored in the runtime configuration file (see /var/lib/wormhole/config.json）。
 */
export function loadConfig(): PihostConfig {
  const defaults: PihostConfig = {
    listen: { host: "127.0.0.1", port: 18887 },
    database: { dsn: "" },
    dataDir: "./data",
    pi: { modelsPath: "", agentDir: "", provider: "glm", modelId: "glm-5.3-flash" },
  };
  const path = process.env.WORMHOLE_CONFIG ?? "config.local.json";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (process.env.WORMHOLE_CONFIG) {
      throw new Error(`[config] Unable to read WORMHOLE_CONFIG=${path}: ${err}`);
    }
    return defaults;
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const listen = (obj.listen ?? {}) as Record<string, unknown>;
  const database = (obj.database ?? {}) as Record<string, unknown>;
  const pi = (obj.pi ?? {}) as Record<string, unknown>;
  return {
    storage:storagePolicy((obj.storage??{}) as Partial<StoragePolicy>),
    ...(obj.codeIntel&&typeof obj.codeIntel==='object'?{codeIntel:obj.codeIntel as Partial<CodeIntelOptions>}:{}),
    ...(obj.hunting&&typeof obj.hunting==='object'?{hunting:obj.hunting as Partial<HuntingOptions>}:{}),
    efficiency:typeof obj.efficiency==='object'&&obj.efficiency!==null?obj.efficiency as Partial<EfficiencyOptions>:undefined,
    listen: {
      host: typeof listen.host === "string" ? listen.host : defaults.listen.host,
      port: typeof listen.port === "number" ? listen.port : defaults.listen.port,
    },
    database: {
      dsn: typeof database.dsn === "string" ? database.dsn : defaults.database.dsn,
    },
    dataDir: typeof obj.dataDir === "string" ? (obj.dataDir as string) : defaults.dataDir,
    pi: {
      modelsPath: typeof pi.modelsPath === "string" ? pi.modelsPath : defaults.pi.modelsPath,
      agentDir: typeof pi.agentDir === "string" ? pi.agentDir : defaults.pi.agentDir,
      provider: typeof pi.provider === "string" ? pi.provider : defaults.pi.provider,
      modelId: typeof pi.modelId === "string" ? pi.modelId : defaults.pi.modelId,
    },
  };
}
