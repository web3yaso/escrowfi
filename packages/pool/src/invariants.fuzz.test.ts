import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { LedgerEntry, SaVerifier } from "./types.js";

/** Deterministic PRNG (mulberry32) — reproducible fuzz. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Conservation, computed from the ledger alone (inv_conservation).
 *  in  = deposits + escrow-in + credit repayments
 *  out = confirmed payouts + confirmed residuals + withdrawals */
function externalDelta(ledger: readonly LedgerEntry[], principalOf: (id: string) => bigint): bigint {
  return ledger.reduce((acc, e) => {
    if (e.kind === "DEPOSIT" || e.kind === "ESCROW_DEPOSIT") return acc + e.amount;
    if (e.kind === "REPAY") return acc + e.principal + e.fee;
    if (e.kind === "PAYOUT_CONFIRMED") return acc - principalOf(e.advanceId);
    if (e.kind === "RESIDUAL_CONFIRMED") return acc - e.amount;
    if (e.kind === "WITHDRAW") return acc - e.amount;
    return acc;
  }, 0n);
}

function assertInvariants(pool: Pool): void {
  const s = pool.state();
  const advances = [...s.advances.values()];
  // inv_nonNegative
  expect(s.liquidity >= 0n).toBe(true);
  expect(s.pendingPayout >= 0n).toBe(true);
  for (const v of s.pendingResidual.values()) expect(v >= 0n).toBe(true);
  for (const v of s.lpDeposits.values()) expect(v >= 0n).toBe(true);
  // inv_pendingBucket
  const pendingSum = advances.filter(a => a.status === "PENDING_PAYOUT")
    .reduce((acc, a) => acc + a.principal, 0n);
  expect(s.pendingPayout).toBe(pendingSum);
  // inv_gate (escrow coverage) + inv_feeNonZero
  for (const a of advances) {
    expect(a.fee >= 1n).toBe(true);
    if (a.invoiceId !== undefined) {
      expect(a.principal + a.fee <= (s.escrows.get(a.invoiceId)?.amount ?? -1n)).toBe(true);
    }
  }
  // inv_singleActive
  const activeByInvoice = new Map<string, number>();
  for (const a of advances) {
    if (a.invoiceId !== undefined && a.status !== "CANCELLED") {
      activeByInvoice.set(a.invoiceId, (activeByInvoice.get(a.invoiceId) ?? 0) + 1);
    }
  }
  for (const n of activeByInvoice.values()) expect(n).toBeLessThanOrEqual(1);
  // inv_escrowLifecycle
  for (const a of advances) {
    if (a.invoiceId !== undefined && a.status === "REPAID") {
      expect(s.escrows.get(a.invoiceId)?.status).toBe("RELEASED");
    }
  }
  // inv_conservation: poolCash == externalIn - externalOut
  const escrowFunded = [...s.escrows.values()]
    .filter(e => e.status === "FUNDED").reduce((acc, e) => acc + e.amount, 0n);
  const residualTotal = [...s.pendingResidual.values()].reduce((acc, v) => acc + v, 0n);
  const poolCash = s.liquidity + s.pendingPayout + escrowFunded + residualTotal;
  const principalOf = (id: string): bigint => s.advances.get(id)?.principal ?? 0n;
  expect(poolCash).toBe(externalDelta(pool.ledger(), principalOf));
}

describe("randomized op sequences preserve all Quint invariants", () => {
  it("2000 ops across 20 seeds, verifier flips nondeterministically", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed);
      const flaky: SaVerifier = async () =>
        rand() < 0.75 ? { ok: true, signer: "0xOp" } : { ok: false, reason: "signature_mismatch" };
      const pool = new Pool({ feeBps: 2000n, verify: flaky });
      const invoices = ["inv-1", "inv-2", "inv-3"];
      let nextId = 0;
      for (let i = 0; i < 100; i++) {
        const t = i * 1000;
        const pick = rand();
        const amt = BigInt(1 + Math.floor(rand() * 9));
        try {
          if (pick < 0.2) pool.deposit("lp-1", amt);
          else if (pick < 0.3) pool.withdraw("lp-1", amt);
          else if (pick < 0.45) {
            pool.escrowDeposit({ invoiceId: invoices[Math.floor(rand() * 3)]!, importer: "0ximp", amount: amt });
          } else if (pick < 0.6) {
            const escrowed = rand() < 0.7;
            await pool.requestAdvance({ advanceId: `a${nextId++}`, saHash: "0xsa", payee: "0xexp",
              amount: amt, advancedAt: t, dueAt: t + 5000,
              ...(escrowed ? { invoiceId: invoices[Math.floor(rand() * 3)]! } : {}) });
          } else {
            const s = pool.state();
            const pending = [...s.advances.values()].filter(a => a.status === "PENDING_PAYOUT");
            const out = [...s.advances.values()].filter(a => a.status === "OUTSTANDING");
            if (pick < 0.7 && pending.length > 0) pool.confirmPayout(pending[0]!.advanceId, `0xtx${i}`);
            else if (pick < 0.78 && pending.length > 0) pool.cancelPayout(pending[0]!.advanceId);
            else if (pick < 0.88 && out.length > 0) {
              const a = out[0]!;
              if (a.invoiceId !== undefined) pool.releaseEscrow(a.invoiceId, t);
              else pool.settleRepayment(a.advanceId, a.principal + a.fee, t);
            } else {
              const owed = [...pool.state().pendingResidual.entries()].find(([, v]) => v > 0n);
              if (owed) pool.confirmResidual(owed[0], `0xtx${i}`);
            }
          }
        } catch {
          // guard-rejected op (insufficient funds, bad state) — a disabled action, fine
        }
        assertInvariants(pool);
      }
    }
  }, 30_000);
});
