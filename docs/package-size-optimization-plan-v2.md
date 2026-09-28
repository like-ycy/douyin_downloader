# Electron 全量包体积优化方案（实测版）

> 本文替代 `docs/package-size-optimization-plan.md`（codex 版）。  
> 所有数字均来自对**真实产物**的解压解剖与重压缩实测：`douyin_downloader_0.1.3_win_full.zip`（GitHub Release v0.1.3）。  
> 状态：**分析与实测已完成，未修改任何构建配置与业务源码。**

## 0. 结论摘要

155.32 MiB 的下载体积里，**150.86 MiB 就是 Electron 官方运行时的原始体积**——本项目产物零冗余。  
把本项目的 zip（用 `zip -9` 重压）和 Electron 官方 `electron-v44.4.5-win32-x64.zip` 对比：

| 包                                                          | 压缩后            |
| ---------------------------------------------------------- | -------------- |
| Electron 官方运行时 zip                                         | 150.86 MiB     |
| 本项目 `win_full.zip` 用 `zip -9` 重压（含 app.asar + 55 个 locale） | **150.36 MiB** |

***本项目打包甚至比官方原始运行时还小 0.5 MiB。****&#x20;所以「找冗余」这条路没有收益，能动的只有两件事：*

1. **locale 裁剪**——解压省 47.7 MiB，下载省 12.6 MiB；
2. **压缩算法**——换 `7z`(LZMA2) 后下载最多再省 41.7 MiB。

实测各组合（同一份解压产物，只换压缩方式与 locale 数量）：

| 方案                                   | 文件名            | 下载体积           | 解压后           | 相对现状                  |
| ------------------------------------ | -------------- | -------------- | ------------- | --------------------- |
| **现状**（Compress-Archive + 55 locale） | `win_full.zip` | 155.32 MiB     | 368.0 MiB     | —                     |
| `zip -9` 全量                          | A.zip          | 150.36 MiB     | 368.0 MiB     | -5.0 MiB              |
| **`zip -9` + 仅 zh-CN**（推荐，零风险）       | B.zip          | **138.31 MiB** | **320.3 MiB** | **-17.0 / -47.7 MiB** |
| `7z` LZMA2 全量                        | C.7z           | 104.05 MiB     | 368.0 MiB     | -51.3 MiB             |
| **`7z` LZMA2 + 仅 zh-CN**（最大收益）       | D2.7z          | **96.45 MiB**  | **320.3 MiB** | **-58.9 / -47.7 MiB** |
| `tar.zstd -19` + 仅 zh-CN             | E.tar.zst      | 107.97 MiB     | 320.3 MiB     | -47.4 MiB             |

**推荐落地顺序：**

- **马上做（零风险、零 src 改动）**：`electronLanguages: [zh-CN, zh_CN, en]` + CI 把 `Compress-Archive` 换成 `7z a -tzip -mx=9` → 下载 -11%，解压 -13%。
- **想再要 42 MiB 就再决策一次**：全量包改发 `.7z`（96.45 MiB）。代价见 §3.3，需要改 `checker.ts` 并确认 Windows 自带 `tar.exe` 能解 7z。
- **其余全部不做**，理由见 §4。

---

## 1. 怎么测的

| 步骤     | 做法                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 取真包    | `gh release download v0.1.3 -R like-ycy/douyin_downloader -p "*_win_full.zip"`                          |
| 解剖     | 解压后逐项统计 `du`/文件大小；用 Python 解析 `app.asar` 头部清单                                                           |
| 逐项压缩贡献 | `zipfile` 读取 A.zip 的 `file_size` / `compress_size`，按文件与目录聚合                                             |
| 压缩对比   | 同一份解压产物分别用 `zip -9`、`7z -t7z -mx=9`、`tar+zstd -19` 重压                                                   |
| 对照基线   | `gh api repos/electron/electron/releases/tags/v44.4.5` 取官方资产体积                                          |
| 配置生效性  | 读 `node_modules/app-builder-lib/out/electron/ElectronFramework.js` 的 `removeUnusedLanguagesIfNeeded` 实现 |

环境：macOS / apple silicon，Electron 44.4.5，electron-builder 26.15.3，7-Zip 26.03。

> 补充证据：本地试跑 `electron-builder --win dir` 时，调用栈明确显示  
> `WinPackager.doPack → ElectronFramework.prepareApplicationStageDirectory → removeUnusedLanguagesIfNeeded`，  
> 证明 `electronLanguages` 在 `--win dir`（绿色版）路径上确实会执行。（该次构建因沙箱文件代理拦截 Electron 解压而中断，不影响上述结论。）

