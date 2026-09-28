# Electron 全量包体积优化方案

> 状态：方案评审稿，未修改构建配置或业务代码。
> 
> 目标：在保留当前 Electron 登录方式、Windows 绿色版分发和现有增量更新机制的前提下，降低 `*_win_full.zip` 的下载体积与解压后占用。

## 1. 结论摘要

367MB 的解压体积大概率主要来自 Electron 运行时，而不是本项目的 React/TypeScript 代码：

- 当前 `out/` 只有约 700KB，项目自身资源很少。
- `package.json` 的生产打包只显式包含 `out/**` 和 `package.json`，没有把仓库根目录的 `node_modules` 整体带入发布包。
- Electron 自带 Chromium、Node.js、V8、GPU/音视频组件、`.pak` 资源和 locale；这些文件决定了解压后的基线体积。
- 当前 Windows CI 用 PowerShell `Compress-Archive` 将 `release/win-unpacked` 打成 zip。它主要影响下载体积和打包耗时，不能明显降低解压后的目录体积。

建议按以下顺序推进：

1. **先建立可复现的体积清单**，确认 367MB 是否包含重复架构、调试文件、缓存或错误的目录层级。
2. **优先裁剪 Chromium locale**，通常是收益明确、业务风险较低的构建配置改动；保留中文和英文并做登录/渲染回归。
3. **改进全量 zip 压缩和发布方式**，降低下载体积；同时继续保留现有 `app.asar` 增量包，日常版本尽量不让用户下载全量包。
4. **评估 Electron 版本与运行时替代方案**。升级 Electron 只为减小体积需要实测，不应盲目降级；迁移到系统 WebView 的 Wails/Tauri 属于重构项目，应单独立项。

## 2. 当前基线与需要先确认的事实

### 2.1 已确认的仓库事实

| 项目 | 当前情况 | 对体积的含义 |
| --- | --- | --- |
| Electron | `^44.0.0` | 每个平台/架构都会携带完整 Electron 运行时 |
| electron-builder | `^26.0.0` | 当前使用 `dir` 目标，再由 CI 手工压缩 |
| 业务产物 | `out/` 约 700KB | 不是 367MB 的主要来源 |
| 打包 `files` | `out/**`、`package.json` | 已经避免把仓库源码和开发依赖整体复制到包内 |
| Windows 全量包 | `release/win-unpacked` → PowerShell `Compress-Archive` | 只影响 zip 下载大小，解压后仍是完整运行时 |
| 增量更新 | 只替换 `resources/app.asar` | 业务代码版本不应重复下载 Electron 运行时 |
| 登录实现 | Electron `WebContentsView` 加载抖音页面 | 不能随意移除浏览器能力或把登录改成纯 Node 页面 |

### 2.2 P0：建立可复现体积报告

在 Windows CI 或一台 Windows x64 构建机上，对**未压缩目录、zip 文件、app.asar**分别记录大小。不要只看 Finder/资源管理器显示的一个总数。

建议报告至少包含：

- `release/win-unpacked` 总大小、文件数；
- 一级目录大小：`locales/`、`resources/`、`swiftshader/` 等；
- 最大的 30 个文件及其相对路径；
- `resources/app.asar` 的大小和文件清单；
- zip 的压缩前后大小、压缩工具和参数；
- 构建平台、目标架构、Electron 版本、electron-builder 版本。

PowerShell 示例：

```powershell
$root = Resolve-Path "release/win-unpacked"
Get-ChildItem $root -File -Recurse |
  Sort-Object Length -Descending |
  Select-Object -First 30 Length, FullName

Get-ChildItem $root -Directory |
  ForEach-Object {
    $bytes = (Get-ChildItem $_.FullName -File -Recurse | Measure-Object Length -Sum).Sum
    [pscustomobject]@{ Directory = $_.Name; MiB = [math]::Round($bytes / 1MB, 1) }
  } | Sort-Object MiB -Descending

Get-ChildItem "release/win-unpacked/resources/app.asar" |
  Select-Object Length, FullName
```

验收：同一 commit、同一架构重复构建，两次目录体积差异应能解释；否则先处理构建环境或缓存污染，再谈优化。

## 3. 优化路线与优先级

### P1：裁剪 Electron locale

**做法**：在 electron-builder 配置中增加 `electronLanguages`，只保留应用实际需要的语言，例如 `zh-CN` 与 `en-US`（实际 locale 名称以构建产物中的 `locales/` 文件名为准）。

