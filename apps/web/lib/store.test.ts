import { describe, expect, it } from "vitest";
import type { SaVerifier } from "@citely-pay/pool";
import { makeMemoryStore } from "./store.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp" });
const T0 = 1_756_700_000_000;

describe("memory store (same serialize path as KV)", () => {
  it("persists pool mutations across withPool calls via serialization", async () => {
    const store = makeMemoryStore({ feeBps: 2000n, verify: PASS, boot: (p) => p.deposit("lp-demo", 100n) });
    await store.withPool(async (pool) => {
      pool.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n, txHash: "0xe1" });
      await pool.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
        amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: T0 + 1000 });
      pool.confirmPayout("a1", "0xtx1");
    });
    const liquidity = await store.withPool((pool) => {
      pool.releaseEscrow("inv-1", T0 + 500);
      return pool.state().liquidity;
    });
    expect(liquidity).toBe(101n); // 100 - 4 + 5
    const state = await store.withPool((pool) => pool.state());
    expect(state.escrows.get("inv-1")?.status).toBe("RELEASED");
    expect(state.pendingResidual.get("inv-1")).toBe(1n);
  });

  it("boots the seed exactly once", async () => {
    const store = makeMemoryStore({ feeBps: 2000n, verify: PASS, boot: (p) => p.deposit("lp-demo", 100n) });
    await store.withPool(() => undefined);
    const deposits = await store.withPool((pool) => pool.ledger().filter((e) => e.kind === "DEPOSIT").length);
    expect(deposits).toBe(1);
  });
});
