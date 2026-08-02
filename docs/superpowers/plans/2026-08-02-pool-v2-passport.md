# Pool v2 + Passport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the escrow-backed pool v2 (three-state payout, release waterfall) and the passport derivation package, matching the verified Quint model `packages/pool/specs/pool.qnt` invariant-for-invariant.

**Architecture:** Pure in-memory accounting core (`packages/pool`) with injected SA verifier; escrow bucket strictly isolated from LP liquidity; a zero-state derivation package (`packages/passport`) computing the credit passport from the ledger. The Quint model is ground truth — every vitest suite mirrors a model invariant or scenario.

**Tech Stack:** TypeScript strict (NodeNext ESM, `.js` import extensions), vitest 4, pnpm workspace. All amounts bigint USDC minor units. Timestamps are `number` epoch ms passed in by callers (pool never reads a clock).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-02-track2-passport-pivot-design.md` §4–§5; model: `packages/pool/specs/pool.qnt` (never edit the model to match code).
- Invariants 1–7 (spec §4) must hold after every task; the fuzz suite (Task 7) asserts them mechanically.
- Expected failures on the advance path are typed rejections; throws are reserved for caller bugs.
- No floats on the money path; fee = `ceil(P × feeBps / 10000)`.
- Existing 11 tests may be *updated* for the new state machine but their protected invariants must survive.
- Run tests from `packages/pool` (or the new package) with `pnpm vitest run <file>`; typecheck with `pnpm typecheck` at repo root before each commit.

---

### Task 1: Three-state payout + timestamps

**Files:**
- Modify: `packages/pool/src/types.ts`
- Modify: `packages/pool/src/pool.ts`
- Modify: `packages/pool/src/pool.test.ts` (update existing cases to confirm flow)
- Test: `packages/pool/src/payout.test.ts`

**Interfaces:**
- Consumes: existing `Pool`, `SaVerifier`.
- Produces (later tasks rely on exactly these):
  - `AdvanceStatus = "PENDING_PAYOUT" | "OUTSTANDING" | "REPAID" | "CANCELLED" | "WRITTEN_OFF"`
  - `Advance` gains `readonly invoiceId?: string; readonly advancedAt: number; readonly dueAt: number; readonly repaidAt?: number; readonly payoutTxHash?: string`
  - `requestAdvance(input: { advanceId: string; saHash: string; payee: string; amount: bigint; invoiceId?: string; advancedAt: number; dueAt: number }): Promise<AdvanceResult>` → advance starts `PENDING_PAYOUT`; liquidity moves to an internal pending bucket.
  - `confirmPayout(advanceId: string, txHash: string): Advance` → `OUTSTANDING`, ledger `PAYOUT_CONFIRMED { advanceId, txHash }`.
  - `cancelPayout(advanceId: string): Advance` → `CANCELLED`, liquidity fully restored, ledger `PAYOUT_CANCELLED { advanceId }`.
  - `PoolState` gains `readonly pendingPayout: bigint`.
  - `settleRepayment(advanceId: string, amount: bigint, repaidAt: number): Advance` (extra param; only `OUTSTANDING` settles).

- [ ] **Step 1: Write the failing test**

```ts
// packages/pool/src/payout.test.ts
import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp", agentId: "854638" });
const T0 = 1_756_700_000_000; // arbitrary epoch ms
const DUE = T0 + 30 * 86_400_000;

function funded() {
  const pool = new Pool({ feeBps: 2000n, verify: PASS });
  pool.deposit("lp-1", 10n);
  return pool;
}

async function requested(pool: Pool) {
  const r = await pool.requestAdvance({
    advanceId: "a1", saHash: "0xsa", payee: "0xexp", amount: 5n,
    advancedAt: T0, dueAt: DUE,
  });
  if (!r.ok) throw new Error("expected ok");
  return r.advance;
}

