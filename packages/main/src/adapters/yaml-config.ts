import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, mergeConfig, type AppConfig, type ConfigSource } from '@agent-drove/core'
import { parse, stringify } from 'yaml'

export interface YamlConfigResult {
  source: ConfigSource
  /** 文件损坏时给出路径供 UI 警示并提供"重置配置";正常为 undefined */
  warning?: string
}

/**
 * YAML 配置源:内置默认 + 用户覆盖合并。
 * 文件损坏不炸启动——按内置默认跑,把坏文件路径报给 UI。
 */
export function loadYamlConfig(
  configDir: string,
  fileName = 'settings.yaml',
): YamlConfigResult {
  const file = join(configDir, fileName)
  return { source: { load: () => readConfig(file) }, warning: probeWarning(file) }
}

function readConfig(file: string): AppConfig {
  if (!existsSync(file)) return mergeConfig(DEFAULT_CONFIG, {})
  try {
    const raw = parse(readFileSync(file, 'utf8'))
    if (raw === undefined || raw === null) return mergeConfig(DEFAULT_CONFIG, {})
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('配置根节点必须是对象')
    }
    return mergeConfig(DEFAULT_CONFIG, raw)
  } catch {
    // 读取/解析失败统一回落内置默认
    return mergeConfig(DEFAULT_CONFIG, {})
  }
}

function probeWarning(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    const raw = parse(readFileSync(file, 'utf8'))
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'object' && !Array.isArray(raw)) return undefined
    return file
  } catch {
    return file
  }
}

/** 设置页保存;全量写入,文件内容即当前生效配置 */
export function saveYamlConfig(
  configDir: string,
  config: AppConfig,
  fileName = 'settings.yaml',
): void {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, fileName), stringify(config, { lineWidth: 100 }), 'utf8')
}
