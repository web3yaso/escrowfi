# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Citely Pay (working title): T+0 cross-border settlement on Arc. A liquidity pool advances USDC payouts the moment a Settlement Authorization (SA) — a signed compliance proof produced by the separate [Deal Desk](https://github.com/web3yaso/citely-deal-desk) engine — verifies. Built for the Ignyte Stablecoins Commerce Stack Challenge, Track 2 (deadline 2026-08-09). The full design/plan (in Chinese) lives in `doc/IgnytePayFi扩展设计20260729.md`; the README status table tracks what's built vs. planned.

## Commands

pnpm workspace monorepo (`packages/*`, `apps/*`), Node >= 20, ESM throughout.

```bash
pnpm install
pnpm test                # all packages, vitest
pnpm typecheck           # all packages, tsc --noEmit
```

Single test run, from `packages/pool`:

```bash
pnpm vitest run src/pool.test.ts             # one file
pnpm vitest run -t "no advance without"      # by test name
```

## Architecture

`packages/pool` (`@citely-pay/pool`) is the product core: in-memory deposit / SA-gated advance / repayment accounting. It ships TypeScript source directly (`main` points at `src/index.ts`, no build step).

The key structural decision is **dependency-injected verification**: the pool never talks to a network. `SaVerifier` (`src/types.ts`) is an async function injected via `PoolConfig`, sitting directly on the money path in `Pool.requestAdvance` (`src/pool.ts`). Production will wire it to the deployed Deal Desk verifier service; tests inject doubles. This makes the compliance gate enforceable in tests and impossible to bypass via frontend parameters.

Planned but not yet present (see README status table): wiring to the real Deal Desk verifier, Circle Wallets, CCTP + Bridge Kit for beneficiary chain choice, and `apps/web` (Next.js payout flow + LP dashboard, deployed to Vercel).

## Invariants — enforced in code, each covered by tests

These define the product; don't weaken them when changing `packages/pool`:

1. **No advance leaves the pool without a verified SA.** Verification runs before the liquidity check so rejection reasons never depend on pool balance.
2. **Advances are idempotent by `advanceId`.** Replay with identical params returns the original advance (`replay: true`) and moves no money; replay with different params is a hard `DUPLICATE_MISMATCH` rejection — never a second payment.
3. **Fees are fixed at advance time** and computed with ceiling division so a nonzero-bps fee never rounds to zero.
4. **Repayment is exact-amount (principal + fee) or a thrown error** — silent partial settlement would corrupt LP accounting. Repaying an already-REPAID advance is an idempotent no-op.
5. **All amounts are bigint USDC minor units (6 decimals).** No floats on the money path.

## Conventions

- Expected failures on the advance path are typed rejections (`AdvanceRejection` discriminated union in `AdvanceResult`), not thrown errors; throws are reserved for caller bugs (unknown advance, wrong repayment amount, invalid deposit).
- Strict TypeScript (`tsconfig.base.json`): `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Imports use `.js` extensions (NodeNext resolution).
- Tests live next to source (`src/*.test.ts`) and are organized around the invariants they protect.

## Security notes (from the design doc)

- No secrets in the repo from the first commit; keys only via environment variables.
- SA verification must stay forced on the advance path — never bypassable by frontend parameters.
- Future CCTP arrival confirmation must be based on on-chain event polling, not frontend self-report.
