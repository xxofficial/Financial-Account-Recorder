# 实施状态与发布前清单

## 首发范围（已实现）

- Android 与 Web PWA 共用 React/TypeScript 账本、计算、行情缓存、K 线和 v5 备份逻辑。
- 旧版 v4 仅可导入；新系统只导出 `recoder-backup-v5`。密钥、邮箱密码、PDF 密码、请求日志和行情缓存不进入备份。
- 文本型 PDF 结单支持长桥、汇丰、uSMART 和嘉信。Web 使用 PDF.js，Android 使用 PDFBox；扫描件明确提示不支持。
- Android 支持“分享至 Recoder”、Keystore 密钥、腾讯主源/新浪回退/Yahoo 期权、IMAP 手动与 WorkManager 后台同步，以及 Room 待确认收件箱。
- Web 不提供邮件后台同步；数据管理页会说明平台能力差异。
- Web PWA 已通过 GitHub Pages 发布：<https://xxofficial.github.io/Financial-Account-Recorder/>。部署工作流包含 lint、类型检查、单元测试、端到端测试和生产构建门禁。

## 已完成验证

- `npm run lint`、`npm run typecheck`、`npm run test`（含本地 v4 迁移与四家券商文本夹具）通过。
- `npm run build`、`npm run test:e2e` 通过；Playwright 使用本地嘉信 PDF 验证浏览器提取、行重建与候选交易预览。
- 390px、414px、430px 的持仓首页视觉回归基线已建立，并纳入 Playwright。
- Android `:app:assembleDebug --offline` 通过；离线构建依赖已随工程保留。
- 腾讯使用迁移样本中的真实港股代码验证了实时行情与日 K 返回。

## 发布前仍需人工验收

- 在实际 Android 设备安装 debug APK，验证分享 PDF/文本、PDF 密码输入、邮件配置、手动同步与 WorkManager 唤醒。
- 待网络代理稳定后，用迁移样本中的未到期期权复核 Yahoo Cookie/crumb 取价与历史 K。插件已保留旧版的会话刷新重试逻辑。
- 确定正式签名密钥后，配置 release signing、递增 `versionCode`，并执行签名 AAB/APK 构建。
- 在桌面与手机浏览器继续验证 PWA 安装入口、安装后启动和离线重新打开。

## GitHub 发布待办

- 新发布源已确定为 `xxofficial/Financial-Account-Recorder`；本地应用内更新仅查询该仓库。
- 配置签名 APK 发布工作流：Release APK 必须命名为 `recoder-v<versionName>-<versionCode>.apk`，例如 `recoder-v2.0.1-102.apk`。客户端拒绝无法解析 `versionCode` 的 APK。
- 以真实设备验证：启动时静默检查、设置页手动检查、同一正式签名覆盖升级，以及未知来源安装授权提示。
