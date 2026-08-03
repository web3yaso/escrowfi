import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp" });
const T0 = 1_756_700_000_000;
const DUE = T0 + 30 * 86_400_000;

describe("serialization round-trip", () => {
  it("restores mid-flow state exactly (bigints, maps, pending buckets, replay cache)", async () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n, txHash: "0xe1" });
    await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
      amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
    p.confirmPayout("a1", "0xtx1");
    p.releaseEscrow("inv-1", DUE); // residual 1 still pending

    const restored = Pool.fromJSON(p.toJSON(), PASS);
    expect(restored.state()).toEqual(p.state());
    expect(restored.ledger()).toEqual(p.ledger());
    // replay caches survive: idempotent release replay still works
    expect(restored.releaseEscrow("inv-1", DUE + 5)).toEqual(p.releaseEscrow("inv-1", DUE + 5));
    // and the pool still works after restore
    expect(restored.confirmResidual("inv-1", "0xtx2")).toBe(1n);
  });

  it("rejects an unknown envelope version", () => {
    expect(() => Pool.fromJSON('{"version":99}', PASS)).toThrow(/unsupported pool snapshot version/);
  });
});
