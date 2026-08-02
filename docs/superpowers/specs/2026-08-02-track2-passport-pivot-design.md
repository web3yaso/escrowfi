# Track 2 转向设计：SME Credit Passport + 按单托管垫资池

日期：2026-08-02　状态：设计定稿待实施
赛道：Ignyte Stablecoins Commerce Stack Challenge, **Track 2 — Best SME Trade Finance & Working Capital Workflow (Invoices, Escrow, Settlement)**，截止 2026-08-09 AoE
前置文档：`doc/IgnytePayFi扩展设计20260729.md`（Track 1 时期方案，架构分层仍有效，赛道定位以本文为准）

## 一、产品定位

**一句话**：进口商按单锁款（escrow）→ Deal Desk SA 验证贸易合规 → 流动性池对出口商 T+0 垫资 → 到期瀑布分账 → 每一步的可验证记录累积成 SME 的 **Credit Passport**（信用护照）。

**主线是 Credit Passport**：护照不是存储的档案，而是从池子账本 + SA 历史**现算推导**的结构化视图——每一行挂 SA 哈希与链上 txHash，任何人可逐条重验。资金流（托管/垫资/回款）是护照的数据引擎；SA 背后就是现金流的历史记录，前后端俱全。

命中 Track 2 官方示例三项：stablecoin escrow（按单托管）、invoice factoring with automated repayment waterfalls（垫资 + 释放瀑布）、SME credit passport（主线）。

**差异化**（对 Huma/Arf 等 PayFi 先例）：垫资准入不靠对机构的信用评估，靠**机器可验证的合规证明**（Compliance as Collateral）；托管先行使 LP 敞口从信用风险收缩为流程风险。落地叙事：SA 不是法律意见，是**流动性池的风控准入工件 + 审计痕迹**——只需说服资金方，不需要产业链配合（吸取 TradeLens/we.trade/Marco Polo 冷启动失败教训）。可引用 Circle Verite（可验证凭证框架）作为同思路先例；UAE 2026 年 7 月起分阶段强制 B2B 电子发票是场景时机锚点。

## 二、已确认决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | Demo 主线 | Credit Passport 为主，资金流为数据引擎 |
| 2 | 护照形态 | 链下聚合 + 逐条可重验证（零新合约） |
| 3 | Circle 深度 | USDC 测试网真实转账；Wallets/CCTP/Gateway 架构级（图 + README 诚实标注）；USYC 写入路线图 |
| 4 | 前端 | 两视图：融资操作台（LP 水位为侧栏）+ 护照页 |
| 5 | 实现路径 | 方案 A 纯衍生层：pool 最小改动，新增 passport 纯函数包 + chain 薄适配器 |
| 6 | 进口商角色 | **按单托管**：针对具体发票锁款，作为还款来源（对外界依赖最小） |
| 7 | 到期触发 | 操作台按钮（确认收货 / 模拟到期），不做 cron |
| 8 | Verifier 接入 | **库依赖**：直接引入 deal-desk 的 `@citely/verifier` 包本地重验，不依赖远端服务部署 |
| 9 | SA 来源 | deal-desk 预生成的真 SA（真签名、真 ERC-8004 身份）作 fixture；实时签发为 stretch |
| 10 | 持久化 | 池子状态序列化为单 JSON blob 存 KV（Upstash），版本号乐观锁 |
| 11 | 资金安全 | pool 核心用 **Quint 形式化建模**验证资金安全性质（见第八节） |

## 三、架构与组件

```
apps/web (新, Next.js App Router, Vercel)
 ├─ 视图① 融资操作台：锁款 → 申请垫资 → 确认收货/到期（LP 池子水位侧栏）
 └─ 视图② /passport/[agentId]：身份 + 统计 + 历史表，逐条钻取重验证
        │ API routes（组装层：注入 verifier、chain、KV）
        │
packages/passport (新)              packages/chain (新)
 纯函数：buildPassport(identity,     Arc 测试网 USDC 转账 (viem)
 advances, ledger, escrows)          返回 txHash；可切换模拟模式
        │                                │
packages/pool (改动收敛)  ←─ SaVerifier 注入（@citely/verifier 本地适配器）
```

- **packages/pool**：资金记账核心，唯一职责"钱从哪来、凭什么出去、怎么回来"。不做信用判断、不读时钟、不碰网络。
- **packages/passport**：零状态纯函数。护照永远从账本现算——"护照无法伪造，因为它不是存储的，是从可验证记录推导的"。
- **packages/chain**：薄适配器，执行 USDC 转账、返回 txHash。接口化，测试网不可用时切模拟模式（txHash 明示 `simulated`）。
- **verifier 适配器**：几十行，将 `@citely/verifier`（EIP-712 签名恢复 + ERC-8004 注册对照 + 绑定/过期/腿状态检查）的输出映射为 pool 的 `SaVerdict`。跨仓库引用用 git dependency 或本地 workspace 链接。

## 四、Pool 设计 v2

### 状态

