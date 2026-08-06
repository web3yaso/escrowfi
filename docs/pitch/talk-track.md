# EscrowFi — Talk Track (8-slide deck + live demo)

对应 deck：`citely-deal-desk/escrowfi-pitch.html`（8 slides）。
英文行照读即可；【】内是中文舞台指令，不要念。

**结构**：Slides 1–5（~2:05）→ 现场 demo（~2:00）→ Slides 6–8（~1:05）。
总时长 ~5:10。Demo 放在 slide 5 之后：观众刚听完「五道检查」，紧接着看假签名被
拒，冲击最大。若主办方只给 3 分钟，见文末「3 分钟压缩版」。

---

## Part 1 — Slides 1–5（2:05）

### Slide 01 · Title —「Working capital, verified.」（0:10）

> "EscrowFi is working capital for small exporters — where the credit decision
> is a proof you can check, not a relationship you have to trust. It runs on
> Arc, it moves real USDC, and I'll show it working in about two minutes."

【不要念副标题上的四个数据块，让它们自己说话。语速放慢，这是唯一一次自我介绍。】

### Slide 02 · The problem（0:25）

> "An exporter ships goods today. The buyer pays in sixty days. That gap is
> where small businesses die — the invoice is an asset, but they can't wait on
> it.
>
> Banks won't close the gap, and it isn't because the trade is risky. It's
> because checking a small trade costs more than the trade earns. Underwriting
> is a document-checking job done by people.
>
> So the requirement is precise: the credit decision has to be real-time, and
> it has to be defensible — every release bound to one trade, one payee, one
> amount."

【最后一句是全场的引子——记得慢下来，因为后面所有内容都是在回答它。】

### Slide 03 · The workflow（0:30）

> "One proof coordinates three money moves.
>
> One — escrow. The importer locks the invoice amount in USDC on Arc,
> earmarked for that single trade.
>
> Two — the SA-gated advance. The exporter presents a Settlement
> Authorization: a signed, hash-anchored compliance proof. EscrowFi re-verifies
> it locally and advances the cash T+0.
>
> Three — the waterfall. At delivery or maturity the escrow splits atomically:
> principal plus fee back to the liquidity providers, the residual to the
> exporter.
>
> No valid proof, no money — and no frontend parameter can change that, because
> the gate sits inside the accounting core, not in the UI."

【三步跟着屏幕上的 01/02/03 走，每步一个手势节拍。最后一句是产品的骨气所在，别赶。】

### Slide 04 · Architecture（0:30）

> "Two systems, and they share no trust — only a proof.
>
> On the left, Deal Desk: our compliance engine, a registered ERC-8004 agent.
> It buys jurisdiction evidence per call and issues the signed Settlement
> Authorization. It's a separate repository, separate deployment, separate
> wallet.
>
> On the right, EscrowFi — this project. It consumes that proof and never asks
> the issuer whether the proof is good. That boundary is deliberate: Deal Desk
> could be offline, or compromised, and the pool still behaves correctly."

【指图从左到右一次就好，别逐个节点念。评委只需要记住「两个系统，只共享一个证明」。】

### Slide 05 · The trust boundary（0:30）

> "Here's what 'verified locally' actually means. Five checks, in this order,
> before a cent leaves the pool.
>
> Hash integrity. Signature — and the signer has to resolve to our on-chain
> trust root, `ownerOf` of agent 854638 on the ERC-8004 registry, not a
> constant in a config file. Expiry. A PASS leg naming *this* payee. And the
> amount within that leg.
>
> Any one of them fails, the money doesn't move. Let me show you that."

【结尾直接切到浏览器，别回头看幻灯片。这句是 demo 的引信。】

---

## Part 2 — Live demo（~2:00）

**页面**：https://escrowfi-web.vercel.app （Arc Testnet · live USDC · KV 持久化）

开口先指徽章：

> "This is live on Arc testnet — every number you're about to see is a real
> USDC transfer."

| # | 【操作】 | 口播 | 兜底 |
|---|---|---|---|
| 1 | 【Step 1：用默认的新发票号，金额 **2**，点 Lock funds；出现 arcscan 链接后点开新标签一眼即关】 | "The importer locks two USDC into escrow for this one invoice. There's the transaction on ArcScan — this is the buyer's money, isolated from the lending pool." | 上链慢就说："While that confirms — note this escrow can only leave through the waterfall. It is not pool liquidity." |
| 2 | 【Step 2：SA 下拉选第一张正常的，金额 **1.5**，点 Request advance】 | "Now the exporter asks for cash today, presenting the Settlement Authorization. The pool runs those five checks locally — signature against the on-chain registry, expiry, payee, amount. It passes: one point five USDC, advanced in seconds. The fee, zero point three, is fixed right here at advance time — it can never be re-priced later." | — |
| 3 | 【Step 2 再来一次：下拉选 **BAD SIGNATURE** 那张，同样金额，点 Request advance，停在 422 画面】 | "Same amount, same escrow, same everything — except this proof was signed by a key that is not the registered agent. Four twenty-two. `SA_REJECTED`, `signer_not_registered`. That's not a mock: the SA is real, EIP-712 signed, it just isn't signed by us." | 若手滑发了正常 SA：直接说 "let me show you the forged one" 再来一次，不要慌。 |
| 4 | 【Step 3：点 Release escrow，手指停在结果的三个数字上】 | "At maturity the escrow splits atomically. One point five principal back to the liquidity providers, zero point three fee — that's their yield — and the remaining zero point two to the exporter. To the cent, in one transaction path." | — |
| 5 | 【切到 Credit Passport 页，展开那条记录，点 verify，再点一个 arcscan 链接】 | "And the by-product. Every completed cycle becomes a line in this SME's Credit Passport. It is never stored — it's re-derived from the ledger on every read, so it can't be edited or forged. Each line re-runs its proof check live, right now, and links to the real transactions." | 若 verify 转圈：说 "it's re-checking the signature against the registry — that's a live call, not a cached badge." |

