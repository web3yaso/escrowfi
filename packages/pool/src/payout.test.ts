import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp", agentId: "854638" });
const T0 = 1_756_700_000_000; // arbitrary epoch ms
const DUE = T0 + 30 * 86_400_000;

function funded() {
  const pool = new Pool({ feeBps: 2000n, verify: PASS });
  pool.deposit("lp-1", 10n);
  return pool;
}

async function requested(pool: Pool) {
  const r = await pool.requestAdvance({
    advanceId: "a1", saHash: "0xsa", payee: "0xexp", amount: 5n,
    advancedAt: T0, dueAt: DUE,
  });
  if (!r.ok) throw new Error("expected ok");
  return r.advance;
}

describe("three-state payout", () => {
  it("requestAdvance locks quota as PENDING_PAYOUT without external outflow", async () => {
    const pool = funded();
    const adv = await requested(pool);
    expect(adv.status).toBe("PENDING_PAYOUT");
    expect(adv.advancedAt).toBe(T0);
    expect(adv.dueAt).toBe(DUE);
    expect(pool.state().liquidity).toBe(5n);
    expect(pool.state().pendingPayout).toBe(5n);
    expect(pool.state().outstanding).toBe(0n);
  });

  it("confirmPayout moves PENDING_PAYOUT to OUTSTANDING with txHash", async () => {
    const pool = funded();
    await requested(pool);
    const adv = pool.confirmPayout("a1", "0xtx1");
    expect(adv.status).toBe("OUTSTANDING");
    expect(adv.payoutTxHash).toBe("0xtx1");
    expect(pool.state().pendingPayout).toBe(0n);
    expect(pool.state().outstanding).toBe(5n);
    expect(pool.ledger().some(e => e.kind === "PAYOUT_CONFIRMED" && e.txHash === "0xtx1")).toBe(true);
  });

  it("cancelPayout rolls the quota back completely (inv 7)", async () => {
    const pool = funded();
    await requested(pool);
    const adv = pool.cancelPayout("a1");
    expect(adv.status).toBe("CANCELLED");
    expect(pool.state().liquidity).toBe(10n);
    expect(pool.state().pendingPayout).toBe(0n);
    expect(pool.state().outstanding).toBe(0n);
  });

  it("confirm and cancel are mutually exclusive and only from PENDING_PAYOUT", async () => {
    const pool = funded();
    await requested(pool);
    pool.confirmPayout("a1", "0xtx1");
    expect(() => pool.cancelPayout("a1")).toThrow(/OUTSTANDING/);
    expect(() => pool.confirmPayout("a1", "0xtx2")).toThrow(/OUTSTANDING/);
  });

  it("settleRepayment records repaidAt and only settles OUTSTANDING", async () => {
    const pool = funded();
    await requested(pool);
    expect(() => pool.settleRepayment("a1", 6n, DUE)).toThrow(/PENDING_PAYOUT/);
    pool.confirmPayout("a1", "0xtx1");
    const adv = pool.settleRepayment("a1", 6n, DUE); // 5 + ceil(5*20%)=1
    expect(adv.status).toBe("REPAID");
    expect(adv.repaidAt).toBe(DUE);
    expect(pool.state().liquidity).toBe(11n);
  });

  it("replay of PENDING request is idempotent; tampered replay hard-rejects", async () => {
    const pool = funded();
    await requested(pool);
    const replay = await pool.requestAdvance({
      advanceId: "a1", saHash: "0xsa", payee: "0xexp", amount: 5n,
      advancedAt: T0, dueAt: DUE,
    });
    expect(replay.ok && replay.replay).toBe(true);
    const tampered = await pool.requestAdvance({
      advanceId: "a1", saHash: "0xsa", payee: "0xEVIL", amount: 5n,
      advancedAt: T0, dueAt: DUE,
    });
    expect(!tampered.ok && tampered.rejection.code === "DUPLICATE_MISMATCH").toBe(true);
  });
});
