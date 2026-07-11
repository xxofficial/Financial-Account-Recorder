# Recoder Platform 架构

`recoder-platform` 是独立仓库。React PWA 与 Capacitor Android 共用同一份领域逻辑、账本和界面；旧 Compose/Room 账本不再参与新应用的数据写入。

## 模块边界

- `apps/web`：React UI、PWA、HashRouter 与 GitHub Pages 构建产物。
- `packages/contracts`：Zod 契约、v4 读取适配器和 `recoder-backup-v5` 格式。
- `packages/core`：计算、幂等指纹、卓锐/嘉信文本邮件解析；不依赖浏览器或 Capacitor。
- `packages/app-data`：数据访问接口；正式账本位于 WebView 的 Dexie/IndexedDB。
- `packages/platform`：能力接口；具体 Android bridge 在 `apps/web/src/platform/nativeRuntime.ts`。
- `android`：Capacitor 宿主与 Kotlin 插件。Room 只保存 `native_import_inbox` 和同步运行日志。

## 重要数据流

```text
分享文本 / PDF / IMAP 邮件
        ↓
Android native_import_inbox（不写账本）
        ↓
PDFBox 文本提取或共享 TypeScript 文本解析
        ↓
用户预览、确认
        ↓
指纹 + platform/externalReference 去重/冲突检查
        ↓
Dexie IndexedDB 正式账本
```

扫描 PDF 会明确提示不支持；系统没有 OCR、ML Kit 或 LLM 路径。

## 行情与密钥

Android 默认使用腾讯（实时、日 K）、新浪（搜索与回退）和 Yahoo（美股期权）。可选 iTick、Twelve Data、MarketData.app 在 Android 上由 `NativeMarket` 执行 HTTP 请求，从而避开 WebView CORS。

Android 可选行情 Key 和 IMAP 密码被加密存入 Keystore。WebView 只保存一个不可用的占位符；`NativeMarket` 在原生进程内将其替换后发送请求，插件不提供读取明文的 API。

## 邮件同步

Android 提供卓锐与嘉信 IMAP 配置。手动或 WorkManager（最短 15 分钟）同步只拉取候选正文并写入收件箱；用户在“数据管理”页确认后才会记账。Web 不暴露邮件同步入口。

## 验证

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

E2E 需要预先安装 Playwright Chromium：`npx playwright install chromium`。
