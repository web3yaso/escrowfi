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
  Escrow,
  LedgerEntry,
  PoolState,
  ReleaseResult,
  SaVerifier,
} from "./types.js";
import { decodeSnapshot, encodeSnapshot } from "./serde.js";

/** Everything a Pool needs to be rebuilt, minus the injected verifier. */
export interface PoolSnapshot {
  readonly feeBps: bigint;
  readonly liquidity: bigint;
  readonly pendingPayout: bigint;
  readonly outstanding: bigint;
  readonly feesAccrued: bigint;
  readonly lpDeposits: ReadonlyMap<string, bigint>;
  readonly escrows: ReadonlyMap<string, Escrow>;
  readonly pendingResidual: ReadonlyMap<string, bigint>;
  readonly advances: ReadonlyMap<string, Advance>;
  readonly releases: ReadonlyMap<string, ReleaseResult>;
  readonly ledger: readonly LedgerEntry[];
}

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
  readonly #escrows = new Map<string, Escrow>();
  readonly #pendingResidual = new Map<string, bigint>();
  readonly #releases = new Map<string, ReleaseResult>();
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

  /** LP withdraw, bounded by the LP's own deposits and current liquidity. */
  withdraw(lp: string, amount: bigint): void {
    if (amount <= 0n) throw new Error("withdraw amount must be > 0");
    const deposited = this.#lpDeposits.get(lp) ?? 0n;
    if (amount > deposited) throw new Error(`withdraw ${amount} exceeds deposits ${deposited} of ${lp}`);
    if (amount > this.#liquidity) throw new Error(`withdraw ${amount} exceeds liquidity ${this.#liquidity}`);
    this.#liquidity -= amount;
    this.#lpDeposits.set(lp, deposited - amount);
    this.#ledger.push({ kind: "WITHDRAW", lp, amount });
  }

  /**
   * Importer locks funds against one invoice. Escrowed funds are earmarked:
   * they never enter liquidity and can only leave via the release waterfall
   * (invariant 6). Top-ups are allowed while FUNDED.
   */
  escrowDeposit(input: { invoiceId: string; importer: string; amount: bigint; txHash?: string }): Escrow {
    if (input.amount <= 0n) throw new Error("escrow amount must be > 0");
    const existing = this.#escrows.get(input.invoiceId);
    if (existing?.status === "RELEASED") {
      throw new Error(`escrow ${input.invoiceId} is already released`);
    }
    const escrow: Escrow = {
      invoiceId: input.invoiceId,
      importer: input.importer,
      amount: (existing?.amount ?? 0n) + input.amount,
      status: "FUNDED",
      txHashes: input.txHash !== undefined
        ? [...(existing?.txHashes ?? []), input.txHash]
        : (existing?.txHashes ?? []),
    };
    this.#escrows.set(input.invoiceId, escrow);
    this.#ledger.push({ kind: "ESCROW_DEPOSIT", invoiceId: input.invoiceId,
      importer: input.importer, amount: input.amount,
      ...(input.txHash !== undefined ? { txHash: input.txHash } : {}) });
    return escrow;
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

    // Escrow gate AFTER the SA verdict, BEFORE liquidity: rejection order is
    // a contract (SA → escrow → liquidity).
    if (input.invoiceId !== undefined) {
      const escrow = this.#escrows.get(input.invoiceId);
      if (!escrow || escrow.status !== "FUNDED") {
        return { ok: false, rejection: { code: "ESCROW_NOT_FOUND", invoiceId: input.invoiceId } };
      }
      const fee = advanceFee(input.amount, this.#config.feeBps);
      if (input.amount + fee > escrow.amount) {
        return { ok: false, rejection: { code: "ESCROW_INSUFFICIENT", escrowAmount: escrow.amount } };
      }
      const busy = [...this.#advances.values()].some(
        (a) => a.invoiceId === input.invoiceId && a.status !== "CANCELLED",
      );
      if (busy) {
        return { ok: false, rejection: { code: "INVOICE_BUSY", invoiceId: input.invoiceId } };
      }
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
   * Release waterfall: the escrowed F splits atomically — P + fee back into
   * liquidity (LP principal + earnings), the residual F − P − fee queued for
   * the exporter until its on-chain transfer confirms. Escrow release is
   * irreversible, so the residual is retry-only (no cancel). Idempotent:
   * replaying a released invoice returns the original result.
   */
  releaseEscrow(invoiceId: string, at: number): ReleaseResult {
    const replay = this.#releases.get(invoiceId);
    if (replay) return replay;
    const escrow = this.#escrows.get(invoiceId);
    if (!escrow) throw new Error(`unknown escrow: ${invoiceId}`);
    const advance = [...this.#advances.values()].find(
      (a) => a.invoiceId === invoiceId && a.status === "OUTSTANDING",
    );
    if (!advance) throw new Error(`no outstanding advance on invoice ${invoiceId}`);
    const residual = escrow.amount - advance.principal - advance.fee;
    const settled: Advance = { ...advance, status: "REPAID", repaidAt: at };
    this.#advances.set(advance.advanceId, settled);
    this.#escrows.set(invoiceId, { ...escrow, status: "RELEASED" });
    this.#liquidity += advance.principal + advance.fee;
    this.#outstanding -= advance.principal;
    this.#feesAccrued += advance.fee;
    if (residual > 0n) this.#pendingResidual.set(invoiceId, residual);
    this.#ledger.push({ kind: "RELEASE", invoiceId, advanceId: advance.advanceId,
      principal: advance.principal, fee: advance.fee, residual });
    const result: ReleaseResult = { advance: settled, principal: advance.principal, fee: advance.fee, residual };
    this.#releases.set(invoiceId, result);
    return result;
  }

  /** Confirm the exporter-tail transfer landed on-chain. Retry-only: no cancel. */
  confirmResidual(invoiceId: string, txHash: string): bigint {
    const amount = this.#pendingResidual.get(invoiceId) ?? 0n;
    if (amount <= 0n) throw new Error(`no pending residual for ${invoiceId}`);
    this.#pendingResidual.set(invoiceId, 0n);
    this.#ledger.push({ kind: "RESIDUAL_CONFIRMED", invoiceId, amount, txHash });
    return amount;
  }

  /**
   * Settle the sender-side repayment for an outstanding advance.
   * Expects principal + fee exactly; anything else is a hard error because
   * silent partial settlement would corrupt LP accounting.
   */
  settleRepayment(advanceId: string, amount: bigint, repaidAt: number): Advance {
    const advance = this.#mustGet(advanceId);
    if (advance.invoiceId !== undefined) {
      throw new Error(`advance ${advanceId} is escrowed; settle it via releaseEscrow`);
    }
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

  /** Full internal state as readonly views — the serialization boundary. */
  snapshot(): PoolSnapshot {
    return {
      feeBps: this.#config.feeBps,
      liquidity: this.#liquidity,
      pendingPayout: this.#pendingPayout,
      outstanding: this.#outstanding,
      feesAccrued: this.#feesAccrued,
      lpDeposits: new Map(this.#lpDeposits),
      escrows: new Map(this.#escrows),
      pendingResidual: new Map(this.#pendingResidual),
      advances: new Map(this.#advances),
      releases: new Map(this.#releases),
      ledger: [...this.#ledger],
    };
  }

  /** Rebuild a pool from a snapshot; the verifier is re-injected (functions don't serialize). */
  static restore(snapshot: PoolSnapshot, verify: SaVerifier): Pool {
    const pool = new Pool({ feeBps: snapshot.feeBps, verify });
    pool.#liquidity = snapshot.liquidity;
    pool.#pendingPayout = snapshot.pendingPayout;
    pool.#outstanding = snapshot.outstanding;
    pool.#feesAccrued = snapshot.feesAccrued;
    for (const [k, v] of snapshot.lpDeposits) pool.#lpDeposits.set(k, v);
    for (const [k, v] of snapshot.escrows) pool.#escrows.set(k, v);
    for (const [k, v] of snapshot.pendingResidual) pool.#pendingResidual.set(k, v);
    for (const [k, v] of snapshot.advances) pool.#advances.set(k, v);
    for (const [k, v] of snapshot.releases) pool.#releases.set(k, v);
    pool.#ledger.push(...snapshot.ledger);
    return pool;
  }

  toJSON(): string {
    return encodeSnapshot(this.snapshot());
  }

  static fromJSON(json: string, verify: SaVerifier): Pool {
    return Pool.restore(decodeSnapshot(json), verify);
  }

  state(): PoolState {
    return {
      liquidity: this.#liquidity,
      pendingPayout: this.#pendingPayout,
      outstanding: this.#outstanding,
      feesAccrued: this.#feesAccrued,
      lpDeposits: new Map(this.#lpDeposits),
      escrows: new Map(this.#escrows),
      pendingResidual: new Map(this.#pendingResidual),
    };
  }

  ledger(): readonly LedgerEntry[] {
    return [...this.#ledger];
  }

  advance(advanceId: string): Advance | undefined {
    return this.#advances.get(advanceId);
  }
}
