# 抖音下载器桌面 App 方案（Electron）

> 目标：把已跑通的 `python/inspect_qualities.py` 能力做成带界面的桌面应用，覆盖**扫码登录 → 输入链接 → 解析 → 选画质 → 下载**的完整链路。  
> 状态：**M0 可行性验证已通过（2026-09-26），可开工 M1**。选型确认见 §11，M0 结果：无风控、HttpOnly Cookie 可读（4 个登录字段全中）、cookie 喂 Python 脚本解析+源片探测成功、无异常跳转。  
> 姊妹篇：`docs/desktop-app-design.md`（Go + Wails 方案，已停止执行）。本文是对它的**技术栈替换方案**，功能范围与里程碑基本沿用。

---

## 〇、为什么要从 Go + Wails 换成 Electron

不是"Electron 也能做"，而是**Electron 能消灭原方案里最脆弱的一整段**。

原方案的全部复杂度来自一条硬约束：Wails 的 WebView（macOS WKWebView / Windows WebView2）不暴露 Cookie 读取接口，登录态 Cookie 是 `HttpOnly`，前端 `document.cookie` 拿不到。为了绕过它，方案被迫：

1. 引入 go-rod，额外起一个**无头 Chromium**；
2. 为了把二维码显示给用户，再做「固定等 10s → 定位二维码 `<img>` → 元素截图 → base64 回传 → 过期自动重截」。

这一串里埋了四个雷：二维码 `<img>` 的匹配特征至今是"待确认"项；无头模式可能被风控；截图是死图，有过期问题；用户体验上是对着一张静态图片扫码。

**Electron 里这些全部消失。** Electron 自身就是 Chromium，主进程 `session.cookies.get()` 原生读得到 `HttpOnly` Cookie，那条约束根本不存在。于是登录退化成最朴素的实现：开一个真实可见的窗口加载抖音登录页，用户在里面扫码，主进程轮询 Cookie 即可。截图、img 定位、等待、重截，一行都不用写。

### 差异对照

| 环节                | Go + Wails                      | Electron                    |
| ----------------- | ------------------------------- | --------------------------- |
| 登录页载体             | go-rod 无头 Chromium              | 独立可见 BrowserWindow          |
| 取 HttpOnly Cookie | CDP `Network.getCookies`        | `session.cookies.get()`（原生） |
| 二维码呈现             | 等 10s → 定位 img → 截图 → base64    | **不需要**，用户直接看官方页面           |
| 二维码过期             | 需计时重截 + 手动刷新按钮                  | **不需要**，官方页面自己刷新            |
| 无头风控风险            | 有，需 headful 兜底                  | 无                           |
| 语言/构建链            | Go + React + go-rod + 遗留 Python | TypeScript 一套               |
| 打包体积              | ~15MB（+ 系统 WebView）             | ~100MB（含 Chromium）          |
| 内存占用              | 低                               | 较高                          |

**代价只有体积和内存**，自用工具场景无所谓。换来的收益是：少一个外部依赖（go-rod + 下载的 Chromium）、少一条最脆的链路、单一语言栈。

> 附带的清理：Python 脚本已归档到 `python/` 目录作 CLI 兜底。等 App 上线接管登录后，脚本里的 `playwright` 依赖就可以删掉了——它唯一的用途是扫码登录，删掉后脚本退回纯标准库。

**关于决策权**：本文 §11 已列出的五项选型（前端框架 / 目标平台 / 登录窗口形态 / Python 去留 / 解析路径）均已拍板，后续开工直接执行，不再回头讨论。

---

## 一、范围界定

**本期做**

1. 扫码登录（独立窗口加载官方登录页 + Cookie 自动捕获与持久化）
2. 输入视频链接解析出视频信息
3. 列出该视频实际可下载的画质档位及真实体积
4. 每个画质档位一个下载按钮，带进度

**本期不做**（后续可加）

- 下载队列 / 多任务并发 / 断点续传
- SQLite 下载历史
- 批量粘贴链接、作者主页批量下载
- 自动更新

---

## 二、用户流程