```
liquidity      可垫资流动性（LP 资金）
outstanding    垫出未回本金
feesAccrued    LP 累计费用收益
lpDeposits     Map<lp, bigint>
escrows        Map<invoiceId, {from, amount, status: FUNDED|RELEASED}>   ← 新增
advances       Map<advanceId, Advance>
ledger         全量账目（含 txHash）
```

### Advance 状态机

```
requestAdvance ─→ PENDING_PAYOUT ─ confirmPayout(txHash) ─→ OUTSTANDING ─ releaseEscrow ─→ REPAID
                       │                                          │
                  cancelPayout（转账失败，额度回滚）          settleRepayment（无托管路径，保留）
```

### 方法与语义

- `deposit(lp, amount)`：LP 存入。不变。
- `escrowDeposit(invoiceId, importer, amount, at)`：进口商按单锁款 F。同一 invoiceId 重复锁款为追加；RELEASED 后拒绝。
- `requestAdvance({advanceId, invoiceId?, saHash, payee, amount: P, advancedAt, dueAt})`：门控**依序**判定——SA 本地重验通过 → 若带 `invoiceId`（托管路径）则托管足额（`P + fee(P) ≤ F`，否则 `ESCROW_INSUFFICIENT`）**且该发票无其他未取消垫资**（一票一垫，Quint 建模时确认为必要守卫，否则瀑布归属歧义）→ 流动性充足。通过后进入 `PENDING_PAYOUT`（额度锁定，钱未出门）。幂等：同 advanceId 同参数返回原 advance；参数不符 `DUPLICATE_MISMATCH` 硬拒。**两类垫资**：带 invoiceId 的托管垫资经 `releaseEscrow` 关闭（零信用敞口）；不带的信用垫资经 `settleRepayment` 关闭（demo 主线用托管路径，信用路径保留现有测试资产并入护照"还款行为"维度）。
- `confirmPayout(advanceId, txHash)` / `cancelPayout(advanceId)`：链上转账成功/失败的收口。cancel 完整回滚额度。
- `releaseEscrow(invoiceId, at)`：**释放瀑布**，一次原子三路分账：本金 P → liquidity；fee → feesAccrued；尾款 F − P − fee → 出口商（链上转出，同走先锁定后确认）。触发方式：进口商提前确认 或 到期按钮。幂等：已 RELEASED 重复调用返回原结果。
- `settleRepayment(advanceId, amount, repaidAt)`：无托管路径，精确金额或报错。保留（已有测试资产；README 标注两类垫资：有托管零信用敞口 / 无托管信用敞口）。
- `withdraw(lp, amount)`：最简版补齐（上限为该 LP 存入余额且不超过当前 liquidity），闭环 LP 侧。
- `toJSON()` / `Pool.fromJSON(json, config)`：状态序列化（bigint 字符串编码；verify 函数恢复时重新注入）。

### 时间与判断的归属

时间（`advancedAt/dueAt/repaidAt/at`）一律调用方传入，pool 不读时钟；真实性锚点是链上 tx 时间戳。`onTime`、逾期、信用统计全部由 passport 层现算，pool 只记事实。

### Invariants（第 1-5 条承自 README，新增第 6-7 条）

1. 无已验证 SA，钱绝不出池（托管路径追加：托管不足额，垫资不放行）。
2. 垫资按 advanceId 幂等；参数篡改重放硬拒。
3. 费用垫资时点固定，非零费率永不归零（ceil）。
4. 回款精确金额或报错，无静默部分结算（瀑布是托管释放的确定性分账，非部分还款）。
5. 资金路径全 bigint USDC 最小单位，无浮点。
6. **托管隔离**：托管桶与流动性严格隔离，托管款永不可垫资，只能沿瀑布释放，每单恰好释放一次。
7. **账实收口**：钱出门 ⇔ confirmPayout 携 txHash；PENDING_PAYOUT 可取消且取消后状态等价于从未申请（除幂等记录外）。

### 刻意不做（YAGNI）

部分还款/还款瀑布按金额分层、`WRITTEN_OFF` 核销流程、争议仲裁（README 路线图：争议窗口 + 复用 deal-desk ESCALATE 语义）、**托管退款**（锁款后垫资未发生即取消交易——Quint 建模时暴露的设计缺口，路线图）、LP 费用按份分配、三按钮间自动编排。

## 五、Passport 设计

`buildPassport({identity, advances, ledger, escrows}) → Passport`

```
identity   ERC-8004 agentId + 链上注册证明链接
history[]  {invoiceId, saHash, principal, fee, advancedAt, dueAt,
            repaidAt/releasedAt, onTime, escrowed: bool, txHashes[], verdict}
stats      总融资额 / 完成周期数 / 准时率 / 平均账期 / 当前敞口
```

有托管单据记录**履约周期 + 进口商锁款及时性**；无托管单据才记录**还款行为**。两类分开呈现。钻取：① 现场重跑本地 verifier 出验证结果 ② txHash 链接 Arc 浏览器。

