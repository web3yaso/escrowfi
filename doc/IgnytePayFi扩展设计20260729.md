# Ignyte Track 1 参赛方案：DealDesk → 跨境支付 PayFi 应用（设计 v0.2）

日期：2026-07-29　状态：方向已定（Sophie 确认"基于现有 DealDesk 深化，做成 Huma 式的 Arc 跨境汇款 fintech app"）；**规则已读毕（v0.2 更新，见 4.2/4.3）**
关联文档：[[方案评估-vs-Ignyte挑战-2026-07-29]]（挑战要求对照）、[[方案评估-vs-黑客松要求-2026-07-25]]（Encode 侧）

## 一、产品定位

**一句话**：UAE 企业发起跨境付款 → DealDesk 引擎产出可验证合规证明（SA）→ 流动性池对持有有效 SA 的付款腿 T+0 垫资 → 收款方秒级在自选链收 USDC → 发款方资金到位后回款池子，LP 赚垫资费。

**对标与差异**：Huma/Arf 的 PayFi 模型（在途资金期间由流动性池垫付实现即时结算），但 Huma 的垫资风控靠对支付机构的信用评估；本产品的垫资准入是**机器可验证的确定性合规证明**——"Compliance as Collateral / 合规即信用"。这是 DealDesk 引擎独有资产，别队复制不了。

**赛道**：Track 1 Best Cross-Border Payments & Remittances Experience（UAE → Global），对应官方示例 "Marketplace settlement / B2B settlement / global payroll payouts"。奖金 1st 5000 / 2nd 3000 USDC。

**产品名**：待定（候选：Citely Pay、Corridor、SettleDesk…）。要求与 DealDesk 区隔清晰。

## 二、架构分层（复用 vs 新增）

| 层 | 内容 | 来源 |
|---|---|---|
| L1 合规判定 | Module 服务 → Policy Engine → SA（结算授权书） | **复用** DealDesk engine + verifier，以包依赖引入 |
| L2 链上基础 | 钱包、USDC 转账、Gateway、幂等、轮询、诊断 | **复用** chain 包 |
| L3 流动性池 | LP 存入 / 垫资 / 回款 / 费率记账 / 池子水位 | **新增**（产品核心） |
| L4 收款体验 | Circle Wallets 嵌入钱包（非币圈用户）、CCTP+Bridge Kit 自选到账链、回执（含合规证明摘要） | **新增** |
| L5 发款体验 | 发起付款 → 费用透明拆解 → 实时状态；AED 入金为概念 UX（赛道允许 conceptual）；FX 腿画 StableFX（gated，架构级集成不扣分） | **新增** |
| L6 前端 | 三视图：发款流、收款确认、LP 收益仪表盘 | **新增**，与 Encode demo 页完全不同形态 |

## 三、资金流（主线一案走通）

1. 发款方创建付款（金额、收款人、走廊）→ 引擎跑合规 → SA 签发（PASS 腿才可垫资；HOLD/ESCALATE 腿进入等待，前端可见原因）。
2. 池子校验 SA（verifier 独立进程）→ 从池子钱包垫付 USDC → 经 CCTP 送达收款人自选链的 Circle Wallet。
3. 收款人实时确认页 + 可下载回执（金额、费用拆解、SA 哈希、链上 tx 链接）。
4. 发款方资金（demo 中为 Gateway/USDC 延迟到账模拟）到位 → 回款池子本金 + 垫资费。
5. LP 仪表盘：池子水位、利用率、垫资费收益、每笔垫资背后的 SA 可点开验证。

## 四、关键决策

### 4.1 池子托管形态（MVP）——待 Sophie 最终认可
- **MVP 方案**：池子资金放 developer-controlled Circle Wallet，垫资即普通 USDC 转账；链上留 SA 哈希 + 资金足迹；README 明写生产路线图为 ERC-4626 金库。理由：12 天内无时间写+测+审一个金库合约；诚实标注比半成品合约更加分。
- **代价（安全敞口，已向 Sophie 说明）**：LP 资金在热钱包，中心化托管；测试网 demo 可接受，叙事上以"路线图"化解。
- 备选：极简 4626 金库（~150 行）仅在时间富余时上（不建议）。

