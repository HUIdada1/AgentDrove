import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '@agent-drove/core'
import { loadYamlConfig, saveYamlConfig } from '../src/adapters/yaml-config.js'

function configDir(): string {
  const dir = join(tmpdir(), `ad-cfg-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('YAML 配置源', () => {
  it('无文件时返回内置默认', () => {
    const { source, warning } = loadYamlConfig(configDir())
    expect(warning).toBeUndefined()
    expect(source.load()).toEqual(DEFAULT_CONFIG)
  })

  it('用户覆盖与默认合并', () => {
    const dir = configDir()
    writeFileSync(
      join(dir, 'settings.yaml'),
      ['throttle:', '  minIntervalMs: 3000', 'hotkey: "Ctrl+`"', 'danger:', '  allowYolo: true', ''].join('\n'),
      'utf8',
    )
    const { source, warning } = loadYamlConfig(dir)
    expect(warning).toBeUndefined()
    const config = source.load()
    expect(config.throttle.minIntervalMs).toBe(3000)
    expect(config.throttle.globalConcurrency).toBe(DEFAULT_CONFIG.throttle.globalConcurrency)
    expect(config.hotkey).toBe('Ctrl+`')
    expect(config.danger.allowYolo).toBe(true)
  })

  it('损坏文件按默认启动并给出警示路径', () => {
    const dir = configDir()
    writeFileSync(join(dir, 'settings.yaml'), 'throttle: [broken', 'utf8')
    const { source, warning } = loadYamlConfig(dir)
    expect(warning).toBe(join(dir, 'settings.yaml'))
    expect(source.load()).toEqual(DEFAULT_CONFIG)
  })

  it('根节点不是对象同样警示并回落默认', () => {
    const dir = configDir()
    writeFileSync(join(dir, 'settings.yaml'), '- a\n- b\n', 'utf8')
    const { source, warning } = loadYamlConfig(dir)
    expect(warning).toBeDefined()
    expect(source.load()).toEqual(DEFAULT_CONFIG)
  })

  it('saveYamlConfig 写回后可完整读回', () => {
    const dir = configDir()
    const customized = { ...DEFAULT_CONFIG, hotkey: 'Alt+Space' }
    saveYamlConfig(dir, customized)
    const { source, warning } = loadYamlConfig(dir)
    expect(warning).toBeUndefined()
    expect(source.load().hotkey).toBe('Alt+Space')
    // 文件内容可人工检阅
    expect(readFileSync(join(dir, 'settings.yaml'), 'utf8')).toContain('Alt+Space')
    rmSync(dir, { recursive: true, force: true })
  })
})