```
启动 App
  │
  ├─ 未登录 ──► 点击「扫码登录」
  │               │
  │               ├─ 主进程开独立登录窗口（临时 session partition）
  │               ├─ 加载 https://www.douyin.com/ ，最佳努力点「扫码登录」
  │               ├─ 用户在真实页面里用抖音 App 扫码
  │               ├─ 主进程每 2s 轮询 session.cookies
  │               └─ 命中真实登录字段 → 存 cookie → 关窗口 → 事件通知前端
  │
  └─ 已登录 ──► 顶部显示登录状态条 + 「退出登录」
                  │
                  ├─ 搜索框输入视频链接 → 点「解析」
                  ├─ 展示视频信息卡（封面 / 作者 / 标题 / 时长 / 发布时间 / 互动数据）
                  ├─ 画质表格：档位 | 分辨率 | 实测大小 | [下载按钮]
                  └─ 点某档「下载」→ 该行变进度条 → 完成提示「打开文件夹」
```

注意流程里**没有二维码截图环节**——这是与 Wails 方案最直观的区别。

---

## 三、技术栈

| 层         | 选型                                           | 说明                                           |
| --------- | -------------------------------------------- | -------------------------------------------- |
| 运行时       | **Electron 44.x**（当前最新 44.4.5，开工时锁定版本）       | 自带 Chromium 与 Node                           |
| 构建        | **electron-vite 5.x**                        | 主进程 / preload / 渲染进程三套配置开箱即用                 |
| 打包        | **electron-builder 26.x**                    | macOS 出 `.dmg` / `.app`                      |
| 前端        | React 19 + TypeScript + Vite                 | 备选：原生 TS（UI 仅三块，够用但表格/进度手写偏啰嗦）               |
| 网络请求      | Electron `net.fetch`（主进程）                    | 走 Chromium 网络栈，可手动控制 UA / Cookie / redirect  |
| Cookie 存储 | `app.getPath('userData')/cookie.txt`，权限 0600 | **格式与现有 `cookie.txt` 完全一致**，可与 Python 脚本互相复用 |
| 日志        | `electron-log`，落 `userData/logs/`            | 排查风控问题                                       |
| 数据库       | 无（本期不存历史）                                    | —                                            |
| 目标平台      | **macOS（开发 + 日常）+ Windows（常用）**               | 双平台都要能用，见下方「平台策略」                             |

**为什么网络请求必须走主进程而不是渲染进程**：渲染进程请求 `douyin.com` 会被 CORS 拦截；且 Cookie 与 UA 需要精确控制。所有请求一律走主进程。

> **M1 实测修正（2026-09-26）**：主进程网络层最终用的是 **Node 原生 `fetch`** 而非 `net.fetch`。原因：实测 `net.fetch` 的 `redirect: 'manual'` 会直接抛异常（"Redirect was cancelled"），`follow` 模式下 `Response.url` 是空字符串拿不到最终重定向 URL——短链解析和播放接口探测都依赖这两点。Node fetch 在主进程同样无 CORS、UA/Cookie 完全可控，三条链路（短链跟随 / manual 302 / Range 实测）已实测通过。

### 平台策略

| 角色       | macOS                                            | Windows                                    |
| -------- | ------------------------------------------------ | ------------------------------------------ |
| 定位       | 开发与日常测试                                          | 高频使用目标端                                     |
| 产物       | `.dmg`（内含 `.app`）                               | NSIS 安装包 `.exe`                            |
| 构建方式     | **本机直接构建**（dmg 只能在 macOS 上产出）                    | 本机出测试包，**正式包建议 GitHub Actions 构建**         |
| 数据目录     | `~/Library/Application Support/douyin-downloader` | `%APPDATA%\douyin-downloader`              |

**构建为什么不都放在本机**：`dmg` 依赖 macOS 系统能力，只能在 Mac 上产出；Windows 的 NSIS 包虽可在 macOS 上交叉产出（electron-builder 支持），但涉及图标、版本资源、签名等细节，原生 Windows 环境更稳。日常在 Mac 上出一个测试用 Windows 包足够，正式 Windows 包交给 CI（`windows-latest` runner）最省事。

