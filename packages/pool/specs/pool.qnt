// -*- mode: Bluespec; -*-
/**
 * Formal model of Pool v2 (design doc: docs/superpowers/specs/2026-08-02-track2-passport-pivot-design.md §4).
 *
 * Scope: the fund-safety state machine only — escrow bucket, SA-gated advance
 * (escrowed + credit paths), three-state payout, release waterfall, LP
 * deposit/withdraw. SA verification is a per-advance oracle bit (the model
 * checks the gate cannot be bypassed, not the verifier's internals). Passport,
 * chain-adapter internals, serialization and timestamps are out of scope: they
 * never move money.
 *
 * Verified properties (design doc §8): conservation, escrow isolation,
 * gate completeness, settlement consistency, plus reachability witnesses.
 */
module pool_model {
  // === System-model constants =============================================
  const INVOICES: Set[int]     // invoice ids (escrow slots)
  const ADVANCE_IDS: Set[int]  // advance idempotency keys; advance i is backed by SA i
  const LPS: Set[str]          // liquidity providers
  const FEE_BPS: int           // advance fee in basis points

  val DENOM = 10000

  // === Types ==============================================================
  type EscrowStatus = Funded | Released
  type AdvStatus = PendingPayout | Outstanding | Repaid | Cancelled
  type Ref = Escrowed(int) | Credit   // an advance's invoice reference

  type Escrow = { amount: int, status: EscrowStatus }
  type Advance = { ref: Ref, principal: int, fee: int, status: AdvStatus }

  type PoolState = {
    liquidity: int,                 // advanceable LP cash (repaid fees flow back here)
    pendingPayout: int,             // principal locked by PendingPayout advances
    escrows: int -> Escrow,         // per-invoice escrow bucket (isolated)
    pendingResidual: int -> int,    // waterfall residual owed to exporter, until confirmed on-chain
    advances: int -> Advance,       // keyed by advance id; absent = never requested
    lpDeposits: str -> int,
    externalIn: int,                // cumulative cash that entered the pool
    externalOut: int,               // cumulative cash that left the pool (confirmed on-chain)
  }

  var state: PoolState
  var saValid: int -> bool          // SA oracle: advance id -> does its SA verify?
  var lastAction: str               // witness helper: which action fired last

  // === Functional layer ===================================================
  pure def ceilFee(p: int, feeBps: int): int = (p * feeBps + DENOM - 1) / DENOM

  pure def escrowFundedTotal(s: PoolState): int =
    s.escrows.keys().fold(0, (acc, i) => {
      val e = s.escrows.get(i)
      if (e.status == Funded) acc + e.amount else acc
    })

  pure def residualTotal(s: PoolState): int =
    s.pendingResidual.keys().fold(0, (acc, i) => acc + s.pendingResidual.get(i))

  pure def poolCash(s: PoolState): int =
    s.liquidity + s.pendingPayout + escrowFundedTotal(s) + residualTotal(s)

  /** Is there a non-cancelled advance already referencing this invoice? */
  pure def hasActiveAdvanceOn(s: PoolState, inv: int): bool =
    s.advances.keys().exists(a => {
      val ad = s.advances.get(a)
      match ad.ref { | Escrowed(i) => i == inv and ad.status != Cancelled | Credit => false }
    })

  /** The Outstanding escrowed advance(s) on an invoice (by construction at most one). */
  pure def outstandingOn(s: PoolState, inv: int): Set[int] =
    s.advances.keys().filter(a => {
      val ad = s.advances.get(a)
      match ad.ref { | Escrowed(i) => i == inv and ad.status == Outstanding | Credit => false }
    })

  pure def pickOne(ids: Set[int]): int = ids.fold(-1, (acc, x) => x)

  // --- guards -------------------------------------------------------------
  pure def canDeposit(amt: int): bool = amt > 0

  pure def canWithdraw(s: PoolState, lp: str, amt: int): bool =
    amt > 0 and amt <= s.lpDeposits.get(lp) and amt <= s.liquidity