---

## 2. Windows 包体积解剖（真实数据）

`win-unpacked/` 共 **72 个文件，368.0 MiB**（APFS 上 `du` 显示 371 MB）。

### 2.1 逐项体积与压缩贡献

「压缩后」列为标准 deflate -9 下的实际占用，它才决定**下载体积**。

| 项                                                                                           | 原始            | 压缩后            | 说明                                              |
| ------------------------------------------------------------------------------------------- | ------------- | -------------- | ----------------------------------------------- |
| `douyin_downloader.exe`                                                                     | 234.64 MiB    | **101.65 MiB** | 占下载体积 **67.7%**，Electron 主二进制（Chromium+V8 静态链接） |
| `locales/`（55 个 `.pak`）                                                                     | 48.30 MiB     | 12.24 MiB      | 唯一可安全裁剪的整块                                      |
| `resources.pak`                                                                             | 11.86 MiB     | 11.76 MiB      | 内部已是 brotli 压缩，**几乎不可压**，必须保留                   |
| `dxcompiler.dll`                                                                            | 24.55 MiB     | 9.71 MiB       | DirectX Shader Compiler（D3D12/WebGPU 用）         |
| `icudtl.dat`                                                                                | 10.37 MiB     | 4.41 MiB       | ICU 数据，中文文本处理依赖，必须保留                            |
| `LICENSES.chromium.html`                                                                    | 19.52 MiB     | 2.01 MiB       | 合规声明文本，压缩后只占 2 MiB                              |
| `vk_swiftshader.dll`                                                                        | 5.26 MiB      | 2.09 MiB       | 软件 Vulkan 回退                                    |
| `d3dcompiler_47.dll`                                                                        | 4.52 MiB      | 2.05 MiB       | D3D11 着色器编译                                     |
| `ffmpeg.dll`                                                                                | 2.97 MiB      | 1.21 MiB       | 音视频编解码                                          |
| `dxil.dll`                                                                                  | 1.44 MiB      | 0.65 MiB       | 配合 dxcompiler                                   |
| `chrome_200_percent.pak`                                                                    | 1.21 MiB      | 1.16 MiB       | HiDPI 资源                                        |
| `vulkan-1.dll`                                                                              | 0.90 MiB      | 0.34 MiB       | 软件 Vulkan loader                                |
| `resources/app.asar`                                                                        | 0.694 MiB     | ~0.2 MiB       | **本项目全部代码**                                     |
| 其余（`chrome_100_percent.pak` / `*.bin` / `LICENSE.electron.txt` / `vk_swiftshader_icd.json`） | 1.76 MiB      | ~1.0 MiB       |                                                 |
| **合计**                                                                                      | **368.0 MiB** | **150.36 MiB** |                                                 |

### 2.2 三条关键事实

1. **`.exe` 一个文件 = 下载体积的 2/3，且不可优化。** 它就是重命名后的官方 `electron.exe`。  
   任何「瘦身」方案只要不换运行时，天花板就锁死在 ~101 MiB。
2. **`locales/` 是唯一可整块拿掉的东西**：55 个文件、48.30 MiB 原始（占解压体积 13.1%），  
   但**压缩得非常好（压缩后仅 12.24 MiB，**&#x32;5.3%**）**，所以它对「下载体积」的贡献远比看起来小。  
   一句话：**裁剪 locale 主要是省磁盘，不是省下载。**（codex 案把这两件事混在一起说了。）
3. **`resources.pak` 压缩率 99%（11.86→11.76）**——说明它内部已是压缩载荷。想「再压一压」是白费力气。

### 2.3 `app.asar` 清单（证明无冗余）

```
0.694 MiB  app.asar
  46455 B  /out/main/index.js
   2107 B  /out/preload/index.js
 668702 B  /out/renderer/assets/index-*.js
   8156 B  /out/renderer/assets/index-*.css
    501 B  /out/renderer/index.html
    190 B  /package.json
```

没有 `.map`、没有 `node_modules`、没有测试夹具、没有文档、**连 `out/.DS_Store` 都被 electron-builder 默认过滤掉了**。  
`files: [out/**, package.json]` 这条规则已经是最优形态，**没有任何收窄空间**。

### 2.4 Electron 各版本运行时体积（官方资产实测）

