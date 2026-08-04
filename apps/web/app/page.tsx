"use client";
import { useCallback, useEffect, useState } from "react";

type PoolSummary = {
  chainMode: string;
  liquidity: string; pendingPayout: string; outstanding: string; feesAccrued: string;
  escrows: { invoiceId: string; amount: string; status: string }[];
  pendingResidual: [string, string][];
  advances: { advanceId: string; status: string; invoiceId?: string }[];
  sas: { saHash: string; bad: boolean }[];
  demo: { payee: string; legAmount: string };
};

const usdc = (minor: string): string => `${(Number(minor) / 1e6).toLocaleString()} USDC`;
/** UI takes whole USDC (decimals ok); the money path stays integer minor units. */
const toMinor = (u: string): string => String(Math.round(Number(u) * 1e6));

function Result({ data }: { data: { ok: boolean; body: unknown } | null }) {
  if (!data) return null;
  const txs = (JSON.stringify(data.body) ?? "").match(/0x[0-9a-f]{64}/g) ?? [];
  return (
    <div className={`result${data.ok ? "" : " err"}`}>
      <code>{JSON.stringify(data.body, null, 1)}</code>
      {[...new Set(txs)].map((h) => (
        <div key={h}>
          <a className="mono" href={`https://testnet.arcscan.app/tx/${h}`} target="_blank" rel="noreferrer">
            arcscan ↗ {h.slice(0, 18)}…
          </a>
        </div>
      ))}
    </div>
  );
}

export default function Console() {
  const [state, setState] = useState<PoolSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, { ok: boolean; body: unknown } | null>>({});
  const [invoice, setInvoice] = useState(() => "INV-" + Math.random().toString(36).slice(2, 6).toUpperCase());
  const [escrowAmt, setEscrowAmt] = useState("2");
  const [saHash, setSaHash] = useState("");
  const [advAmt, setAdvAmt] = useState("1.5");
  const [seq, setSeq] = useState(1);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/state");
    const body = (await res.json()) as PoolSummary;
    setState(body);
    if (!saHash && body.sas.length > 0) setSaHash(body.sas[0]!.saHash);
  }, [saHash]);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (key: string, path: string, body: unknown): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST", body: JSON.stringify(body) });
      setResults((r) => ({ ...r, [key]: { ok: res.ok, body: undefined } }));
      const parsed = (await res.json()) as unknown;
      setResults((r) => ({ ...r, [key]: { ok: res.ok, body: parsed } }));
      await refresh();
    } finally { setBusy(false); }
  };

  return (
    <>
      <h1>Financing Console</h1>
      <p className="sub">
        Escrow → SA-gated advance → waterfall release. Every step lands in the{" "}
        <a href="/passport/854638">credit passport</a>.
        {state?.chainMode === "arc"
          ? <> <span className="badge ok">Arc testnet · live USDC</span></>
          : <> <span className="badge sim">simulated chain</span></>}
      </p>
      <div className="grid">
        <div>
          <div className="card">
            <div className="step">Step 1 · Importer</div>
            <h2>Lock escrow for an invoice</h2>
            <label>Invoice</label>
            <input value={invoice} onChange={(e) => setInvoice(e.target.value)} />
            <label>Amount (USDC)</label>
            <input value={escrowAmt} onChange={(e) => setEscrowAmt(e.target.value)} />
            <button disabled={busy} onClick={() => act("escrow", "/api/escrow", { invoiceId: invoice, amount: toMinor(escrowAmt) })}>
              Lock funds
            </button>
            <Result data={results["escrow"] ?? null} />
          </div>

          <div className="card">
            <div className="step">Step 2 · Exporter</div>
            <h2>Request a T+0 advance against a Settlement Authorization</h2>
            <label>Settlement Authorization (the proof — one is rogue-signed on purpose)</label>
            <select value={saHash} onChange={(e) => setSaHash(e.target.value)}>
              {state?.sas.map((s) => (
                <option key={s.saHash} value={s.saHash}>
                  {s.saHash.slice(0, 18)}… {s.bad ? "(BAD SIGNATURE)" : ""}
                </option>
              ))}
            </select>
            <label>Advance amount in USDC (leg authorizes up to {state ? usdc(state.demo.legAmount) : "…"})</label>
            <input value={advAmt} onChange={(e) => setAdvAmt(e.target.value)} />
            <button disabled={busy} onClick={() => {
              void act("advance", "/api/advance", { advanceId: `a-${invoice}-${seq}`, invoiceId: invoice, saHash, amount: toMinor(advAmt) });
              setSeq((n) => n + 1);
            }}>
              Request advance
            </button>
            <Result data={results["advance"] ?? null} />
          </div>

          <div className="card">
            <div className="step">Step 3 · Maturity</div>
            <h2>Confirm delivery / simulate due date — waterfall release</h2>
            <label>Invoice</label>
            <select value={invoice} onChange={(e) => setInvoice(e.target.value)}>
              {[...new Set([invoice, ...(state?.escrows.filter((e) => e.status === "FUNDED").map((e) => e.invoiceId) ?? [])])]
                .map((i) => <option key={i}>{i}</option>)}
            </select>
            <button disabled={busy} onClick={() => act("release", "/api/release", { invoiceId: invoice })}>
              Release escrow
            </button>
            <Result data={results["release"] ?? null} />
          </div>
        </div>

        <aside>
          <div className="card">
            <h2>Pool</h2>
            {state ? (
              <>
                <div className="kv"><span>Liquidity</span><b>{usdc(state.liquidity)}</b></div>
                <div className="kv"><span>Pending payout</span><b>{usdc(state.pendingPayout)}</b></div>
                <div className="kv"><span>Outstanding</span><b>{usdc(state.outstanding)}</b></div>
                <div className="kv"><span>Fees accrued</span><b>{usdc(state.feesAccrued)}</b></div>
              </>
            ) : <p className="sub">loading…</p>}
          </div>
          <div className="card">
            <h2>Escrows</h2>
            {state?.escrows.length ? state.escrows.map((e) => (
              <div className="kv" key={e.invoiceId}>
                <span>{e.invoiceId} <span className={`badge ${e.status === "FUNDED" ? "ok" : "sim"}`}>{e.status}</span></span>
                <b>{usdc(e.amount)}</b>
              </div>
            )) : <p className="sub">none yet</p>}
          </div>
          <div className="card">
            <h2>Advances</h2>
            {state?.advances.length ? state.advances.map((a) => (
              <div className="kv" key={a.advanceId}>
                <span>{a.advanceId}</span>
                <span className={`badge ${a.status === "REPAID" ? "ok" : a.status === "CANCELLED" ? "bad" : "sim"}`}>{a.status}</span>
              </div>
            )) : <p className="sub">none yet</p>}
          </div>
        </aside>
      </div>
    </>
  );
}