**原因**：Electron/Chromium 默认会带一批 locale `.pak` 文件；这些文件不会改变 Chromium 核心能力，但会增加目录体积。electron-builder 提供 `electronLanguages` 选项，多个真实项目也使用该配置只保留少数语言。

**注意事项**：

- 先在产物中确认 Electron 44 使用的文件名和应用界面语言策略；不要凭名称猜测并删除文件。
- 至少验证：主窗口渲染、抖音登录页、Cookie 读取、中文字符、系统语言为英文时的启动。
- locale 裁剪只影响语言资源，不能替代对 `.pak`、DLL 或 Chromium 核心文件的裁剪。

**预期**：收益取决于当前 locale 数量，通常是数 MB 到十几 MB；以 P0 报告的 `locales/` 实测为准。

### P1：改用更高压缩级别生成全量 zip

当前 CI 使用 PowerShell `Compress-Archive`。建议在 Windows runner 上比较以下方案：

1. `Compress-Archive` 当前实现，作为基线；
2. 7-Zip `7z a -tzip -mx=9`，生成普通 zip，确保 Windows 用户仍能直接解压；
3. 若分发渠道允许，再比较 `tar.zst`/`7z`，但不要替换绿色版用户默认下载格式。

验收应同时记录：

- 下载文件大小；
- Windows 资源管理器解压是否能得到同样目录；
- 解压耗时；
- 解压后启动、自动更新和目录替换是否正常。

**边界**：压缩级别不会减少解压后体积。它只解决下载量、GitHub Release 存储和网络耗时。

### P1：把“首次安装”和“日常更新”彻底分开

当前仓库已经产出 `*_win_asar.zip` 增量包，这是最有效的日常体感优化：Electron 运行时不变时只下载 `app.asar`。建议继续强化这条策略：

- Full 包只用于首次安装、Electron 版本变更或运行时文件变更。
- 普通业务版本优先发布 asar 增量包，并在发布流程中检查 Electron 版本是否真的未变。
- 更新检查器继续按附件是否存在选择增量/全量；不要为了缩小 full zip 而把运行时拆成用户手动拼装的多个包。
- Full 包和 asar 包都保留 SHA-256 校验；发布前生成体积报告，避免误把调试产物上传为正式包。

这条路线不一定降低 367MB 的解压基线，但能把大多数升级从“下载约 367MB”降到几百 KB 级别。

### P2：严格收窄生产文件匹配规则

当前 `files` 已经只包含 `out/**` 和 `package.json`，应先用构建日志和 `app.asar` 清单确认没有意外文件，再考虑进一步收窄：

- 明确只打包运行时需要的 `out/main/**`、`out/preload/**`、`out/renderer/**`；
- 只保留生产运行所需的 `package.json` 字段；
- 在构建后检查 `app.asar` 是否出现 `.map`、测试夹具、文档、源码或开发配置；
- 不要删除 `package.json`，因为当前 `app.getVersion()` 和 Electron 启动都依赖它；
- 不要把 `node_modules` 过滤规则当作主要优化点：当前构建已经没有生产依赖，收益很可能接近零。

这一步的目标是防止未来依赖或构建规则变化造成回弹，不应在没有清单证据时盲目增加排除 glob。

### P2：评估 Electron 版本和架构策略

Electron 运行时体积由 Chromium 版本、平台和架构决定。建议建立一个小型矩阵，在不改业务代码的分支上比较：

- 当前 Electron 44；
- 一个受项目依赖和安全支持允许的较新版本；
- Windows x64 与项目实际发布的其他架构分别测量。

每个候选版本都要验证：抖音登录页、`WebContentsView`、Cookie、Node `fetch`、视频下载、自动更新和代码签名。不能仅因某版本目录更小就直接升级或降级。

如果用户群明确只使用一种架构，CI 只发布该架构可以避免额外资产，但不会改变单个包解压后的 Electron 基线。不要把 x64/arm64 合并到一个 Windows 包中。

### P3：系统 WebView 或其他桌面壳迁移

Wails/Tauri 等方案可依赖系统 WebView，理论上能显著降低安装包体积，但会带来：

- 登录页在不同 Windows/macOS 系统上的 WebView 版本差异；
- Cookie、UA、导航拦截、下载和自动更新能力重新实现；
- TypeScript/React 与现有 Electron 主进程逻辑的迁移成本；
- Windows 系统组件缺失或版本过旧时的兼容问题。

