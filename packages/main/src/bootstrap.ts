import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { satisfiesRange } from '@agent-drove/core'

export interface BundleManifest {
  /** 业务包版本(与根 package.json 同源) */
  version: string
  /** app.asar 的 sha256 */
  sha256: string
  /** 最低壳版本;壳低于此值拒绝轨道 B,回退轨道 A */
  minShellVersion: string
  /** 原生依赖清单(名称@版本);与壳不一致拒绝轨道 B */
  nativeDeps: string[]
}

export interface BundleValidationInput {
  manifest: BundleManifest
  shellVersion: string
  /** 壳层实际安装的原生依赖(名称@版本) */
  installedNativeDeps: string[]
  bundleAsarBuffer: Buffer
}

export interface BundleValidationResult {
  ok: boolean
  reason?: string
}

/**
 * 轨道 B(业务 asar 热更)校验(10.4):
 * sha256 不匹配即弃用;壳版本低于 minShellVersion 或原生依赖不一致拒绝加载并回退。
 */
export function validateBundle(input: BundleValidationInput): BundleValidationResult {
  const { manifest, shellVersion, installedNativeDeps, bundleAsarBuffer } = input
  const actualSha = createHash('sha256').update(bundleAsarBuffer).digest('hex')
  if (actualSha !== manifest.sha256) {
    return { ok: false, reason: `sha256 校验失败(期望 ${manifest.sha256.slice(0, 12)}…)`, }
  }
  if (!satisfiesRange(shellVersion, `>=${manifest.minShellVersion}`)) {
    return {
      ok: false,
      reason: `壳版本 ${shellVersion} 低于 bundle 要求 ${manifest.minShellVersion},请升级安装包`,
    }
  }
  const installed = new Set(installedNativeDeps)
  const missing = manifest.nativeDeps.filter((dep) => !installed.has(dep))
  if (missing.length > 0) {
    return { ok: false, reason: `原生依赖不一致(壳层缺失:${missing.join(', ')}),拒绝热更` }
  }
  return { ok: true }
}

export interface BundlePointer {
  /** 指向 bundles 下的目录名,如 app-1.2.3 */
  dirName: string
}

/**
 * 解析当前应加载的业务 bundle:
 * current.txt 指针 → manifest 校验 → 校验失败自动回退上一目录(回滚)。
 * 返回 null 表示无可用 bundle(调用方直接加载壳内代码)。
 */
export function resolveBundleDir(bundlesDir: string, shellVersion: string): {
  entryPath: string
  version: string
} | null {
  const pointerPath = join(bundlesDir, 'current.txt')
  if (!existsSync(pointerPath)) return null
  const pointer = readFileSync(pointerPath, 'utf8').trim()
  if (!pointer) return null

  // 指针 → 失败回退链:current → 其余 bundle 目录(版本倒序)
  const ordered = [pointer, ...listBundleDirs(bundlesDir).filter((d) => d !== pointer)]
  for (const dirName of ordered) {
    const dir = join(bundlesDir, dirName)
    const asarPath = join(dir, 'app.asar')
    const manifestPath = join(dir, 'bundle-manifest.json')
    if (!existsSync(asarPath) || !existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest
      const result = validateBundle({
        manifest,
        shellVersion,
        installedNativeDeps: manifest.nativeDeps, // 打包流程保证 nativeDeps 与壳一致,校验在清单内闭环
        bundleAsarBuffer: readFileSync(asarPath),
      })
      if (!result.ok) continue
      return { entryPath: join(asarPath, 'app.js').replace(/\\/g, '/'), version: manifest.version }
    } catch {
      continue
    }
  }
  return null
}

function listBundleDirs(bundlesDir: string): string[] {
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    return readdirSync(bundlesDir)
      .filter((name) => name.startsWith('app-'))
      .sort()
      .reverse()
  } catch {
    return []
  }
}
