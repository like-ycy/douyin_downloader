# 抖音下载器桌面 App 方案（Go + Wails）

> 目标：把现有 `inspect_qualities.py` 的能力做成带界面的桌面应用，覆盖**扫码登录 → 输入链接 → 解析 → 选画质 → 下载**的完整链路。
> 状态：待审核，未开工。

---

## 一、范围界定

**本期做**
1. 扫码登录（二维码截图展示 + Cookie 自动捕获）
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
  │               ├─ Go 后台：无头 Chromium 打开抖音官方登录页
  │               ├─ 等待 10s（登录页 SPA 异步渲染，过早取会拿到空白）
  │               ├─ 定位二维码 <img>（匹配方式待补，见第十一节）
  │               ├─ 元素截图 → base64 → 事件推给前端
  │               ├─ 前端展示二维码 + 「等待扫码…」
  │               ├─ Go 后台每 2s 轮询 Cookie
  │               └─ 命中真实登录字段 → 事件通知前端 → 提示「登录成功」
  │
  └─ 已登录 ──► 顶部显示登录状态条 + 「退出登录」
                  │
                  ├─ 搜索框输入视频链接 → 点「解析」
                  ├─ 展示视频信息卡（封面 / 作者 / 标题 / 时长 / 发布时间 / 互动数据）
                  ├─ 画质表格：档位 | 分辨率 | 实测大小 | [下载按钮]
                  └─ 点某档「下载」→ 该行变进度条 → 完成提示「打开文件夹」
```

---

## 三、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面框架 | **Wails v2.14.0** | 稳定版。v3 仍在 beta（`v3.0.0-beta.8`），不采用 |
| 后端语言 | **Go ≥ 1.21** | 全部网络请求、解析、下载逻辑 |
| 前端 | React 18 + TypeScript + Vite（Wails 官方模板） | 备选：原生 TS（更轻但画质表/进度手写 DOM 偏啰嗦） |
| CDP 控制 | **go-rod**（`github.com/go-rod/rod`） | 自带 launcher，能自动寻找系统 Chrome/Edge，缺失时自动下载 Chromium |
| Cookie 存储 | 本地文件 `os.UserConfigDir()`，权限 0600 | 后期可换 `go-keyring` 存系统钥匙串 |
| 数据库 | 无（本期不存历史） | — |
| 图标/打包 | Wails 自带 `build/appicon.png` + `wails build` | macOS 出 `.app` |

**为什么登录必须走 CDP 而不是 Wails 自己的 WebView**：登录态 Cookie（如 `sessionid`）是 `HttpOnly`，前端 `document.cookie` 读不到；而 Wails 未暴露 WKWebView / WebView2 的 Cookie 读取接口。CDP 的 `Network.getCookies` 能拿到全部 Cookie，包括 HttpOnly 的。

---

## 四、功能点清单

### 4.1 登录模块

| 编号 | 功能点 | 说明 |
|---|---|---|
| L1 | 触发登录 | 前端 `StartLogin()`，Go 起后台 goroutine，不阻塞 UI |
| L2 | 打开登录页 | go-rod 启动无头 Chromium（`--headless=new`），导航到 `https://www.douyin.com/` |
| L3 | 触发二维码 | 最佳努力点击「登录 / 扫码登录」按钮，弹出官方二维码 |
| L4 | **10s 等待** | 导航/点击后固定等 10s（可配置）再定位二维码，避开 SPA 异步渲染空窗 |
| L5 | 定位二维码 | 按 `<img>` 标签特征匹配（选择器待补，见第十一节）；找不到则重试若干次 |
| L6 | 元素截图 | 对二维码元素截图 → PNG → base64 dataURL |
| L7 | 推送展示 | 通过 `login:qrcode` 事件推给前端，前端 `<img>` 显示 |
| L8 | Cookie 轮询 | 每 2s 用 CDP 读 Cookie，判定是否命中真实登录字段 |
| L9 | 登录成功 | 命中 → `login:success` 事件 → 前端提示并切到已登录视图 → 关闭浏览器 |
| L10 | 二维码过期 | 记录抓取时间，超过阈值（暂定 180s）自动重截；前端提供「刷新二维码」按钮 |
| L11 | 超时/取消 | 超时（暂定 180s）提示重试；用户可 `CancelLogin()` 随时取消 |
| L12 | Cookie 持久化 | 保存为 `name=value; ...` 字符串到本地文件，启动时自动加载 |
| L13 | 退出登录 | `Logout()` 清除本地 Cookie |