现有设计文档已经记录过 Go + Wails 方案；这应作为新项目或重大版本的架构评估，不属于本次 full.zip 的低风险优化。

## 4. 不建议直接采用的做法

### 4.1 手工删除任意 `.pak`、DLL 或 Electron 子程序

Chromium 的 `chrome_*.pak`、`resources.pak`、`icudtl.dat`、GPU/音视频 DLL 和辅助进程之间有运行时依赖。删除后可能出现白屏、字体/国际化异常、登录页面加载失败或特定机器崩溃。只有在官方支持、文件清单和多平台回归都明确时才考虑。

### 4.2 只把 `asar` 压缩得更小

`app.asar` 只包含本项目代码和少量元数据，而当前 `out/` 已不足 1MB。继续压缩业务代码不会改变 Chromium 运行时的主要体积。

### 4.3 改成 portable 单文件

`portable` 通常把完整目录封装到单个自解压 exe。它可能方便分发，但启动时需要解压，且不会减少实际占用；当前项目文档也记录过每次启动需要解压约 250MB、耗时数秒，因此不适合作为本项目的体积优化方案。

### 4.4 为减小体积降级 Electron

降级可能带来 Chromium 安全修复缺失、抖音页面兼容性下降和 Node 行为差异。除非有明确的体积收益和完整回归结果，否则不建议。

## 5. 推荐实施顺序

| 阶段 | 工作 | 产出 | 通过标准 |
| --- | --- | --- | --- |
| 0 | 生成目录、zip、asar 体积报告 | 基线表和最大文件清单 | 能解释 367MB 的来源 |
| 1 | 只保留实际使用 locale | 一个实验构建 | 登录、渲染、下载、更新通过；记录节省值 |
| 1 | 比较 `Compress-Archive` 与 7-Zip `-mx=9` | 压缩方式对比表 | 解压兼容，下载体积下降或确认无收益 |
| 1 | 保持 asar 增量发布 | 发布检查项 | 普通业务更新不下载 Electron 运行时 |
| 2 | 收窄文件规则并加产物审计 | 构建后检查脚本/CI 步骤 | `app.asar` 无意外大文件，功能不变 |
| 2 | Electron 版本/架构矩阵 | 版本选择记录 | 安全、兼容、体积均有证据 |
| 3 | Wails/Tauri 预研 | 单独迁移评估 | 只有在能接受重构成本时立项 |

## 6. 建议的验收指标

每次实验都应同时记录以下数字，而不是只报告“zip 变小了”：

- `full.zip` 下载大小；
- 解压后目录大小；
- `locales/`、Electron 核心文件、`resources/app.asar` 各自大小；
- 首次启动耗时和空闲内存（Windows x64）；
- 登录页打开、扫码登录、Cookie 持久化成功率；
- 解析、探测、下载和打开文件夹流程；
- 增量更新和 Electron 版本变化时的全量更新；
- 杀毒软件/SmartScreen、代码签名和 Windows 资源管理器解压结果。

建议把当前 367MB 作为“解压目录基线”，并分别设定目标：

- **短期目标**：通过 locale 和文件审计获得可验证的目录节省；
- **发布体验目标**：普通版本更新优先保持几百 KB 级 asar 下载；
- **中长期目标**：只有在接受架构迁移的前提下，才追求数量级的安装包下降。

## 7. 参考资料

- Electron 官方《Application Packaging》：说明 Electron 分发包含预构建运行时，应用代码可放入 `app.asar`；
  <https://www.electronjs.org/docs/latest/tutorial/application-distribution>
- electron-builder 文件匹配规则：`files` 只控制应用文件，目录匹配会复制其全部内容；
  <https://www.electron.build/file-patterns>
- electron-builder 配置：`electronLanguages` 用于限定 Electron 随包携带的语言资源；
  <https://www.electron.build/configuration/configuration>
- electron-builder 目标选择：`dir`、`zip`、`portable` 的分发语义和取舍；
  <https://www.electron.build/targets>
- Electron Fuses 官方说明：fuses 主要用于安全/运行时特性开关，不应当当作通用体积优化手段；
  <https://www.electronjs.org/docs/latest/tutorial/fuses>
- GitHub 实际配置示例（用于确认社区对 `electronLanguages` 的使用方式）：
  <https://github.com/gitify-app/gitify/blob/main/electron-builder.js>
  <https://github.com/PostHog/posthog/blob/master/products/desktop/apps/code/electron-builder.ts>
  <https://github.com/poooi/poi/blob/master/electron-builder.config.js>

