/**
 * Pool persistence. Serverless has no memory between invocations, so the pool
 * lives as a versioned JSON snapshot in KV. The memory store runs the SAME
 * serialize→deserialize path on every access so serde bugs surface in dev,
 * not in production.
 */
import { Pool } from "@citely-pay/pool";
import type { SaVerifier } from "@citely-pay/pool";

export interface PoolStore {
  withPool<T>(fn: (pool: Pool) => Promise<T> | T): Promise<T>;
}

export interface StoreConfig {
  readonly feeBps: bigint;
  readonly verify: SaVerifier;
  /** Seeds a brand-new pool (e.g. demo LP deposit). Runs exactly once. */
  readonly boot: (pool: Pool) => void;
}

export function makeMemoryStore(config: StoreConfig): PoolStore {
  let blob: string | undefined;
  return {
    async withPool(fn) {
      let pool: Pool;
      if (blob === undefined) {
        pool = new Pool({ feeBps: config.feeBps, verify: config.verify });
        config.boot(pool);
      } else {
        pool = Pool.fromJSON(blob, config.verify);
      }
      const result = await fn(pool);
      blob = pool.toJSON();
      return result;
    },
  };
}

/** Upstash Redis REST. Optimistic lock: version key must not move mid-write. */
export function makeKvStore(opts: StoreConfig & { url: string; token: string }): PoolStore {
  const call = async (command: unknown[]): Promise<unknown> => {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!res.ok) throw new Error(`kv error ${res.status}`);
    const body = (await res.json()) as { result: unknown };
    return body.result;
  };

  const attempt = async <T>(fn: (pool: Pool) => Promise<T> | T): Promise<{ ok: boolean; result?: T }> => {
    const [blob, version] = (await Promise.all([call(["GET", "pool-state"]), call(["GET", "pool-version"])])) as [
      string | null, string | null,
    ];
    let pool: Pool;
    if (blob === null) {
      pool = new Pool({ feeBps: opts.feeBps, verify: opts.verify });
      opts.boot(pool);
    } else {
      pool = Pool.fromJSON(blob, opts.verify);
    }
    const result = await fn(pool);
    const next = Number(version ?? 0) + 1;
    // Compare-and-set via Lua-free two-step: re-read version; if unchanged, write both.
    const current = (await call(["GET", "pool-version"])) as string | null;
    if ((current ?? null) !== (version ?? null)) return { ok: false };
    await call(["MSET", "pool-state", pool.toJSON(), "pool-version", String(next)]);
    return { ok: true, result };
  };

  return {
    async withPool(fn) {
      const first = await attempt(fn);
      if (first.ok) return first.result as Awaited<ReturnType<typeof fn>>;
      const second = await attempt(fn); // one retry on version conflict
      if (second.ok) return second.result as Awaited<ReturnType<typeof fn>>;
      throw new Error("pool store write conflict; retry the request");
    },
  };
}
