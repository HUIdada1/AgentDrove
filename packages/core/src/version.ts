/** 极简版本范围判断,只支持 ">=0.16 <0.17" 这类空格分隔子句;为免为一个两子句需求引入 semver 依赖 */

type Op = '>=' | '>' | '<=' | '<' | '=' 

function compare(a: string, b: string): number {
  const [a1 = 0, a2 = 0, a3 = 0] = a.split('.').map(Number)
  const [b1 = 0, b2 = 0, b3 = 0] = b.split('.').map(Number)
  if (a1 !== b1) return a1 - b1
  if (a2 !== b2) return a2 - b2
  return a3 - b3
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
