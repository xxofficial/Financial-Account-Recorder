# 开发与构建

本文保存 Recoder Platform 的本地开发、Android 签名、构建和发布约束。项目概览与功能介绍见仓库根目录的 [README](../README.md)。

## Web 开发

```powershell
npm install
npm run dev
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

Playwright 端到端测试需要预先安装 Chromium：

```powershell
npx playwright install chromium
```

## Capacitor Android

Web 构建完成后同步静态资源：

```powershell
npm run android:sync
npm run android:open
```

Windows 命令行构建环境：

```powershell
$env:JAVA_HOME = 'D:\Software\Program\Android Studio\jbr'
$env:ANDROID_HOME = 'D:\ProgramData\Android\Sdk'
Set-Location android
.\gradlew :app:assembleDebug --offline --no-daemon
```

debug APK 输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 包名与签名

- debug：`com.recoder.stockledger.debug`，使用默认 debug keystore，可覆盖安装旧工程的 debug 包。
- release：`com.recoder.stockledger`，必须使用旧正式应用相同的 keystore。
- 当前新工程 `versionCode` 必须始终高于已发布旧版。

release 签名只允许通过 `android/local.properties`（已忽略）或环境变量提供：

```properties
RECODER_STORE_FILE=keystore 的绝对路径
RECODER_STORE_PASSWORD=...
RECODER_KEY_ALIAS=...
RECODER_KEY_PASSWORD=...
```

构建正式包：

```powershell
Set-Location android
.\gradlew :app:assembleRelease
```

缺少任一正式签名项时，release 构建会主动失败，避免生成无法覆盖旧正式包的错误签名 APK。

## 应用内更新

Android 只检查 `xxofficial/Financial-Account-Recorder` 的 GitHub Releases。Release APK 文件名必须以 Android `versionCode` 结尾：

```text
recoder-v<versionName>-<versionCode>.apk
recoder-v2.0.1-102.apk
```

客户端只在远端 `versionCode` 高于当前安装包时提示更新。Android 系统安装器会继续校验包名与签名；正式更新包必须使用原正式 keystore。

## 数据边界

- `recoder-backup-v5` 是唯一导出格式；旧版 v4 仅允许导入。
- API Key、邮箱密码、PDF 密码、行情缓存、请求日志和邮件正文不进入备份。
- Android/Web 都支持长桥、汇丰、uSMART、嘉信的文本型 PDF 结单；扫描件不支持。
- Web 使用 PDF.js，Android 使用 PDFBox。PDF 文件、密码和提取文本不会写入正式账本或备份。
- Android 额外支持分享接收、Keystore、腾讯/新浪/Yahoo 原生行情和 IMAP 待确认收件箱。

更详细的数据流和模块边界见 [平台架构](PLATFORM_ARCHITECTURE.md)。
