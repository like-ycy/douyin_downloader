#!/usr/bin/env bash
# 本地打包脚本：按当前机器平台/架构自动构建，便于手动测试。
# - macOS: 产出 .app（双击直接运行），架构跟随当前机器（arm64/x64）
# - Windows: 产出 portable .exe（免安装，双击直接运行）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 构建主进程 / preload / 渲染层 ..."
npx electron-vite build

if [[ "$(uname -s)" == "Darwin" ]]; then
  ARCH="$(uname -m)"
  echo "==> macOS ($ARCH) 打包 .app ..."
  npx electron-builder --mac dir
  # electron-builder 无证书时会跳过签名，但遗留的 Electron linker 签名与资源不符，
  # 可能无法启动 —— 这里强制做 ad-hoc bundle 签名（Apple Silicon 必需）
  APP="$(ls -d release/mac-*/抖音下载器.app | head -1)"
  echo "==> ad-hoc 签名: $APP"
  codesign --force --deep -s - "$APP"
  codesign --verify "$APP" && echo "    签名校验通过"
  echo ""
  echo "✓ 完成: $APP （双击运行；首次打开如被 Gatekeeper 拦，右键 -> 打开）"
elif [[ "${OS:-}" == "Windows_NT" ]]; then
  echo "==> Windows 打包 portable .exe ..."
  npx electron-builder --win portable
  echo ""
  echo "✓ 完成: release/抖音下载器-*.exe （双击直接运行；如被 SmartScreen 拦，点 更多信息 -> 仍要运行）"
else
  echo "✗ 不支持的平台: $(uname -s)" >&2
  exit 1
fi