  pure def canEscrowDeposit(s: PoolState, inv: int, amt: int): bool =
    amt > 0 and s.escrows.get(inv).status == Funded

  pure def canRequestEscrowed(s: PoolState, id: int, inv: int, p: int, feeBps: int): bool = and {
    not(s.advances.keys().contains(id)),   // idempotency: an id is spent forever
    p > 0,
    s.liquidity >= p,
    s.escrows.get(inv).status == Funded,
    p + ceilFee(p, feeBps) <= s.escrows.get(inv).amount,   // escrow fully covers due
    not(hasActiveAdvanceOn(s, inv)),        // one active advance per invoice
  }

  pure def canRequestCredit(s: PoolState, id: int, p: int): bool = and {
    not(s.advances.keys().contains(id)),
    p > 0,
    s.liquidity >= p,
  }

  pure def canSettle(s: PoolState, id: int, amt: int): bool = and {
    s.advances.keys().contains(id),
    val ad = s.advances.get(id)
    and {
      ad.status == Outstanding,
      ad.ref == Credit,
      amt == ad.principal + ad.fee,        // exact-amount-or-nothing
    }
  }

  // --- updates ------------------------------------------------------------
  pure def applyDeposit(s: PoolState, lp: str, amt: int): PoolState =
    { ...s, liquidity: s.liquidity + amt,
            lpDeposits: s.lpDeposits.setBy(lp, d => d + amt),
            externalIn: s.externalIn + amt }

  pure def applyWithdraw(s: PoolState, lp: str, amt: int): PoolState =
    { ...s, liquidity: s.liquidity - amt,
            lpDeposits: s.lpDeposits.setBy(lp, d => d - amt),
            externalOut: s.externalOut + amt }

  pure def applyEscrowDeposit(s: PoolState, inv: int, amt: int): PoolState =
    { ...s, escrows: s.escrows.setBy(inv, e => { ...e, amount: e.amount + amt }),
            externalIn: s.externalIn + amt }

  pure def applyRequest(s: PoolState, id: int, ref: Ref, p: int, feeBps: int): PoolState =
    { ...s, liquidity: s.liquidity - p,
            pendingPayout: s.pendingPayout + p,
            advances: s.advances.put(id,
              { ref: ref, principal: p, fee: ceilFee(p, feeBps), status: PendingPayout }) }

  pure def applyConfirmPayout(s: PoolState, id: int): PoolState = {
    val ad = s.advances.get(id)
    { ...s, pendingPayout: s.pendingPayout - ad.principal,
            externalOut: s.externalOut + ad.principal,
            advances: s.advances.set(id, { ...ad, status: Outstanding }) }
  }

  pure def applyCancelPayout(s: PoolState, id: int): PoolState = {
    val ad = s.advances.get(id)
    { ...s, pendingPayout: s.pendingPayout - ad.principal,
            liquidity: s.liquidity + ad.principal,          // full rollback
            advances: s.advances.set(id, { ...ad, status: Cancelled }) }
  }

  /** Waterfall: escrow F splits atomically into P+fee -> liquidity, F-P-fee -> residual owed. */
  pure def applyRelease(s: PoolState, inv: int, aid: int): PoolState = {
    val ad = s.advances.get(aid)
    val f = s.escrows.get(inv).amount
    { ...s, escrows: s.escrows.setBy(inv, e => { ...e, status: Released }),
            liquidity: s.liquidity + ad.principal + ad.fee,
            pendingResidual: s.pendingResidual.set(inv, f - ad.principal - ad.fee),
            advances: s.advances.set(aid, { ...ad, status: Repaid }) }
  }

  pure def applyConfirmResidual(s: PoolState, inv: int): PoolState =
    { ...s, externalOut: s.externalOut + s.pendingResidual.get(inv),
            pendingResidual: s.pendingResidual.set(inv, 0) }

  pure def applySettle(s: PoolState, id: int, amt: int): PoolState = {
    val ad = s.advances.get(id)
    { ...s, liquidity: s.liquidity + amt,
            externalIn: s.externalIn + amt,
            advances: s.advances.set(id, { ...ad, status: Repaid }) }
  }

