/**
 * Pool domain types.
 *
 * All amounts are USDC minor units (6 decimals) as bigint. No floats anywhere
 * on the money path — mirrors the Deal Desk convention.
 *
 * The pool NEVER decides compliance. It advances funds only against a
 * Settlement Authorization (SA) that an independent verifier has accepted.
 * The verifier is injected (see `SaVerifier`), so the pool package has no
 * network dependency and the gating is enforceable in tests.
 */

/** Result of asking the independent verifier about one SA leg. */
export interface SaVerdict {
  readonly ok: boolean;
  /** Machine-readable reason when ok=false, e.g. "signature_mismatch". */
  readonly reason?: string;
  /** EIP-712 signer recovered by the verifier (checksummed 0x address). */
  readonly signer?: string;
  /** ERC-8004 agent id the signer resolves to, when the registry lookup ran. */
  readonly agentId?: string;
}

/**
 * Injected verification port. Implementations: verify-client against the
 * deployed Deal Desk verifier service (production), or a double in tests.
 */
export type SaVerifier = (input: {
  readonly saHash: string;
  readonly payee: string;
  readonly amount: bigint;
}) => Promise<SaVerdict>;

export type AdvanceStatus =
  | "PENDING_PAYOUT" | "OUTSTANDING" | "REPAID" | "CANCELLED" | "WRITTEN_OFF";

export interface Advance {
  /** Caller-supplied idempotency key. Same key → same advance, ever. */
  readonly advanceId: string;
  readonly saHash: string;
  readonly payee: string;
  readonly principal: bigint;
  /** Fee owed on repayment, fixed at advance time. */
  readonly fee: bigint;
  readonly status: AdvanceStatus;
  readonly verdict: SaVerdict;
  /** Present = escrowed path (Task 2); absent = credit path. */
  readonly invoiceId?: string;
  readonly advancedAt: number;
  readonly dueAt: number;
  readonly repaidAt?: number;
  readonly payoutTxHash?: string;
}

/** Per-invoice escrow: importer funds earmarked for one trade, isolated from LP liquidity. */
export interface Escrow {
  readonly invoiceId: string;
  readonly importer: string;
  readonly amount: bigint;
  readonly status: "FUNDED" | "RELEASED";
  readonly txHashes: readonly string[];
}

export type LedgerEntry =
  | { readonly kind: "DEPOSIT"; readonly lp: string; readonly amount: bigint }
  | {
      readonly kind: "ESCROW_DEPOSIT";
      readonly invoiceId: string;
      readonly importer: string;
      readonly amount: bigint;
      readonly txHash?: string;
    }
  | { readonly kind: "WITHDRAW"; readonly lp: string; readonly amount: bigint }
  | { readonly kind: "ADVANCE"; readonly advanceId: string; readonly amount: bigint }
  | {
      readonly kind: "REPAY";
      readonly advanceId: string;
      readonly principal: bigint;
      readonly fee: bigint;
    }
  | { readonly kind: "PAYOUT_CONFIRMED"; readonly advanceId: string; readonly txHash: string }
  | { readonly kind: "PAYOUT_CANCELLED"; readonly advanceId: string }
  | {
      readonly kind: "RELEASE";
      readonly invoiceId: string;
      readonly advanceId: string;
      readonly principal: bigint;
      readonly fee: bigint;
      readonly residual: bigint;
    }
  | {
      readonly kind: "RESIDUAL_CONFIRMED";
      readonly invoiceId: string;
      readonly amount: bigint;
      readonly txHash: string;
    };

/** Atomic three-way split of a released escrow (the repayment waterfall). */
export interface ReleaseResult {
  readonly advance: Advance;
  readonly principal: bigint;
  readonly fee: bigint;
  readonly residual: bigint;
}

export interface PoolState {
  /** USDC sitting in the pool, available to advance. */
  readonly liquidity: bigint;
  /** Principal locked for a payout that hasn't been confirmed on-chain yet. */
  readonly pendingPayout: bigint;
  /** Principal currently advanced and not yet repaid. */
  readonly outstanding: bigint;
  /** Fees earned by LPs since inception. */
  readonly feesAccrued: bigint;
  /** Per-LP deposited principal (simple share model for the MVP). */
  readonly lpDeposits: ReadonlyMap<string, bigint>;
  /** Per-invoice escrow bucket — isolated from liquidity (invariant 6). */
  readonly escrows: ReadonlyMap<string, Escrow>;
  /** Waterfall residual owed to the exporter, until confirmed on-chain. */
  readonly pendingResidual: ReadonlyMap<string, bigint>;
  /** All advances ever requested, keyed by advanceId. */
  readonly advances: ReadonlyMap<string, Advance>;
}

/** Errors are typed rejections, not thrown strings. */
export type AdvanceRejection =
  | { readonly code: "SA_REJECTED"; readonly reason: string }
  | { readonly code: "INSUFFICIENT_LIQUIDITY"; readonly liquidity: bigint }
  | { readonly code: "DUPLICATE_MISMATCH"; readonly advanceId: string }
  | { readonly code: "INVALID_AMOUNT" }
  | { readonly code: "ESCROW_INSUFFICIENT"; readonly escrowAmount: bigint }
  | { readonly code: "ESCROW_NOT_FOUND"; readonly invoiceId: string }
  | { readonly code: "INVOICE_BUSY"; readonly invoiceId: string };

export type AdvanceResult =
  | { readonly ok: true; readonly advance: Advance; readonly replay: boolean }
  | { readonly ok: false; readonly rejection: AdvanceRejection };