### 4.2 解析模块

| 编号 | 功能点 | 说明 |
|---|---|---|
| P1 | 链接输入 | 支持完整页 `douyin.com/video/{id}/`、短链 `v.douyin.com/xxx/`、带 `aweme_id` 的分享页 |
| P2 | 解析 aweme_id | 跟随重定向后从 URL 正则提取 |
| P3 | 抓详情 | 优先解析页面内嵌 `window._ROUTER_DATA`，失败降级到详情 API |
| P4 | 视频信息卡 | 封面图、作者、标题、时长、发布时间、点赞/评论/分享/收藏/播放、背景音乐 |
| P5 | 画质探测 | 并发探测 `360p/540p/720p/1080p/2k/4k/default`，只保留真正拿得到直链的档位 |
| P6 | 实测体积 | 对每个直链发 `Range: bytes=0-0`，只读响应头取真实总大小 |
| P7 | 排序展示 | 表格按画质从高到低排列，`default`（源片）置顶并标注 |

### 4.3 下载模块

| 编号 | 功能点 | 说明 |
|---|---|---|
| D1 | 单档下载 | 画质表格每行右侧一个「下载」按钮 |
| D2 | 进度展示 | 该行切换为进度条：已下/总量、百分比、速度 |
| D3 | 自动命名 | `作者 - 去#话题后的标题.mp4`，标题为空退回 `douyin_{aweme_id}.mp4` |
| D4 | 防覆盖 | 目标已存在自动加 `_1` / `_2` 后缀 |
| D5 | 选择目录 | `SelectDir()` 用系统目录选择对话框，默认 `~/Downloads` |
| D6 | 完成提示 | 显示最终路径 + 「打开文件夹」按钮 |
| D7 | 取消下载 | 进行中可取消，删除半成品文件 |
| D8 | 错误提示 | 风控/403/网络失败给出可读原因 |

### 4.4 通用

| 编号 | 功能点 | 说明 |
|---|---|---|
| C1 | 登录状态条 | 常驻顶部，显示已登录/未登录 |
| C2 | 加载态 | 解析中、探测中的骨架屏/spinner |
| C3 | 设置页 | 下载目录、默认画质、二维码等待时长、超时时长、手动导入 Cookie（兜底） |
| C4 | 日志 | Go 侧关键步骤落日志文件，便于排查风控问题 |

---

## 五、目录结构

```
douyin-downloader/
├── main.go                      # Wails 入口
├── app.go                       # 暴露给前端的绑定方法
├── internal/
│   ├── auth/
│   │   ├── login.go             # CDP 登录：开页、等 10s、截二维码、轮询 Cookie
│   │   ├── qrcode.go            # 二维码元素定位与截图
│   │   └── store.go             # Cookie 本地读写
│   ├── douyin/
│   │   ├── resolve.go           # 短链 → aweme_id
│   │   ├── parse.go             # _ROUTER_DATA / RENDER_DATA / 详情 API 解析
│   │   ├── probe.go             # ratio 探测 + Range 实测体积
│   │   ├── download.go          # 流式下载 + 进度回调
│   │   └── naming.go            # 文件名清洗、防覆盖
│   └── httpc/
│       └── client.go            # 统一 UA、代理、超时、限速
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── LoginPanel.tsx       # 二维码展示 + 状态
│   │   │   ├── SearchBar.tsx        # 链接输入 + 解析按钮
│   │   │   ├── VideoCard.tsx        # 视频信息
│   │   │   └── QualityTable.tsx     # 画质表 + 每档下载按钮/进度
│   │   └── wailsjs/                 # 自动生成（勿手改）
│   └── package.json
├── build/
│   └── appicon.png
└── wails.json
```