describe("three-state payout", () => {
  it("requestAdvance locks quota as PENDING_PAYOUT without external outflow", async () => {
    const pool = funded();
    const adv = await requested(pool);
    expect(adv.status).toBe("PENDING_PAYOUT");
    expect(adv.advancedAt).toBe(T0);
    expect(adv.dueAt).toBe(DUE);
    expect(pool.state().liquidity).toBe(5n);
    expect(pool.state().pendingPayout).toBe(5n);
    expect(pool.state().outstanding).toBe(0n);
  });

  it("confirmPayout moves PENDING_PAYOUT to OUTSTANDING with txHash", async () => {
    const pool = funded();
    await requested(pool);
    const adv = pool.confirmPayout("a1", "0xtx1");
    expect(adv.status).toBe("OUTSTANDING");
    expect(adv.payoutTxHash).toBe("0xtx1");
    expect(pool.state().pendingPayout).toBe(0n);
    expect(pool.state().outstanding).toBe(5n);
    expect(pool.ledger().some(e => e.kind === "PAYOUT_CONFIRMED" && e.txHash === "0xtx1")).toBe(true);
  });

  it("cancelPayout rolls the quota back completely (inv 7)", async () => {
    const pool = funded();
    await requested(pool);
    const adv = pool.cancelPayout("a1");
    expect(adv.status).toBe("CANCELLED");
    expect(pool.state().liquidity).toBe(10n);
    expect(pool.state().pendingPayout).toBe(0n);
    expect(pool.state().outstanding).toBe(0n);
  });

  it("confirm and cancel are mutually exclusive and only from PENDING_PAYOUT", async () => {
    const pool = funded();
    await requested(pool);
    pool.confirmPayout("a1", "0xtx1");
    expect(() => pool.cancelPayout("a1")).toThrow(/OUTSTANDING/);
    expect(() => pool.confirmPayout("a1", "0xtx2")).toThrow(/OUTSTANDING/);
  });

  it("settleRepayment records repaidAt and only settles OUTSTANDING", async () => {
    const pool = funded();
    await requested(pool);
    expect(() => pool.settleRepayment("a1", 6n, DUE)).toThrow(/PENDING_PAYOUT/);
    pool.confirmPayout("a1", "0xtx1");
    const adv = pool.settleRepayment("a1", 6n, DUE); // 5 + ceil(5*20%)=1
    expect(adv.status).toBe("REPAID");
    expect(adv.repaidAt).toBe(DUE);
    expect(pool.state().liquidity).toBe(11n);
  });

  it("replay of PENDING request is idempotent; tampered replay hard-rejects", async () => {
    const pool = funded();
    await requested(pool);
    const replay = await pool.requestAdvance({
      advanceId: "a1", saHash: "0xsa", payee: "0xexp", amount: 5n,
      advancedAt: T0, dueAt: DUE,
    });
    expect(replay.ok && replay.replay).toBe(true);
    const tampered = await pool.requestAdvance({
      advanceId: "a1", saHash: "0xsa", payee: "0xEVIL", amount: 5n,
      advancedAt: T0, dueAt: DUE,
    });
    expect(!tampered.ok && tampered.rejection.code === "DUPLICATE_MISMATCH").toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pool && pnpm vitest run src/payout.test.ts`
Expected: FAIL — `advancedAt` missing from input type / `confirmPayout is not a function`.

- [ ] **Step 3: Implement**

In `types.ts` — replace `AdvanceStatus` and extend `Advance` / `LedgerEntry` / `PoolState`:

```ts
export type AdvanceStatus =
  | "PENDING_PAYOUT" | "OUTSTANDING" | "REPAID" | "CANCELLED" | "WRITTEN_OFF";

export interface Advance {
  readonly advanceId: string;
  readonly saHash: string;
  readonly payee: string;
  readonly principal: bigint;
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
```

Add to `LedgerEntry` union:

```ts
  | { readonly kind: "PAYOUT_CONFIRMED"; readonly advanceId: string; readonly txHash: string }
  | { readonly kind: "PAYOUT_CANCELLED"; readonly advanceId: string }
```

Add `readonly pendingPayout: bigint;` to `PoolState`.

In `pool.ts`:

```ts
#pendingPayout = 0n;
```

`requestAdvance` — extend the input type with `invoiceId?/advancedAt/dueAt`, include them in the duplicate-match check (`existing.advancedAt === input.advancedAt && existing.dueAt === input.dueAt && existing.invoiceId === input.invoiceId`), and change the tail of the happy path:

```ts
const advance: Advance = {
  advanceId: input.advanceId, saHash: input.saHash, payee: input.payee,
  principal: input.amount, fee: advanceFee(input.amount, this.#config.feeBps),
  status: "PENDING_PAYOUT", verdict,
  ...(input.invoiceId !== undefined ? { invoiceId: input.invoiceId } : {}),
  advancedAt: input.advancedAt, dueAt: input.dueAt,
};
this.#advances.set(advance.advanceId, advance);
this.#liquidity -= advance.principal;
this.#pendingPayout += advance.principal;
this.#ledger.push({ kind: "ADVANCE", advanceId: advance.advanceId, amount: advance.principal });
```

(`#outstanding` no longer moves here.) New methods:

```ts
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
```

`settleRepayment(advanceId, amount, repaidAt)` — add the param, include `repaidAt` in the settled record, and error message for non-OUTSTANDING must name the actual status (test matches `/PENDING_PAYOUT/`). `state()` returns `pendingPayout: this.#pendingPayout`.

- [ ] **Step 4: Update the existing suite for the new flow**

In `pool.test.ts`: every existing `requestAdvance` call gains `advancedAt: T0, dueAt: DUE` (declare the two constants at top); flows that previously assumed money already out add `pool.confirmPayout(id, "0xtx")` before repayment; `settleRepayment` calls gain a third arg. Assertions about `SA_REJECTED`, replay, fee math, exact-amount repayment stay byte-identical in intent.

- [ ] **Step 5: Run all pool tests + typecheck**

Run: `cd packages/pool && pnpm vitest run && cd ../.. && pnpm typecheck`
Expected: PASS (existing 11 updated + 6 new).

- [ ] **Step 6: Commit**

```bash
git add packages/pool
git commit -m "feat(pool): three-state payout (PENDING_PAYOUT/confirm/cancel) + caller-supplied timestamps"
```

---

### Task 2: Escrow bucket + gated escrowed advances

**Files:**
- Modify: `packages/pool/src/types.ts`
- Modify: `packages/pool/src/pool.ts`
- Test: `packages/pool/src/escrow.test.ts`

**Interfaces:**
- Consumes: Task 1 `requestAdvance` input (`invoiceId?`), three-state machine.
- Produces:
  - `interface Escrow { readonly invoiceId: string; readonly importer: string; readonly amount: bigint; readonly status: "FUNDED" | "RELEASED"; readonly txHashes: readonly string[] }`
  - `escrowDeposit(input: { invoiceId: string; importer: string; amount: bigint; txHash?: string }): Escrow` — top-up allowed while FUNDED; throws on RELEASED.
  - Rejections: `{ code: "ESCROW_INSUFFICIENT"; escrowAmount: bigint }`, `{ code: "ESCROW_NOT_FOUND"; invoiceId: string }`, `{ code: "INVOICE_BUSY"; invoiceId: string }` added to `AdvanceRejection`.
  - `PoolState` gains `readonly escrows: ReadonlyMap<string, Escrow>`.
  - Ledger kind: `{ kind: "ESCROW_DEPOSIT"; invoiceId: string; importer: string; amount: bigint; txHash?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/pool/src/escrow.test.ts
import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp", agentId: "854638" });
const T0 = 1_756_700_000_000;
const DUE = T0 + 30 * 86_400_000;

function pool(): Pool {
  const p = new Pool({ feeBps: 2000n, verify: PASS });
  p.deposit("lp-1", 10n);
  return p;
}

const req = (p: Pool, over: Partial<{ advanceId: string; amount: bigint; invoiceId: string }> = {}) =>
  p.requestAdvance({
    advanceId: over.advanceId ?? "a1", saHash: "0xsa", payee: "0xexp",
    amount: over.amount ?? 4n, invoiceId: over.invoiceId ?? "inv-1",
    advancedAt: T0, dueAt: DUE,
  });

describe("escrow bucket (inv 6: isolation)", () => {
  it("escrowDeposit funds and tops up per invoice; escrow is not liquidity", () => {
    const p = pool();
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 4n, txHash: "0xe1" });
    const e = p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 2n });
    expect(e.amount).toBe(6n);
    expect(e.status).toBe("FUNDED");
    expect(e.txHashes).toEqual(["0xe1"]);
    expect(p.state().liquidity).toBe(10n); // escrow never enters liquidity
  });

  it("gates the advance on full coverage: P + fee <= F (inv 1/3)", async () => {
    const p = pool();
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 4n });
    // P=4, fee=ceil(4*20%)=1, due 5 > escrow 4 → rejected
    const r = await req(p);
    expect(!r.ok && r.rejection.code === "ESCROW_INSUFFICIENT").toBe(true);
    expect(p.state().liquidity).toBe(10n);
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 2n }); // F=6
    const ok = await req(p, { advanceId: "a2" });
    expect(ok.ok).toBe(true);
  });

  it("rejects an advance on an unknown invoice", async () => {
    const r = await req(pool(), { invoiceId: "inv-404" });
    expect(!r.ok && r.rejection.code === "ESCROW_NOT_FOUND").toBe(true);
  });

  it("one active advance per invoice; a cancelled one frees the slot (inv_singleActive)", async () => {
    const p = pool();
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n });
    await req(p);
    const busy = await req(p, { advanceId: "a2" });
    expect(!busy.ok && busy.rejection.code === "INVOICE_BUSY").toBe(true);
    p.cancelPayout("a1");
    const retry = await req(p, { advanceId: "a3" });
    expect(retry.ok).toBe(true);
  });

  it("SA rejection still wins over escrow problems (rejection-order contract)", async () => {
    const REJECT: SaVerifier = async () => ({ ok: false, reason: "signature_mismatch" });
    const p = new Pool({ feeBps: 2000n, verify: REJECT });
    p.deposit("lp-1", 10n);
    const r = await req(p, { invoiceId: "inv-404" });
    expect(!r.ok && r.rejection.code === "SA_REJECTED").toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pool && pnpm vitest run src/escrow.test.ts`
Expected: FAIL — `escrowDeposit is not a function`.

- [ ] **Step 3: Implement**

`types.ts`: add the `Escrow` interface, the three rejection variants, the `ESCROW_DEPOSIT` ledger kind, and `escrows` on `PoolState` as declared in **Interfaces** above.

`pool.ts`:

```ts
readonly #escrows = new Map<string, Escrow>();

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
```

In `requestAdvance`, after the SA verdict check and before the liquidity check (order contract: SA → escrow → liquidity):

```ts
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
    a => a.invoiceId === input.invoiceId && a.status !== "CANCELLED",
  );
  if (busy) {
    return { ok: false, rejection: { code: "INVOICE_BUSY", invoiceId: input.invoiceId } };
  }
}
```

`state()` adds `escrows: new Map(this.#escrows)`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/pool && pnpm vitest run && cd ../.. && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pool
git commit -m "feat(pool): per-invoice escrow bucket with coverage gate and one-active-advance rule"
```

---

### Task 3: Release waterfall + residual confirmation

**Files:**
- Modify: `packages/pool/src/types.ts`
- Modify: `packages/pool/src/pool.ts`
- Test: `packages/pool/src/release.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`confirmPayout`, `Escrow`, escrowed advances).
- Produces:
  - `interface ReleaseResult { readonly advance: Advance; readonly principal: bigint; readonly fee: bigint; readonly residual: bigint }`
  - `releaseEscrow(invoiceId: string, at: number): ReleaseResult` — waterfall; idempotent replay returns the original result.
  - `confirmResidual(invoiceId: string, txHash: string): bigint` — returns the confirmed residual amount.
  - `PoolState` gains `readonly pendingResidual: ReadonlyMap<string, bigint>`.
  - Ledger kinds: `{ kind: "RELEASE"; invoiceId: string; advanceId: string; principal: bigint; fee: bigint; residual: bigint }`, `{ kind: "RESIDUAL_CONFIRMED"; invoiceId: string; amount: bigint; txHash: string }`.
  - `settleRepayment` now throws for escrowed advances (credit path only).

- [ ] **Step 1: Write the failing test**

```ts
// packages/pool/src/release.test.ts
import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp", agentId: "854638" });
const T0 = 1_756_700_000_000;
const DUE = T0 + 30 * 86_400_000;

/** Mirrors pool_test.qnt happyEscrowPathTest: F=6, P=4, fee=1, residual=1. */
async function afterAdvance(): Promise<Pool> {
  const p = new Pool({ feeBps: 2000n, verify: PASS });
  p.deposit("lp-1", 10n);
  p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n, txHash: "0xe1" });
  await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
    amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
  p.confirmPayout("a1", "0xtx1");
  return p;
}

describe("release waterfall (mirrors Quint happyEscrowPathTest)", () => {
  it("splits F atomically: P+fee to liquidity, residual queued; advance REPAID", async () => {
    const p = await afterAdvance();
    const r = p.releaseEscrow("inv-1", DUE);
    expect({ principal: r.principal, fee: r.fee, residual: r.residual })
      .toEqual({ principal: 4n, fee: 1n, residual: 1n });
    expect(r.advance.status).toBe("REPAID");
    expect(r.advance.repaidAt).toBe(DUE);
    const s = p.state();
    expect(s.liquidity).toBe(11n);          // 10 - 4 + (4+1)
    expect(s.outstanding).toBe(0n);
    expect(s.feesAccrued).toBe(1n);
    expect(s.escrows.get("inv-1")?.status).toBe("RELEASED");
    expect(s.pendingResidual.get("inv-1")).toBe(1n);
  });

  it("confirmResidual pays the exporter tail exactly once", async () => {
    const p = await afterAdvance();
    p.releaseEscrow("inv-1", DUE);
    expect(p.confirmResidual("inv-1", "0xtx2")).toBe(1n);
    expect(p.state().pendingResidual.get("inv-1")).toBe(0n);
    expect(() => p.confirmResidual("inv-1", "0xtx3")).toThrow(/no pending residual/);
  });

  it("release is idempotent: replay returns the original result, moves nothing", async () => {
    const p = await afterAdvance();
    const first = p.releaseEscrow("inv-1", DUE);
    const replay = p.releaseEscrow("inv-1", DUE + 999);
    expect(replay).toEqual(first);
    expect(p.state().liquidity).toBe(11n);
  });

  it("refuses to release while payout is still PENDING (money not out yet)", async () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n });
    await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
      amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
    expect(() => p.releaseEscrow("inv-1", DUE)).toThrow(/no outstanding advance/);
  });

  it("zero residual (F == P+fee) needs no confirmation", async () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 5n });
    await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
      amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
    p.confirmPayout("a1", "0xtx1");
    const r = p.releaseEscrow("inv-1", DUE);
    expect(r.residual).toBe(0n);
    expect(() => p.confirmResidual("inv-1", "0xtx2")).toThrow(/no pending residual/);
  });

  it("settleRepayment refuses escrowed advances (they settle via release)", async () => {
    const p = await afterAdvance();
    expect(() => p.settleRepayment("a1", 5n, DUE)).toThrow(/escrowed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pool && pnpm vitest run src/release.test.ts`
Expected: FAIL — `releaseEscrow is not a function`.

- [ ] **Step 3: Implement**

`types.ts`: add `ReleaseResult`, the two ledger kinds, `pendingResidual` on `PoolState` (all exactly as in **Interfaces**).

`pool.ts`:

```ts
readonly #pendingResidual = new Map<string, bigint>();
readonly #releases = new Map<string, ReleaseResult>();

releaseEscrow(invoiceId: string, at: number): ReleaseResult {
  const replay = this.#releases.get(invoiceId);
  if (replay) return replay;
  const escrow = this.#escrows.get(invoiceId);
  if (!escrow) throw new Error(`unknown escrow: ${invoiceId}`);
  const advance = [...this.#advances.values()].find(
    a => a.invoiceId === invoiceId && a.status === "OUTSTANDING",
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

confirmResidual(invoiceId: string, txHash: string): bigint {
  const amount = this.#pendingResidual.get(invoiceId) ?? 0n;
  if (amount <= 0n) throw new Error(`no pending residual for ${invoiceId}`);
  this.#pendingResidual.set(invoiceId, 0n);
  this.#ledger.push({ kind: "RESIDUAL_CONFIRMED", invoiceId, amount, txHash });
  return amount;
}
```

In `settleRepayment`, before the status check:

```ts
if (advance.invoiceId !== undefined) {
  throw new Error(`advance ${advanceId} is escrowed; settle it via releaseEscrow`);
}
```

`state()` adds `pendingResidual: new Map(this.#pendingResidual)`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/pool && pnpm vitest run && cd ../.. && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pool
git commit -m "feat(pool): release waterfall with queued residual + retry-only confirmation"
```

---

### Task 4: LP withdraw

**Files:**
- Modify: `packages/pool/src/types.ts` (WITHDRAW ledger kind already exists — no change expected; verify)
- Modify: `packages/pool/src/pool.ts`
- Test: `packages/pool/src/withdraw.test.ts`

**Interfaces:**
- Consumes: Task 1 state buckets.
- Produces: `withdraw(lp: string, amount: bigint): void` — throws unless `0 < amount ≤ lpDeposits[lp]` and `amount ≤ liquidity`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/pool/src/withdraw.test.ts
import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true });

describe("LP withdraw (mirrors Quint withdrawBoundedTest)", () => {
  it("withdraws up to own deposits and pool liquidity", () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    p.withdraw("lp-1", 10n);
    expect(p.state().liquidity).toBe(0n);
    expect(p.state().lpDeposits.get("lp-1")).toBe(0n);
    expect(p.ledger().some(e => e.kind === "WITHDRAW" && e.lp === "lp-1" && e.amount === 10n)).toBe(true);
  });

  it("bounds: own deposits and current liquidity", async () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    expect(() => p.withdraw("lp-1", 11n)).toThrow(/exceeds deposits/);
    expect(() => p.withdraw("lp-2", 1n)).toThrow(/exceeds deposits/);
    expect(() => p.withdraw("lp-1", 0n)).toThrow(/> 0/);
    await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
      amount: 8n, advancedAt: 0, dueAt: 1 });
    expect(() => p.withdraw("lp-1", 3n)).toThrow(/exceeds liquidity/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pool && pnpm vitest run src/withdraw.test.ts`
Expected: FAIL — `withdraw is not a function`.

- [ ] **Step 3: Implement**

```ts
withdraw(lp: string, amount: bigint): void {
  if (amount <= 0n) throw new Error("withdraw amount must be > 0");
  const deposited = this.#lpDeposits.get(lp) ?? 0n;
  if (amount > deposited) throw new Error(`withdraw ${amount} exceeds deposits ${deposited} of ${lp}`);
  if (amount > this.#liquidity) throw new Error(`withdraw ${amount} exceeds liquidity ${this.#liquidity}`);
  this.#liquidity -= amount;
  this.#lpDeposits.set(lp, deposited - amount);
  this.#ledger.push({ kind: "WITHDRAW", lp, amount });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/pool && pnpm vitest run && cd ../.. && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pool
git commit -m "feat(pool): minimal LP withdraw bounded by own deposits and liquidity"
```

---

### Task 5: Serialization (toJSON / fromJSON)

**Files:**
- Create: `packages/pool/src/serde.ts`
- Modify: `packages/pool/src/pool.ts` (expose internals to serde via a snapshot method)
- Modify: `packages/pool/src/index.ts`
- Test: `packages/pool/src/serde.test.ts`

**Interfaces:**
- Consumes: full Pool v2 surface (Tasks 1–4).
- Produces:
  - `Pool.prototype.toJSON(): string` — versioned envelope, bigints as strings.
  - `Pool.fromJSON(json: string, verify: SaVerifier): Pool` — static; feeBps restored from the envelope, verifier re-injected (functions don't serialize).
  - `Pool.prototype.snapshot(): PoolSnapshot` and `interface PoolSnapshot { readonly feeBps: bigint; readonly liquidity: bigint; readonly pendingPayout: bigint; readonly outstanding: bigint; readonly feesAccrued: bigint; readonly lpDeposits: ReadonlyMap<string, bigint>; readonly escrows: ReadonlyMap<string, Escrow>; readonly pendingResidual: ReadonlyMap<string, bigint>; readonly advances: ReadonlyMap<string, Advance>; readonly releases: ReadonlyMap<string, ReleaseResult>; readonly ledger: readonly LedgerEntry[] }`
  - `Pool.restore(snapshot: PoolSnapshot, verify: SaVerifier): Pool` (used by fromJSON; also by tests).

- [ ] **Step 1: Write the failing test**

```ts
// packages/pool/src/serde.test.ts
import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { SaVerifier } from "./types.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp" });
const T0 = 1_756_700_000_000;
const DUE = T0 + 30 * 86_400_000;

describe("serialization round-trip", () => {
  it("restores mid-flow state exactly (bigints, maps, pending buckets, replay cache)", async () => {
    const p = new Pool({ feeBps: 2000n, verify: PASS });
    p.deposit("lp-1", 10n);
    p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n, txHash: "0xe1" });
    await p.requestAdvance({ advanceId: "a1", saHash: "0xsa", payee: "0xexp",
      amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
    p.confirmPayout("a1", "0xtx1");
    p.releaseEscrow("inv-1", DUE); // residual 1 still pending

    const restored = Pool.fromJSON(p.toJSON(), PASS);
    expect(restored.state()).toEqual(p.state());
    expect(restored.ledger()).toEqual(p.ledger());
    // replay caches survive: idempotent release replay still works
    expect(restored.releaseEscrow("inv-1", DUE + 5)).toEqual(p.releaseEscrow("inv-1", DUE + 5));
    // and the pool still works after restore
    expect(restored.confirmResidual("inv-1", "0xtx2")).toBe(1n);
  });

  it("rejects an unknown envelope version", () => {
    expect(() => Pool.fromJSON('{"version":99}', PASS)).toThrow(/unsupported pool snapshot version/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pool && pnpm vitest run src/serde.test.ts`
Expected: FAIL — `toJSON/fromJSON is not a function`.

- [ ] **Step 3: Implement**

`pool.ts` — add `snapshot()` returning the readonly views of every private field (same shape as `PoolSnapshot` above), and `static restore(snapshot, verify)` constructing a Pool and assigning fields. `serde.ts` — encode/decode with a bigint marker:

```ts
// packages/pool/src/serde.ts
import type { PoolSnapshot } from "./pool.js";

const VERSION = 1;

export function encodeSnapshot(s: PoolSnapshot): string {
  return JSON.stringify({ version: VERSION, snapshot: s }, (_k, v: unknown) => {
    if (typeof v === "bigint") return { $bigint: v.toString() };
    if (v instanceof Map) return { $map: [...v.entries()] };
    return v;
  });
}

export function decodeSnapshot(json: string): PoolSnapshot {
  const parsed: unknown = JSON.parse(json, (_k, v: unknown) => {
    if (typeof v === "object" && v !== null) {
      if ("$bigint" in v) return BigInt((v as { $bigint: string }).$bigint);
      if ("$map" in v) return new Map((v as { $map: [unknown, unknown][] }).$map);
    }
    return v;
  });
  const env = parsed as { version?: number; snapshot?: PoolSnapshot };
  if (env.version !== VERSION || env.snapshot === undefined) {
    throw new Error(`unsupported pool snapshot version: ${String(env.version)}`);
  }
  return env.snapshot;
}
```

`Pool.toJSON()` = `encodeSnapshot(this.snapshot())`; `Pool.fromJSON(json, verify)` = `Pool.restore(decodeSnapshot(json), verify)`. Export `serde` helpers and `PoolSnapshot` from `index.ts`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/pool && pnpm vitest run && cd ../.. && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pool
git commit -m "feat(pool): versioned snapshot serialization with verifier re-injection"
```

---

### Task 6: Passport package

**Files:**
- Create: `packages/passport/package.json`, `packages/passport/tsconfig.json` (copy `packages/pool` layout; name `@citely-pay/passport`, add `"@citely-pay/pool": "workspace:*"` to devDependencies for types)
- Create: `packages/passport/src/types.ts`, `packages/passport/src/passport.ts`, `packages/passport/src/index.ts`
- Test: `packages/passport/src/passport.test.ts`

**Interfaces:**
- Consumes: `Advance`, `LedgerEntry`, `Escrow` types from `@citely-pay/pool`.
- Produces:

```ts
export interface PassportEntry {
  readonly advanceId: string;
  readonly saHash: string;
  readonly escrowed: boolean;
  readonly invoiceId?: string;
  readonly principal: bigint;
  readonly fee: bigint;
  readonly advancedAt: number;
  readonly dueAt: number;
  readonly closedAt?: number;      // repaidAt when REPAID
  readonly onTime?: boolean;       // closedAt <= dueAt; only when closed
  readonly status: "OPEN" | "COMPLETED" | "CANCELLED";
  readonly txHashes: readonly string[];   // payout + escrow + residual txs, ledger order
}
export interface PassportStats {
  readonly totalFinanced: bigint;         // Σ principal, non-cancelled
  readonly completedCycles: number;       // REPAID count
  readonly onTimeRateBps: number;         // completed on time / completed, in bps; 0 when none
  readonly avgTenorMs: number;            // mean(closedAt - advancedAt) over completed; 0 when none
  readonly currentExposure: bigint;       // Σ principal of OUTSTANDING + PENDING_PAYOUT
}
export interface Passport {
  readonly identity: { readonly agentId: string };
  readonly escrowedEntries: readonly PassportEntry[];  // conduct = cycle completion
  readonly creditEntries: readonly PassportEntry[];    // conduct = repayment behavior
  readonly stats: PassportStats;
}
export function buildPassport(input: {
  agentId: string;
  advances: readonly Advance[];
  ledger: readonly LedgerEntry[];
  escrows: ReadonlyMap<string, Escrow>;
}): Passport;
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/passport/src/passport.test.ts
import { describe, expect, it } from "vitest";
import { Pool } from "@citely-pay/pool";
import type { SaVerifier } from "@citely-pay/pool";
import { buildPassport } from "./passport.js";

const PASS: SaVerifier = async () => ({ ok: true, signer: "0xOp", agentId: "854638" });
const T0 = 1_756_700_000_000;
const DUE = T0 + 30 * 86_400_000;

async function playedPool(): Promise<Pool> {
  const p = new Pool({ feeBps: 2000n, verify: PASS });
  p.deposit("lp-1", 20n);
  // escrowed cycle, completed on time
  p.escrowDeposit({ invoiceId: "inv-1", importer: "0ximp", amount: 6n, txHash: "0xe1" });
  await p.requestAdvance({ advanceId: "a1", saHash: "0xsa1", payee: "0xexp",
    amount: 4n, invoiceId: "inv-1", advancedAt: T0, dueAt: DUE });
  p.confirmPayout("a1", "0xtx1");
  p.releaseEscrow("inv-1", T0 + 86_400_000); // closed after 1 day, before due
  p.confirmResidual("inv-1", "0xtx2");
  // credit cycle, repaid late
  await p.requestAdvance({ advanceId: "a2", saHash: "0xsa2", payee: "0xexp",
    amount: 5n, advancedAt: T0, dueAt: DUE });
  p.confirmPayout("a2", "0xtx3");
  p.settleRepayment("a2", 6n, DUE + 86_400_000); // one day late
  // a cancelled one — must not pollute stats
  await p.requestAdvance({ advanceId: "a3", saHash: "0xsa3", payee: "0xexp",
    amount: 2n, advancedAt: T0, dueAt: DUE });
  p.cancelPayout("a3");
  return p;
}

describe("buildPassport", () => {
  it("separates escrowed and credit entries with per-entry verifiable anchors", async () => {
    const p = await playedPool();
    const s = p.state();
    const pass = buildPassport({ agentId: "854638", advances: [...s.advances.values()],
      ledger: p.ledger(), escrows: s.escrows });

    expect(pass.escrowedEntries).toHaveLength(1);
    const e = pass.escrowedEntries[0]!;
    expect(e).toMatchObject({ advanceId: "a1", saHash: "0xsa1", escrowed: true,
      invoiceId: "inv-1", status: "COMPLETED", onTime: true });
    expect(e.txHashes).toEqual(["0xe1", "0xtx1", "0xtx2"]); // escrow-in, payout, residual

    expect(pass.creditEntries).toHaveLength(2); // a2 repaid-late + a3 cancelled
    const late = pass.creditEntries.find(x => x.advanceId === "a2")!;
    expect(late.onTime).toBe(false);
    const cancelled = pass.creditEntries.find(x => x.advanceId === "a3")!;
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.onTime).toBeUndefined();
  });

  it("computes stats over non-cancelled entries only", async () => {
    const p = await playedPool();
    const s = p.state();
    const { stats } = buildPassport({ agentId: "854638", advances: [...s.advances.values()],
      ledger: p.ledger(), escrows: s.escrows });
    expect(stats.totalFinanced).toBe(9n);        // 4 + 5, cancelled 2 excluded
    expect(stats.completedCycles).toBe(2);
    expect(stats.onTimeRateBps).toBe(5000);      // 1 of 2
    expect(stats.currentExposure).toBe(0n);
    expect(stats.avgTenorMs).toBe((86_400_000 + 31 * 86_400_000) / 2);
  });

  it("is a pure derivation: same inputs, same passport", async () => {
    const p = await playedPool();
    const s = p.state();
    const input = { agentId: "854638", advances: [...s.advances.values()],
      ledger: p.ledger(), escrows: s.escrows };
    expect(buildPassport(input)).toEqual(buildPassport(input));
  });
});
```

- [ ] **Step 2: Scaffold the package, run test to verify it fails**

`packages/passport/package.json`:

```json
{
  "name": "@citely-pay/passport",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@citely-pay/pool": "workspace:*",
    "typescript": "^5.0.0",
    "vitest": "^4.0.0"
  }
}
```

`tsconfig.json`: copy from `packages/pool/tsconfig.json` unchanged. Run `pnpm install` at repo root, then:

Run: `cd packages/passport && pnpm vitest run`
Expected: FAIL — cannot resolve `./passport.js`.

- [ ] **Step 3: Implement**

`src/types.ts`: the `PassportEntry` / `PassportStats` / `Passport` interfaces exactly as in **Interfaces**. `src/passport.ts`:

```ts
import type { Advance, Escrow, LedgerEntry } from "@citely-pay/pool";
import type { Passport, PassportEntry, PassportStats } from "./types.js";

function entryStatus(a: Advance): PassportEntry["status"] {
  if (a.status === "REPAID") return "COMPLETED";
  if (a.status === "CANCELLED") return "CANCELLED";
  return "OPEN";
}

function txHashesFor(a: Advance, ledger: readonly LedgerEntry[]): string[] {
  return ledger.flatMap(e => {
    if (e.kind === "ESCROW_DEPOSIT" && e.invoiceId === a.invoiceId && e.txHash !== undefined) return [e.txHash];
    if (e.kind === "PAYOUT_CONFIRMED" && e.advanceId === a.advanceId) return [e.txHash];
    if (e.kind === "RESIDUAL_CONFIRMED" && e.invoiceId === a.invoiceId) return [e.txHash];
    return [];
  });
}

function toEntry(a: Advance, ledger: readonly LedgerEntry[]): PassportEntry {
  const closed = a.status === "REPAID" && a.repaidAt !== undefined;
  return {
    advanceId: a.advanceId, saHash: a.saHash,
    escrowed: a.invoiceId !== undefined,
    ...(a.invoiceId !== undefined ? { invoiceId: a.invoiceId } : {}),
    principal: a.principal, fee: a.fee,
    advancedAt: a.advancedAt, dueAt: a.dueAt,
    ...(closed ? { closedAt: a.repaidAt, onTime: a.repaidAt <= a.dueAt } : {}),
    status: entryStatus(a),
    txHashes: txHashesFor(a, ledger),
  };
}

function stats(entries: readonly PassportEntry[]): PassportStats {
  const active = entries.filter(e => e.status !== "CANCELLED");
  const completed = active.filter(e => e.status === "COMPLETED");
  const onTime = completed.filter(e => e.onTime === true).length;
  const tenors = completed.map(e => (e.closedAt ?? 0) - e.advancedAt);
  return {
    totalFinanced: active.reduce((acc, e) => acc + e.principal, 0n),
    completedCycles: completed.length,
    onTimeRateBps: completed.length === 0 ? 0 : Math.round((onTime / completed.length) * 10_000),
    avgTenorMs: tenors.length === 0 ? 0 : tenors.reduce((a, b) => a + b, 0) / tenors.length,
    currentExposure: active.filter(e => e.status === "OPEN").reduce((acc, e) => acc + e.principal, 0n),
  };
}

export function buildPassport(input: {
  agentId: string;
  advances: readonly Advance[];
  ledger: readonly LedgerEntry[];
  escrows: ReadonlyMap<string, Escrow>;
}): Passport {
  const entries = input.advances.map(a => toEntry(a, input.ledger));
  return {
    identity: { agentId: input.agentId },
    escrowedEntries: entries.filter(e => e.escrowed),
    creditEntries: entries.filter(e => !e.escrowed),
    stats: stats(entries),
  };
}
```

`src/index.ts`: `export { buildPassport } from "./passport.js"; export type * from "./types.js";`

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/passport && pnpm vitest run && cd ../.. && pnpm typecheck && pnpm test`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add packages/passport pnpm-lock.yaml
git commit -m "feat(passport): pure credit-passport derivation from pool ledger"
```

---

### Task 7: Invariant fuzz harness (implementation ↔ model bridge)

**Files:**
- Test: `packages/pool/src/invariants.fuzz.test.ts`

**Interfaces:**
- Consumes: full Pool v2 surface; ledger kinds from Tasks 1–4.
- Produces: nothing (test-only). This suite is the mechanical counterpart of `specs/pool.qnt` `allInvariants`.

- [ ] **Step 1: Write the fuzz test (it should pass immediately if Tasks 1–6 are correct — its value is regression)**

```ts
// packages/pool/src/invariants.fuzz.test.ts
import { describe, expect, it } from "vitest";
import { Pool } from "./pool.js";
import type { LedgerEntry, SaVerifier } from "./types.js";

/** Deterministic PRNG (mulberry32) — reproducible fuzz. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Conservation, computed from the ledger alone (inv_conservation).
 *  in  = deposits + escrow-in + credit repayments
 *  out = confirmed payouts + confirmed residuals + withdrawals */
function externalDelta(ledger: readonly LedgerEntry[], principalOf: (id: string) => bigint): bigint {
  return ledger.reduce((acc, e) => {
    if (e.kind === "DEPOSIT" || e.kind === "ESCROW_DEPOSIT") return acc + e.amount;
    if (e.kind === "REPAY") return acc + e.principal + e.fee;
    if (e.kind === "PAYOUT_CONFIRMED") return acc - principalOf(e.advanceId);
    if (e.kind === "RESIDUAL_CONFIRMED") return acc - e.amount;
    if (e.kind === "WITHDRAW") return acc - e.amount;
    return acc;
  }, 0n);
}

function assertInvariants(pool: Pool): void {
  const s = pool.state();
  const advances = [...s.advances.values()];
  // inv_nonNegative
  expect(s.liquidity >= 0n).toBe(true);
  expect(s.pendingPayout >= 0n).toBe(true);
  for (const v of s.pendingResidual.values()) expect(v >= 0n).toBe(true);
  for (const v of s.lpDeposits.values()) expect(v >= 0n).toBe(true);
  // inv_pendingBucket
  const pendingSum = advances.filter(a => a.status === "PENDING_PAYOUT")
    .reduce((acc, a) => acc + a.principal, 0n);
  expect(s.pendingPayout).toBe(pendingSum);
  // inv_gate (escrow coverage) + inv_feeNonZero
  for (const a of advances) {
    expect(a.fee >= 1n).toBe(true);
    if (a.invoiceId !== undefined) {
      expect(a.principal + a.fee <= (s.escrows.get(a.invoiceId)?.amount ?? -1n)).toBe(true);
    }
  }
  // inv_singleActive
  const activeByInvoice = new Map<string, number>();
  for (const a of advances) {
    if (a.invoiceId !== undefined && a.status !== "CANCELLED") {
      activeByInvoice.set(a.invoiceId, (activeByInvoice.get(a.invoiceId) ?? 0) + 1);
    }
  }
  for (const n of activeByInvoice.values()) expect(n).toBeLessThanOrEqual(1);
  // inv_escrowLifecycle
  for (const a of advances) {
    if (a.invoiceId !== undefined && a.status === "REPAID") {
      expect(s.escrows.get(a.invoiceId)?.status).toBe("RELEASED");
    }
  }
  // inv_conservation: poolCash == externalIn - externalOut
  const escrowFunded = [...s.escrows.values()]
    .filter(e => e.status === "FUNDED").reduce((acc, e) => acc + e.amount, 0n);
  const residualTotal = [...s.pendingResidual.values()].reduce((acc, v) => acc + v, 0n);
  const poolCash = s.liquidity + s.pendingPayout + escrowFunded + residualTotal;
  const principalOf = (id: string): bigint => s.advances.get(id)?.principal ?? 0n;
  expect(poolCash).toBe(externalDelta(pool.ledger(), principalOf));
}

describe("randomized op sequences preserve all Quint invariants", () => {
  it("2000 ops across 20 seeds, verifier flips nondeterministically", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed);
      const flaky: SaVerifier = async () =>
        rand() < 0.75 ? { ok: true, signer: "0xOp" } : { ok: false, reason: "signature_mismatch" };
      const pool = new Pool({ feeBps: 2000n, verify: flaky });
      const invoices = ["inv-1", "inv-2", "inv-3"];
      let nextId = 0;
      for (let i = 0; i < 100; i++) {
        const t = i * 1000;
        const pick = rand();
        const amt = BigInt(1 + Math.floor(rand() * 9));
        try {
          if (pick < 0.2) pool.deposit("lp-1", amt);
          else if (pick < 0.3) pool.withdraw("lp-1", amt);
          else if (pick < 0.45) {
            pool.escrowDeposit({ invoiceId: invoices[Math.floor(rand() * 3)]!, importer: "0ximp", amount: amt });
          } else if (pick < 0.6) {
            const escrowed = rand() < 0.7;
            await pool.requestAdvance({ advanceId: `a${nextId++}`, saHash: "0xsa", payee: "0xexp",
              amount: amt, advancedAt: t, dueAt: t + 5000,
              ...(escrowed ? { invoiceId: invoices[Math.floor(rand() * 3)]! } : {}) });
          } else {
            const s = pool.state();
            const pending = [...s.advances.values()].filter(a => a.status === "PENDING_PAYOUT");
            const out = [...s.advances.values()].filter(a => a.status === "OUTSTANDING");
            if (pick < 0.7 && pending.length > 0) pool.confirmPayout(pending[0]!.advanceId, `0xtx${i}`);
            else if (pick < 0.78 && pending.length > 0) pool.cancelPayout(pending[0]!.advanceId);
            else if (pick < 0.88 && out.length > 0) {
              const a = out[0]!;
              if (a.invoiceId !== undefined) pool.releaseEscrow(a.invoiceId, t);
              else pool.settleRepayment(a.advanceId, a.principal + a.fee, t);
            } else {
              const owed = [...pool.state().pendingResidual.entries()].find(([, v]) => v > 0n);
              if (owed) pool.confirmResidual(owed[0], `0xtx${i}`);
            }
          }
        } catch {
          // guard-rejected op (insufficient funds, bad state) — a disabled action, fine
        }
        assertInvariants(pool);
      }
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/pool && pnpm vitest run src/invariants.fuzz.test.ts`
Expected: PASS. If it fails, the *implementation* is wrong — fix code, never weaken an assertion (the model is ground truth).

- [ ] **Step 3: Full suite + typecheck + model re-run**

Run: `pnpm test && pnpm typecheck && cd packages/pool/specs && quint test pool_test.qnt --main=pool_test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/pool
git commit -m "test(pool): seeded fuzz harness asserting all Quint invariants after every op"
```
