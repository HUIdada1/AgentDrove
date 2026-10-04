#!/usr/bin/env node
/**
 * AgentDrove 主进程打包脚本(esbuild)。
 *
 * 产物:
 *   packages/main/dist/app.cjs           主进程入口(package.json main 指向此文件)
 *   packages/main/dist/preload/index.cjs preload(sandbox 只支持 CJS)
 *   packages/main/dist/renderer/         渲染层静态资源(存在 packages/renderer/dist 时拷入)
 *
 * 约定:
 *   - @agent-drove/core、@agent-drove/shared 会被打进 app.cjs,需先构建两者的 dist;
 *   - electron / electron-updater / better-sqlite3 / yaml 保持 external,运行时由
 *     electron-builder 按生产依赖装入 asar(原生模块 *.node 由 asarUnpack 解包);
 *   - 源码按 ESM 书写(import.meta.dirname),打成 CJS 后用 __dirname 顶替。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)) // packages/main/scripts
const mainRoot = path.resolve(here, '..') // packages/main
const repoRoot = path.resolve(mainRoot, '..', '..') // 仓库根
const distDir = path.join(mainRoot, 'dist')

const EXTERNAL = ['electron', 'electron-updater', 'better-sqlite3', 'yaml']

function ensurePrerequisite() {
  // workspace 前置包未构建时,esbuild 解析 exports 会直接失败,先给出可读报错
  for (const name of ['core', 'shared']) {
    const dts = path.join(repoRoot, 'packages', name, 'dist', 'index.d.ts')
    if (!fs.existsSync(dts)) {
      console.error(`[bundle] 缺少 packages/${name}/dist,请先执行: pnpm --filter @agent-drove/${name} build`)
      process.exit(1)
    }
  }
}

async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch {
    console.error('[bundle] 未找到 esbuild,请先在仓库根目录执行: pnpm install')
    console.error('[bundle] (esbuild 已声明在 packages/main 的 devDependencies 中)')
    process.exit(1)
  }
}

async function main() {
  ensurePrerequisite()
  const esbuild = await loadEsbuild()
  const t0 = Date.now()

  // 干净产物:清空后重打,避免 tsc 调试产物混入 electron-builder 的 files 范围
  fs.rmSync(distDir, { recursive: true, force: true })
  fs.mkdirSync(distDir, { recursive: true })

  await esbuild.build({
    entryPoints: [
      { in: path.join(mainRoot, 'src', 'app.ts'), out: 'app' },
      { in: path.join(mainRoot, 'src', 'preload', 'index.ts'), out: 'preload/index' },
    ],
    outdir: distDir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    external: EXTERNAL,
    // 源码按 ESM 写;打包成 CJS 后 import.meta 由 __dirname 等接管
    define: {
      'import.meta.dirname': '__dirname',
      'import.meta.url': 'import_meta_url',
    },
    banner: {
      js: 'var import_meta_url = typeof document === "undefined" ? new (require("url").URL)("file:" + __filename).href : "";',
    },
    logLevel: 'info',
  })

  // 渲染层并行开发期可能尚未构建:缺目录只警告不报错
  const rendererDist = path.join(repoRoot, 'packages', 'renderer', 'dist')
  const rendererTarget = path.join(distDir, 'renderer')
  if (fs.existsSync(rendererDist)) {
    fs.cpSync(rendererDist, rendererTarget, { recursive: true })
    console.log('[bundle] 已拷贝 packages/renderer/dist -> dist/renderer')
  } else {
    console.warn('[bundle] 警告: packages/renderer/dist 不存在,跳过 renderer 拷贝(发布前需先构建 renderer)')
  }

  const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(1)} KB`
  console.log(
    `[bundle] 完成: app.cjs=${kb(path.join(distDir, 'app.cjs'))} preload/index.cjs=${kb(path.join(distDir, 'preload', 'index.cjs'))} 耗时 ${Date.now() - t0}ms`,
  )
}

main().catch((error) => {
  console.error('[bundle] 打包失败:', error)
  process.exit(1)
})