> 由此产生的代码约束（写代码时必须遵守）：
> 1. 路径拼接一律 `path.join`，禁止硬编码 `/` 或 `\`；
> 2. 数据目录一律 `app.getPath('userData')`，不手写平台路径；
> 3. 文件名清洗必须同时满足两套规则，见 §8 Windows 文件名一节。

---

## 四、功能点清单

### 4.1 登录模块

| 编号  | 功能点        | 说明                                                         |
| --- | ---------- | ---------------------------------------------------------- |
| L1  | 触发登录       | 前端 `auth:login`，主进程开窗口，异步，结果走事件                            |
| L2  | 独立登录窗口     | 480×720，`session.fromPartition('douyin-login')`（非持久，重启即清空） |
| L3  | 覆盖 UA      | 干掉默认 UA 里的 `Electron/xx`，伪装成正常 Chrome                      |
| L4  | 导航白名单      | 只允许 douyin.com 系域名在窗口内跳转，其余交系统浏览器                          |
| L5  | 触发二维码      | 最佳努力点击「登录 / 扫码登录」；失败也不阻塞，用户可手动点                            |
| L6  | Cookie 轮询  | 每 2s `session.cookies.get({})`，判定是否命中真实登录字段                |
| L7  | 登录成功       | 命中 → 导出 cookie 字符串 → 落盘 → `auth:success` → 关窗口             |
| L8  | 超时/取消      | 超时（暂定 180s）或用户取消 → `auth:failed`，关窗口                       |
| L9  | Cookie 持久化 | 存为 `name=value; ...` 到 `userData/cookie.txt`，0600；启动时自动加载  |
| L10 | 退出登录       | `auth:logout` 删除本地文件                                       |
| L11 | 手动导入       | 设置页可粘贴 cookie 字符串（兜底，兼容从浏览器 F12 复制）                        |

### 4.2 解析模块

| 编号 | 功能点         | 说明                                                                    |
| -- | ----------- | --------------------------------------------------------------------- |
| P1 | 链接输入        | 完整页 `douyin.com/video/{id}/`、短链 `v.douyin.com/xxx/`、带 `aweme_id` 的分享页 |
| P2 | 解析 aweme_id | 跟随重定向后从 URL 正则提取                                                      |
| P3 | 抓详情（主路径）    | 复用登录 session 开隐藏窗口，`executeJavaScript` 取 `window._ROUTER_DATA`        |
| P4 | 抓详情（兜底）     | 主进程 `net.fetch` 拉 HTML 正则解析，再降级到详情 API                                |
| P5 | 视频信息卡       | 封面图、作者、标题、时长、发布时间、点赞/评论/分享/收藏/播放、背景音乐                                 |
| P6 | 画质探测        | 并发探测 `360p/540p/720p/1080p/2k/4k/default`，只保留真正拿得到直链的档位               |
| P7 | 实测体积        | 对每个直链发 `Range: bytes=0-0`，只读响应头取真实总大小                                 |
| P8 | 排序展示        | 表格按画质从高到低排列，`default`（源片）置顶并标注                                        |

### 4.3 下载模块

| 编号 | 功能点  | 说明                                                 |
| -- | ---- | -------------------------------------------------- |
| D1 | 单档下载 | 画质表格每行右侧一个「下载」按钮                                   |
| D2 | 进度展示 | 该行切换为进度条：已下/总量、百分比、速度；IPC 节流 ~200ms                |
| D3 | 自动命名 | `作者 - 去#话题后的标题.mp4`，标题为空退回 `douyin_{aweme_id}.mp4` |
| D4 | 防覆盖  | 目标已存在自动加 `_1` / `_2` 后缀                            |
| D5 | 选择目录 | `dialog:selectDir` 系统目录选择，默认 `~/Downloads`         |
| D6 | 完成提示 | 显示最终路径 + 「打开文件夹」按钮（`shell.showItemInFolder`）       |
| D7 | 取消下载 | 进行中可取消，`AbortController` 中断 + 删除半成品文件              |
| D8 | 错误提示 | 风控/403/网络失败给出可读原因                                  |

### 4.4 通用

