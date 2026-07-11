# 部署指南与说明 (DEPLOYMENT)

本项目是纯前端、本地优先的 React PWA 应用。构建产物为全静态资源（HTML、JS、CSS、WebManifest 等），可以完全免费地托管在任何静态网页服务平台上。

---

## 一、 本地开发与构建

在本地运行或构建应用需要配置好 Node.js 环境（推荐 v18+）。

### 1. 常用命令
- **启动本地开发服务**：
  ```bash
  npm run dev
  ```
- **代码静态类型检查**：
  ```bash
  npm run typecheck
  ```
- **代码 Lint 扫描**：
  ```bash
  npm run lint
  ```
- **运行单元测试**：
  ```bash
  npm run test
  ```
- **打包静态资源**：
  ```bash
  npm run build
  ```
- **本地预览打包产物**：
  ```bash
  npm run preview
  ```

---

## 二、 免费静态托管部署

由于应用没有任何后端及云端数据库，你可以使用以下几种主流平台进行一键免费部署：

### 1. Vercel 部署
Vercel 是最便捷的托管方式，支持开箱即用的前端路由。
1. 在 GitHub 上创建一个私有或公开仓库，并推送代码。
2. 登录 [Vercel](https://vercel.com/)，导入该仓库。
3. 框架选择 **Vite**，构建命令默认为 `npm run build`，输出目录默认为 `dist`。
4. 点击 **Deploy**。
5. **Vercel 配置 (Vite 路由支持)**：
   由于项目使用 React Router 的 History 模式，为防止刷新页面时出现 404，项目根目录下已配置 `vercel.json`：
   ```json
   {
     "rewrites": [
       { "source": "/(.*)", "destination": "/index.html" }
     ]
   }
   ```

### 2. GitHub Pages 部署
1. 若要部署到 `https://<username>.github.io/<repo-name>/`，需在 `vite.config.ts` 中设置正确的 `base` 路径：
   ```typescript
   // vite.config.ts 示例
   export default defineConfig({
     base: '/<repo-name>/', // 必须与仓库名一致
     // ...
   })
   ```
2. 使用 `gh-pages` 工具或配置 GitHub Actions 自动打包部署。
3. **路由降级提醒**：GitHub Pages 默认不支持 HTML5 History 路由回退。如果刷新非根路径页面可能会 404。若有此需求，可考虑在打包产物中拷贝 `index.html` 为 `404.html`，或改用 Hash 路由。

### 3. Cloudflare Pages 部署
1. 登录 Cloudflare 控制台，进入 **Workers & Pages** -> **Pages**。
2. 连接你的 GitHub 账户并选择本项目仓库。
3. 选择 **Vite** 作为预设，Build command 设置为 `npm run build`，Build output directory 设置为 `dist`。
4. 在 Environment variables 中无需设置任何敏感 API Key（API Key 需在应用运行后由用户在前端设置中自行填入）。
5. 点击 **Save and Deploy**。
6. **路由重定向**：在 `public/` 目录下放置一个 `_redirects` 文件，写入 `/* /index.html 200`，以确保 React Router 正常工作。

---

## 三、 PWA 注意事项

1. **HTTPS 强制要求**：
   Service Worker 必须在安全上下文（HTTPS 或本地 `localhost`）下运行。部署到线上后，务必保证通过 HTTPS 协议访问，否则 PWA 无法注册，应用将失去离线可用能力和添加到桌面的功能。
2. **Service Worker 更新机制**：
   - 默认采用 `prompt` 提示更新或 `autoUpdate` 自动静默更新。
   - 当检测到新版本打包产物时，应用会弹窗提示“发现新版本，是否刷新载入？”。
   - 用户确认后，Service Worker 会调用 `skipWaiting()` 接管页面并刷新。

---

## 四、 重要安全与数据保护警示 ⚠️

> [!CAUTION]
> **本地数据防丢警示**：
> 1. 本项目的所有交易记录和敏感配置仅保存在浏览器的 IndexedDB 数据库中。
> 2. 如果用户在浏览器中手动选择“清除浏览器数据”、“清理 Cookie 和网站数据”或卸载浏览器，**本地的账本数据将会被彻底删除**！
> 3. 在“无痕/隐私模式”下打开本网页，数据在窗口关闭后即被销毁，无法持久保存。
> 4. 强烈建议用户在进行大批量记账或升级系统前，通过“备份”功能**导出 JSON 备份文件**并妥善保存在本地硬盘或云盘中。
