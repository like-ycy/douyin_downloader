# Windows 绿色版自动更新方案（全量 + 增量）

> 状态：**已实现**（2026-09-26，P0+P1+P2 全部落地，见 `src/main/update/` 与 `release.yml`）。
> 待 Windows 真机实测：运行中 asar rename、全量 bat 整目录替换、中文路径 robocopy。
> 参考实现：`../video_cut/internal/updater/`（Go + Wails，逻辑可 1:1 移植为 TS）。

## 1. 目标与约束

- Windows zip 绿色版：打开软件自动检测新版，可一键更新，**替换启动 exe 所在的整个目录**。
- macOS .app 同样支持（增量优先，全量列 P2）。
- 不引入 electron-updater（不支持 portable/dir 目标）；不建服务器，**直接查 GitHub Releases**。
- *不做限流：每次启动都查，请求失败静默跳过，绝不阻塞或打断正常使用。*
- 下载、解压、更新脚本全部放 `%TEMP%`（`app.getPath('temp')`），用户清垃圾即天然清理。

## 2. 两种更新包

| 包                                              | 内容                                                 | 体积    | 什么时候用                       |
| ---------------------------------------------- | -------------------------------------------------- | ----- | --------------------------- |
| **全量包** `douyin_downloader_<ver>_win_full.zip` | win-unpacked 整目录（保持现 CI 打法，解压出 `win-unpacked/` 一层） | ~90MB | 首次安装分发；**Electron 版本升级**的版本 |
| **增量包** `douyin_downloader_<ver>_win_asar.zip` | 只含 `resources/app.asar` 一个文件（zip 内不带目录层）           | 几百 KB | 日常代码更新（Electron 没升）         |

**CI 规则（release.yml 改动）**：每个 tag 都打全量包；Electron 版本相对上一个 release 没变时，**额外**打增量包。Electron 升了就只发全量包——客户端用"附件存不存在"当信号，不需要任何清单文件。

**为什么增量只有 asar 就够**：本项目零生产依赖，全部业务代码（main/preload/renderer 打包产物 + package.json）都在 `app.asar` 里；Electron 框架本体（exe/dll/locales/pak）日常不变。换 asar 后 `app.getVersion()` 读的就是新 asar 里的 package.json，版本号显示自动正确。

**sha256 校验**：直接用 GitHub API asset 自带的 `digest` 字段（格式 `sha256:xxxx`，video_cut 已验证可用），不需要 sidecar 文件。

## 3. 更新检查（checker）

1. 主进程 `app.whenReady` 后 **3 秒**异步执行（不抢启动）。
2. `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`，解析 `tag_name`、`body`（release notes）、`assets[]`（name/size/digest/browser_download_url）。
3. semver 比较 `tag_name` vs `app.getVersion()`（自写 30 行，strip `v` 前缀，处理 pre-release，逻辑照抄 video_cut `version.go`）。
4. **asset 匹配**（按当前平台）：
   - 命中 `*_win_asar.zip` → 增量更新可用（`type: 'asar'`）
   - 否则命中 `*_win_full.zip` → 全量更新可用（`type: 'full'`）
   - 都没有 → `hasUpdate = false`（有新版但没包时不提示，避免用户点了下载却失败）
5. 结果通过事件 `update:available` 推给渲染层；同时存为 pending，渲染层可随时 `update:getPending` 补拉（防止检查完成早于监听注册）。
6. 设置页保留手动"检查更新"入口，走同一逻辑。

任何一步失败：静默忽略（log 记一行），不打扰用户。

## 4. 增量更新流程（默认路径，几百 KB）

全程**进程内完成，不需要外部脚本**：

```
下载 asar zip → %TEMP%\douyin_downloader_update\<ver>\
  → 解压出 app.asar → 校验 size + digest
  → 渲染层弹"重启以完成更新"（用户确认，不强制）
  → ① fs.rename(resources/app.asar, app.asar.old)   ← 改名让位
  → ② fs.copyFile(新 asar, resources/app.asar)
  → app.relaunch() + app.exit(0)
  → 新版启动 10s 后：发现 app.asar.old 存在 → 删除（清理上一次更新残留）
```