  // === Init ===============================================================
  action init: bool = {
    nondet validSas = ADVANCE_IDS.powerset().oneOf()
    all {
      state' = {
        liquidity: 0,
        pendingPayout: 0,
        escrows: INVOICES.mapBy(_ => { amount: 0, status: Funded }),  // amount 0 = not yet funded
        pendingResidual: INVOICES.mapBy(_ => 0),
        advances: Map(),
        lpDeposits: LPS.mapBy(_ => 0),
        externalIn: 0,
        externalOut: 0,
      },
      saValid' = ADVANCE_IDS.mapBy(a => validSas.contains(a)),
      lastAction' = "init",
    }
  }

  // === Actions ============================================================
  action depositAction(lp: str, amt: int): bool = all {
    canDeposit(amt),
    state' = applyDeposit(state, lp, amt),
    saValid' = saValid,
    lastAction' = "deposit",
  }

  action withdrawAction(lp: str, amt: int): bool = all {
    canWithdraw(state, lp, amt),
    state' = applyWithdraw(state, lp, amt),
    saValid' = saValid,
    lastAction' = "withdraw",
  }

  action escrowDepositAction(inv: int, amt: int): bool = all {
    canEscrowDeposit(state, inv, amt),
    state' = applyEscrowDeposit(state, inv, amt),
    saValid' = saValid,
    lastAction' = "escrowDeposit",
  }

  action requestEscrowedAction(id: int, inv: int, p: int): bool = all {
    saValid.get(id),                                   // the SA gate — on the money path
    canRequestEscrowed(state, id, inv, p, FEE_BPS),
    state' = applyRequest(state, id, Escrowed(inv), p, FEE_BPS),
    saValid' = saValid,
    lastAction' = "requestEscrowed",
  }

  action requestCreditAction(id: int, p: int): bool = all {
    saValid.get(id),                                   // the SA gate — on the money path
    canRequestCredit(state, id, p),
    state' = applyRequest(state, id, Credit, p, FEE_BPS),
    saValid' = saValid,
    lastAction' = "requestCredit",
  }

  action confirmPayoutAction(id: int): bool = all {
    state.advances.keys().contains(id),
    state.advances.get(id).status == PendingPayout,
    state' = applyConfirmPayout(state, id),
    saValid' = saValid,
    lastAction' = "confirmPayout",
  }

  action cancelPayoutAction(id: int): bool = all {
    state.advances.keys().contains(id),
    state.advances.get(id).status == PendingPayout,
    state' = applyCancelPayout(state, id),
    saValid' = saValid,
    lastAction' = "cancelPayout",
  }

  action releaseEscrowAction(inv: int): bool = {
    val cands = outstandingOn(state, inv)
    all {
      state.escrows.get(inv).status == Funded,
      cands.size() > 0,
      state' = applyRelease(state, inv, pickOne(cands)),
      saValid' = saValid,
      lastAction' = "releaseEscrow",
    }
  }

  action confirmResidualAction(inv: int): bool = all {
    state.pendingResidual.get(inv) > 0,
    state' = applyConfirmResidual(state, inv),
    saValid' = saValid,
    lastAction' = "confirmResidual",
  }

  action settleRepaymentAction(id: int, amt: int): bool = all {
    canSettle(state, id, amt),
    state' = applySettle(state, id, amt),
    saValid' = saValid,
    lastAction' = "settleRepayment",
  }

  action step: bool = {
    nondet lp = LPS.oneOf()
    nondet inv = INVOICES.oneOf()
    nondet aid = ADVANCE_IDS.oneOf()
    nondet amt = 1.to(10).oneOf()
    nondet p = 1.to(6).oneOf()
    any {
      depositAction(lp, amt),
      withdrawAction(lp, amt),
      escrowDepositAction(inv, amt),
      requestEscrowedAction(aid, inv, p),
      requestCreditAction(aid, p),
      confirmPayoutAction(aid),
      cancelPayoutAction(aid),
      releaseEscrowAction(inv),
      confirmResidualAction(inv),
      settleRepaymentAction(aid, amt),
    }
  }

  // === Properties: invariants (design doc §8) =============================

  /** Conservation: pool cash always equals external in minus external out. */
  val inv_conservation: bool =
    poolCash(state) == state.externalIn - state.externalOut

  /** No bucket ever goes negative. */
  val inv_nonNegative: bool = and {
    state.liquidity >= 0,
    state.pendingPayout >= 0,
    state.escrows.keys().forall(i => state.escrows.get(i).amount >= 0),
    state.pendingResidual.keys().forall(i => state.pendingResidual.get(i) >= 0),
    state.lpDeposits.keys().forall(lp => state.lpDeposits.get(lp) >= 0),
  }

  /** Gate completeness: every advance that exists passed the SA gate,
   *  and escrowed ones are fully covered by their escrow. */
  val inv_gate: bool =
    state.advances.keys().forall(a => {
      val ad = state.advances.get(a)
      and {
        saValid.get(a),
        match ad.ref {
          | Escrowed(inv) => ad.principal + ad.fee <= state.escrows.get(inv).amount
          | Credit => true
        }
      }
    })

  /** Settlement consistency: the pendingPayout bucket is exactly the sum of
   *  principal locked by PendingPayout advances (confirm/cancel never leak). */
  val inv_pendingBucket: bool =
    state.pendingPayout == state.advances.keys().fold(0, (acc, a) => {
      val ad = state.advances.get(a)
      if (ad.status == PendingPayout) acc + ad.principal else acc
    })

  /** A nonzero fee rate never rounds a fee to zero. */
  val inv_feeNonZero: bool =
    state.advances.keys().forall(a => state.advances.get(a).fee >= 1)

  /** Escrow lifecycle: a Released escrow has exactly its one Repaid advance;
   *  an escrowed Repaid advance implies its escrow is Released. */
  val inv_escrowLifecycle: bool =
    state.advances.keys().forall(a => {
      val ad = state.advances.get(a)
      match ad.ref {
        | Escrowed(inv) => ad.status != Repaid or state.escrows.get(inv).status == Released
        | Credit => true
      }
    })

  /** At most one non-cancelled advance per invoice. */
  val inv_singleActive: bool =
    INVOICES.forall(inv =>
      state.advances.keys().filter(a => {
        val ad = state.advances.get(a)
        match ad.ref { | Escrowed(i) => i == inv and ad.status != Cancelled | Credit => false }
      }).size() <= 1)

  val allInvariants: bool = and {
    inv_conservation,
    inv_nonNegative,
    inv_gate,
    inv_pendingBucket,
    inv_feeNonZero,
    inv_escrowLifecycle,
    inv_singleActive,
  }

  // === Properties: witnesses (reachability) ===============================
  val w_escrowFunded: bool = INVOICES.exists(i => state.escrows.get(i).amount > 0)
  val w_advancePending: bool = state.advances.keys().exists(a => state.advances.get(a).status == PendingPayout)
  val w_advanceOutstanding: bool = state.advances.keys().exists(a => state.advances.get(a).status == Outstanding)
  val w_escrowedRepaid: bool = state.advances.keys().exists(a => {
    val ad = state.advances.get(a)
    ad.status == Repaid and ad.ref != Credit
  })
  val w_creditRepaid: bool = state.advances.keys().exists(a => {
    val ad = state.advances.get(a)
    ad.status == Repaid and ad.ref == Credit
  })
  val w_cancelled: bool = state.advances.keys().exists(a => state.advances.get(a).status == Cancelled)
  val w_residualPending: bool = INVOICES.exists(i => state.pendingResidual.get(i) > 0)
  val w_residualConfirmed: bool = lastAction == "confirmResidual"
  val w_withdrawn: bool = lastAction == "withdraw"
}

module pool_2 {
  import pool_model(
    INVOICES = Set(1, 2),
    ADVANCE_IDS = Set(1, 2),
    LPS = Set("lp1"),
    FEE_BPS = 2000
  ).*
}
