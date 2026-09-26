# 抖音下载器（douyin-downloader）

一个桌面端抖音视频下载工具：扫码登录 → 粘贴链接 → 解析视频 → 探测真实画质与体积 → 一键下载源片/各档画质。基于 Electron 实现，跨 macOS / Windows。

> 设计文档见 [`docs/desktop-app-electron-design.md`](docs/desktop-app-electron-design.md)（方案与踩坑）；自动更新设计见 [`docs/auto-update-design.md`](docs/auto-update-design.md)。

---

## 功能特性

- **扫码登录**：内置浏览器视图加载抖音官网，用抖音 App 扫码即可，登录态捕获后自动持久化（无需复制粘贴 Cookie）。
- **链接解析**：支持完整页 `douyin.com/video/{id}/`、短链 `v.douyin.com/xxx/`、带 `aweme_id` 的分享页，自动跟随重定向提取视频。
- **画质探测**：并发探测 360p / 540p / 720p / 1080p / 2k / 4k / default，并实测每个直链的真实体积，只保留真正可下载的档位。
- **源片优先**：`default` 档即原始上传画质（最高清），在列表置顶并标注。
- **单档下载**：每档一行下载按钮，带实时进度条（已下/总量、百分比、速度），可取消、可「打开文件夹」定位文件。
- **自动命名**：`作者 - 标题.mp4`，自动清洗文件名、防覆盖（`_1`/`_2` 后缀），并适配 Windows 保留设备名等平台规则。
- **自动更新**：启动后后台检查 GitHub Releases，支持增量（asar，几百 KB）与全量（整目录替换）两种更新，弹窗提示、一键升级。
- **明暗主题**：内置主题切换。

---

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Electron 44.x | 自带 Chromium 与 Node，登录态 Cookie 原生可读 |
| 构建 | electron-vite 5.x | 主进程 / preload / 渲染进程三套配置开箱即用 |
| 打包 | electron-builder 26.x | 产出 `.app`（macOS）/ 绿色目录（Windows） |
| 前端 | React 19 + TypeScript + Vite |  |
| 网络请求 | Node 原生 `fetch`（主进程） | 走主进程规避 CORS，UA / Cookie 可控；弃用 `net.fetch`（见下） |
| 存储 | 本地文件 | Cookie、配置、日志落应用数据目录，无数据库 |
| 自动更新 | 自研（查 GitHub Releases） | 不依赖 electron-updater（其不支持 dir/portable 目标） |

**为什么网络请求走主进程、且用 Node `fetch`**：渲染进程直接请求 `douyin.com` 会被 CORS 拦截，且 Cookie / UA 需精确控制。早期方案用 `net.fetch`，但实测 `redirect:'manual'` 会抛异常、`follow` 模式下 `Response.url` 为空，无法满足短链跟随与播放接口探测；改用 Node 原生 `fetch` 同样无 CORS、完全可控，三条链路均已跑通。

---

## 快速开始

### 环境要求

- Node ≥ 20（运行时由 Electron 自带，仅需构建期）
- macOS 打包需 Xcode Command Line Tools（`xcode-select --install`）
- Windows 正式包建议走 CI，本机 macOS 可交叉产出测试用绿色目录

### 开发模式

```bash
npm install
npm run dev      # electron-vite 启动，支持热重载
```

### 构建与本地打包

```bash
npm run build          # 仅编译主进程 / preload / 渲染层到 out/
npm run dist:local     # 按当前平台自动打包：macOS → .app，Windows → win-unpacked/
npm run dist:mac      # macOS .app（dir 目标）
npm run dist:win      # Windows 绿色目录（dir）
```

打包产物位于 `release/` 下（macOS 为 `release/mac-<arch>/douyin_downloader.app`，Windows 为 `release/win-unpacked/`）。

> 自用分发不做正式签名：macOS 由 electron-builder 自动 ad-hoc 签名（`build-local.sh` 会再补一次 deep 签名，Apple Silicon 必需）；Windows 绿色目录双击 `douyin_downloader.exe` 即可运行。

---

## 目录结构