- `resources` 目录定位用 `process.resourcesPath`（Electron 内置，指向 `<exe目录>\resources`，mac 上是 `.app/Contents/Resources`），不要自己拼路径。
- **关键假设（待实测）**：Windows 下运行中的 `app.asar` 能否 rename。大概率可以（Node/Chromium 打开文件默认带 share-delete）；**若 rename 抛 EPERM/EBUSY，自动降级：主进程补下 Release 里的 `*_win_full.zip`，下载解压后回到「待确认」状态，用户再点一次「重启并更新」走全量 bat 流程**（v0.1.3 修复：早期版本降级时误用增量包目录找 win-unpacked，必然报"更新包里没有找到 win-unpacked 目录"）。增量不存在"卡死"风险。
- 一期不做"新 asar 启动失败自动回滚"：`.old` 保留在 resources 下，极端情况用户手动改回即可。启动失败回滚（连续 N 次崩溃换回 .old）列 P2。
- macOS 同一逻辑适用（mac 无文件锁问题，rename 一定成功）。

## 5. 全量更新流程（Electron 升级时，~90MB）

### 5.1 根基认知：文件锁只存在于进程存活期

之前讨论的"exe 改名让位"可以简化掉。Windows 锁定运行中的 exe/dll 是**因为进程开着句柄**；主进程退出（含所有 Electron 子进程退出）后，**整个目录没有任何锁，可以直接删、直接覆盖**。所以全量替换不需要改名腾位置，一个 bat 顺序做完即可。这是 video_cut 方案（单 exe move 互换）到整目录场景的自然推广。

### 5.2 流程

```
下载 full zip → %TEMP%\douyin_downloader_update\<ver>\
  → 解压到 extracted\（内容为 win-unpacked/ 一层）
  → 校验 size + digest
  → 渲染层确认后：
  → 生成 update.bat（放 temp 目录）→ 隐藏启动（DETACHED，CREATE_NO_WINDOW）
  → 主进程 app.exit(0)
  → bat 依次执行：
     1. 等待退出：tasklist 轮询主进程 PID，最多 30s（子进程随主进程一起死，
        个别 GPU 进程可能晚 1-2 秒，robocopy 失败重试兜底）
     2. 备份：move "%APP_DIR%" "%APP_DIR%.bak"          ← 整目录改名留作回滚
     3. 替换：robocopy "%TEMP%\...\extracted\win-unpacked" "%APP_DIR%" /E
        （退出码 0-7 算成功；失败重试 3 次，间隔 2s）
     4. 成功 → start "" "%APP_DIR%\douyin_downloader.exe"
              → rd /s /q "%APP_DIR%.bak"
        失败 → move "%APP_DIR%.bak" "%APP_DIR%" 回滚 → start 旧 exe
     5. rd /s /q temp 下的本次更新目录
```

要点：

- **bat 自己放 %TEMP%**，不在被替换目录里，无自删问题。
- `move` 整目录改名需要同一卷；%TEMP% 和 App 目录可能不同卷——没关系，move 只动 App 目录自己（原地改名 `dir → dir.bak`），跨卷问题不存在。
- 若 `move dir dir.bak` 失败（极少数情况，如目录被资源管理器占用）：跳过备份直接 robocopy /E（不 /MIR，避免误删），失败则提示手动更新。 robocopy 用 /E 不用 /MIR 配合备份方案：备份存在时用 /E 即可（旧目录整个改名走了，新目录是干净的）。
- exe 名固定 `douyin_downloader.exe`（CI 已定英文名），不需要 video_cut 那种"在解压目录里找 exe"的探测，但仍保留一层容错：若解压出多一层目录，按 `extracted\win-unpacked\` 约定找，找不到则报错退出。
- **Windows 路径 260 字符**：App 目录如果放得深，`dir.bak` + robocopy 目标路径要留意；bat 里全部加引号。
- 权限：App 目录在用户盘（桌面/D:\apps）无问题；检测到目录不可写（如被放进 Program Files）时，检查阶段就降级为"提示手动下载"，不进入下载。

### 5.3 macOS 全量（P2）

照搬 video_cut `apply_darwin.go` 的 bash：`setsid` 独立会话 → 等 PID → `mv .app .old` → `mv 新.app` → `xattr -dr com.apple.quarantine` → `open` → 清理。一期 mac 只做增量，全量提示手动下载。

## 6. 临时目录约定

- 根目录：`path.join(app.getPath('temp'), 'douyin_downloader_update')`（跟随系统 TEMP 环境变量，别写死路径）。
- 每次更新用子目录 `<version>-<timestamp>/`，互不干扰。
- **启动时清扫**：删除根目录下所有非本次会话的子目录（处理上次更新中途被杀的残留）。
- 用户手动清 %TEMP% 导致下载中断 → 本次更新失败静默跳过，下次启动重来。不做断点续传（90MB 一次下完，失败了重来）。

## 7. 事件与 IPC（对齐 video_cut）

| 通道                              | 方向    | 内容                                                        |
| ------------------------------- | ----- | --------------------------------------------------------- |
| `update:available`              | 主 → 渲 | UpdateInfo（hasUpdate/version/notes/type/downloadUrl/size） |
| `update:progress`               | 主 → 渲 | {downloaded, total, percent, speed}，节流 200ms              |
| `update:done` / `update:failed` | 主 → 渲 | — / 错误信息                                                  |
| `update:getPending`             | 渲 → 主 | 补拉最近一次检查结果                                                |
| `update:check`                  | 渲 → 主 | 手动检查                                                      |
| `update:download`               | 渲 → 主 | 开始下载（可带 useProxy）                                         |
| `update:apply`                  | 渲 → 主 | 应用更新（确认弹窗后调用）                                             |
| `update:cancelDownload`         | 渲 → 主 | AbortController 取消 + 删半成品                                 |

渲染层新增 `UpdateModal`：检测到新版的提示卡（版本号 + release notes + 下载按钮）、下载进度条、下载完成后的"重启更新"确认按钮。下载中不允许关弹窗丢进度（同 video_cut，可取消）。

国内加速：可选 `useProxy` 给下载 URL 加 `https://ghfast.top/` 前缀（video_cut 同款），默认关。

