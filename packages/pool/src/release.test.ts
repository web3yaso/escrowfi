import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp", agentId: "854638" });
const T0 = 1_756_700_000_000;
const DUE = T0 + 30 * 86_400_000;

/** Mirrors pool_test.qnt happyEscrowPathTest: F=6, P=4, fee=1, residual=1. */
async function afterAdvance(): Promise<Pool> {
  const p = new Pool({ feeBps: 2000n, verify: PASS });
  p.deposit("lp-1", 10n);
  p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n, txHash: "0xe1" });
  await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
    amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
  p.confirmPayout("a1", "0xtx1");
  return p;
}

describe("release waterfall (mirrors Quint happyEscrowPathTest)", () => {
  it("splits F atomically: P+fee to liquidity, residual queued; advance REPAID", async () => {
    const p = await afterAdvance();
    const r = p.releaseEscrow("inv-1", DUE);
    expect({ principal: r.principal, fee: r.fee, residual: r.residual })
      .toEqual({ principal: 4n, fee: 1n, residual: 1n });
    expect(r.advance.status).toBe("REPAID");
    expect(r.advance.repaidAt).toBe(DUE);
    const s = p.state();
    expect(s.liquidity).toBe(11n);          // 10 - 4 + (4+1)
    expect(s.outstanding).toBe(0n);
    expect(s.feesAccrued).toBe(1n);
    expect(s.escrows.get("inv-1")?.status).toBe("RELEASED");
    expect(s.pendingResidual.get("inv-1")).toBe(1n);
  });

  it("confirmResidual pays the exporter tail exactly once", async () => {
    const p = await afterAdvance();
    p.releaseEscrow("inv-1", DUE);
    expect(p.confirmResidual("inv-1", "0xtx2")).toBe(1n);
    expect(p.state().pendingResidual.get("inv-1")).toBe(0n);
    expect(() => p.confirmResidual("inv-1", "0xtx3")).toThrow(/no pending residual/);
  });

  it("release is idempotent: replay returns the original result, moves nothing", async () => {
    const p = await afterAdvance();
    const first = p.releaseEscrow("inv-1", DUE);
    const replay = p.releaseEscrow("inv-1", DUE + 999);
    expect(replay).toEqual(first);
    expect(p.state().liquidity).toBe(11n);
  });

  it("refuses to release while payout is still PENDING (money not out yet)", async () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n });
    await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
      amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
    expect(() => p.releaseEscrow("inv-1", DUE)).toThrow(/no outstanding advance/);
  });

  it("zero residual (F == P+fee) needs no confirmation", async () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 5n });
    await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
      amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
    p.confirmPayout("a1", "0xtx1");
    const r = p.releaseEscrow("inv-1", DUE);
    expect(r.residual).toBe(0n);
    expect(() => p.confirmResidual("inv-1", "0xtx2")).toThrow(/no pending residual/);
  });

  it("settleRepayment refuses escrowed advances (they settle via release)", async () => {
    const p = await afterAdvance();
    expect(() => p.settleRepayment("a1", 5n, DUE)).toThrow(/escrowed/);
  });
});