---

## 六、Go ↔ 前端接口

### 6.1 前端调用的 Go 方法（Wails 自动生成 TS 定义）

```go
func (a *App) LoginStatus() LoginState          // 是否已登录、Cookie 来源
func (a *App) StartLogin() error                // 启动登录，异步，结果走事件
func (a *App) CancelLogin() error
func (a *App) RefreshQRCode() error             // 手动刷新二维码
func (a *App) Logout() error

func (a *App) Inspect(link string) (*VideoInfo, error)
func (a *App) Download(req DownloadReq) (string, error)  // 返回 taskID
func (a *App) CancelDownload(taskID string) error

func (a *App) SelectDir() (string, error)
func (a *App) OpenFolder(path string) error
func (a *App) GetConfig() Config
func (a *App) SetConfig(cfg Config) error
```

### 6.2 Go 推给前端的事件

| 事件 | 载荷 | 触发 |
|---|---|---|
| `login:qrcode` | `{ dataURL, capturedAt }` | 拿到/刷新二维码 |
| `login:waiting` | `{ elapsed }` | 等待扫码中的心跳 |
| `login:success` | `{ nickname? }` | 命中真实登录 Cookie |
| `login:failed` | `{ reason }` | 超时/取消/取码失败 |
| `download:progress` | `{ taskID, downloaded, total, speed }` | 下载中（节流 ~200ms） |
| `download:done` | `{ taskID, path }` | 完成 |
| `download:error` | `{ taskID, message }` | 失败 |

### 6.3 主要数据结构

```go
type VideoInfo struct {
    AwemeID   string
    Author    string
    Desc      string
    Duration  int64   // ms
    Cover     string
    CreatedAt int64
    Stats     Stats
    Music     string
    Qualities []Quality
}

type Quality struct {
    Ratio    string  // 360p / 720p / default ...
    Width    int
    Height   int
    Size     int64   // 实测字节数，0 表示未测到
    Playable bool
}

type DownloadReq struct {
    Link string
    Ratio string
    Dir  string
}
```

---

## 七、关键实现细节

### 7.1 登录（核心）

```
1. rod 启动浏览器
   - 默认 --headless=new，静默无窗口
   - 兜底：--window-position=-9999,-9999 的 headful（规避无头风控）
   - 必须使用独立临时 user-data-dir（go-rod 默认行为），禁止复用系统 Chrome profile
2. 导航 https://www.douyin.com/ → 点击「登录 / 扫码登录」
3. sleep 10s（配置项 qrWaitSec，默认 10）
4. 定位二维码 <img> → element.Screenshot() → base64
5. 每 2s 轮询 CDP Network.getCookies（域含 .douyin.com）
6. 命中登录字段 → 保存 Cookie → 发 login:success → 关闭浏览器
```

**登录判定字段（关键）**：只认 `sessionid` / `sessionid_ss` / `sid_tt` / `sid_guard`。
`ttwid` / `odin_tt` 是抖音打开页面就下发的设备与风控标识，**不是登录标志**——用它们判定会导致页面一加载就误判成功。这是现有 Python 脚本踩过的坑。

**必须用独立临时 profile**：若复用系统 Chrome 的用户数据目录，里面可能已有历史 `sessionid`，会立刻误判为"已登录"，用户根本没扫码。独立 profile 同时也避免污染用户自己的浏览器。

**取不到二维码的降级**：元素截图为主；若二维码是 `<img src>` 直链而非 canvas，可退化为直接下载该图片（更清晰）——具体取决于 `<img>` 标签形态，待确认。

### 7.2 解析（1:1 移植现有脚本）

`_ROUTER_DATA` 有三种形态，需按优先级尝试：
1. 裸对象字面量 `_ROUTER_DATA = {...}`
2. `JSON.parse("...")` —— 参数是"JSON 文本的字符串"，必须**双重解析**（先还原 JS 字符串转义，再 `json.Unmarshal`）
3. `<script id="RENDER_DATA">` 内的 URL-encoded JSON