## 8. 代码模块规划（src/main/update/）

| 文件                    | 职责                                                     | 参考                       |
| --------------------- | ------------------------------------------------------ | ------------------------ |
| `types.ts`（放 shared）  | UpdateInfo / UpdateProgress / UpdateType               | video_cut UpdateInfo     |
| `version.ts`          | 30 行 semver 比较（含 pre-release）                          | version.go               |
| `checker.ts`          | GitHub API 查询 + asset 匹配 + digest 解析                   | updater.go CheckUpdate   |
| `downloader.ts`       | 流式下载 + 进度事件 + 取消 + size/digest 校验                      | updater.go StartDownload |
| `applyAsar.ts`        | 增量：rename/copy/relaunch + 启动后清 .old                    | 新写（无对应物）                 |
| `applyFullWin.ts`     | 全量：bat 生成 + 隐藏 spawn + 退出                              | apply_windows.go（推广为目录级） |
| `applyFullMac.ts`（P2） | bash 脚本                                                | apply_darwin.go          |
| `index.ts`            | Manager：串起 check/download/apply + IPC + 启动接线 + temp 清扫 | app.go 接线部分              |

渲染层：`UpdateModal.tsx` + 相关 types。网络全走主进程（既有约束），下载用 Node 原生 fetch（不碰 net.fetch，既有踩坑约束）。

## 9. CI 改动（release.yml）

win job 在现有 `--win dir` + Compress-Archive 全量 zip 基础上追加：

1. 判断本次 Electron 版本是否与上一 release 相同（`git describe`/读上一 release 的 tag 或直接比对 package.json 历史版本），**相同 → 追打 asar 增量包**：`Compress-Archive release/win-unpacked/resources/app.asar` 单文件。
2. 命名：`douyin_downloader_<ver>_win_full.zip` / `douyin_downloader_<ver>_win_asar.zip`。
3. SHA256SUMS 照旧生成（客户端校验主要靠 API digest，SUMS 作人工核对用）。

## 10. 待实测清单（写码前/写码中验证）

1. **Windows 运行中 `app.asar` 能否 rename**——决定增量走进程内还是降级 bat（都有兜底，不影响架构）。
2. bat 中 `move` 整目录 + `robocopy /E` 在中文路径/带空格路径下的行为（全程引号）。
3. Electron 子进程退出时序：主 exit 后 GPU 进程残留时长，robocopy 重试 3 次是否足够。
4. 真机跑一次完整全量更新（v0.0.x → v0.0.y）：确认替换、重启、.bak 清理全链路。
5. 真机跑一次增量更新：确认换 asar 后版本号、功能正常。

## 11. 一期范围

| 优先级 | 内容                                        |
| --- | ----------------------------------------- |
| P0  | 检查 + 增量下载 + asar 替换（Win/mac）+ UpdateModal |
| P0  | 全量下载 + bat 整目录替换（Win）                     |
| P1  | CI asar 增量包产出；temp 清扫；手动检查入口              |
| P2  | mac 全量 bash；启动失败自动回滚 .old；下载代理选项          |
