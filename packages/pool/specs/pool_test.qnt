// -*- mode: Bluespec; -*-
/**
 * Deterministic scenario tests for pool_model. Kept out of the main module
 * per modelling convention. testInit forces all SAs valid so scenarios are
 * deterministic; SA-invalid paths are exercised by the nondeterministic
 * simulation in pool.qnt (inv_gate).
 */
module pool_test {
  import pool_model(
    INVOICES = Set(1, 2),
    ADVANCE_IDS = Set(1, 2),
    LPS = Set("lp1"),
    FEE_BPS = 2000
  ).* from "./pool"

  action testInit: bool = all {
    state' = {
      liquidity: 0,
      pendingPayout: 0,
      escrows: Set(1, 2).mapBy(_ => { amount: 0, status: Funded }),
      pendingResidual: Set(1, 2).mapBy(_ => 0),
      advances: Map(),
      lpDeposits: Set("lp1").mapBy(_ => 0),
      externalIn: 0,
      externalOut: 0,
    },
    saValid' = Set(1, 2).mapBy(_ => true),
    lastAction' = "init",
  }

  /** Happy path: escrow-backed advance through the full waterfall.
   *  F=6, P=4, fee=ceil(4*20%)=1, residual=1.
   *  End: liquidity 10+4+1-4=11, in 10+6=16, out 4+1=5, cash 11=16-5. */
  run happyEscrowPathTest = testInit
    .then(depositAction("lp1", 10))
    .then(escrowDepositAction(1, 6))
    .then(requestEscrowedAction(1, 1, 4))
    .then(confirmPayoutAction(1))
    .then(releaseEscrowAction(1))
    .then(confirmResidualAction(1))
    .expect(and {
      state.liquidity == 11,
      state.pendingPayout == 0,
      state.pendingResidual.get(1) == 0,
      state.escrows.get(1).status == Released,
      state.advances.get(1).status == Repaid,
      state.externalIn == 16,
      state.externalOut == 5,
      poolCash(state) == state.externalIn - state.externalOut,
    })

  /** Cancel rolls the locked quota back completely: observable funds as if never requested. */
  run cancelRollbackTest = testInit
    .then(depositAction("lp1", 10))
    .then(requestCreditAction(1, 5))
    .then(cancelPayoutAction(1))
    .expect(and {
      state.liquidity == 10,
      state.pendingPayout == 0,
      state.externalOut == 0,
      state.advances.get(1).status == Cancelled,
    })

  /** Credit path: exact-amount repayment P+fee (5+1=6). */
  run creditExactRepaymentTest = testInit
    .then(depositAction("lp1", 10))
    .then(requestCreditAction(1, 5))
    .then(confirmPayoutAction(1))
    .then(settleRepaymentAction(1, 6))
    .expect(and {
      state.liquidity == 11,
      state.advances.get(1).status == Repaid,
      state.externalIn == 16,
      state.externalOut == 5,
      poolCash(state) == state.externalIn - state.externalOut,
    })

  /** LP withdraw bounded by own deposits and pool liquidity. */
  run withdrawBoundedTest = testInit
    .then(depositAction("lp1", 10))
    .then(withdrawAction("lp1", 10))
    .expect(and {
      state.liquidity == 0,
      state.lpDeposits.get("lp1") == 0,
      state.externalIn == 10,
      state.externalOut == 10,
    })
}
