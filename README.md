# Recoder

一个本地优先的跨平台股票投资记账应用，用一套代码同时支持 Android 与 Web PWA。

Recoder 用于记录股票、ETF、期权、现金和外汇相关流水，汇总多个券商与账本的持仓、成本和盈亏，并通过历史行情生成收益分析与个股日 K 线。应用无需账号和后端服务，正式账本保存在用户设备本地。

> Web PWA 已通过 [GitHub Pages](https://xxofficial.github.io/Financial-Account-Recorder/) 发布；Android 仍在真机验收阶段，正式安装包尚未发布。

## 功能特性

- **持仓管理**：按账本或全部账本汇总资产、现金、证券市值、成本与盈亏。
- **完整流水**：支持买入、卖出、出入金、转账、股息、税费、利息、外汇兑换、拆股、期权到期等记录。
- **收益分析**：提供资产曲线、收益日历、盈亏排行，以及汇总视图下的市场和券商分布。
- **股票与期权**：覆盖 A 股、港股、美股股票，以及美股期权代码、行情和相关计算。
- **历史行情与日 K**：本地缓存日线数据，按持仓区间检测缺口，并支持按时间范围补齐个股日 K。
- **多行情源**：Android 默认使用腾讯、新浪和 Yahoo；Web 可选 iTick、Twelve Data 与 MarketData.app。
- **备份迁移**：可导入旧版 v4 备份，新系统统一导出 `recoder-backup-v5`，支持追加、恢复、去重与冲突检查。
- **结单导入**：支持长桥、汇丰、uSMART 和嘉信的文本型 PDF 结单；所有候选交易确认后才会入账。
- **Android 原生能力**：支持分享 PDF/文本、IMAP 邮件同步、Keystore 安全存储和 GitHub Release 应用内更新。
- **离线优先**：账本与缓存均保存在本地；无网络时仍可打开应用、查看数据和手动记账。

## 平台能力

| 能力 | Android | Web PWA |
|---|---:|---:|
| 账本、持仓、流水与分析 | ✓ | ✓ |
| v4 导入 / v5 备份恢复 | ✓ | ✓ |
| 文本型 PDF 结单 | ✓ | ✓ |
| 个股日 K 与行情缓存 | ✓ | ✓ |
| 腾讯 / 新浪 / Yahoo 默认行情 | ✓ | — |
| 可选第三方行情 API | ✓ | ✓ |
| 分享至 Recoder | ✓ | — |
| IMAP 手动与周期同步 | ✓ | — |
| 应用内更新 | ✓ | — |

Web 端受浏览器 CORS 和免费 API 配额约束，默认关闭自动行情补齐；Android 默认开启历史行情补齐，但实时价格始终由用户显式刷新。

## 技术架构

| 层级 | 技术 |
|---|---|
| UI 与 PWA | React、TypeScript、Vite、HashRouter |
| Android 宿主 | Capacitor、Kotlin |
| 正式账本 | Dexie / IndexedDB |
| 数据契约 | Zod、`recoder-backup-v5` |
| Android 原生存储 | Room，仅保存邮件待导入收件箱与运行日志 |
| Android 后台任务 | WorkManager |
| PDF 文本提取 | PDF.js（Web）、PDFBox（Android） |
| 测试 | Vitest、Playwright、Android/JUnit |

仓库采用 npm workspaces：

```text
recoder-platform/
├── apps/web/              # React UI、PWA 与浏览器平台实现
├── packages/contracts/    # 领域类型、Zod 契约与备份格式
├── packages/core/         # 计算、行情调度、解析与导入去重
├── packages/app-data/     # 数据访问接口与业务用例
├── packages/platform/     # Web / Android 平台能力接口
├── android/               # Capacitor Android 工程与 Kotlin 插件
├── tools/market-fetcher/  # 独立行情缓存预取工具
└── docs/                  # 架构、部署、开发与迁移文档
```

## 快速开始

### 环境要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- Android Studio、JDK 17 与 Android SDK（仅构建 Android 时需要）

### Web

```powershell
git clone https://github.com/xxofficial/Financial-Account-Recorder.git
cd Financial-Account-Recorder
npm install
npm run dev
```

常用校验命令：

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

### Android

先构建 Web 并同步到 Capacitor：

```powershell
npm run android:sync
npm run android:open
```

随后可直接在 Android Studio 中选择 `app` 配置并运行 debug 变体。Windows 命令行构建示例：

```powershell
$env:JAVA_HOME = 'D:\Software\Program\Android Studio\jbr'
$env:ANDROID_HOME = 'D:\ProgramData\Android\Sdk'
Set-Location android
.\gradlew :app:assembleDebug --offline --no-daemon
```

debug APK 输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 数据与隐私

- 不要求注册账号，不依赖 Recoder 自建后端。
- 正式账本只保存在本机 IndexedDB 中；Android Room 不保存正式账本。
- API Key 与邮箱密码在 Android 上由 Keystore 加密保存，UI 无法读取明文。
- PDF 密码仅用于当前解析，不写入账本、备份或日志。
- v5 备份不包含 API Key、邮箱密码、PDF 密码、行情缓存、请求日志或邮件正文。
- 扫描型 PDF、OCR、ML Kit 与 LLM 解析不在支持范围内。

首次覆盖安装旧版正式应用前，请先导出 v4 备份；新系统可导入 v4，但只导出 v5。

## 文档

- [开发与构建](docs/DEVELOPMENT.md)
- [平台架构](docs/PLATFORM_ARCHITECTURE.md)
- [详细架构](docs/ARCHITECTURE.md)
- [Android 与 Web 功能映射](docs/ANDROID_WEB_MAPPING.md)
- [部署说明](docs/DEPLOYMENT.md)
- [实施状态与发布前清单](docs/TODO.md)