## 六、数据流与错误处理

三按钮 demo 流（见第三节组件图）：

1. **锁款**：POST /api/escrow → USDC 转入池子钱包 → `escrowDeposit`(+txHash) → 存 KV
2. **垫资**：POST /api/advance → 取 fixture SA → 本地重验 → `requestAdvance` → USDC 转出 → `confirmPayout` → 存 KV
3. **确认收货/到期**：POST /api/release → `releaseEscrow` 瀑布 → 尾款 USDC 转出并确认 → 存 KV

错误三类：

1. **业务拒绝**：typed rejection 原样透传前端，明文展示拒绝码。demo 编排一单被拒案例（SA 验证失败）作为正面剧情。
2. **链上失败**：三状态兜底，操作台提供重试/取消；账实永不脱节。
3. **KV 写冲突**：版本号乐观锁，冲突则重读重放一次。

SA fixture 若 `ae-msb`（UAE 模块）已部署则用 UAE 法源证据（demo 成色最佳）；未部署则用现有辖区模块并在 README 标注（**待确认**：用户提及 msb-agent 已加 UAE 支持，公开仓库与线上服务尚未见到，需确认状态）。

## 七、持久化与部署

- Vercel serverless 无内存持久 → 池子状态 JSON blob 存 Upstash KV，读时 `fromJSON` 注入 verifier。
- 池子钱包私钥、Circle/RPC key 仅经环境变量；仓库自首个 commit 起无密钥。
- Arc 测试网公共 RPC 有限流坑（msb-agent 仓库已记录），备选端点见其 `docs/`。

## 八、测试与验证策略

**双层验证：vitest 单测覆盖实现，Quint 形式化模型覆盖设计。**

### vitest（实现层）

- pool：现有 11 测保留；新增托管隔离、瀑布分账、三状态收口、幂等重放、序列化往返。
- passport：纯函数统计正确性（onTime 边界、两类单据分离）。
- chain/web：适配器接口测试 + 手工验收；不做前端自动化。

### Quint（设计层，资金安全）—— ✅ 已完成并全部通过（2026-08-02）

模型：`packages/pool/specs/pool.qnt`（+ `pool_test.qnt` 确定性场景、`README.md` 交接记录）。
结果：7 条 invariant 采样检查无违反（300–500 traces × 30 steps）；9 个 witness 全部可达（无死动作）；4 个确定性场景资金对账精确通过。
建模过程中反哺设计两点：① 一票一垫守卫（已并入第四节）；② **托管退款路径**（锁款后交易取消、垫资未发生）尚未设计——列入路线图，模型 scope 注明。

模型检查的资金安全性质（与第四节 invariants 对应）：

- **资金守恒**：任意可达状态，`池内总资产 = liquidity + escrowTotal`，且每步操作前后 `池内总资产变化 = 外部流入 − 外部流出`（无凭空创造/消失）。
- **托管隔离**：任意状态 `liquidity ≥ 0 ∧ 每单 escrow ≥ 0`；垫资操作不减少任何 escrow；释放操作恰好一次且三路分账之和 = F。
- **门控完备**：出现资金外流（payout 确认）的每条路径上，均存在先行的 SA 验证通过与托管足额判定。
- **幂等安全**：同 advanceId 重放任意次，状态不变（除返回值）；篡改参数重放不改变状态。
- **收口一致**：`PENDING_PAYOUT` 的取消/确认互斥且必居其一后终态；cancel 后可观测状态等价于未申请。
- **无死锁**：任何可达状态都存在通往"全部 advance 终态（REPAID）且 escrow 全释放"的路径（活性，`run` 场景覆盖）。

Quint 模型是 spec 的一部分：先模型验证通过，再按模型写实现，实现层单测的断言与模型 invariant 一一对应。

## 九、分期交付与降级预案

| 期 | 内容 | 降级预案 |
|---|---|---|
| D1 | Quint 模型 + pool v2 + passport（零外部依赖，当天测试全绿） | 无需预案 |
| D2 | 前端两视图（先接内存数据） | 无外部依赖 |
| D3 | chain 适配器 + 测试网打通 + verifier 库接入 | 测试网不配合 → 模拟模式（txHash 标注 simulated）；ae-msb 未部署 → 现有辖区 SA |
| D4+ | KV + Vercel 部署、架构图、英文 README（Circle Product Feedback 章节）、视频 | 部署问题缓冲 2 天 |

总量约 3 天出头纯开发，距 8/9 缓冲充裕。唯一外部不确定性：Arc 测试网（有降级预案）。

## 十、对外依赖清单

- **deal-desk**：`@citely/verifier` 库（已存在、测试齐全，库依赖非服务依赖）；预生成 SA fixture 一批（含一单验证失败案例）。
- **msb-agent**：`ae-msb` UAE 模块部署状态待确认（影响 demo 成色，不阻塞开发）。
- **Ignyte 侧行政项**（不占排期，有截止风险）：Sophie 点击 Join（8/9 前）、注册 Circle Developer Account。
