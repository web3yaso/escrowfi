# EscrowFi — Demo Video Script (~2.5 min)

> 录制建议：1080p 录屏 + 人声旁白；正常语速念完约 2 分 20 秒。英文 VO 照读；【】内是画面/操作指令。开录前在 Upstash 清一次 `escrowfi:pool-state`/`pool-version` 键，保证干净开局。

| # | 画面【操作】 | 英文旁白 VO |
|---|---|---|
| 1 | 【README 首屏 / 标题卡 3s】 | "An SME ships goods today — and waits 60 days to get paid. Banks won't finance small trades: checking each one costs more than it earns. EscrowFi fixes that with one idea: make the compliance check itself the collateral." |
| 2 | 【打开 escrowfi-web.vercel.app，指向 "Arc testnet · live USDC" 徽章】 | "This is EscrowFi, running live on Circle's Arc testnet. Everything you'll see moves real USDC." |
| 3 | 【Step 1：默认新发票号，金额 2，点 Lock funds；等 arcscan 链接出现并点开】 | "Step one: the importer locks the invoice amount — two USDC — into escrow for this one trade. There's the transaction, on-chain." |
| 4 | 【Step 2：选第一张正常 SA，金额 1.5，点 Request advance】 | "Step two: the exporter asks for cash today, presenting a Settlement Authorization — a signed compliance proof issued by our Deal Desk engine, an ERC-8004 registered agent. The pool re-verifies it locally: signature against the on-chain registry, expiry, payee and amount. It checks out — one point five USDC, advanced in seconds." |
| 5 | 【Step 2 再来一次：下拉选 BAD SIGNATURE 那张，点 Request advance，停在 422 SA_REJECTED】 | "And if the proof is forged? Watch. Rejected — SA_REJECTED, 422. No valid proof, no money. The gate is on the money path, and nothing in the frontend can bypass it." |
| 6 | 【Step 3：点 Release escrow，指结果里的分账数字】 | "At maturity, the escrow splits atomically: one point five back to liquidity providers, zero point three financing fee — their earnings — and the zero point two remainder to the exporter. To the cent." |
| 7 | 【切到 Credit Passport 页，展开那条记录，点 verify，再点一个 arcscan 链接】 | "Every completed cycle becomes a line in the SME's Credit Passport. It's never stored — it's re-derived from the ledger on every read, so it can't be forged. Each line re-verifies its proof live, and links to the real transactions." |
| 8 | 【回 README 架构图 5s】 | "Under the hood: the fund-safety core is formally modeled in Quint — seven invariants, model-checked. USDC on Arc today; Circle Wallets, CCTP and USYC on the roadmap." |
| 9 | 【标题卡 + URL + repo 3s】 | "EscrowFi. The proof is the credit. Try it live." |

## 备用剪辑点
- 若超时：先砍 Scene 8（架构），再砍 Scene 3 的 arcscan 点开。
- Ignyte 版结尾可加一句："Built on USDC, Arc, and the Circle stack for the Stablecoins Commerce Stack Challenge."
