import { describe, expect, it } from "vitest";
import { Pool, advanceFee } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({
  ok: true,
  signer: "0xOperator",
  agentId: "854638",
});
const REJECT: SaVerifier = async () => ({
  ok: false,
  reason: "signature_mismatch",
});

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

const T0 = 1_756_700_000_000; // arbitrary epoch ms
const DUE = T0 + 30 * 86_400_000;

function fundedPool(verify: SaVerifier = PASS, feeBps = 30n) {
  const pool = new Pool({ feeBps, verify });
  pool.deposit("lp-1", USDC(100));
  return pool;
}

describe("advanceFee", () => {
  it("charges 30bps and never rounds a nonzero fee to zero", () => {
    expect(advanceFee(USDC(100), 30n)).toBe(USDC(0.3));
    expect(advanceFee(1n, 30n)).toBe(1n); // ceil, not floor-to-zero
    expect(advanceFee(USDC(100), 0n)).toBe(0n);
  });
});

describe("the invariant: no advance without a verified SA", () => {
  it("rejects when the verifier rejects, and moves no money", async () => {
    const pool = fundedPool(REJECT);
    const result = await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xpayee",
      amount: USDC(10),
      advancedAt: T0,
      dueAt: DUE,
    });
    expect(result).toEqual({
      ok: false,
      rejection: { code: "SA_REJECTED", reason: "signature_mismatch" },
    });
    expect(pool.state().liquidity).toBe(USDC(100));
    expect(pool.state().outstanding).toBe(0n);
    expect(pool.ledger().filter((e) => e.kind === "ADVANCE")).toHaveLength(0);
  });

  it("reports SA rejection even when liquidity would also be insufficient", async () => {
    const pool = new Pool({ feeBps: 30n, verify: REJECT }); // empty pool
    const result = await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xpayee",
      amount: USDC(10),
      advancedAt: T0,
      dueAt: DUE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("SA_REJECTED");
  });
});

describe("advance happy path", () => {
  it("advances, fixes the fee at advance time, and updates accounting", async () => {
    const pool = fundedPool();
    const result = await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xpayee",
      amount: USDC(40),
      advancedAt: T0,
      dueAt: DUE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toBe(false);
    expect(result.advance.fee).toBe(USDC(0.12)); // 30bps of 40
    expect(result.advance.verdict.agentId).toBe("854638");
    expect(pool.state().liquidity).toBe(USDC(60));
    expect(pool.state().pendingPayout).toBe(USDC(40));
    pool.confirmPayout("a1", "0xtx1");
    const s = pool.state();
    expect(s.liquidity).toBe(USDC(60));
    expect(s.outstanding).toBe(USDC(40));
  });

  it("rejects beyond available liquidity", async () => {
    const pool = fundedPool();
    const result = await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xpayee",
      amount: USDC(101),
      advancedAt: T0,
      dueAt: DUE,
    });
    expect(result).toEqual({
      ok: false,
      rejection: { code: "INSUFFICIENT_LIQUIDITY", liquidity: USDC(100) },
    });
  });
});

describe("idempotency", () => {
  it("replays the same advanceId without moving money twice", async () => {
    const pool = fundedPool();
    const input = {
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xpayee",
      amount: USDC(10),
      advancedAt: T0,
      dueAt: DUE,
    };
    const first = await pool.requestAdvance(input);
    const second = await pool.requestAdvance(input);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.replay).toBe(true);
    expect(pool.state().liquidity).toBe(USDC(90)); // only one advance left the pool
    expect(pool.ledger().filter((e) => e.kind === "ADVANCE")).toHaveLength(1);
  });

  it("hard-rejects the same advanceId with different parameters", async () => {
    const pool = fundedPool();
    await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xpayee",
      amount: USDC(10),
      advancedAt: T0,
      dueAt: DUE,
    });
    const tampered = await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xATTACKER",
      amount: USDC(10),
      advancedAt: T0,
      dueAt: DUE,
    });
    expect(tampered).toEqual({
      ok: false,
      rejection: { code: "DUPLICATE_MISMATCH", advanceId: "a1" },
    });
    expect(pool.state().liquidity).toBe(USDC(90));
  });
});

describe("repayment", () => {
  it("closes the loop: principal returns, fee accrues to LPs", async () => {
    const pool = fundedPool();
    await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xpayee",
      amount: USDC(40),
      advancedAt: T0,
      dueAt: DUE,
    });
    pool.confirmPayout("a1", "0xtx1");
    const settled = pool.settleRepayment("a1", USDC(40.12), DUE);
    expect(settled.status).toBe("REPAID");
    expect(settled.repaidAt).toBe(DUE);
    const s = pool.state();
    expect(s.liquidity).toBe(USDC(100.12));
    expect(s.outstanding).toBe(0n);
    expect(s.feesAccrued).toBe(USDC(0.12));
  });

  it("refuses partial or excess settlement", async () => {
    const pool = fundedPool();
    await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xpayee",
      amount: USDC(40),
      advancedAt: T0,
      dueAt: DUE,
    });
    pool.confirmPayout("a1", "0xtx1");
    expect(() => pool.settleRepayment("a1", USDC(40), DUE)).toThrow(/mismatch/);
    expect(() => pool.settleRepayment("a1", USDC(41), DUE)).toThrow(/mismatch/);
  });

  it("is idempotent on replayed settlement", async () => {
    const pool = fundedPool();
    await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0xsa",
      payee: "0xpayee",
      amount: USDC(40),
      advancedAt: T0,
      dueAt: DUE,
    });
    pool.confirmPayout("a1", "0xtx1");
    pool.settleRepayment("a1", USDC(40.12), DUE);
    const replay = pool.settleRepayment("a1", USDC(40.12), DUE);
    expect(replay.status).toBe("REPAID");
    expect(pool.state().liquidity).toBe(USDC(100.12)); // unchanged
  });
});

describe("accounting conservation", () => {
  it("ledger always reconciles to state across a mixed sequence", async () => {
    const pool = new Pool({ feeBps: 25n, verify: PASS });
    pool.deposit("lp-1", USDC(50));
    pool.deposit("lp-2", USDC(30));
    await pool.requestAdvance({
      advanceId: "a1",
      saHash: "0x1",
      payee: "0xp1",
      amount: USDC(20),
      advancedAt: T0,
      dueAt: DUE,
    });
    await pool.requestAdvance({
      advanceId: "a2",
      saHash: "0x2",
      payee: "0xp2",
      amount: USDC(35),
      advancedAt: T0,
      dueAt: DUE,
    });
    pool.confirmPayout("a1", "0xtx1");
    pool.confirmPayout("a2", "0xtx2");
    const fee1 = advanceFee(USDC(20), 25n);
    pool.settleRepayment("a1", USDC(20) + fee1, DUE);

    let liquidity = 0n;
    for (const e of pool.ledger()) {
      if (e.kind === "DEPOSIT") liquidity += e.amount;
      if (e.kind === "WITHDRAW") liquidity -= e.amount;
      if (e.kind === "ADVANCE") liquidity -= e.amount;
      if (e.kind === "REPAY") liquidity += e.principal + e.fee;
    }
    expect(liquidity).toBe(pool.state().liquidity);
    expect(pool.state().outstanding).toBe(USDC(35));
    expect(pool.state().feesAccrued).toBe(fee1);
  });
});