收口一句，然后切回幻灯片：

> "That's the whole loop: escrow, proof, advance, settle, and a credit history
> that anyone can re-check."

**Demo 前 5 分钟检查清单**
- [ ] Upstash 清 `escrowfi:pool-state` / `escrowfi:pool-version`，保证干净开局
- [ ] Pool wallet 有 Arc testnet USDC 和 gas；先自己跑通一轮完整流程再上台
- [ ] 三个标签页预开：console / passport / ArcScan 首页
- [ ] 备份：本地录屏 `demo.mp4`。网络或 RPC 挂了就直接放，并说明 "same build, recorded ten minutes ago"

---

## Part 3 — Slides 6–8（1:05）

### Slide 06 · Why Arc（0:25）

> "Why Arc, specifically. This workflow isn't merely deployed on Arc — it's
> designed around what Arc gives it.
>
> Fees are denominated in USDC, so the settlement economics stay legible to a
> finance team — there's no volatile gas asset in the middle of a working-
> capital product. Deterministic finality is what makes T+0 credible
> operationally: 'the money arrived' has to be a fact, not a probability. And
> escrow, advance and distribution execute as one programmable flow."

【如果评委里有 Circle 的人，这一页值得多停 3 秒。】

### Slide 07 · The compounding asset（0:25）

> "And here's what compounds. Each completed cycle becomes on-ledger evidence,
> and the passport turns it into something the SME can carry to the next
> lender: total financed, completed cycles, on-time rate, current exposure.
>
> This is what replaces institutional due diligence — registry, signature,
> escrow coverage, advance, settlement. A chain of machine-checkable facts
> instead of a credit committee. Compliance-as-collateral."

【屏幕上的数字是 USDC minor units（4.5M = 4.5 USDC 的 testnet 演示额），有人问就直说，别含糊。】

### Slide 08 · The opportunity（0:15）

> "The goal is simple: make every SME invoice able to prove why it deserves
> capital.
>
> EscrowFi is live on Arc testnet today — open source, fifty-five tests, and
> the fund-safety core is formally modeled in Quint with seven invariants
> model-checked. Working capital that moves at the speed of proof. Thank you."

【停住，别再补充。把 URL 留在屏幕上。】

---

## 3 分钟压缩版

砍到：Slide 01（10s）→ 02 只讲「The gap」一段（15s）→ 03 三步（25s）→ 05 五道检查
（25s）→ **demo 只做第 2、3、5 步**（70s，跳过 lock 和 release，用已有的 funded
escrow）→ 08（15s）。Slides 04、06、07 只在 Q&A 被问到时翻出来。

## Q&A 备答

| 问题 | 答法（先给结论，再给证据） |
|---|---|
| "合规判断是 LLM 做的吗？" | 不是。PASS/HOLD/ESCALATE 由 Deal Desk 的策略引擎从模块返回的检查结果推导，函数签名根本不接受模型输出；那边有一个把模型输出完全污染的回归测试，判定逐字节不变。EscrowFi 这侧更简单——只验签名和绑定，不做任何合规判断。 |
| "Deal Desk 撒谎怎么办？" | 它撒不了对我们有利的谎：它只能签它自己的名。签名解析不到链上 `ownerOf(854638)` 就直接拒；换发行方=改注册表 owner，不用改代码。这正是刚才假签名那一幕。 |
| "钱在谁手里？" | 诚实说：MVP 阶段池子资金在开发者控制的钱包，生产路径是 ERC-4626 金库。托管资金与 LP 流动性在账务上严格隔离，只能走 waterfall 出去，这条有形式化验证。 |
| "违约了呢？" | Escrow-first 把信用风险压成流程风险——只有在托管足额（`P + fee ≤ F`）时才放款，所以放款不依赖对买方的信用判断。无托管的纯信用路径代码里有，但不是这次演示的主张。 |
| "有多少是真的，有多少是 mock？" | 链是真的（Arc testnet 真 USDC，每笔都有 ArcScan）；SA 是真的（用 Deal Desk 真实 operator key 走它自己的 EIP-712 签名路径生成，含那张故意用未注册 key 签的）。还没接的是 Deal Desk 的线上签发 API——消费侧完整，签发侧是下一步。README 里写明了。 |
| "为什么不直接写个智能合约？" | 会做，但顺序不同：先把资金安全的不变量在 Quint 里钉死并跑通业务闭环，合约是这套语义的下一个执行载体。现在核心 7 条不变量已经模型检查 + 模糊测试双覆盖。 |
| "怎么赚钱？" | 放款费在放款时刻固定（演示里 2 USDC 托管、1.5 放款、0.3 费）；LP 拿收益，协议抽成。真正的护城河是通过率——证明可机检，所以单笔尽调成本趋近于零。 |
| "和 Huma / Arf 有什么不同？" | 它们的承销是机构尽调，我们的承销物是每笔交易可机器验证的凭证。而且 TradeLens、we.trade 那批联盟失败在要整条供应链改流程；我们只需要说服一方——出资人，而证明本身就在做这件事。 |
