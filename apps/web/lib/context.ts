/**
 * Assembly point: fixtures + verifier + chain adapter + store, built once per
 * process. KV when configured, memory otherwise (dev/demo fallback).
 */
import { pickAdapter } from "@citely-pay/chain";
import type { ChainAdapter } from "@citely-pay/chain";
import { demoFixtures, makeSaVerifier } from "@citely-pay/verify-adapter";
import type { Address } from "viem";
import { makeMemoryStore, makeKvStore } from "./store";
import type { PoolStore } from "./store";

export const DEMO = {
  agentId: "854638",
  feeBps: 2000n,
  lpSeed: 10_000_000_000n, // 10,000 USDC
  poolAddress: "0x2222222222222222222222222222222222222222" as Address,
  importerAddress: "0x3333333333333333333333333333333333333333" as Address,
} as const;

export interface AppContext {
  store: PoolStore;
  chain: ChainAdapter;
  fixtures: Awaited<ReturnType<typeof demoFixtures>>;
  verify: ReturnType<typeof makeSaVerifier>;
}

let ctx: Promise<AppContext> | undefined;

export function getAppContext(): Promise<AppContext> {
  ctx ??= build();
  return ctx;
}

async function build(): Promise<AppContext> {
  const fixtures = await demoFixtures();
  const verify = makeSaVerifier({ registeredSigners: fixtures.signers, sas: fixtures.sas });
  const chain = pickAdapter(process.env);
  const boot = (pool: import("@citely-pay/pool").Pool): void => pool.deposit("lp-demo", DEMO.lpSeed);
  const kvUrl = process.env["KV_URL"];
  const kvToken = process.env["KV_TOKEN"];
  const store = kvUrl && kvToken
    ? makeKvStore({ feeBps: DEMO.feeBps, verify, boot, url: kvUrl, token: kvToken })
    : makeMemoryStore({ feeBps: DEMO.feeBps, verify, boot });
  return { store, chain, fixtures, verify };
}

/** Test hook: swap the whole context (memory store, fixed chain). */
export function __setAppContext(next: Promise<AppContext>): void {
  ctx = next;
}
