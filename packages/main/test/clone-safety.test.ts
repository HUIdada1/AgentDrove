import { describe, expect, it } from 'vitest'

function safeClone<T>(val: T): T {
  if (val === undefined || val === null) return val
  try {
    return JSON.parse(JSON.stringify(val))
  } catch {
    return val
  }
}

describe('IPC 数据克隆安全性与 Vue Proxy 净化测试', () => {
  it('应当能够将包含 Proxy 的响应式对象完全净化为纯 POJO 并支持 structuredClone', () => {
    // 模拟 Vue 3 的 reactive Proxy 对象
    const rawSkills = ['terminal', 'file_editor', 'code_search']
    const skillsProxy = new Proxy(rawSkills, {
      get(target, prop, receiver) {
        return Reflect.get(target, prop, receiver)
      },
    })

    const rawAttachment = { path: 'C:\\test\\file.txt', kind: 'file' }
    const attachmentProxy = new Proxy(rawAttachment, {
      get(target, prop, receiver) {
        return Reflect.get(target, prop, receiver)
      },
    })

    const submitDto = {
      agentId: 'zcode',
      prompt: '测试任务',
      skills: skillsProxy,
      attachments: [attachmentProxy],
      toolPolicy: {
        denyList: ['Bash'],
        maxTurns: 10,
      },
    }

    // 直接使用 safeClone 进行安全克隆
    const cloned = safeClone(submitDto)

    // 验证净化后的对象能够被原生的 structuredClone 无损克隆（不抛出 An object could not be cloned）
    const nativeCloned = structuredClone(cloned)
    expect(nativeCloned).toEqual({
      agentId: 'zcode',
      prompt: '测试任务',
      skills: ['terminal', 'file_editor', 'code_search'],
      attachments: [{ path: 'C:\\test\\file.txt', kind: 'file' }],
      toolPolicy: {
        denyList: ['Bash'],
        maxTurns: 10,
      },
    })

    expect(Array.isArray(nativeCloned.skills)).toBe(true)
    expect(nativeCloned.skills).toContain('terminal')
  })

  it('对于 null 或 undefined 应当原样安全返回', () => {
    expect(safeClone(null)).toBeNull()
    expect(safeClone(undefined)).toBeUndefined()
  })
})