| 编号 | 功能点   | 说明                                                                |
| -- | ----- | ----------------------------------------------------------------- |
| C1 | 登录状态条 | 常驻顶部，显示已登录/未登录                                                    |
| C2 | 加载态   | 解析中、探测中的骨架屏/spinner                                               |
| C3 | 设置页   | 下载目录、默认画质、登录超时时长、手动导入 Cookie                                      |
| C4 | 日志    | 关键步骤落 `userData/logs/`，便于排查风控                                     |
| C5 | 窗口安全  | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` |

---

## 五、目录结构

```
douyin-downloader/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── build/
│   ├── icon.png                  # 1024×1024，electron-builder 转 icns
│   └── entitlements.mac.plist
├── src/
│   ├── main/
│   │   ├── index.ts              # app 生命周期、主窗口创建
│   │   ├── ipc.ts                # 所有 ipcMain.handle 注册
│   │   ├── windows.ts            # 主窗口 / 登录窗口工厂
│   │   ├── auth/
│   │   │   ├── loginWindow.ts    # 登录窗口 + 临时 partition + 轮询
│   │   │   ├── cookieStore.ts    # cookie 落盘/读取（0600）
│   │   │   └── detect.ts         # 登录判据常量与命中逻辑
│   │   ├── douyin/
│   │   │   ├── resolve.ts        # 短链 → aweme_id
│   │   │   ├── parse.ts          # _ROUTER_DATA / RENDER_DATA / 详情 API
│   │   │   ├── probe.ts          # ratio 探测 + Range 实测体积
│   │   │   ├── download.ts       # 流式下载 + 进度 + 取消
│   │   │   └── naming.ts         # 文件名清洗、防覆盖
│   │   └── httpc/
│   │       └── client.ts         # 统一 UA、Cookie、超时、限速
│   ├── preload/
│   │   └── index.ts              # contextBridge 暴露 window.api
│   └── renderer/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── styles.css
│       └── components/
│           ├── LoginPanel.tsx    # 触发登录 + 等待扫码状态
│           ├── SearchBar.tsx     # 链接输入 + 解析按钮
│           ├── VideoCard.tsx     # 视频信息
│           └── QualityTable.tsx  # 画质表 + 每档下载按钮/进度
```

---

## 六、接口设计

### 6.1 渲染进程 → 主进程（`ipcRenderer.invoke`）

```ts
auth:status    ()                        => { loggedIn: boolean; source: 'file' | 'none' }
auth:login     ()                        => void   // 异步，结果走事件
auth:cancel    ()                        => void
auth:logout    ()                        => void
auth:import    (cookie: string)          => void

video:inspect  (link: string)            => VideoInfo
download:start (req: DownloadReq)        => string  // 返回 taskId
download:cancel(taskId: string)          => void

dialog:selectDir ()                      => string | null
shell:showItemInFolder (path: string)    => void
config:get      ()                       => Config
config:set      (cfg: Partial<Config>)   => void
```

### 6.2 主进程 → 渲染进程（事件）

| 事件                  | 载荷                                     | 触发             |
| ------------------- | -------------------------------------- | -------------- |
| `auth:waiting`      | `{ elapsed }`                          | 等待扫码中的心跳       |
| `auth:success`      | `{ cookieCount }`                      | 命中真实登录 Cookie  |
| `auth:failed`       | `{ reason }`                           | 超时 / 取消 / 窗口异常 |
| `download:progress` | `{ taskId, downloaded, total, speed }` | 下载中（节流 ~200ms） |
| `download:done`     | `{ taskId, path }`                     | 完成             |
| `download:error`    | `{ taskId, message }`                  | 失败             |

### 6.3 主要数据结构

```ts
interface VideoInfo {
  awemeId: string
  author: string
  desc: string
  durationMs: number
  cover: string
  createdAt: number
  stats: { digg: number; comment: number; share: number; collect: number; play: number }
  music: string
  qualities: Quality[]
}

interface Quality {
  ratio: string      // 360p / 720p / default ...
  width: number
  height: number
  size: number       // 实测字节数，0 表示未测到
  url: string        // 已签名 CDN 直链（有时效，勿跨会话缓存）
}

interface DownloadReq {
  link: string
  ratio: string
  dir: string
}

interface Config {
  downloadDir: string
  defaultRatio: string
  loginTimeoutSec: number
}
```

---

## 七、关键实现细节

### 7.1 登录（核心，也是相对 Wails 方案最大的简化）

```
1. 创建登录窗口
   - session.fromPartition('douyin-login')
     不带 persist: 前缀 → 内存 session，App 重启即清空
     这是"每次都必须真扫码"的保证，等价于 Wails 方案里的独立临时 user-data-dir
   - 尺寸 480×720，可调整大小，标题栏保留（用户需要知道这是个浏览器）
2. 覆盖 UA：干掉默认的 Electron/xx 字段
3. 拦截导航：白名单 douyin.com / amemv.com / snssdk.com，
   其余用 shell.openExternal 交系统浏览器（避免 App 变成通用浏览器）
