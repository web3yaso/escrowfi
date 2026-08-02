/**
 * Liquidity pool core: deposit / advance / repay, with the one invariant that
 * defines the product:
 *
 *   **No advance ever leaves the pool without a verified SA.**
 *
 * The SA verifier is injected. The pool cannot be talked into paying by any
 * frontend parameter — the gate lives here, on the money path, exactly like
 * `deriveCondition()` lives on the verdict path in Deal Desk.
 *
 * Idempotency: `advanceId` is the caller's idempotency key. Replaying the same
 * advanceId returns the original advance (replay: true) and moves no money.
 * Replaying it with different parameters is a hard rejection, never a second
 * payment.
 */

import type {
  Advance,
  AdvanceResult,
  LedgerEntry,
  PoolState,
  SaVerifier,
} from "./types.js";

export interface PoolConfig {
  /** Advance fee in basis points, e.g. 30n = 0.30%. */
  readonly feeBps: bigint;
  readonly verify: SaVerifier;
}

const BPS_DENOMINATOR = 10_000n;

export function advanceFee(principal: bigint, feeBps: bigint): bigint {
  // Ceil so a nonzero-bps fee is never rounded to zero on small advances.
  return (principal * feeBps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

export class Pool {
  readonly #config: PoolConfig;
  readonly #ledger: LedgerEntry[] = [];
  readonly #advances = new Map<string, Advance>();
  readonly #lpDeposits = new Map<string, bigint>();
  #liquidity = 0n;
  #pendingPayout = 0n;
  #outstanding = 0n;
  #feesAccrued = 0n;

  constructor(config: PoolConfig) {
    if (config.feeBps < 0n) throw new Error("feeBps must be >= 0");
    this.#config = config;
  }

  deposit(lp: string, amount: bigint): void {
    if (amount <= 0n) throw new Error("deposit amount must be > 0");
    this.#liquidity += amount;
    this.#lpDeposits.set(lp, (this.#lpDeposits.get(lp) ?? 0n) + amount);
    this.#ledger.push({ kind: "DEPOSIT", lp, amount });
  }

  /**
   * Request a T+0 advance for one SA leg. This is the only exit for pool
   * funds toward a payee, and it is gated on the injected verifier.
   */
  async requestAdvance(input: {
    advanceId: string;
    saHash: string;
    payee: string;
    amount: bigint;
    invoiceId?: string;
    advancedAt: number;
    dueAt: number;
  }): Promise<AdvanceResult> {
    const existing = this.#advances.get(input.advanceId);
    if (existing) {
      const same =
        existing.saHash === input.saHash &&
        existing.payee === input.payee &&
        existing.principal === input.amount &&
        existing.advancedAt === input.advancedAt &&
        existing.dueAt === input.dueAt &&
        existing.invoiceId === input.invoiceId;
      return same
        ? { ok: true, advance: existing, replay: true }
        : {
            ok: false,
            rejection: { code: "DUPLICATE_MISMATCH", advanceId: input.advanceId },
          };
    }

    if (input.amount <= 0n) {
      return { ok: false, rejection: { code: "INVALID_AMOUNT" } };
    }

    // Verify BEFORE liquidity so a rejected SA is always reported as such —
    // rejection reasons must not depend on pool balance.
    const verdict = await this.#config.verify({
      saHash: input.saHash,
      payee: input.payee,
      amount: input.amount,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        rejection: { code: "SA_REJECTED", reason: verdict.reason ?? "unspecified" },
      };
    }

    if (input.amount > this.#liquidity) {
      return {
        ok: false,
        rejection: { code: "INSUFFICIENT_LIQUIDITY", liquidity: this.#liquidity },
      };
    }

    const advance: Advance = {
      advanceId: input.advanceId,
      saHash: input.saHash,
      payee: input.payee,
      principal: input.amount,
      fee: advanceFee(input.amount, this.#config.feeBps),
      status: "PENDING_PAYOUT",
      verdict,
      ...(input.invoiceId !== undefined ? { invoiceId: input.invoiceId } : {}),
      advancedAt: input.advancedAt,
      dueAt: input.dueAt,
    };
    this.#advances.set(advance.advanceId, advance);
    this.#liquidity -= advance.principal;
    this.#pendingPayout += advance.principal;
    this.#ledger.push({
      kind: "ADVANCE",
      advanceId: advance.advanceId,
      amount: advance.principal,
    });
    return { ok: true, advance, replay: false };
  }

  /**
   * Confirm that the off-pool payout to the payee landed on-chain. Moves the
   * advance from the pending-payout bucket into outstanding principal.
   */
  confirmPayout(advanceId: string, txHash: string): Advance {
    const advance = this.#mustGet(advanceId);
    if (advance.status !== "PENDING_PAYOUT") {
      throw new Error(`cannot confirm payout: advance ${advanceId} is ${advance.status}`);
    }
    const confirmed: Advance = { ...advance, status: "OUTSTANDING", payoutTxHash: txHash };
    this.#advances.set(advanceId, confirmed);
    this.#pendingPayout -= advance.principal;
    this.#outstanding += advance.principal;
    this.#ledger.push({ kind: "PAYOUT_CONFIRMED", advanceId, txHash });
    return confirmed;
  }

  /**
   * Cancel a payout that never landed. Restores the locked principal to
   * available liquidity in full (invariant 7).
   */
  cancelPayout(advanceId: string): Advance {
    const advance = this.#mustGet(advanceId);
    if (advance.status !== "PENDING_PAYOUT") {
      throw new Error(`cannot cancel payout: advance ${advanceId} is ${advance.status}`);
    }
    const cancelled: Advance = { ...advance, status: "CANCELLED" };
    this.#advances.set(advanceId, cancelled);
    this.#pendingPayout -= advance.principal;
    this.#liquidity += advance.principal;
    this.#ledger.push({ kind: "PAYOUT_CANCELLED", advanceId });
    return cancelled;
  }

  #mustGet(advanceId: string): Advance {
    const advance = this.#advances.get(advanceId);
    if (!advance) throw new Error(`unknown advance: ${advanceId}`);
    return advance;
  }

  /**
   * Settle the sender-side repayment for an outstanding advance.
   * Expects principal + fee exactly; anything else is a hard error because
   * silent partial settlement would corrupt LP accounting.
   */
  settleRepayment(advanceId: string, amount: bigint, repaidAt: number): Advance {
    const advance = this.#mustGet(advanceId);
    if (advance.status !== "OUTSTANDING") {
      if (advance.status === "REPAID") return advance; // idempotent replay
      throw new Error(`advance ${advanceId} is ${advance.status}`);
    }
    const due = advance.principal + advance.fee;
    if (amount !== due) {
      throw new Error(
        `repayment mismatch for ${advanceId}: expected ${due}, got ${amount}`,
      );
    }
    const settled: Advance = { ...advance, status: "REPAID", repaidAt };
    this.#advances.set(advanceId, settled);
    this.#liquidity += advance.principal + advance.fee;
    this.#outstanding -= advance.principal;
    this.#feesAccrued += advance.fee;
    this.#ledger.push({
      kind: "REPAY",
      advanceId,
      principal: advance.principal,
      fee: advance.fee,
    });
    return settled;
  }

  state(): PoolState {
    return {
      liquidity: this.#liquidity,
      pendingPayout: this.#pendingPayout,
      outstanding: this.#outstanding,
      feesAccrued: this.#feesAccrued,
      lpDeposits: new Map(this.#lpDeposits),
    };
  }

  ledger(): readonly LedgerEntry[] {
    return [...this.#ledger];
  }

  advance(advanceId: string): Advance | undefined {
    return this.#advances.get(advanceId);
  }
}