| Electron       | `electron-v*-win32-x64.zip` |
| -------------- | --------------------------- |
| 36.9.5         | 116.0 MiB                   |
| 37.10.3        | 127.6 MiB                   |
| 38.7.2         | 130.1 MiB                   |
| 39.8.3         | 130.3 MiB                   |
| 40.6.0         | 131.6 MiB                   |
| 41.4.0         | 136.1 MiB                   |
| 42.3.0         | 137.7 MiB                   |
| 43.2.0         | 137.6 MiB                   |
| **44.4.5（当前）** | **150.9 MiB**               |

**Electron 44 相比 43 一次性胖了 13.3 MiB。** 这条数据有用，但用法是「**升级前先看一眼体积**」，  
不是「为了省 13 MiB 降级」——见 §4.6。

---

## 3. 值得做的优化

### 3.1 【P0，零风险】locale 只留 zh-CN

**为什么安全**：`locales/*.pak` 只提供 **Chromium/Electron 浏览器外壳自己的界面字符串**（右键菜单、内置错误页等）。  
本项目 UI 是自研 React（全中文），源码里没有任何 `app.getLocale()` / i18n 调用；抖音登录页的文案与字体来自网页自身，与 `.pak` 无关。  
右键菜单也已在 v0.0.2 移除。**裁剪它不影响登录、渲染、下载任何一条链路。**

**改一处即可**，`electron-builder.yml` 顶层加：

```yaml
electronLanguages:
  - zh-CN   # Windows: locales/zh-CN.pak
  - zh_CN   # macOS: zh_CN.lproj —— mac 用下划线命名，漏了就会把中文资源一起删掉
  - en      # macOS 保留 en.lproj 作英文系统兜底；Windows 无 en.pak，不产生额外文件
```

> **⚠️ 这是本方案里唯一一个真坑，务必留意：**  
> electron-builder 的语言匹配是**把文件名里的语言段原样小写后精确比对**（源码 `ElectronFramework.js:81-88`）：  
> Windows 是 `zh-CN.pak` → 记作 `zh-cn`；macOS 是 `zh_CN.lproj` → 记作 `zh_cn`。  
> **横杠和下划线不互通**。所以只写 `zh-CN` 在 mac 上匹配不到任何目录，会触发  
> `no locales found matching wanted languages, skipping cleanup` 警告并**原地不动**（不报错、静默失效）；  
> 若写成只匹配到一半，就会出现「中文资源被删、其它语言保留」的反效果。  
> 两个写法都写上最稳。（另注：`en` 在 Windows 上不匹配 `en-US.pak`，是有意为之，不会多留文件。）

**实测收益**：解压 **368.0 → 320.3 MiB（-47.7 MiB，-13.0%）**；zip 下载 **150.36 → 138.31 MiB（-12.05 MiB）**。  
mac 侧同样生效：`Frameworks` 下有 220 个 `.lproj`（48.8 MiB），裁剪后留下 `zh_CN` + `en` 约 1.1 MiB。  
（mac 的 `.app.tar.gz` 因此也会小一截，未单独实测，量级与 win 一致。）

### 3.2 【P1，零风险】把 `Compress-Archive` 换成 7-Zip 的 `-tzip -mx=9`

**现状问题**：`Compress-Archive` 的 deflate 级别偏低。同一份内容：

| 压缩工具                  | 结果                                 |
| --------------------- | ---------------------------------- |
| 现状 `Compress-Archive` | 155.32 MiB                         |
| `zip -9`              | 150.36 MiB                         |
| `7z a -tzip -mx=9`    | 同 `zip -9` 量级（标准 zip，资源管理器可直接双击解压） |

**白丢 5 MiB，免费拿回。** GitHub 的 `windows-2022` runner **预装 7-Zip 26.03**（已核实官方镜像清单），  
且产物仍是标准 zip，用户侧、更新器侧、`extractArchive`（走 `tar -xf`）**全部无需改动**。

`release.yml` 的 `Package full zip` 步骤改成（注意 `Push-Location release` 是为了保持和现在一样的  
`win-unpacked/` 顶层结构，别让更新器的目录探测逻辑失效）：