4. loadURL('https://www.douyin.com/') → 最佳努力点击「扫码登录」
5. 每 2s 轮询 session.cookies.get({})
6. 命中 → 拼成 'name=value; ...' → 写 userData/cookie.txt(0600) → 关窗口 → auth:success
```

**登录判定字段（关键）**：只认 `sessionid` / `sessionid_ss` / `sid_tt` / `sid_guard`。  
`ttwid` / `odin_tt` 是抖音打开页面就下发的设备与风控标识，**不是登录标志**——用它们判定会导致页面一加载就误判成功。这是 Python 脚本已经踩过的坑，换框架后依然存在。

**为什么用非持久 partition**：若持久化和复用，窗口里可能残留上次的 `sessionid`，一打开就"已登录"，用户根本没扫码。同时这也是登录窗口与主窗口 Cookie 隔离的保证。

**没有二维码截图环节**：用户直接在窗口里看官方渲染的二维码，官方页面自己会刷新二维码，所以我们不需要处理过期、不需要定位 `<img>`、不需要 base64 回传。原方案的 L4/L5/L6/L10 四个功能点直接消失。

### 7.2 解析：两条路径（决策：MVP 走路径 B）

从链接拿到视频详情，有两条技术路线，**产出完全一样**，区别在于**要不要让浏览器真的去加载一遍页面**。

**路径 A —— 隐藏窗口 + `executeJavaScript`**

复用登录时那个 session，开一个 `show: false` 的窗口加载视频页。浏览器会把页面的 JS 全部执行一遍，页面内存里就有了 `window._ROUTER_DATA` 这个对象，直接取出来：

```ts
const data = await win.webContents.executeJavaScript('window._ROUTER_DATA', true)
```

- 好处：拿到就是现成对象，不用碰 HTML 字符串，绕开抖音三种数据形态（裸对象 / `JSON.parse("...")` 双重转义 / `<script id="RENDER_DATA">`）；天然带登录态。
- 代价：慢（要等整个 SPA 渲染完，通常 2-5 秒）、占内存、失败时难诊断（页面卡住或跳风控，你看不出来）。

**路径 B —— 主进程 HTTP 正则解析（现行 Python 脚本的做法）**

`net.fetch` 把视频页 HTML 当作**纯文本**拉下来，浏览器完全不参与；再用正则从文本里抠出 `_ROUTER_DATA` 的片段，按三种形态还原后 `JSON.parse`；三种都失败则降级到详情 API `aweme/v1/web/aweme/detail/`。

- 好处：快、行为确定、易于重试、失败信息清晰；**这套逻辑已在 `python/inspect_qualities.py` 里真实跑通过**，是目前唯一被验证的路径。
- 代价：抖音若改版嵌入格式，需要跟着改正则——但已有详情 API 兜底，风险可控。

**决策：MVP 只实现路径 B，路径 A 本期不做。**

1. 路径 B 是唯一经过真实验证的实现，照着移植就能用；
2. 路径 A 会带回一个不确定环节——SPA 是异步渲染的，"页面什么时候算加载完"只能靠定时轮询去试探。这恰恰是 Wails 方案里「固定等 10s 再截二维码」那种脆弱做法的翻版，**为了绕开几个正则而把它请回来，不划算**；
3. 路径 A 也没解决真正的风险点——解析失败的真正原因是风控和接口变更，这两条路径都躲不掉。

**什么时候才需要补路径 A**：上线后如果发现解析频繁失败，且确认是"路径 B 拿不到数据"而不是风控所致，再把它作为降级手段加上。届时它是增强，不是返工。

### 7.3 画质探测

- 关键字段是 `video.play_addr.uri`（video_id），调用移动端播放接口：  
  `https://aweme.snssdk.com/aweme/v1/play/?video_id={uri}&ratio={r}&line=0&aid=6383`
- **必须带移动端 UA**，否则被 302 跳到普通网页拿不到源片
- 用 `redirect: 'manual'` 拿 302 的 `Location`（源片直链），或解析 200 响应里的 `play_addr.url_list[0]`
- `ratio=default` 即源片（最高画质），其余为转码副本
- `Promise.all` 并发探测 7 个档位 + 并发实测体积，耗时从串行的数秒降到数百毫秒

### 7.4 两种 UA 的分工（容易搞混）

| 用途                 | UA           | 说明                            |
| ------------------ | ------------ | ----------------------------- |
| 抓视频页 HTML / 详情 API | 桌面 Chrome UA | 与登录窗口 UA 保持一致，避免同会话两个 UA 被判异常 |
| 播放接口探测 / CDN 下载    | 移动端 UA       | 拿高画质的前提，缺了会被 302 跳到网页         |

