import { describe, expect, it } from 'vitest'
import { isNotFound } from '../src/shell/updater.js'

describe('更新错误分类', () => {
  it('HTTP 404 视为无可用更新(仓库尚无 release 资产)', () => {
    expect(isNotFound(Object.assign(new Error('Cannot find latest.yml'), { statusCode: 404 }))).toBe(true)
    expect(isNotFound({ statusCode: 404 })).toBe(true)
  })

  it('非 404 错误仍按更新出错处理', () => {
    expect(isNotFound(new Error('network down'))).toBe(false)
    expect(isNotFound({ statusCode: 500 })).toBe(false)
    expect(isNotFound(null)).toBe(false)
    expect(isNotFound('404')).toBe(false)
  })
})