```
douyin-downloader/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── build/
│   └── icon.png                 # 应用图标
├── docs/                        # 设计文档（对照 / 现行方案 / 自动更新）
├── scripts/
│   └── build-local.sh           # 本地按平台打包脚本
├── src/
│   ├── main/                    # 主进程（Electron 主线程）
│   │   ├── index.ts             # app 生命周期、模块接线
│   │   ├── ipc.ts               # 所有 ipcMain.handle 注册
│   │   ├── windows.ts           # 主窗口工厂
│   │   ├── emit.ts              # 主 → 渲 事件封装
│   │   ├── config.ts            # 配置读写（config.json）
│   │   ├── paths.ts             # 数据目录定位 + 旧目录迁移
│   │   ├── platform.ts          # 平台判断
│   │   ├── log.ts               # 日志（落 logs/）
│   │   ├── auth/
│   │   │   ├── loginWindow.ts   # 内嵌登录视图（WebContentsView + 轮询）
│   │   │   └── cookieStore.ts   # cookie 落盘/读取（0600）
│   │   ├── douyin/
│   │   │   ├── resolve.ts       # 短链 → aweme_id
│   │   │   ├── parse.ts         # _ROUTER_DATA / 详情 API 解析
│   │   │   ├── probe.ts         # ratio 探测 + Range 实测体积
│   │   │   ├── download.ts      # 流式下载 + 进度 + 取消
│   │   │   └── naming.ts        # 文件名清洗、防覆盖、Windows 规则
│   │   ├── httpc/
│   │   │   └── client.ts        # 统一 UA、Cookie、超时、限速
│   │   └── update/              # 自动更新（P0/P1/P2 已落地）
│   │       ├── index.ts         # Manager：check/download/apply 接线
│   │       ├── checker.ts       # GitHub API 查询 + asset 匹配
│   │       ├── downloader.ts    # 流式下载 + 校验
│   │       ├── applyAsar.ts     # 增量（rename/copy/relaunch）
│   │       ├── applyFullWin.ts  # 全量（bat 整目录替换）
│   │       ├── applyFullMac.ts  # 全量（macOS bash）
│   │       ├── extract.ts       # 解压
│   │       └── version.ts       # semver 比较
│   ├── preload/
│   │   └── index.ts             # contextBridge 暴露 window.api
│   ├── renderer/                # 渲染进程（React）
│   │   ├── App.tsx
│   │   ├── components/          # LoginPanel / SearchBar / VideoCard / QualityTable / UpdateModal / ThemeToggle
│   │   ├── hooks/useTheme.ts
│   │   └── lib/theme.ts
│   └── shared/
│       └── types.ts             # 主/渲共享类型定义
```

---

## 工作原理

### 1. 登录（内嵌视图，非独立窗口）

点击「扫码登录」后，主进程用 `WebContentsView` 盖在主窗口解析页上方（顶部留 52px 顶栏放标题与「取消」按钮），加载 `https://www.douyin.com/`：

- 使用**非持久** partition `douyin-login`（不带 `persist:` 前缀），App 重启即清空，杜绝"假登录"；
- UA 覆盖为正常 Chrome，去掉 `Electron/` 标识；
- 导航白名名单（`douyin/amemv/snssdk/iesdouyin` 等系域名），其余跳转交系统浏览器；
- 每 2s 轮询 `session.cookies.get({})`，**只认 `sessionid` / `sessionid_ss` / `sid_tt` / `sid_guard`**（`ttwid` / `odin_tt` 是设备/风控标识，不是登录标志，据此判定会一打开就误判成功）；
- 命中后把 Cookie 拼接成 `name=value; ...` 写入数据目录，关闭视图，自动退回解析页。

### 2. 解析

主进程 HTTP 拉取视频页 HTML（纯文本），正则抠出 `_ROUTER_DATA`，按三种形态还原后 `JSON.parse`；三种都失败则降级到详情 API。解析产出视频信息（作者 / 标题 / 时长 / 封面 / 发布时间 / 互动数据 / BGM）与画质列表。

### 3. 画质探测