主进程的请求 UA 与浏览器窗口 UA 是两回事，各自独立设置。这套分工已在 Python 脚本里验证有效，照搬即可。

### 7.5 下载


- 对已签名 CDN 直链发全量 GET，`net.fetch` 拿 `ReadableStream`，`Readable.fromWeb()` 转 Node 流后 1MB 分块写盘
- 进度按真实 `Content-Length` 计算，事件节流 ~200ms 推给前端（不节流会把渲染进程刷爆）
- 取消用 `AbortController` + `fs.unlink` 删半成品
- 文件名：`作者 - 去#话题后的标题.mp4`，非法字符替换、空白压缩、限长 120

### 7.6 Cookie 文件格式

与现有 `python/cookie.txt` **完全一致**（`name=value; name=value`）。好处是 App 导出的 cookie 可以直接喂给 `python/inspect_qualities.py --cookie-file`，反之亦然，两条路互为备份。

> Python 脚本已归档到 `python/` 目录，作为 CLI 兜底保留，不再随 App 打包分发。App 上线后可移除其中的 `playwright` 依赖（登录已由 App 接管，脚本退回纯标准库）。

---

## 八、已知坑与对策

| 坑                          | 对策                                           |
| -------------------------- | -------------------------------------------- |
| 默认 UA 含 `Electron/xx` 被识别  | `session.setUserAgent` 覆盖成正常 Chrome          |
| `ttwid`/`odin_tt` 误判登录     | 只认 `sessionid` 系列字段                          |
| 复用 session 导致"假登录"         | 登录窗口强制非持久 partition                          |
| 渲染进程 CORS                  | 所有网络请求走主进程 `net.fetch`                       |
| 抖音页面跳到外部站点                 | 导航白名单 + `shell.openExternal`                 |
| `_ROUTER_DATA` 三种形态 + 双重解析 | 按 Python 脚本的正则逻辑 1:1 移植；失败降级详情 API（见 §7.2 决策） |
| 接口拿不到 2K/4K                | 移动端 UA + `ratio=default`；有无取决于上传原片           |
| CDN 直链签名有时效                | 探测与下载连续完成，不跨会话缓存 URL                         |
| 频繁请求触发滑块/风控                | 请求限速、复用 Cookie、UA 保持一致；错误提示可读化               |
| 进度事件刷爆渲染进程                 | IPC 节流 ~200ms                                |
| macOS 未签名被 Gatekeeper 拦截   | 自用 ad-hoc 签名 + 右键"打开"；正式分发需开发者账号公证           |
| Windows 未签名 exe 被 SmartScreen 拦截 | 首次运行点「更多信息 → 仍要运行」；正式分发需 OV/EV 代码签名证书     |
| **Windows 文件名非法导致写盘失败**      | 见下方专门一节，这是双平台最容易漏的一处                        |

### Windows 文件名规则（双平台最容易踩的坑）

抖音标题常带 emoji、全角符号、竖线、问号，现有 Python 脚本的清洗规则只替换了 `\ / : * ? " < > |` 和控制字符，**这套规则在 macOS 上够用，在 Windows 上不够**。Windows 额外禁止：

1. **保留设备名**：`CON`、`PRN`、`AUX`、`NUL`、`COM1`~`COM9`、`LPT1`~`LPT9`。**带扩展名也不行**——`CON.mp4`、`NUL.txt` 都会被系统拒绝。标题正好是这些词的概率极低，但作者名/标题组合后有可能撞上。
2. **结尾不能是空格或点**：现有规则已经 `strip(" ._-")`，这一条已覆盖。
3. **全角符号**：`？`、`｜`、`＊` 等在 Windows 上是**合法**的，不需要处理，别过度清洗反而破坏标题可读性。
4. **长度限制**：Windows 完整路径上限 260 字符（`MAX_PATH`）。现有规则限文件名 120 字符，加上下载目录通常安全；但若用户把下载目录设在深层嵌套路径下仍有风险，建议**落盘前校验完整路径长度，超限时截断文件名**。

**处理策略**：`naming.ts` 里做一个 `isWindows` 分支，命中保留设备名时加下划线后缀（如 `CON_1.mp4`），并统一校验完整路径长度。不要试图用一套"最小公倍数"规则硬扛两边——macOS 上把标题洗得太干净，用户反而不满意。

> 顺带一提：emoji 文件名在 Windows 上合法且能正常显示，无需处理。

---

## 九、外部依赖

