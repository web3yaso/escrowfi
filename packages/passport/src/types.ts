/**
 * Credit-passport domain types. The passport is never stored: it is derived
 * from the pool's ledger and advances on every read, so it cannot disagree
 * with the money records. Every entry carries verifiable anchors (SA hash +
 * on-chain tx hashes) that a reader can re-verify independently.
 */

export interface PassportEntry {
  readonly advanceId: string;
  readonly saHash: string;
  readonly escrowed: boolean;
  readonly invoiceId?: string;
  readonly principal: bigint;
  readonly fee: bigint;
  readonly advancedAt: number;
  readonly dueAt: number;
  /** repaidAt when the cycle completed. */
  readonly closedAt?: number;
  /** closedAt <= dueAt; only present when closed. */
  readonly onTime?: boolean;
  readonly status: "OPEN" | "COMPLETED" | "CANCELLED";
  /** payout + escrow + residual txs, ledger order. */
  readonly txHashes: readonly string[];
}

export interface PassportStats {
  /** Σ principal, non-cancelled. */
  readonly totalFinanced: bigint;
  /** REPAID count. */
  readonly completedCycles: number;
  /** completed on time / completed, in bps; 0 when none. */
  readonly onTimeRateBps: number;
  /** mean(closedAt - advancedAt) over completed; 0 when none. */
  readonly avgTenorMs: number;
  /** Σ principal of OUTSTANDING + PENDING_PAYOUT. */
  readonly currentExposure: bigint;
}

export interface Passport {
  readonly identity: { readonly agentId: string };
  /** Escrow-backed deals: conduct = cycle completion. */
  readonly escrowedEntries: readonly PassportEntry[];
  /** Credit deals: conduct = repayment behavior. */
  readonly creditEntries: readonly PassportEntry[];
  readonly stats: PassportStats;
}
