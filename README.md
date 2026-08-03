# Citely Pay

**SME trade finance on Arc, where the credit gate is a verifiable compliance
proof — not trust. Every completed cycle becomes a line in an on-ledger,
re-verifiable Credit Passport.**

A UAE SME exports goods and needs working capital *now*; its buyer pays at
maturity. Citely Pay closes that gap with three moves:

1. **Escrow** — the importer locks the invoice amount in the pool (USDC),
   earmarked for that one trade. Conditional protection for the buyer,
   certainty of funds for everyone else.
2. **SA-gated advance** — the [Deal Desk](https://github.com/web3yaso/citely-deal-desk)
   engine produces a Settlement Authorization (SA): a signed, hash-anchored
   compliance proof. The pool re-verifies it **locally** (EIP-712 signature ↔
   registered signer, expiry, and a PASS leg naming this payee and amount) and
   advances the exporter T+0. No valid proof, no money — the gate is on the
   money path and no frontend parameter can bypass it.
3. **Waterfall release** — at delivery/maturity the escrow splits atomically:
   principal + fee back to LPs, the residual to the exporter. Every transfer
   carries a tx hash; every advance carries its SA hash.

The by-product is the product: an ERC-8004-anchored **Credit Passport** —
never stored, derived from the pool ledger on every read, each line
re-verifiable by anyone (re-run the SA check live, click through to the
explorer). Compliance-as-collateral instead of credit committees.

> Track 2 — Best SME Trade Finance & Working Capital Workflow
> (Ignyte Stablecoins Commerce Stack Challenge). Settlement engine powered by
> Deal Desk, our Encode Arc Hackathon project; this repo is the trade-finance
> application built on top of it.

## Why this is different

Huma/Arf-style PayFi advances against receivables, but their underwriting is
institutional due diligence. Here the underwriting artifact is **machine-
verifiable per transaction**: registry → SA signature → escrow coverage →
advance. The failed trade-finance consortia (TradeLens, we.trade, Marco Polo)
required the whole supply chain to change workflows; this design only has to
convince one party — the liquidity provider — and the proof does that job.

## Architecture

```mermaid
flowchart LR
  subgraph web [apps/web — console + passport]
    C[Financing console] --> API[API routes]
    P[Credit passport view] --> API
  end
  API --> Pool[packages/pool<br/>escrow bucket · SA gate · 3-state payout · waterfall]
  API --> Passport[packages/passport<br/>pure derivation from ledger]
  Pool -- injected SaVerifier --> V[packages/verify-adapter<br/>local EIP-712 re-verification]
  API --> Chain[packages/chain<br/>USDC on Arc · simulated fallback]
  Pool -. snapshot .-> KV[(Upstash KV)]
  V -. proofs from .-> DD[Deal Desk engine<br/>ERC-8004 agent #854638]
```

- **`packages/pool`** — the accounting core. Formally modeled in Quint
  (`packages/pool/specs/`): 7 fund-safety invariants (conservation, escrow
  isolation, gate completeness, settlement consistency…) hold across sampled
  model checking, and a seeded fuzz harness asserts the same invariants in
  vitest after every random operation. The model is ground truth; the
  implementation mirrors it invariant-for-invariant.
- **`packages/verify-adapter`** — the pool's trust boundary. Verifies SAs
  locally with the vendored Deal Desk verifier checks: your own money, your
  own verification — no reliance on the issuer's uptime or honesty.
- **`packages/chain`** — `CHAIN_MODE=arc` for real Arc-testnet USDC
  (fail-closed: reverted transfers throw, unknown modes throw, txs bound to
  chain id) or `simulated` (deterministic hashes, clearly labeled in the UI).
- **`packages/passport`** — zero state. A passport that is recomputed from
  verifiable records on every read cannot be forged or drift out of sync.

## Fund-safety invariants (each enforced in code, tested, and model-checked)

1. No advance ever leaves the pool without a locally verified SA **bound to
   that payee and amount**; escrowed advances additionally require full
   escrow coverage (`P + fee ≤ F`) and one active advance per invoice.
2. Advances are idempotent by `advanceId`; tampered replays are hard-rejected.
3. Fees are fixed at advance time and never round to zero.
4. Escrow funds are strictly isolated from LP liquidity — they can only leave
   through the release waterfall, exactly once per invoice.
5. Money leaves accounting only with an on-chain confirmation
   (`PENDING_PAYOUT → confirm/cancel`); a cancelled payout rolls back fully.
6. Repayment is exact-amount-or-error; the waterfall three-way split always
   sums to the escrow amount.
7. All amounts are bigint USDC minor units. No floats on the money path.

## Demo script (2 minutes)

1. **Console → Lock funds**: importer escrows 2.0 USDC against `inv-1`.
2. **Request advance** with a valid SA: exporter receives 1.5 USDC T+0
   (watch the pool sidebar: liquidity down, outstanding up, tx hash attached).
3. **Request again with the SA marked `BAD SIGNATURE`** — the pool answers
   `422 SA_REJECTED / signature check failed`. The gate is real.
4. **Release escrow**: atomic waterfall — 1.5 principal + 0.3 fee to LPs,
   0.2 residual to the exporter, all with tx hashes.
5. **Credit Passport**: the cycle is now a passport line — expand it, hit
   *verify*, and the SA is re-checked live; every tx links out.

## Run it

```bash
pnpm install
pnpm -r test        # 53 tests: pool (33) · chain (4) · verify-adapter (8) · passport (3) · web (5)
pnpm typecheck
cd apps/web && pnpm dev   # console on http://localhost:3000, simulated chain
```

Formal model: `cd packages/pool/specs && quint test pool_test.qnt --main=pool_test`
(see `packages/pool/specs/README.md` for the full invariant/witness commands).

Env (`apps/web`): `CHAIN_MODE=arc` needs `ARC_RPC_URL`, `POOL_WALLET_KEY`,
`ARC_USDC_ADDRESS`, `ARC_CHAIN_ID`; KV persistence needs `KV_URL`, `KV_TOKEN`.
Defaults: simulated chain + in-memory store — the full demo runs with zero
configuration.

## Circle products

| Product | Use here |
|---|---|
| **USDC (Arc)** | Escrow, advances, waterfall settlement — every money movement |
| **Circle Wallets** | Roadmap: embedded wallets so non-crypto SMEs hold their own keys |
| **CCTP + Bridge Kit** | Roadmap: exporter chooses the receiving chain for advances |
| **Gateway** | Roadmap: treasury routing for multi-pool operations |
| **USYC** | Roadmap: yield on idle pool liquidity between advances |

### Product feedback

- *USDC/Arc*: the EVM-standard surface made the chain adapter trivially thin
  (viem + erc20Abi); public testnet RPC rate limits were the only friction —
  a documented, keyed dev endpoint would remove it.
- *Wallets/CCTP*: we kept these architecture-level for the deadline; the docs
  are clear, but a single "testnet quickstart matrix" (which chains, which
  faucets, which quotas) would have saved the evaluation time that pushed
  them to the roadmap.

## Honest limitations & roadmap

- **Custody**: pool funds sit in a developer-controlled wallet for the MVP;
  production path is an ERC-4626 vault.
- **Dispute window**: releases are importer-confirmed or maturity-triggered;
  a dispute/arbitration path (reusing Deal Desk's ESCALATE semantics) is
  designed but not built.
- **Escrow refund** (deal cancelled before any advance) — surfaced by the
  Quint model as a gap; roadmap.
- Verifier module-attestation and rubric-coverage checks (beyond signature/
  expiry/leg binding) activate once the Deal Desk manifest assets ship with
  the app.
- SAs are pre-generated by Deal Desk for the demo; live issuance is an
  integration flag away.
