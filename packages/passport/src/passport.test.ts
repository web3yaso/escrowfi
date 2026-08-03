import { describe, expect, it } from "vitest";
import { Pool } from "@citely-pay/pool";
import type { SaVerifier } from "@citely-pay/pool";
import { buildPassport } from "./passport.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp", agentId: "854638" });
const T0 = 1_756_700_000_000;
const DUE = T0 + 30 * 86_400_000;

async function playedPool(): Promise<Pool> {
  const p = new Pool({ feeBps: 2000n, verify: PASS });
  p.deposit("lp-1", 20n);
  // escrowed cycle, completed on time
  p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n, txHash: "0xe1" });
  await p.requestAdvance({ advanceId: "a1", saHash: "0xsa1", payee: "0xexp",
    amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
  p.confirmPayout("a1", "0xtx1");
  p.releaseEscrow("inv-1", T0 + 86_400_000); // closed after 1 day, before due
  p.confirmResidual("inv-1", "0xtx2");
  // credit cycle, repaid late
  await p.requestAdvance({ advanceId: "a2", saHash: "0xsa2", payee: "0xexp",
    amount: 5n, advancedAt: T0, dueAt: DUE });
  p.confirmPayout("a2", "0xtx3");
  p.settleRepayment("a2", 6n, DUE + 86_400_000); // one day late
  // a cancelled one — must not pollute stats
  await p.requestAdvance({ advanceId: "a3", saHash: "0xsa3", payee: "0xexp",
    amount: 2n, advancedAt: T0, dueAt: DUE });
  p.cancelPayout("a3");
  return p;
}

describe("buildPassport", () => {
  it("separates escrowed and credit entries with per-entry verifiable anchors", async () => {
    const p = await playedPool();
    const s = p.state();
    const pass = buildPassport({ agentId: "854638", advances: [...s.advances.values()],
      ledger: p.ledger(), escrows: s.escrows });

    expect(pass.escrowedEntries).toHaveLength(1);
    const e = pass.escrowedEntries[0]!;
    expect(e).toMatchObject({ advanceId: "a1", saHash: "0xsa1", escrowed: true,
      invoiceId: "inv-1", status: "COMPLETED", onTime: true });
    expect(e.txHashes).toEqual(["0xe1", "0xtx1", "0xtx2"]); // escrow-in, payout, residual

    expect(pass.creditEntries).toHaveLength(2); // a2 repaid-late + a3 cancelled
    const late = pass.creditEntries.find(x => x.advanceId === "a2")!;
    expect(late.onTime).toBe(false);
    const cancelled = pass.creditEntries.find(x => x.advanceId === "a3")!;
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.onTime).toBeUndefined();
  });

  it("computes stats over non-cancelled entries only", async () => {
    const p = await playedPool();
    const s = p.state();
    const { stats } = buildPassport({ agentId: "854638", advances: [...s.advances.values()],
      ledger: p.ledger(), escrows: s.escrows });
    expect(stats.totalFinanced).toBe(9n);        // 4 + 5, cancelled 2 excluded
    expect(stats.completedCycles).toBe(2);
    expect(stats.onTimeRateBps).toBe(5000);      // 1 of 2
    expect(stats.currentExposure).toBe(0n);
    expect(stats.avgTenorMs).toBe((86_400_000 + 31 * 86_400_000) / 2);
  });

  it("is a pure derivation: same inputs, same passport", async () => {
    const p = await playedPool();
    const s = p.state();
    const input = { agentId: "854638", advances: [...s.advances.values()],
      ledger: p.ledger(), escrows: s.escrows };
    expect(buildPassport(input)).toEqual(buildPassport(input));
  });
});