三者都失败 → 降级调用详情 API `aweme/v1/web/aweme/detail/`。

### 7.3 画质探测

- 关键字段是 `video.play_addr.uri`（video_id），调用移动端播放接口：
  `https://aweme.snssdk.com/aweme/v1/play/?video_id={uri}&ratio={r}&line=0&aid=6383`
- **必须带移动端 UA**，否则被 302 跳到普通网页拿不到源片
- `ratio=default` 即源片（最高画质），其余为转码副本
- Go 侧用 `errgroup` 并发探测全部档位 + 并发实测体积，整体耗时从 Python 的串行数秒降到数百毫秒

### 7.4 下载

- 对已签名 CDN 直链发全量 GET，1MB 分块流式写盘
- 进度按真实 `Content-Length` 计算，通过事件节流推送给前端
- 文件名：`作者 - 去#话题后的标题.mp4`，非法字符替换、空白压缩、限长 120

---

## 八、已知坑与对策

| 坑 | 对策 |
|---|---|
| HttpOnly Cookie 拿不到 | CDP `Network.getCookies` |
| `ttwid`/`odin_tt` 误判登录 | 只认 `sessionid` 系列字段 |
| 复用系统 profile 导致假登录 | 强制独立临时 user-data-dir |
| SPA 异步渲染，取码过早得到空白 | 固定等待 10s + 重试 |
| 二维码过期 | 记录抓取时间，超时自动重截 + 手动刷新按钮 |
| 无头模式被风控 | 自动降级到 headful（窗口移出屏幕） |
| `_ROUTER_DATA` 三种形态 + 双重解析 | 见 7.2 |
| 接口拿不到 2K/4K | 移动端 UA + `ratio=default`；源片有无取决于上传原片 |
| 频繁请求触发滑块/风控 | 请求限速、复用 Cookie、UA 保持一致；错误提示可读化 |
| macOS 未签名被 Gatekeeper 拦截 | 自用 ad-hoc 签名 + 右键"打开"；正式分发需开发者账号公证 |

---

## 九、外部依赖

| 依赖 | 必需性 | 说明 |
|---|---|---|
| Go ≥ 1.21 | 必需 | — |
| Node ≥ 18 | 必需 | 前端构建 |
| Wails CLI v2.14.0 | 必需 | `go install github.com/wailsapp/wails/v2/cmd/wails@latest` |
| macOS WKWebView | 必需，系统自带 | Windows 需 WebView2 runtime |
| Chromium（go-rod） | 登录时需要 | 优先用系统 Chrome/Edge，缺失时自动下载 |
| Xcode Command Line Tools | macOS 打包需要 | — |

---

## 十、里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M1 | Wails 骨架 + 前端页面骨架 + 解析链路（先用现有 `cookie.txt`，不做登录） | 能输入链接看到视频信息和画质表 |
| M2 | 单档下载 + 进度条 + 自动命名 + 打开文件夹 | 能真正下文件 |
| M3 | CDP 扫码登录（10s 等待 / 截图 / 展示 / Cookie 轮询） | 完整链路打通 |
| M4 | 设置页、错误处理、图标、打包 `.app` | 可自用分发 |

M1/M2 可以先绕开登录（直接读现有 `cookie.txt`），风险最低，能最快验证 Go 侧逻辑与 Python 结果是否一致。

---

## 十一、待确认

1. **二维码 `<img>` 标签的匹配特征** —— 你提到后续提供，需要：class/id、父容器特征、src 前缀（data: 还是 https）、页面上是 img 还是 canvas。这直接决定 L5 用 CSS selector 还是 XPath。
2. **前端框架** —— 建议 React + TS；若追求极轻量可选原生 TS。
3. **目标平台** —— 仅 macOS，还是 macOS + Windows（后者需处理 WebView2 依赖与安装包）。
4. **二维码过期时长** —— 抖音二维码实际有效期需实测，暂按 180s 自动刷新。
5. **登录成功后是否展示昵称** —— 取决于能否顺带从页面取到用户信息，可选。
