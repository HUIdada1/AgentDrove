/** 极简版本范围判断,只支持 ">=0.16 <0.17" 这类空格分隔子句;为免为一个两子句需求引入 semver 依赖 */

type Op = '>=' | '>' | '<=' | '<' | '='

/** 版本段取前导数字,容忍 "0.16.9-beta" 这类客户端自带后缀 */
function segment(value: string | undefined): number {
  const match = /^\d+/.exec(value ?? '')
  return match ? Number(match[0]) : 0
}

function compare(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < 3; i++) {
    const diff = segment(left[i]) - segment(right[i])
    if (diff !== 0) return diff
  }
  return 0
}

export function satisfiesRange(version: string, range: string): boolean {
  for (const clause of range.split(/\s+/).filter(Boolean)) {
    const match = clause.match(/^(>=|>|<=|<|=)?([\d.]+)$/)
    if (!match) return false
    const op = (match[1] ?? '=') as Op
    const cmp = compare(version, match[2])
    const ok =
      op === '>=' ? cmp >= 0 :
      op === '>' ? cmp > 0 :
      op === '<=' ? cmp <= 0 :
      op === '<' ? cmp < 0 :
      cmp === 0
    if (!ok) return false
  }
  return true
}
