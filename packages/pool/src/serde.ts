/**
 * Versioned snapshot encoding for Pool state. bigints and Maps don't survive
 * JSON, so both are wrapped in tagged objects. The verifier function is NOT
 * serialized — it is re-injected on restore (see Pool.fromJSON).
 */
import type { PoolSnapshot } from "./pool.js";

const VERSION = 1;

export function encodeSnapshot(s: PoolSnapshot): string {
  return JSON.stringify({ version: VERSION, snapshot: s }, (_k, v: unknown) => {
    if (typeof v === "bigint") return { $bigint: v.toString() };
    if (v instanceof Map) return { $map: [...v.entries()] };
    return v;
  });
}

export function decodeSnapshot(json: string): PoolSnapshot {
  const parsed: unknown = JSON.parse(json, (_k, v: unknown) => {
    if (typeof v === "object" && v !== null) {
      if ("$bigint" in v) return BigInt((v as { $bigint: string }).$bigint);
      if ("$map" in v) return new Map((v as { $map: [unknown, unknown][] }).$map);
    }
    return v;
  });
  const env = parsed as { version?: number; snapshot?: PoolSnapshot };
  if (env.version !== VERSION || env.snapshot === undefined) {
    throw new Error(`unsupported pool snapshot version: ${String(env.version)}`);
  }
  return env.snapshot;
}
