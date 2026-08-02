# Pool v2 — formal model (Quint)

`pool.qnt` is the ground-truth specification of the pool's fund-safety state
machine, written before the implementation. **If model and code disagree, the
model wins; never edit the model to match broken code.** Design doc:
`docs/superpowers/specs/2026-08-02-track2-passport-pivot-design.md` §4/§8.

## What it covers

- Escrow bucket (per-invoice, isolated from LP liquidity), funded by importers.
- SA-gated advances, both paths: escrowed (requires full escrow coverage
  `P + fee ≤ F`, at most one active advance per invoice) and credit.
- Three-state payout: `PendingPayout → confirmPayout(Outstanding) | cancelPayout(Cancelled)`,
  cancel fully rolls back the locked quota.
- Release waterfall: escrow `F` splits atomically into `P + fee → liquidity`
  and `F − P − fee → pendingResidual`, residual leaves only on on-chain
  confirmation (retry-only, no cancel — escrow release is irreversible).
- Credit repayment: exact `P + fee` or nothing.
- LP deposit/withdraw (withdraw bounded by own deposits and pool liquidity).

Checked invariants (all hold, sampled `quint run`, 300–500 traces × 30 steps):

| Invariant | Meaning |
|---|---|
| `inv_conservation` | pool cash ≡ external in − external out (no money created/lost) |
| `inv_nonNegative` | no bucket ever negative |
| `inv_gate` | every advance passed the SA gate; escrowed ones fully covered |
| `inv_pendingBucket` | pendingPayout bucket ≡ sum of pending principals (confirm/cancel never leak) |
| `inv_feeNonZero` | nonzero fee rate never rounds to zero |
| `inv_escrowLifecycle` | escrowed Repaid ⇒ escrow Released |
| `inv_singleActive` | ≤ 1 non-cancelled advance per invoice |

Reachability: 9 witnesses, all reached (> 0 traces), i.e. no dead action.
Deterministic scenarios with exact cash reconciliation: `pool_test.qnt` (4 runs).

```bash
quint typecheck pool.qnt
quint run pool.qnt --main=pool_2 --invariant=allInvariants --max-steps=30 --max-samples=300
quint run pool.qnt --main=pool_2 --invariant=allInvariants \
  --witnesses w_escrowFunded w_advancePending w_advanceOutstanding w_escrowedRepaid \
  w_creditRepaid w_cancelled w_residualPending w_residualConfirmed w_withdrawn \
  --max-steps=30 --max-samples=500
quint test pool_test.qnt --main=pool_test
```

## What it does NOT cover

- Verifier internals: SA validity is an oracle bit per advance; the model checks
  the gate cannot be bypassed, not that the verifier judges correctly (that is
  deal-desk's test responsibility).
- Timestamps, passport derivation, serialization/KV, chain-adapter mechanics —
  they never move money.
- **Escrow refund** (importer funded, deal cancelled before any advance): not
  designed yet; roadmap. The model has no refund action, so funded-but-unused
  escrow stays in the pool — matches the current design's scope.
- Idempotent *replay responses* (same advanceId returns the original result):
  modeled only as "an id can never be spent twice" (creation guard); the
  response-echo behavior is an API concern covered by vitest.

## When to update

Change the model and re-run all three commands **before** changing
`packages/pool/src`. Implementation unit tests should assert the same
invariants the model checks (one vitest describe block per invariant).
