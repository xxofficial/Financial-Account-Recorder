# Android / Web 差异、待办与发布清单

本文档是 Android 原项目与当前 React/Web 实现之间的能力状态来源。界面视觉规范见 [UI 视觉规范](./UI_VISUAL_GUIDELINES.md)，对应关系见 [Android / Web 映射](./ANDROID_WEB_MAPPING.md)。

## 功能 TODO

| 项目 | 当前行为 | 目标行为 | 平台与依赖 |
| :--- | :--- | :--- | :--- |
| 自动估算费用 | 已覆盖 HSBC、uSMART、致富、嘉信、东方财富、卓锐的公开港/美股规则，以及长桥港股固定公开费率、美股股票和期权。结果经用户确认后回填；不考虑账户阶梯/优惠。 | 补充尚未覆盖的期权、A 股及其他品种规则。 | Android 与 Web；核心框架已完成，持续补充规则。 |
| Yahoo 历史行情 Worker | Web 先使用 stock-sdk；MarketData.app 只能作为浏览器 CORS 允许时的回退，受阻任务会明确标为“暂不支持”。 | 在 Cloudflare Workers 部署受限 Yahoo Chart 只读转发，补齐 `BRKB → BRK-B` 等别名、CORS、限流与输入校验。 | Web；需要用户自己的 Cloudflare 账户与部署授权。 |

## UI / 交互对齐待审查

当前没有待审查的 UI / 交互对齐项。

## 平台差异（非 TODO）

| 能力 | Android APK | Web / PWA | 说明 |
| :--- | :--- | :--- | :--- |
| 邮箱同步 | 支持多个邮箱配置、Keystore 密码保护、手动同步、WorkManager 后台任务和待确认收件箱。 | 不显示邮箱配置、同步入口或原生收件箱。 | IMAP 后台任务和安全凭据存储依赖 Android 原生能力；PWA 不模拟该能力。 |
| 分享到应用 | 接收系统分享的 PDF/文本。 | 使用浏览器文件选择与分享能力。 | 入口不同，均保留导入前确认。 |
| 密钥与后台任务 | 使用 Android Keystore 与 WorkManager。 | 使用浏览器安全存储与页面/PWA 生命周期。 | 不要求两端拥有相同的系统级实现。 |
| 应用更新 | APK 可走 Android 发布与应用内更新策略。 | 由浏览器和 PWA 缓存策略更新。 | 发布流程不同，不视为功能遗漏。 |
| 一级导航 | 固定“持仓 / 分析 / + / 数据 / 流水”。 | 固定“持仓 / 分析 / + / 数据 / 流水”。 | Android 原“操作”能力按此既定结构拆入“+”动作入口和“数据”页。 |

## 已实现范围

- Android 与 Web PWA 共用 React/TypeScript 账本、计算、行情缓存、K 线和 v5 备份逻辑。
- 旧版 v4 仅可导入；新系统只导出 `recoder-backup-v5`。密钥、邮箱密码、PDF 密码、请求日志和行情缓存不进入备份。
- 文本型 PDF 结单支持长桥、汇丰、uSMART 和嘉信。Web 使用 PDF.js，Android 使用 PDFBox；扫描件明确提示不支持。
- Android 支持“分享至 Recoder”、Keystore 密钥、腾讯主源/新浪回退/Yahoo 期权、IMAP 手动与 WorkManager 后台同步，以及 Room 待确认收件箱。
- Web PWA 已通过 GitHub Pages 发布：<https://xxofficial.github.io/Financial-Account-Recorder/>。部署工作流包含 lint、类型检查、单元测试、端到端测试和生产构建门禁。

## 发布前人工验收

- 在实际 Android 设备安装 debug APK，验证分享 PDF/文本、PDF 密码输入、邮件配置、手动同步与 WorkManager 唤醒。
- 待网络代理稳定后，用迁移样本中的未到期期权复核 Yahoo Cookie/crumb 取价与历史 K。
- 确定正式签名密钥后，配置 release signing、递增 `versionCode`，并执行签名 AAB/APK 构建。
- 在桌面与手机浏览器继续验证 PWA 安装入口、安装后启动和离线重新打开。
- 新发布源已确定为 `xxofficial/Financial-Account-Recorder`；正式 APK 须命名为 `recoder-v<versionName>-<versionCode>.apk`，客户端拒绝无法解析 `versionCode` 的 APK。