### 4.2 规则查证结果（2026-07-29，登录后读取 Rules 页全文）
- **既有项目深化：允许**。规则只要求 "submissions are original and do not infringe on any third-party rights"——即自有原创、不侵犯第三方权利，无"须在比赛期间从零开发"条款；DealDesk 是 Sophie 自有项目，扩展合规。挑战窗口 4/13-8/9，7 月的开发也在窗口内。
- **每人限提交 1 个 entry**（"maximum of only One entry"）——**不能 Track 1 / Track 4 双投**，赛道必须二选一。另：一人多账号注册直接取消资格。
- **IP 条款温和**：获奖者向 Ignyte 授予**非独占许可**（Non-exclusive License），非 IP 转让；获奖需交付可用的最终方案与文档、同意名字/形象用于宣传、自负税务。
- 注意条款："No private sharing externally"（禁止对外私下分享代码/数据/策略）系 Kaggle 式模板条款，与提交要求的公开 GitHub repo 并存，公开提交不受影响。
- 文件提交上限 40MB/个。
- 状态：Sophie 账号已登录但**尚未 Join**（Participations=0），Join 需在 8/9 前完成。
- Encode 侧规则仍需同样查证一遍（待办）。

### 4.3 与 Encode 作品的区隔策略
- 新 repo、新产品名；DealDesk 包以依赖引入。
- README 明写 "settlement engine powered by DealDesk (our Encode Arc Hackathon project)"——公开血缘，两个比赛交的是不同层的产品（引擎 vs 引擎之上的 fintech 应用）。
- 规则层面已确认无障碍（见 4.2）。

## 五、技术栈（新增部分）

- 前端：Next.js（App Router）单应用，部署 Vercel（已连 Vercel MCP，可直接部署拿 demo URL——Ignyte 硬性要求 Application URL）。
- Circle 集成：@circle-fin SDK（developer-controlled wallets）+ CCTP Bridge Kit（Arc Testnet → 收款链，demo 选一条如 Base Sepolia 即可）；沿用 viem。
- 池子记账：沿用 engine 的 db 层模式（SQLite/文件存储），不引入新数据库。
- 风险最大的未知数：Circle Wallets 与 CCTP 的测试网配额/开通流程——**第 1 天先打通**，失败预案为"收款钱包用普通 EOA + CCTP 保留、Wallets 降级为架构图集成"。

## 六、12 天排期（与 Encode final 并行，双截止 8/9 AoE）

| 日 | 内容 |
|---|---|
| D1-3（7/30-8/1） | 新 repo 脚手架；Circle Wallets + CCTP 测试网打通（最大不确定性前置）；池子记账模型 |
| D4-7（8/2-8/5） | 全流程串通：发款→SA→垫资→CCTP 到账→回款；前端两页（发款流、LP 仪表盘）；收款确认页 |
| D8-10（8/6-8/8ᵃᵐ） | Vercel 部署；架构图；英文 README（setup + Circle 集成说明）；**Circle Product Feedback 章节**；Circle Developer Account 注册确认 |
| D11-12（8/8-8/9） | 视频（一次录制、Encode/Ignyte 两版剪辑，Ignyte 版强调 Circle 产品词表）；两边提交；缓冲 |

前置行动（不占排期）：**Join Ignyte 挑战（Sophie 本人点击，账号已登录、尚未 Join）**；注册 Circle Developer Account。

## 七、Ignyte 提交清单映射

- Title/描述/赛道：Track 1 ✓（本方案；规则限一人一 entry，赛道单选已定）
- Circle Developer Account 邮箱：待注册（console.circle.com）
- Circle 产品勾选：USDC ✓、Gateway ✓、Wallets ✓（新增）、CCTP/Bridge Kit ✓（新增）、StableFX（概念级）；Nanopayments 不适用本赛道
- Working frontend + backend：L6 前端 + 全栈流程 ✓
- 架构图：D8-10 产出
- 视频 + presentation：D11-12
- GitHub repo + 详细文档：英文 README（含 DealDesk 血缘声明）
- Demo URL：Vercel
- Circle Product Feedback 章节：README 专节（为什么选/什么好用/什么该改进/DX 建议）

## 八、安全清单（commit 前过一遍）

- 新 repo 从第一个 commit 起无密钥（.env.example 模式沿用 DealDesk；git 历史扫描）
- 池子钱包私钥/Circle API key 只经环境变量；redact 模块复用
- 垫资幂等（复用 idempotency-store 模式），防重复垫付
- SA 校验在垫资路径上强制（verifier 独立进程），不可被前端参数绕过
- CCTP 到账确认基于链上事件轮询而非前端回报