从 `video.play_addr.uri` 调用移动端播放接口，用**移动端 UA**（否则被 302 跳网页拿不到源片），`redirect:'manual'` 取 302 `Location` 即 CDN 直链；并逐个发 `Range: bytes=0-0` 只读响应头取真实体积。7 个档位并发探测，数百毫秒完成。`ratio=default` 为源片（最高画质）。

### 4. 下载

对已签名 CDN 直链发全量 GET，流式分块写盘（1MB/块），按真实 `Content-Length` 计算进度，事件节流 ~200ms 推给前端；取消用 `AbortController` + 删除半成品。文件名 `作者 - 标题.mp4`，非法字符替换、空白压缩、限长 120，并针对 Windows 保留设备名（CON/PRN/NUL/COM1-9/LPT1-9）、完整路径 ≤260 字符做专门处理（emoji / 全角符号在 Windows 合法，不过度清洗）。

### 5. 自动更新

启动 3 秒后后台查 GitHub Releases（`/releases/latest`），semver 比较版本；按平台匹配 asset：

- 命中 `_win_asar.zip` / `_macos_<arch>_asar.zip` → **增量**：进程内替换 `app.asar`，重启生效（几百 KB）；
- 命中 `*_full.zip` → **全量**：Windows 走 bat 整目录 robocopy 替换，macOS 走 bash；
- 用 GitHub asset 自带 `sha256` digest 做校验；
- 失败静默跳过，绝不阻塞正常使用；设置页可手动「检查更新」。

---

## 数据存储位置

应用数据统一落在数据目录（**不在**项目目录）：

| 平台 | 路径 |
| --- | --- |
| macOS / Linux | `~/.douyin_downloader/` |
| Windows | `%APPDATA%\douyin_downloader\` |

目录内容：

- `cookie.txt` —— 登录态 Cookie（`name=value; ...` 格式，权限 0600），与归档的 `python/` CLI 脚本格式兼容，可互用；
- `config.json` —— 用户配置；
- `logs/` —— 运行日志（排查风控问题）。

---

## 配置项

配置文件 `config.json`（缺省值见 `src/main/config.ts`）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `downloadDir` | `~/Downloads` | 下载目录 |
| `defaultRatio` | `default` | 默认下载画质（`default` = 源片） |
| `loginTimeoutSec` | `180` | 登录窗口超时（秒），超时未扫码自动关闭 |

---

## 构建与分发说明

- **macOS**：本机 `npm run dist:mac` 或 `dist:local` 产出 `.app`，双击运行；首启若被 Gatekeeper 拦截，右键 → 打开即可。正式分发需开发者账号公证。
- **Windows**：本机可交叉产出 `win-unpacked/` 绿色目录（zip 一次后免安装秒开），双击 `douyin_downloader.exe` 运行；首次若被 SmartScreen 拦截，点「更多信息 → 仍要运行」。正式包 / 增量包建议交给 GitHub Actions（`windows-latest`）。
- 路径一律 `path.join`，数据目录一律 `app.getPath`，文件名清洗同时满足双平台规则——详见设计文档 §3、§8。

---

## 已知坑与注意事项

- 登录判据只认 `sessionid` 系字段，`ttwid` / `odin_tt` 会误判；
- 登录视图必须非持久 partition，否则残留 Cookie 造成"假登录"；
- 解析用主进程 HTTP 正则，抖音改版需同步改正则（已有详情 API 兜底）；
- CDN 直链带签名有时效，探测与下载必须连续完成，不跨会话缓存 URL；
- Windows 文件名额外禁止保留设备名、完整路径 ≤260 字符（见上）；
- 自动更新的全量 bat 流程、运行中 `app.asar` 重命名等，待 Windows 真机复测验证。

---

## 相关文档

- [`docs/desktop-app-electron-design.md`](docs/desktop-app-electron-design.md) —— 现行方案（Electron）设计、选型与踩坑全集
- [`docs/auto-update-design.md`](docs/auto-update-design.md) —— 自动更新方案（增量 + 全量）
- [`docs/desktop-app-design.md`](docs/desktop-app-design.md) —— Go + Wails 旧方案（已停止执行，仅作对照）
- [`python/`](python/) —— 已归档的 CLI 兜底脚本（`inspect_qualities.py`），Cookie 格式与 App 互通
