"use client";
import { useCallback, useEffect, useState } from "react";

type Entry = {
  advanceId: string; saHash: string; invoiceId?: string;
  principal: string; fee: string; advancedAt: number; dueAt: number;
  closedAt?: number; onTime?: boolean; status: string;
  txHashes: string[]; explorers: string[];
  verifyNow: { ok: boolean; signer?: string; reason?: string };
};
type PassportView = {
  identity: { agentId: string };
  stats: { totalFinanced: string; completedCycles: number; onTimeRateBps: number; avgTenorMs: number; currentExposure: string };
  escrowedEntries: Entry[]; creditEntries: Entry[];
};

const usdc = (m: string): string => `${(Number(m) / 1e6).toLocaleString()} USDC`;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function Rows({ entries }: { entries: Entry[] }) {
  if (entries.length === 0) return <p className="sub">no records yet — run a cycle in the console</p>;
  return (
    <table>
      <thead><tr><th>deal</th><th>principal</th><th>window</th><th>conduct</th><th>proof</th></tr></thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.advanceId}>
            <td>{e.advanceId}{e.invoiceId ? ` · ${e.invoiceId}` : ""}</td>
            <td>{usdc(e.principal)} <span className="sub">+{usdc(e.fee)} fee</span></td>
            <td>{day(e.advancedAt)} → {e.closedAt ? day(e.closedAt) : day(e.dueAt)}</td>
            <td>
              {e.status === "COMPLETED"
                ? <span className={`badge ${e.onTime ? "ok" : "bad"}`}>{e.onTime ? "on time" : "late"}</span>
                : <span className="badge sim">{e.status}</span>}
            </td>
            <td>
              <details>
                <summary>verify</summary>
                <div className="mono">SA {e.saHash.slice(0, 22)}…</div>
                <div>
                  re-verified now:{" "}
                  {e.verifyNow.ok
                    ? <span className="badge ok">valid · signer {e.verifyNow.signer?.slice(0, 10)}…</span>
                    : <span className="badge bad">{e.verifyNow.reason}</span>}
                </div>
                {e.txHashes.map((h, i) => (
                  <div className="mono" key={h}>
                    {h.startsWith("simulated-") ? <>{h} <span className="badge sim">simulated</span></>
                      : <a href={e.explorers[i]} target="_blank" rel="noreferrer">{h.slice(0, 22)}…</a>}
                  </div>
                ))}
              </details>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PassportPage() {
  const [p, setP] = useState<PassportView | null>(null);
  const refresh = useCallback(async () => {
    const res = await fetch("/api/passport");
    setP((await res.json()) as PassportView);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  if (!p) return <p className="sub">loading…</p>;
  return (
    <>
      <h1>Credit Passport</h1>
      <p className="sub">
        ERC-8004 agent <span className="mono">#{p.identity.agentId}</span> — not stored, derived from the
        pool ledger on every read; each line re-verifiable by anyone.{" "}
        <button className="ghost" onClick={() => void refresh()}>re-derive now</button>
      </p>
      <div className="stats">
        <div className="stat"><div className="n">{usdc(p.stats.totalFinanced)}</div><div className="l">total financed</div></div>
        <div className="stat"><div className="n">{p.stats.completedCycles}</div><div className="l">completed cycles</div></div>
        <div className="stat"><div className="n">{(p.stats.onTimeRateBps / 100).toFixed(1)}%</div><div className="l">on-time rate</div></div>
        <div className="stat"><div className="n">{(p.stats.avgTenorMs / 86_400_000).toFixed(1)}d</div><div className="l">avg tenor</div></div>
        <div className="stat"><div className="n">{usdc(p.stats.currentExposure)}</div><div className="l">current exposure</div></div>
      </div>
      <div className="card">
        <h2>Escrow-backed deals <span className="sub">(zero credit exposure — conduct = cycle completion)</span></h2>
        <Rows entries={p.escrowedEntries} />
      </div>
      <div className="card">
        <h2>Credit deals <span className="sub">(repayment behavior)</span></h2>
        <Rows entries={p.creditEntries} />
      </div>
    </>
  );
}
