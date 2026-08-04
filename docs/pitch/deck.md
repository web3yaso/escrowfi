# EscrowFi — Pitch Deck (10 slides)

> 用法：每张 slide 一屏；标题句就是要说出口的话。评审语言英文，括号内中文是讲者备忘。

## 1. Title
**EscrowFi — SME trade finance where the credit gate is a proof, not trust.**
Live on Arc testnet: escrowfi-web.vercel.app · Track 2 (Invoices, Escrow, Settlement)

## 2. The problem
**An SME ships goods today and waits 30–90 days to get paid.**
$2.5T global trade-finance gap; banks reject SMEs because underwriting each small trade costs more than the margin. (痛点一句话：小单撑不起人工尽调)

## 3. The insight
**Underwriting is a document-checking job — so make the documents machine-verifiable.**
Deal Desk turns a trade's compliance check into a signed, hash-anchored proof: the Settlement Authorization (SA). If the proof verifies, the money can move. Compliance-as-collateral. (核心概念：合规即信用)

## 4. How it works — 3 moves
1. **Escrow**: importer locks the invoice amount (USDC on Arc) for that one trade
2. **Advance**: pool re-verifies the SA locally → exporter gets cash T+0
3. **Waterfall**: at maturity the escrow splits atomically — principal + fee to LPs, tail to exporter
Every step leaves a tx hash; the by-product is a **Credit Passport**.

## 5. The trust chain is on-chain, end to end
**ERC-8004 registry (agent #854638) → operator key → SA signature → advance.**
The pool trusts no service — it re-verifies signature, expiry, payee and amount binding on every request. A tampered byte or rogue signer dies at the gate (we demo this live). (现场演示坏 SA 被拒)

## 6. Credit Passport
**Not stored — derived from the ledger on every read, so it cannot be forged.**
Each line: SA hash + live re-verification + on-chain tx links. An SME's verifiable trade history becomes portable credit. (这就是 Track 2 点名的 credit passport)

## 7. Why LPs come
**Escrow-first design collapses credit risk to process risk.**
Funds advance only against a verified proof AND a fully-funded escrow. Fee is fixed at advance time. Fund-safety core is formally modeled in Quint — 7 invariants (conservation, escrow isolation, gate completeness…) model-checked and fuzz-tested. (差异化 vs Huma/Arf：不靠机构尽调)

## 8. Live demo
escrowfi-web.vercel.app — real USDC on Arc testnet, KV-persisted.
Lock 2 → advance 1.5 (fee 0.3, on-chain in seconds) → try the rogue SA → 422 → release → passport line with 3 arcscan links.

## 9. Built on Circle
**USDC on Arc** (every money movement, gas included) · Roadmap: **Circle Wallets** (self-custody for non-crypto SMEs) · **CCTP + Bridge Kit** (exporter picks receiving chain) · **Gateway** (treasury routing) · **USYC** (idle liquidity yield).

## 10. Ask & roadmap
Today: working full-stack on Arc testnet, formally verified core, open source.
Next: live Deal Desk issuance API · Circle Wallets self-custody · dispute window (ESCALATE) · ERC-4626 vault custody.
**EscrowFi: the proof IS the credit.** (收尾金句)
