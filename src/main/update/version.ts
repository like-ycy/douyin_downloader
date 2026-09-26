/**
 * 轻量 semver 比较（逻辑对齐 video_cut/internal/version/version.go）。
 * 支持 "v" 前缀与 pre-release（正式版 > 同版本号 pre-release）。
 */

interface ParsedVersion {
  segs: number[]
  pre: string
}

function parseVersion(v: string): ParsedVersion {
  const trimmed = v.trim().replace(/^[vV]/, '')
  const [mainPart, prePart = ''] = trimmed.split('-', 2)
  const segs = mainPart.split('.').map((s) => {
    const n = parseInt(s, 10)
    return Number.isNaN(n) ? 0 : n
  })
  return { segs, pre: prePart }
}

/** a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const maxLen = Math.max(pa.segs.length, pb.segs.length)

  for (let i = 0; i < maxLen; i++) {
    const av = pa.segs[i] ?? 0
    const bv = pb.segs[i] ?? 0
    if (av > bv) return 1
    if (av < bv) return -1
  }

  // 主版本段一致时：正式版 > pre-release
  if (pa.pre === '' && pb.pre !== '') return 1
  if (pa.pre !== '' && pb.pre === '') return -1
  if (pa.pre > pb.pre) return 1
  if (pa.pre < pb.pre) return -1
  return 0
}