| 依赖                       | 必需性        | 说明                    |
| ------------------------ | ---------- | --------------------- |
| Node ≥ 20                | 构建期必需      | 运行时由 Electron 自带      |
| Electron 44.x            | 必需         | 自带 Chromium，无需额外下载浏览器 |
| electron-vite 5.x        | 必需         | 构建                    |
| electron-builder 26.x    | 必需         | 打包 dmg / NSIS         |
| React 19 + Vite          | 可选         | 若走原生 TS 则不需要          |
| Xcode Command Line Tools | macOS 打包需要 | 打 dmg 必需               |
| Windows 构建环境            | 打正式包时需要    | 本机 mac 可交叉出测试包；正式包建议 GitHub Actions（详见 §3 平台策略） |

对比 Wails 方案：不需要 Go、不需要 Wails CLI、不需要 go-rod、不需要额外下载 Chromium、不需要 Python/Playwright。

---

## 十、里程碑

| 阶段     | 内容                                                         | 产出         |
| ------ | ---------------------------------------------------------- | ---------- |
| **M0** | **可行性验证（半天，先做这个）**                                         | 见下方验证清单    |
| M1     | Electron 骨架 + 主进程解析链路（先读现有 `cookie.txt`，不做登录）+ 视频信息卡 + 画质表 | 能输入链接看到画质表 |
| M2     | 单档下载 + 进度条 + 自动命名 + 打开文件夹                                  | 能真正下文件     |
| M3     | 登录窗口 + Cookie 轮询 + 持久化                                     | 完整链路打通     |
| M4     | 设置页、错误处理、图标、打包 macOS `.dmg`                       | 可自用分发（Mac）   |
| M5     | Windows 适配：文件名规则、路径、NSIS 打包                       | 可自用分发（Win）   |

M5 不是"最后再补 Windows"，而是**从 M1 写代码起就要带着平台约束**（见 §3 平台策略的三条代码约束）；M5 阶段专门做的是打包验证与文件名规则落地。

### M0 验证清单（半天，决定要不要继续）

先做一个空壳 Electron，只验证这四件事：

1. 登录窗口能正常打开 `https://www.douyin.com/`，二维码正常渲染，**没有滑块/风控拦截**；
2. 扫码后主进程 `session.cookies.get()` 能拿到 `sessionid` —— 验证 HttpOnly 可读性，这是整个方案的地基；
3. 把拿到的 cookie 字符串存成 `cookie.txt`，用**现有 Python 脚本**跑一次解析+下载，确认格式兼容、能拿到源片；
4. 观察登录窗口里是否有异常跳转或报错。

**退路**：若第 1 条不通过（Electron 环境被风控），降级为「引导用户在系统浏览器登录 + 手动粘贴 Cookie」（L11 手动导入功能），或回退到已验证的 Playwright 方案。第 2 条不通过的概率极低（这是 Electron 原生能力）。

---

## 十一、已确认选型（2026-09-26 拍板）

| 项        | 结论                                                        |
| -------- | --------------------------------------------------------- |
| 前端框架     | **React + TypeScript**（表格、进度条、状态管理写着舒服）                   |
| 目标平台     | **macOS 开发 + 日常，Windows 常用**，双平台都要能用 → 见 §3 平台策略、§8 Windows 文件名 |
| 登录窗口形态   | **内嵌 WebContentsView**（2026-09-26 用户改决策：不再开独立窗口，盖在主窗口解析页上方，顶部留 topbar 可取消，登录成功自动退回解析页） |
| Python 脚本 | **已归档到 `python/` 目录**，作 CLI 兜底保留，不随 App 打包；App 上线后可移除 playwright 依赖 |
| 解析路径     | **路径 B（HTTP 正则）**，路径 A 本期不做 → 理由见 §7.2                    |

**仍需实测后确认的**（都不阻塞 M1 开工）：

1. 抖音视频标题里的 emoji 与全角符号，在 Windows 上实际写盘表现如何——预期无问题，M5 阶段实测。
2. Windows 上 Electron 是否同样不触发风控——M0 在 Mac 上验证后，建议在 Windows 上复验一次。

---

## 十二、遗留问题

- 原 Go + Wails 方案文档（`docs/desktop-app-design.md`）保留作为对照，**不再执行**。
- `docs/desktop-app-design.md` 第十一节第 1 条「二维码 `<img>` 匹配特征」这个待确认项，随方案切换而作废——Electron 方案不需要截二维码。