```yaml
      - name: Package full zip (7z -tzip -mx=9)
        shell: pwsh
        run: |
          $VERSION = (Get-Content package.json | ConvertFrom-Json).version
          if (-not (Test-Path "release/win-unpacked/douyin_downloader.exe")) { throw "missing win-unpacked exe" }
          $sevenZip = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
          if (-not (Test-Path $sevenZip)) { $sevenZip = "7z" }
          Push-Location release
          & $sevenZip a -tzip -mx=9 -mmt=on "..\douyin_downloader_${VERSION}_win_full.zip" win-unpacked
          Pop-Location
          if (-not (Test-Path "douyin_downloader_${VERSION}_win_full.zip")) { throw "failed to create zip" }
```

### 3.3 【P2，收益最大但需决策】全量包改 `.7z`（LZMA2）

`7z -t7z -mx=9` 用 LZMA2 + 固实压缩，是唯一能啃动那 234 MiB `.exe` 的手段：  
exe 的 deflate 成绩是 101.65 MiB，LZMA2 把它压到明显更低，整体 **150.36 → 104.05 MiB**；  
再叠加 locale 裁剪，最终 **96.45 MiB（相对现状 -58.9 MiB，-37.9%）**。

已校验 D2.7z 是**完整包**：21 个条目，exe / 全部 dll / 全部 pak / `resources/app.asar` / `LICENSES.chromium.html` 都在，只少了 54 个没用的 locale。

**代价（必须一次性想清楚）：**

| 问题               | 说明                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------ |
| 用户解压门槛           | Windows 11（23H2+）资源管理器原生支持 7z；**Windows 10 需要装 7-Zip**。这是最大摩擦点。                      |
| 更新器要改代码          | `checker.ts` 有两处硬编码 `_win_full.zip`（:50 和 :67），`extract.ts` 用 `tar -xf`。             |
| `tar -xf` 能否解 7z | Windows 自带 `tar.exe` 基于 libarchive，理论上支持 7z 读取，**但我没有 Windows 环境，未验证**。见 §5 的一行命令自测。 |
| 过渡期              | 老客户端降级路径依赖 `_win_full.zip` 存在，**不能立刻停发 zip**。                                        |
| 备选形态             | 7z SFX（自解压单 exe，用户双击即解）可绕开「装 7-Zip」问题，但签名/杀软信誉风险更高。                                  |

**建议的中庸做法**：主推 `_win_full.zip`（3.1+3.2 后的 138.31 MiB）不动，  
**额外**发布一个 `_win_full.7z`（96.45 MiB）并在 README 注明「网络慢的可以下 7z 版，需 7-Zip」。  
零风险、零代码改动、不动现有更新链路，谁想省 42 MiB 谁自己选。

---

## 4. 明确不做 / 属于伪命题的项

### 4.1 codex 方案逐条对照

| codex 条目                                      | 判定                 | 实测依据                                                                                                                 |
| --------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| P0 建立体积基线报告                                   | ✅ **对，且必要**        | 本方案 §2 就是它，codex 只给了方法没给结果                                                                                           |
| P1 裁剪 locale                                  | ✅ **对**            | 但收益描述要修正：**下载省 12.6 MiB、解压省 47.7 MiB**，不是含糊的「数 MB 到十几 MB」；且有 mac 下划线命名坑（codex 未提）                                    |
| P1 比 `Compress-Archive` 与 7-Zip `-tzip -mx=9` | ⚠️ **方向对，收益被高估**   | 实测只省 **5 MiB（3%）**，属于「顺手做」而非 P1 重点                                                                                   |
| P1 「首次安装与日常更新彻底分开」                            | ❌ **无效——这已是现状**    | 仓库早已产出 `_win_asar.zip`（v0.1.3 实测 136936 B ≈ 134 KiB），CI 也已按 Electron 版本是否变化决定是否产出。codex 自己在文中都承认了，等于写了一段「请继续做你正在做的事」 |
| P2 「严格收窄生产文件匹配规则」                             | ❌ **零收益**          | 实测 `app.asar` 仅 **0.694 MiB**，且已无 `.map`/`.DS_Store`/node_modules/源码。`files: [out/**, package.json]` 已是地板，没有可收窄空间    |
| P2 「Electron 版本/架构矩阵」                         | ⚠️ **数据有用，结论要反过来** | 44 比 43 胖 **13.3 MiB**（§2.4）。正确用法是「升级前先量体积」，不是「为体积降级」或「建矩阵慢慢选」                                                       |
| P3 Wails / Tauri 迁移                           | ❌ **不属于体积优化**      | 那是重写项目（换运行时、重做登录态/UA/cookie/更新器），应单独立项评估，混在「full.zip 优化」里是范畴错误                                                       |
| §4.1 不手工删 `.pak`/DLL                          | ✅ 对                | 与 §4.2/§4.4 一致                                                                                                       |
| §4.2 「只把 asar 压更小」                            | ⚠️ 对但重复            | 与「文件规则零收益」是同一件事，说两遍                                                                                                  |
| §4.3 不改 portable 单文件                          | ✅ 对                | 每次启动解压，体验差                                                                                                           |
| §4.4 不为体积降级 Electron                          | ✅ 对                | 与我的结论一致（§2.4、§4.6）                                                                                                   |

