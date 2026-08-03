# Citely Pay (working title)

**T+0 cross-border settlement on Arc, where the credit gate is a verifiable
compliance proof — not trust.**

A UAE business initiates a cross-border payout. The
[Deal Desk](https://github.com/web3yaso/citely-deal-desk) engine produces a
Settlement Authorization (SA) — a signed, hash-anchored conditional proof.
This app's liquidity pool advances the payout **the moment the SA verifies**,
the beneficiary receives USDC on their chain of choice in seconds, and the
sender's funds repay the pool (plus a fixed-at-advance-time fee) when they
settle. LPs earn the financing fee; every advance in the book is backed by a
proof anyone can re-verify.

> Compliance-as-collateral: the pool only advances against SAs signed by an
> [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)-registered agent
> identity. Registry → SA signature → advance: the trust chain is on-chain
> end to end.

Settlement engine powered by Deal Desk (our Encode Arc Hackathon project);
this application — the PayFi layer, pool, and payment experience — is built
for the Ignyte Stablecoins Commerce Stack Challenge, Track 2.

## Status

| Piece | State |
|---|---|
| `packages/pool/specs` — Quint formal model of the fund-safety core | ✅ 7 invariants, 9 witnesses, 4 scenarios |
| `packages/pool` — escrow bucket / SA-gated advance / three-state payout / release waterfall / serialization | ✅ 33 tests incl. invariant fuzz harness |
| `packages/passport` — credit passport derived from the ledger | ✅ 3 tests |
| Verifier wiring (`@citely/verifier` as a library) | ⬜ |
| `apps/web` — financing console + passport view | ⬜ |
| `packages/chain` — Arc testnet USDC adapter | ⬜ |
| KV persistence + Vercel deployment | ⬜ |
| Architecture diagram, Circle Product Feedback section | ⬜ |

## Invariants (each enforced in code, each covered by tests)

1. **No advance ever leaves the pool without a verified SA.** The verifier is
   injected on the money path (`packages/pool/src/pool.ts`); no frontend
   parameter can bypass it.
2. **Advances are idempotent by `advanceId`.** Replay returns the original
   advance and moves no money; replay with tampered parameters is a hard
   rejection.
3. **Fees are fixed at advance time** and never round to zero.
4. **Repayment is exact-amount or nothing** — silent partial settlement would
   corrupt LP accounting, so it is a hard error.
5. **All amounts are bigint USDC minor units.** No floats on the money path.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
```
