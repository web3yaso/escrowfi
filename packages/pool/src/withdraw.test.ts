import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true });

describe("LP withdraw (mirrors Quint withdrawBoundedTest)", () => {
  it("withdraws up to own deposits and pool liquidity", () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    p.withdraw("lp-1", 10n);
    expect(p.state().liquidity).toBe(0n);
    expect(p.state().lpDeposits.get("lp-1")).toBe(0n);
    expect(p.ledger().some(e => e.kind === "WITHDRAW" && e.lp === "lp-1" && e.amount === 10n)).toBe(true);
  });

  it("bounds: own deposits and current liquidity", async () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    expect(() => p.withdraw("lp-1", 11n)).toThrow(/exceeds deposits/);
    expect(() => p.withdraw("lp-2", 1n)).toThrow(/exceeds deposits/);
    expect(() => p.withdraw("lp-1", 0n)).toThrow(/> 0/);
    await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
      amount: 8n, advancedAt: 0, dueAt: 1 });
    expect(() => p.withdraw("lp-1", 3n)).toThrow(/exceeds liquidity/);
  });
});