**一句话**：codex 的 P0 和 locale 两条是对的（也就是你自己判断的那两条），  
其余 5 条里 **2 条是现状/零收益、1 条收益高估、1 条结论方向反了、1 条范畴错误**。  
它真正**漏掉**的是：压缩算法才是最大杠杆（LZMA2 一项 46 MiB），以及 locale 的收益主要在磁盘而非下载。

### 4.2 删 `dxcompiler.dll` + `dxil.dll`（压缩后 10.36 MiB）

24.55 MiB 原始体积看着很诱人，但 Electron 44 的 GPU 光栅化在 Windows 上会走 D3D12/Dawn 路径，  
这两个 DLL 是 HLSL→DXIL 的编译器。删掉可能退化为软件渲染（卡）甚至白屏。  
**收益 10 MiB、风险不确定、且没有 Windows 环境回归**——按「不为 7% 的体积赌稳定性」原则不做。  
（真想试：§5 有零成本试法。）

### 4.3 删 `vk_swiftshader.dll` + `vulkan-1.dll`（压缩后 2.43 MiB）

软件 Vulkan 回退，只在无 GPU 环境被加载。收益 2.4 MiB，不值得。**不做。**

### 4.4 删 `LICENSES.chromium.html`（原始 19.52 MiB，压缩后 2.01 MiB）

解压看着省 19.5 MiB 很香，但它：  
① 压缩后**只占 2.01 MiB**——对下载体积几乎没意义；  
② 是 Chromium 的**开源许可声明，分发时应随附**。  
**不做。**（对比一下：locale 原始 48.30 MiB / 压缩 12.24 MiB，同样「大而无害」但合法可删——这才是正确的裁剪目标。）

### 4.5 删 `resources.pak` / `icudtl.dat` / `chrome_*_percent.pak` / `*.bin`

`icudtl.dat` 是 ICU 数据（中文文本/编码处理依赖），`resources.pak` 是 Blink/WebUI 资源，  
`chrome_200_percent.pak` 是 200% 缩放屏必需的图标资源，`v8_context_snapshot.bin` / `snapshot_blob.bin` 是 V8 快照。  
全部**必须保留**。且 `resources.pak` 压缩率 99%，删了收益也有限。**不做。**


### 4.6 为减小体积降级 Electron

44 → 43 省 13.3 MiB，44 → 41 省 14.8 MiB。但代价是丢掉 Chromium 安全补丁，
并且要重新回归登录/UA/cookie/Node fetch/自动更新/签名全链路。**13 MiB ≈ 下载量 8.5%，不值得。**
正确做法写进流程：**下次升级 Electron 前，先查官方资产体积（§6.4 一行命令），异常增量时再决定要不要跟。**

### 4.7 UPX 压缩 `.exe`

能把 exe 压小，但会：触发杀软误报（对国内分发是致命伤）、拖慢冷启动、破坏签名。
**不做。**

### 4.8 改用 `tar.zst` / 其它格式

实测 `tar.zst -19` = 107.97 MiB，比 7z 差，且 Windows 侧解压门槛更高（Win11 才行，Win10 完全不行）。
**不做。** 要换格式就换 7z（§3.3）。

---

## 5. Windows 侧零成本验证清单（不需要开发环境）

以下都可以在一台普通 Windows 上、**不装任何开发工具**完成：

