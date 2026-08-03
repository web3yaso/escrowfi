import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp", agentId: "854638" });
const T0 = 1_756_700_000_000;
const DUE = T0 + 30 * 86_400_000;

function pool(): Pool {
  const p = new Pool({ feeBps: 2000n, verify: PASS });
  p.deposit("lp-1", 10n);
  return p;
}

const req = (p: Pool, over: Partial<{ advanceId: string; amount: bigint; invoiceId: string }> = {}) =>
  p.requestAdvance({
    advanceId: over.advanceId ?? "a1", saHash: "0xsa", payee: "0xexp",
    amount: over.amount ?? 4n, invoiceId: over.invoiceId ?? "inv-1",
    advancedAt: T0, dueAt: DUE,
  });

describe("escrow bucket (inv 6: isolation)", () => {
  it("escrowDeposit funds and tops up per invoice; escrow is not liquidity", () => {
    const p = pool();
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 4n, txHash: "0xe1" });
    const e = p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 2n });
    expect(e.amount).toBe(6n);
    expect(e.status).toBe("FUNDED");
    expect(e.txHashes).toEqual(["0xe1"]);
    expect(p.state().liquidity).toBe(10n); // escrow never enters liquidity
  });

  it("gates the advance on full coverage: P + fee <= F (inv 1/3)", async () => {
    const p = pool();
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 4n });
    // P=4, fee=ceil(4*20%)=1, due 5 > escrow 4 → rejected
    const r = await req(p);
    expect(!r.ok && r.rejection.code === "ESCROW_INSUFFICIENT").toBe(true);
    expect(p.state().liquidity).toBe(10n);
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 2n }); // F=6
    const ok = await req(p, { advanceId: "a2" });
    expect(ok.ok).toBe(true);
  });

  it("rejects an advance on an unknown invoice", async () => {
    const r = await req(pool(), { invoiceId: "inv-404" });
    expect(!r.ok && r.rejection.code === "ESCROW_NOT_FOUND").toBe(true);
  });

  it("one active advance per invoice; a cancelled one frees the slot (inv_singleActive)", async () => {
    const p = pool();
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n });
    await req(p);
    const busy = await req(p, { advanceId: "a2" });
    expect(!busy.ok && busy.rejection.code === "INVOICE_BUSY").toBe(true);
    p.cancelPayout("a1");
    const retry = await req(p, { advanceId: "a3" });
    expect(retry.ok).toBe(true);
  });

  it("SA rejection still wins over escrow problems (rejection-order contract)", async () => {
    const REJECT: SaVerifier = async () => ({ ok: false, reason: "signature_mismatch" });
    const p = new Pool({ feeBps: 2000n, verify: REJECT });
    p.deposit("lp-1", 10n);
    const r = await req(p, { invoiceId: "inv-404" });
    expect(!r.ok && r.rejection.code === "SA_REJECTED").toBe(true);
  });
});
