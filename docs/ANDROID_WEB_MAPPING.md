# Android 到 Web 映射说明

本文档定义原 Android 项目 (`recoder`) 与当前 React/Web 实现的映射关系。全局字体、间距、颜色、圆角和页面层级遵循 [Android / Web UI 视觉规范](./UI_VISUAL_GUIDELINES.md)；未完成能力和平台边界见 [差异、待办与发布清单](./TODO.md)。

## 数据与核心逻辑

| Android | Web | 说明 |
| :--- | :--- | :--- |
| Room 实体 | Dexie / IndexedDB | 账本、交易、报价和历史日 K 以等价模型保存；账本与平台范围均参与计算。 |
| `PortfolioCalculator`、`PortfolioMappers` | `src/core/portfolio/portfolioCalculator.ts` | 持仓、成本、已实现/未实现盈亏、出入金和手工拆合股计算。 |
| `PortfolioSecurityRules` | `src/core/portfolio/portfolioCalculator.ts` | 美股交易日切分与期权 100 倍乘数规则。 |
| `TradeFeeEstimator` | `src/core/fees/tradeFeeEstimator.ts` | 已有费率与费用计算基础；自动填写交易表单仍是 TODO。 |
| `MarketTradingSessions` | `src/core/market/marketTradingSessions.ts` | A 股、港股、美股的开盘状态判断；精确节假日历仍是 TODO。 |
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
| 平台间资产转仓 | 仅可独立录入转入、转出。 | 对齐成对转仓、平台/余额校验和关联编辑语义。 |
| 自动费用估算 | 保留费率配置和表单入口，不自动回填。 | 基于完整费率规则计算并确认费用。 |
| 自动拆股与过期期权处理 | 仍依赖手工记录。 | 自动同步公司行动并提供批量清理确认。 |
| 精确交易所休市日历 | 仅按周末近似。 | 使用交易所节假日与交易时段数据。 |