**① 验证 locale 裁剪没副作用（最快，5 分钟）**
把现有解压目录里 `locales\` 下除了 `zh-CN.pak` 之外的文件**全部临时挪到别处**（不要删），
然后双击 `douyin_downloader.exe`，跑一遍：打开登录窗 → 扫码 → 解析一个视频 → 选画质 → 下载 → 打开文件夹。
全通过就说明 §3.1 可放心落地。

**② 验证 `tar.exe` 能不能解 `.7z`（决定 §3.3 走不走得通）**
装一个 7-Zip 造个测试档：`7z a -t7z t.7z <任意文件夹>`，
然后开 `cmd`，把 `t.7z` 拖进去换成路径，执行：

```cmd
tar -xf t.7z -C %TEMP%\t7ztest
```

能正常解出内容 → 说明 §3.3 只需改 `checker.ts` 的资产名后缀，解压层不用动；
报错 → §3.3 必须额外引入 7z 解压能力，成本上升，建议退回「zip 主推 + 7z 附加」的中庸做法。

**③ 验证激进裁剪（可选，20 分钟）**
在解压目录里把 `dxcompiler.dll`、`dxil.dll` 两个文件**改名**（加 `.bak`），再跑一遍 ① 的全流程，
重点看画面是否正常、有无白屏、进度是否明显变卡。没异常再谈要不要裁。

---

## 6. 附录：可复现命令

### 6.1 下载并解剖真实产物

```bash
mkdir -p /tmp/dy-sizeprobe && cd /tmp/dy-sizeprobe
gh release download v0.1.3 -R like-ycy/douyin_downloader -p "*_win_full.zip" -D .
unzip -q douyin_downloader_0.1.3_win_full.zip -d extracted
cd extracted/win-unpacked
du -sh .                                   # 解压总体积
for f in *; do echo "$(du -sk "$f" | cut -f1) $f"; done | sort -rn   # 逐项体积
ls -l locales | awk 'NR>1{print $5, $9}' | sort -rn                  # 每个 locale
```

### 6.2 逐项压缩贡献（决定下载体积）

```bash
zip -q -9 -r /tmp/A.zip extracted/win-unpacked
python3 - <<'PY'
import zipfile
z = zipfile.ZipFile('/tmp/A.zip')
for i in sorted(z.infolist(), key=lambda x:-x.compress_size)[:15]:
    print(f"{i.compress_size/1048576:8.2f} MiB  ({i.file_size/1048576:8.2f} 原始)  {i.filename}")
PY
```

### 6.3 压缩方案对比

```bash
cd /tmp/dy-sizeprobe
zip -q -9 -r A.zip extracted/win-unpacked                      # 150.36 MiB
7z a -t7z -mx=9 -mmt=on C.7z extracted/win-unpacked            # 104.05 MiB

# 只留 zh-CN
zip -q -9 -r B.zip extracted/win-unpacked -x "extracted/win-unpacked/locales/*"
zip -q -9 -j B.zip extracted/win-unpacked/locales/zh-CN.pak    # 138.31 MiB
7z a -t7z -mx=9 -mmt=on -xr'!*/locales/*' D2.7z extracted/win-unpacked
7z a -t7z -mx=9 -mmt=on D2.7z extracted/win-unpacked/locales/zh-CN.pak   # 96.45 MiB
```

> 注意：7-Zip 的排除语法要写 `-xr'!*/locales/*'`，只写 `-xr'!locales/*'` **不会生效**（它按完整路径匹配），
> 结果是静默产出一个未裁剪的包。实测踩过。

### 6.4 官方运行时体积对照

```bash
for v in 43.2.0 44.4.5; do
  printf "%-8s %s\n" "$v" "$(gh api repos/electron/electron/releases/tags/v$v \
    --jq "[.assets[]|select(.name==\"electron-v$v-win32-x64.zip\")|.size]|.[0]")"
done
```

---

## 7. 落地清单

| # | 动作 | 改哪个文件 | 收益 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | 加 `electronLanguages: [zh-CN, zh_CN, en]` | `electron-builder.yml` | 解压 -47.7 MiB，下载 -12.05 MiB | 无（§5① 可先验证） |
| 2 | `Compress-Archive` → `7z a -tzip -mx=9` | `.github/workflows/release.yml` | 下载 -5.0 MiB | 无（仍是标准 zip） |
| 3 | 额外发布 `_win_full.7z`（README 注明需 7-Zip） | `release.yml` + `README.md` | 下载再 -41.9 MiB（对主动选择者） | 无（不动现有链路） |
| 4 | 全量包正式切 `.7z` | 另需改 `src/main/update/checker.ts`（`_win_full.zip` → `.7z`，2 处） | 同上，且成为默认 | 中，需 §5② 验证 + 过渡期双发 |
| — | 删 dll / 删 `LICENSES.chromium.html` / 降级 Electron / UPX / 换 Wails | — | — | **不做**（§4） |
