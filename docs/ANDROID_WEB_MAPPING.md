# Android 到 Web 映射说明

本文档定义原 Android 项目 (`recoder`) 与当前 React/Web 实现的映射关系。全局字体、间距、颜色、圆角和页面层级遵循 [Android / Web UI 视觉规范](./UI_VISUAL_GUIDELINES.md)；未完成能力和平台边界见 [差异、待办与发布清单](./TODO.md)。

## 数据与核心逻辑

| Android | Web | 说明 |
| :--- | :--- | :--- |
| Room 实体 | Dexie / IndexedDB | 账本、交易、报价和历史日 K 以等价模型保存；账本与平台范围均参与计算。 |
| `PortfolioCalculator`、`PortfolioMappers` | `src/core/portfolio/portfolioCalculator.ts` | 持仓、成本、已实现/未实现盈亏、出入金和手工拆合股计算。 |
| `PortfolioSecurityRules` | `src/core/portfolio/portfolioCalculator.ts` | 美股交易日切分与期权 100 倍乘数规则。 |
| 自动费用估算 | `src/core/fees/tradeFeeEstimator.ts` + 平台费率方案 | 已覆盖 HSBC、uSMART、致富、嘉信、东方财富、卓锐的公开港/美股规则，以及长桥港股固定公开费率、美股股票和期权；展示明细并经用户确认后回填；其余平台/品种提示手工录入。 |
| 公司行动同步 | `src/core/corporateActions/*` | A 股通过 stock-sdk/东方财富、港股/美股通过 Yahoo Chart 生成拆并股候选；期权到期按本地持仓扫描。仅在用户确认后写入账本，可在设置开启启动时的每日收市窗口检查。 |
| `MarketTradingSessions` | `src/core/market/marketTradingSessions.ts` + `src/core/market/itickCalendarProvider.ts` | A 股使用 stock-sdk，港股/美股通过 iTick 自动同步交易日历并本地缓存；无缓存时保留工作日降级。 |
| 备份模型 | `recoder-backup-v5` | Web 可导入旧 v4；敏感凭据、缓存和请求日志不导出。 |

## 页面与导航

| Android 页面 / 能力 | Web 页面 / 入口 | 映射说明 |
| :--- | :--- | :--- |
| 应用壳、顶栏、底栏 | `src/app/AppShell.tsx` | 两端一级导航固定为“持仓 / 分析 / + / 数据 / 流水”。 |
| 持仓 | `src/pages/PortfolioPage.tsx` | 持仓摘要、报价刷新与列表。 |
| 分析、完整排行、收益日历、个股详情 | `AnalysisPage` 及相关详情页 | 复用平台范围与展示币种，保留 K 线和补齐入口。 |
| 流水、筛选、批量管理 | `TransactionsPage.tsx` | 按日期分组的流水与筛选、长按批量操作。 |
| 交易录入 | `TransactionFormPage.tsx` | “+”入口进入新增交易；交易表单支持基础交易、资金操作、公司行动和期权字段。 |
| Android“操作”页 | “+”动作入口 + `DataPage.tsx` | 这是既定导航拆分，不是缺失页面。数据备份、行情缓存、结单导入等功能归入“数据”。 |
| 设置 | `SettingsPage.tsx` | 通用偏好、平台配置、数据与 Android 专属邮箱设置。 |

## 平台专属能力

| 能力 | Android APK | Web / PWA |
| :--- | :--- | :--- |
| 邮箱同步 | 多邮箱配置、Keystore 密码隔离、手动同步、WorkManager 自动同步、待确认收件箱。 | 不提供 IMAP 配置、后台同步或原生收件箱。 |
| PDF / 文本导入 | 支持系统分享及 PDFBox 解析。 | 支持文件选择及 PDF.js 解析。 |
| 系统服务 | Keystore、WorkManager、原生分享和 APK 更新策略。 | 浏览器安全存储、PWA 生命周期和浏览器更新策略。 |

上述差异是平台能力边界，不应作为 Web 未完成项追踪。

## 未映射能力（TODO）

| Android 能力 | Web 当前状态 | 后续目标 |
| :--- | :--- | :--- |
| 自动费用估算 | 已覆盖 HSBC、uSMART、致富、嘉信、东方财富、卓锐的公开港/美股规则，以及长桥港股固定公开费率、美股股票和期权，并在用户确认后回填。 | 补充尚未覆盖的期权、A 股和其他品种。 |
