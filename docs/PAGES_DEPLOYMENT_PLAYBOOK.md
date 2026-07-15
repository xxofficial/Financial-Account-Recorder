# GitHub Pages 发布手册

本文是本项目 Web PWA 的唯一发布排障手册。目标是避免把“代码已经推送”误认为“页面已经发布”。

## 1. 发布链路

生产 Web 页面只通过 `.github/workflows/pages.yml` 发布：

```text
push main
  -> verify
     -> npm ci
     -> lint / typecheck / Vitest
     -> Playwright Smoke
     -> npm run build
     -> upload apps/web/dist
  -> deploy
     -> GitHub Pages
```

只要 `verify` 失败，`build`、`upload-pages-artifact` 和 `deploy` 都不会执行，Pages 会继续提供上一个成功版本。

当前页面地址：

<https://xxofficial.github.io/Financial-Account-Recorder/>

## 2. 发布前检查

在推送前执行：

```powershell
git status --short
git branch --show-current
git log -1 --oneline
npm ci
npm run lint
npm run typecheck
npm run test --workspace @recoder/web -- --testTimeout=15000
npm run build
```

确认构建产物存在：

```powershell
Test-Path apps/web/dist/index.html
Test-Path apps/web/dist/manifest.webmanifest
Test-Path apps/web/dist/sw.js
```

Pages 发布只要求应用 Smoke 测试，不要求把所有行情探针都塞进发布门禁：

```powershell
npm run test:e2e --workspace @recoder/web -- src/e2e/smoke.spec.ts
```

推送前应满足：

- 当前分支为 `main`，且工作区没有未提交的意外改动；
- `lint`、`typecheck`、单元测试、Smoke 测试和生产构建全部通过；
- 未把 Android Release、测试产物或本地数据库提交到仓库。

## 3. E2E 测试的边界

不要在 Pages 工作流中直接运行根目录的完整 `npm run test:e2e`。该命令还包含 `stock-sdk-*.spec.ts` 和视觉回归测试，它们有不同的运行前提：

- stock-sdk 探针需要 `market-probe` 构建、专用 Playwright 配置和实时上游接口；
- 普通 Playwright 配置使用 Vite 开发服务器，不能替代 market-probe 预览服务；
- 视觉测试对页面文案、选择器和快照敏感，新增设置分组时应使用精确 locator，并单独更新快照；
- 上游行情接口、CORS、CDN 或浏览器缓存波动不应阻断静态页面发布。

行情探针应单独验证：

```powershell
npm run build:market-probe --workspace @recoder/web
npx playwright test -c apps/web/stock-sdk-pwa.config.ts
```

这类探针失败时，记录为行情能力验证失败，不要通过删除应用功能或反复重跑 Pages 工作流来规避。

## 4. 推送和确认发布

推送：

```powershell
git push origin main
```

立即查看工作流：

```powershell
gh run list --workflow pages.yml --limit 5
gh run view <run-id> --log-failed
```

确认顺序：

1. `verify` 为 `success`；
2. 日志中出现 `upload-pages-artifact`；
3. `deploy` 为 `success`，而不是 `skipped`；
4. 打开 Pages 地址并执行一次硬刷新。

如果 GitHub CLI 报 API rate limit，直接打开仓库的 **Actions → Deploy Web PWA** 查看同一个运行编号，不要连续重复推送。连续推送会触发 `concurrency: pages`，旧运行可能被取消。

## 5. 常见现象与处理

| 现象 | 先看什么 | 处理方式 |
| --- | --- | --- |
| 页面没有“自动同步” | `verify` 是否失败、`deploy` 是否 skipped | 修复失败步骤后重新推送；确认成功后对站点执行硬刷新 |
| `main` 是新提交但页面仍旧 | Pages 运行是否只完成 checkout，后续是否失败 | 以 `deploy success` 为准，不能以 push 成功为准 |
| E2E 报 manifest 不存在 | 是否用 Vite dev server 跑了 PWA 探针 | 普通发布跑 Smoke；探针使用 `stock-sdk-pwa.config.ts` 和 market-probe 构建 |
| E2E 报 `window.__RECORDER_STOCK_SDK_*` 未定义 | 是否设置了 `VITE_MARKET_PROBE=true` 或 `--mode market-probe` | 使用专用 market-probe 构建，不要在普通应用构建中等待探针全局变量 |
| 视觉测试 strict mode | locator 是否同时匹配父标题和子标题 | 对标题使用 `exact: true`，或改用稳定的 class/label locator |
| 页面看起来还是旧版 | Service Worker/CDN 缓存 | Ctrl+F5；必要时在 DevTools → Application 中注销 Service Worker 并清理 Cache Storage |
| 多次重跑仍失败 | 是否为上游行情、网络或权限问题 | 先读取失败日志，确认是代码、测试前提、上游接口还是 Pages 权限，不要盲目重跑 |

## 6. 本次事故的记录

提交 `ceeba6c` 已经推送到 `main`，但对应 Pages 运行的 `verify` 在完整 E2E 阶段失败，因此 `build` 和 `deploy` 被跳过；这就是“代码已上传、页面仍是旧版”的直接原因。之后将 Pages 门禁收敛为 Smoke 测试，并在 `vite.config.ts` 中启用开发环境 PWA manifest，避免同类失败再次阻断部署。

## 7. 发布完成定义

一次 Web 发布只有同时满足以下条件才算完成：

- `main` 已推送；
- GitHub Actions 的 `verify` 和 `deploy` 均为绿色；
- `apps/web/dist` 已上传为 Pages artifact；
- 线上页面硬刷新后能看到本次提交对应的功能；
- Android Release 没有被构建、上传或发布，除非用户另行明确授权。
