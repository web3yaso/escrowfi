import type { Advance, Escrow, LedgerEntry } from "@citely-pay/pool";
import type { Passport, PassportEntry, PassportStats } from "./types.js";

function entryStatus(a: Advance): PassportEntry["status"] {
  if (a.status === "REPAID") return "COMPLETED";
  if (a.status === "CANCELLED") return "CANCELLED";
  return "OPEN";
}

function txHashesFor(a: Advance, ledger: readonly LedgerEntry[]): string[] {
  return ledger.flatMap((e) => {
    if (e.kind === "ESCROW_DEPOSIT" && e.invoiceId === a.invoiceId && e.txHash !== undefined) return [e.txHash];
    if (e.kind === "PAYOUT_CONFIRMED" && e.advanceId === a.advanceId) return [e.txHash];
    if (e.kind === "RESIDUAL_CONFIRMED" && e.invoiceId === a.invoiceId) return [e.txHash];
    return [];
  });
}

function toEntry(a: Advance, ledger: readonly LedgerEntry[]): PassportEntry {
  const closed = a.status === "REPAID" && a.repaidAt !== undefined;
  return {
    advanceId: a.advanceId,
    saHash: a.saHash,
    escrowed: a.invoiceId !== undefined,
    ...(a.invoiceId !== undefined ? { invoiceId: a.invoiceId } : {}),
    principal: a.principal,
    fee: a.fee,
    advancedAt: a.advancedAt,
    dueAt: a.dueAt,
    ...(closed ? { closedAt: a.repaidAt, onTime: a.repaidAt <= a.dueAt } : {}),
    status: entryStatus(a),
    txHashes: txHashesFor(a, ledger),
  };
}

function stats(entries: readonly PassportEntry[]): PassportStats {
  const active = entries.filter((e) => e.status !== "CANCELLED");
  const completed = active.filter((e) => e.status === "COMPLETED");
  const onTime = completed.filter((e) => e.onTime === true).length;
  const tenors = completed.map((e) => (e.closedAt ?? 0) - e.advancedAt);
  return {
    totalFinanced: active.reduce((acc, e) => acc + e.principal, 0n),
    completedCycles: completed.length,
    onTimeRateBps: completed.length === 0 ? 0 : Math.round((onTime / completed.length) * 10_000),
    avgTenorMs: tenors.length === 0 ? 0 : tenors.reduce((a, b) => a + b, 0) / tenors.length,
    currentExposure: active.filter((e) => e.status === "OPEN").reduce((acc, e) => acc + e.principal, 0n),
  };
}

/** Pure derivation: the passport is computed from the records, never stored. */
export function buildPassport(input: {
  agentId: string;
  advances: readonly Advance[];
  ledger: readonly LedgerEntry[];
  escrows: ReadonlyMap<string, Escrow>;
}): Passport {
  const entries = input.advances.map((a) => toEntry(a, input.ledger));
  return {
    identity: { agentId: input.agentId },
    escrowedEntries: entries.filter((e) => e.escrowed),
    creditEntries: entries.filter((e) => !e.escrowed),
    stats: stats(entries),
  };
}
