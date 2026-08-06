<div align="center">

# EscrowFi

**SME trade finance on Arc, where the credit gate is a verifiable compliance
proof — not trust.**

[![Arc Testnet](https://img.shields.io/badge/Arc%20Testnet-5042002-1f6feb)](https://testnet.arcscan.app)
[![USDC](https://img.shields.io/badge/USDC-escrow%20·%20advance%20·%20waterfall-2775ca)](https://developers.circle.com)
[![ERC-8004](https://img.shields.io/badge/ERC--8004-trust%20root%20agent%20854638-brightgreen)](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e)
[![Quint](https://img.shields.io/badge/Quint-7%20fund--safety%20invariants-8250df)](packages/pool/specs/README.md)
[![Tests](https://img.shields.io/badge/tests-55%20passing-success)](#run-it)

[**Live demo**](https://escrowfi-web.vercel.app) ·
[Architecture](docs/architecture.md) ·
[Deal Desk — the SA issuer](https://github.com/web3yaso/citely-deal-desk) ·
[Formal model](packages/pool/specs/README.md) ·
[Pitch deck](docs/pitch/deck.md)

*Track 2 — Best SME Trade Finance & Working Capital Workflow
(Ignyte Stablecoins Commerce Stack Challenge)*

</div>

---

An SME exports goods and needs working capital *now*; its buyer pays at
maturity. EscrowFi closes that gap in three moves — **Escrow → SA-gated
advance → Waterfall release** — all live on Arc Testnet with real USDC.

## What we've built

- **A credit gate that is a proof, not a relationship.** The exporter presents
  a Settlement Authorization (SA): a signed, hash-anchored compliance proof
  issued by [Deal Desk](https://github.com/web3yaso/citely-deal-desk). The pool
  re-verifies it **locally** — hash integrity, EIP-712 signature ↔ registered
  signer, expiry, a PASS leg naming *this* payee for *this* amount — and only
  then does money move. The issuer being offline or compromised cannot make the
  pool pay.
- **An on-chain trust root.** The registered-signer set isn't a config
  constant: it's `ownerOf(854638)` on the ERC-8004 Identity Registry
  [`0x8004A818…BD9e`](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e).
  Registry → operator key → SA signature → advance.
- **Escrow that is structurally isolated.** Importer funds are earmarked per
  invoice and can leave only through the release waterfall — principal + fee to
  LPs, residual to the exporter — exactly once. Money leaves accounting only
  against a confirmed tx hash; a failed transfer rolls back in full.
- **A Credit Passport that cannot be forged**, because it is never stored: it's
  derived from the pool ledger on every read, each line carrying its SA hash
  (re-verified live) and its arcscan links.
- **A core that is formally modeled, not just tested.** 7 fund-safety
  invariants in Quint, model-checked and fuzz-asserted in vitest; 55 tests.
  All amounts are bigint USDC minor units — no floats on the money path.

## The gate, concretely

```http
POST /api/advance
{ "advanceId": "adv-7", "saHash": "0xb413937e…", "amount": "1500000", "invoiceId": "inv-7" }
```

```json
{
  "advance": {
    "advanceId": "adv-7", "principal": "1500000", "fee": "300000",
    "status": "OUTSTANDING",
    "verdict": { "ok": true, "signer": "0x45698638CFF60B188E338aa580e11ba9eb560759" },
    "payoutTxHash": "0x…"
  },
  "txHash": "0x…"
}
```

Same request, an SA signed by an unregistered key — `HTTP 422`, no money moves:

```json
{ "rejection": { "code": "SA_REJECTED", "reason": "signer_not_registered" } }
```

## Try it in 60 seconds

On the [live demo](https://escrowfi-web.vercel.app) (Arc Testnet, real USDC,
KV-persisted):

1. **Lock 2 USDC** into escrow for a fresh invoice → arcscan link appears.
2. **Advance 1.5 USDC** against a valid SA → paid on-chain in seconds, fee 0.3
   fixed at advance time.
3. **Retry with the rogue SA** → `422 · SA_REJECTED · signer_not_registered`.
   Same amount, same escrow — only the signature differs.
4. **Release** → the waterfall splits: 1.8 to LPs, 0.2 residual to the exporter.
5. **Open the passport** → one completed cycle, its SA re-verified live, three
   arcscan links.

The demo SAs are minted at boot through Deal Desk's own signing code path
(vendored, real EIP-712 signatures against the real operator key) — including
the deliberately rogue-signed one, so the rejection is a real check failing,
not a mock.

## Run it

```bash
pnpm install
pnpm -r test        # 55 tests: pool (33) · verify-adapter (10) · chain (4) · web (5) · passport (3)
pnpm typecheck
cd apps/web && pnpm dev   # console on http://localhost:3000, simulated chain
```

Defaults are simulated chain + in-memory store — **the full demo runs with zero
configuration**, and the UI says plainly which mode it's in. Real chain:
`CHAIN_MODE=arc` with `ARC_RPC_URL`, `POOL_WALLET_KEY`, `ARC_USDC_ADDRESS`,
`ARC_CHAIN_ID`; persistence with `KV_URL`/`KV_TOKEN`.

Formal model: `cd packages/pool/specs && quint test pool_test.qnt --main=pool_test`.

## More

[`docs/architecture.md`](docs/architecture.md) — the SA's path from issuance to
consumption, the five verification checks and their failure codes, the package
map, the 7 invariants, Circle product usage and feedback, and the honest
limitations (MVP custody, live issuance API not yet wired, no dispute window).

## Circle products

**USDC on Arc** carries every money movement — escrow, advance, waterfall.
Roadmap: **Circle Wallets** (self-custody for non-crypto SMEs), **CCTP + Bridge
Kit** (exporter picks the receiving chain), **Gateway** (treasury routing),
**USYC** (yield on idle liquidity).

## License

Arc Testnet demo only, no real funds. Compliance verdicts originate from Deal
Desk's demo modules built on public legal sources and do not constitute legal
or financial advice.
