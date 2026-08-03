/**
 * Route logic, framework-free (plain Request→Response) so vitest drives it
 * without a Next server. The files under app/api re-export these.
 * Rejections from the pool pass through verbatim (422) — the gate's word is
 * the product, not something the web layer edits.
 */
import { buildPassport } from "@citely-pay/passport";
import { getAppContext, DEMO } from "./context";
import { asBigint, asStr, handling, jsonBig, readBody } from "./api";

export async function postEscrow(req: Request): Promise<Response> {
  return handling(async () => {
    const body = await readBody(req);
    const invoiceId = asStr(body["invoiceId"], "invoiceId");
    const amount = asBigint(body["amount"], "amount");
    const { store, chain } = await getAppContext();
    const { txHash } = await chain.transferUsdc({ to: DEMO.poolAddress, amount, memo: `escrow-${invoiceId}` });
    const escrow = await store.withPool((pool) =>
      pool.escrowDeposit({ invoiceId, importer: DEMO.importerAddress, amount, txHash }));
    return jsonBig({ escrow, txHash, explorer: chain.explorerUrl(txHash) });
  });
}

export async function postAdvance(req: Request): Promise<Response> {
  return handling(async () => {
    const body = await readBody(req);
    const advanceId = asStr(body["advanceId"], "advanceId");
    const saHash = asStr(body["saHash"], "saHash");
    const amount = asBigint(body["amount"], "amount");
    const dueAt = Number(body["dueAt"] ?? Date.now() + 30 * 86_400_000);
    const invoiceId = typeof body["invoiceId"] === "string" ? body["invoiceId"] : undefined;
    const { store, chain, fixtures } = await getAppContext();
    const result = await store.withPool(async (pool) => {
      const r = await pool.requestAdvance({
        advanceId, saHash, payee: fixtures.payee, amount,
        ...(invoiceId !== undefined ? { invoiceId } : {}),
        advancedAt: Date.now(), dueAt,
      });
      if (!r.ok) return { rejected: r.rejection };
      if (r.replay) return { advance: r.advance, replay: true };
      try {
        const { txHash } = await chain.transferUsdc({ to: fixtures.payee, amount, memo: `payout-${advanceId}` });
        return { advance: pool.confirmPayout(advanceId, txHash), txHash };
      } catch (error) {
        pool.cancelPayout(advanceId);
        return { chainFailed: error instanceof Error ? error.message : String(error) };
      }
    });
    if ("rejected" in result) return jsonBig({ rejection: result.rejected }, 422);
    if ("chainFailed" in result) return jsonBig({ error: "CHAIN_FAILED", detail: result.chainFailed }, 502);
    return jsonBig(result);
  });
}

export async function postRelease(req: Request): Promise<Response> {
  return handling(async () => {
    const body = await readBody(req);
    const invoiceId = asStr(body["invoiceId"], "invoiceId");
    const { store, chain, fixtures } = await getAppContext();
    const result = await store.withPool(async (pool) => {
      const release = pool.releaseEscrow(invoiceId, Date.now());
      const owed = pool.state().pendingResidual.get(invoiceId) ?? 0n;
      if (owed > 0n) {
        try {
          const { txHash } = await chain.transferUsdc({ to: fixtures.payee, amount: owed, memo: `residual-${invoiceId}` });
          pool.confirmResidual(invoiceId, txHash);
          return { release, residualTxHash: txHash };
        } catch {
          return { release, residualPending: true };
        }
      }
      return { release };
    });
    return jsonBig(result);
  });
}

export async function postRepay(req: Request): Promise<Response> {
  return handling(async () => {
    const body = await readBody(req);
    const advanceId = asStr(body["advanceId"], "advanceId");
    const { store, chain } = await getAppContext();
    const result = await store.withPool(async (pool) => {
      const advance = pool.state().advances.get(advanceId);
      if (!advance) throw new Error(`unknown advance: ${advanceId}`);
      const due = advance.principal + advance.fee;
      const { txHash } = await chain.transferUsdc({ to: DEMO.poolAddress, amount: due, memo: `repay-${advanceId}` });
      return { advance: pool.settleRepayment(advanceId, due, Date.now()), txHash };
    });
    return jsonBig(result);
  });
}

export async function getState(): Promise<Response> {
  return handling(async () => {
    const { store, chain, fixtures } = await getAppContext();
    const state = await store.withPool((pool) => pool.state());
    return jsonBig({
      chainMode: chain.mode,
      liquidity: state.liquidity,
      pendingPayout: state.pendingPayout,
      outstanding: state.outstanding,
      feesAccrued: state.feesAccrued,
      escrows: [...state.escrows.values()],
      pendingResidual: [...state.pendingResidual.entries()],
      advances: [...state.advances.values()],
      sas: [...fixtures.sas.keys()].map((saHash) => ({ saHash, bad: saHash === fixtures.badSaHash })),
      demo: { payee: fixtures.payee, legAmount: fixtures.legAmount },
    });
  });
}

export async function getPassport(): Promise<Response> {
  return handling(async () => {
    const { store, chain, verify, fixtures } = await getAppContext();
    const { passport, ledger } = await store.withPool((pool) => ({
      passport: buildPassport({
        agentId: DEMO.agentId,
        advances: [...pool.state().advances.values()],
        ledger: pool.ledger(),
        escrows: pool.state().escrows,
      }),
      ledger: pool.ledger(),
    }));
    void ledger;
    const verifyNow = async (saHash: string, amount: bigint): Promise<unknown> =>
      verify({ saHash, payee: fixtures.payee, amount });
    const enrich = async (entries: typeof passport.escrowedEntries) =>
      Promise.all(entries.map(async (e) => ({
        ...e,
        verifyNow: await verifyNow(e.saHash, e.principal),
        explorers: e.txHashes.map((h) => chain.explorerUrl(h)),
      })));
    return jsonBig({
      identity: passport.identity,
      stats: passport.stats,
      escrowedEntries: await enrich(passport.escrowedEntries),
      creditEntries: await enrich(passport.creditEntries),
    });
  });
}
