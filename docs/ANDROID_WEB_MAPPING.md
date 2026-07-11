# Android 到 Web 映射说明 (ANDROID_WEB_MAPPING)

本文档定义了原 Android 项目 (`recoder`) 源码中的类、实体、数据流及 UI 界面到 Web PWA 项目中的映射关系，为后续阶段的迁移提供清晰的代码映射指南。

---

## 一、 数据库与模型映射 (Database & Models)

原 Android 项目使用 Room 作为本地数据库，Web 项目使用 Dexie.js (IndexedDB)。

| Android Room 实体 / 数据结构 | Web IndexedDB 字段 / 映射目标 | 变更说明 |
| :--- | :--- | :--- |
| `LedgerEntity.kt` | `src/db/schema.ts` (ledgers) | 数据结构字段完全保留，第一版只操作默认的单账本，但保留多账本能力。 |
| `TransactionEntity.kt` | `src/db/schema.ts` (transactions) | 对齐所有基础交易与期权扩展字段。**取消邮件导入特有字段**。 |
| `QuoteSnapshotEntity.kt` | `src/db/schema.ts` (quoteSnapshots) | 保存各股票/期权的最新报价缓存。唯一主键逻辑映射为 `symbol + market`。 |
| `HistoricalCloseEntity.kt` | `src/db/schema.ts` (historicalDailyBars) | 缓存股票及期权的历史日K线。主键映射为 `symbol + market + assetType + date`。 |
| (SharedPreferences / SettingsStore) | `src/db/schema.ts` (appSettings) | 包含默认账本、默认平台、上次备份时间及 persistent storage 请求状态等。 |
| `Models.kt` -> `Market` | `src/shared/models/market.ts` -> `Market` | 转换为 TS 枚举，包含属性：`label` (名称), `currencySymbol` (货币符号), `toCnyRate` (兜底汇率)。 |
| `Models.kt` -> `DisplayCurrency` | `src/shared/models/settings.ts` | 转换为 TS 常用货币枚举。 |
| `Models.kt` -> `TradeType` | `src/shared/models/trade.ts` -> `TradeType` | 包含：`BUY`, `SELL`, `DEPOSIT`, `WITHDRAW`, `TRANSFER_IN`, `TRANSFER_OUT` 等所有记账类型。 |
| `Models.kt` -> `BrokerPlatform` | `src/shared/models/settings.ts` | 转换为 TS 券商平台枚举。 |

---

## 二、 核心业务逻辑映射 (Core Business Logic)

计算核心和平台辅助规则完全脱离 React 与 IndexedDB 依赖，位于 `src/core/` 中。

| Android 业务类 | Web 对应路径 | 说明 |
| :--- | :--- | :--- |
| `PortfolioCalculator.kt` | `src/core/portfolio/portfolioCalculator.ts` | 迁移资产持有量、平均成本、已实现盈亏、未实现盈亏、总出入金及拆合股计算。 |
| `PortfolioSecurityRules.kt` | `src/core/portfolio/portfolioCalculator.ts` | 迁移美股夜盘交易日期的转换截止逻辑 (US_TIMEZONE_CUTOFF: 06:00)，以及期权 100 倍乘数逻辑。 |
| `PortfolioMappers.kt` | `src/core/portfolio/portfolioCalculator.ts` | 迁移 DB 实体到 Portfolio 内部计算模型的转换函数。 |
| `TradeFeeEstimator.kt` | `src/core/fees/tradeFeeEstimator.ts` | 迁移各券商（长桥、卓锐、汇丰等）港美股交易税费与佣金自动计算逻辑。 |
| `MarketTradingSessions.kt` | `src/core/market/marketTradingSessions.ts` | 迁移交易市场开盘状态判定逻辑，支持 A股/港股/美股。 |

---

## 三、 UI 界面映射 (UI Screen Mapping)

原 Android 使用 Jetpack Compose 开发，针对手机端优化；Web 版使用 React 编写，维持手机优先（Mobile First）的适配策略。

| Android Compose 页面 | Web React Page / Component | 映射说明 |
| :--- | :--- | :--- |
| `StockLedgerApp.kt` | `src/app/AppShell.tsx` | App 壳结构，包含移动端专用的底部导航栏（Tab Bar）。 |
| `Screens.kt` (总持仓大底) | `src/pages/PortfolioPage.tsx` | 首页持仓，显示总资产、日盈亏、持仓列表、刷新报价按钮。 |
| `Screens.kt` (交易列表) | `src/pages/TransactionsPage.tsx` | 按日期分组展示交易明细，包含搜索框与类型/市场筛选。 |
| `Screens.kt` (记账表单) | `src/pages/TransactionFormPage.tsx` | 新增和编辑交易的表单，根据交易类型动态隐藏/显示期权或外汇兑换字段。 |
| `ProfitAnalysisScreen.kt` | `src/pages/AnalysisPage.tsx` | 资产分析页，第一版主要提供累计资产曲线、累计盈亏曲线及资产分布饼图。 |
| `SettingsScreen.kt` (备份段) | `src/pages/ImportExportPage.tsx` | 备份导入导出专页，包含 JSON 备份的 preview 预览、追加或清空覆盖执行。 |
| `SettingsScreen.kt` (其他) | `src/pages/SettingsPage.tsx` | 行情源 API Key 管理（iTick、TwelveData、MarketData.app），及存储持久化状态。 |

---

## 四、 备份兼容性映射 (Backup Mapping)

Android 原版备份使用 JSON 格式。Web PWA 保证可以兼容导入该 JSON，并且导出的格式也可以反向导入到 Android 客户端。

| Android 备份字段 | Web 备份映射 | 兼容与过滤说明 |
| :--- | :--- | :--- |
| `version` | `version` | Android 最新版本为 `4`，Web 将支持版本 `4` 的解析。 |
| `displayCurrency` | `displayCurrency` | 主币种，如 "CNY", "USD", "HKD"。 |
| `enabledPlatforms` | `enabledPlatforms` | 启用的平台列表。 |
| `ledgers` | `ledgers` | 账本列表。 |
| `transactions` | `transactions` | 交易明细列表，字段一一对应。 |

> **注意：** 默认导出不导出 `marketProviderConfigs`（API Key），防止用户配置的秘钥意外泄漏。

---

## 五、 明确被移除的模块 (Removed Components)

第一版 Web 纯前端应用**完全移除**以下与邮件同步及云端相关的模块，不安装任何相关依赖：

1. **邮件同步与解析**：
   - `ZhuoruiEmailSyncWorker.kt` (卓锐邮件同步任务)
   - `SchwabEmailSyncWorker.kt` (嘉信邮件同步任务)
   - `HsbcNotificationParser.kt` (汇丰邮件解析器)
   - `MailBodyTextExtractor.kt` (邮件正文提取)
   - 不引入 `jakarta.mail`、`IMAP` 或其他任何 Node.js 邮件解析库。
2. **本地 OCR 引擎**：
   - `AndroidOcrEngine.kt` (OCR 解析结单)
3. **App 自动更新**：
   - `AppUpdateRepository.kt` (App 内部更新，Web 部署由浏览器 PWA 控制更新)
