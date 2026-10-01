#!/usr/bin/env node
/**
 * AgentDrove 一键发版脚本(方案 10.3/10.4)。
 *
 * 用法:
 *   node scripts/release.mjs [--major|--minor|--patch] [--no-upload] [--skip-bundle]
 *     --major/--minor/--patch  语义化版本递增,默认 patch
 *     --no-upload              只构建与出包,不打 tag/不推送/不上传
 *     --skip-bundle            跳过轨道 B 热更产物(app.asar + bundle-manifest.json)
 *
 * 流程:
 *   ① 解析参数(上传模式下先校验 git 工作区干净,保证 tag 指向已提交代码;
 *      本脚本对 package.json/CHANGELOG.md 的写入发生在校验之后,由发布者发版后自行提交)
 *   ② 递增根 package.json version,并同步写入 core/shared/main/renderer 四包
 *   ③ 构建链:core -> shared -> renderer -> main bundle(任一步失败即退出)
 *   ④ electron-builder --win nsis --publish never(产物在 packages/main/release/)
 *   ⑤ 轨道 B 热更产物:dist 打成 asar + sha256 + minShellVersion + nativeDeps,
 *      写 bundle-manifest.json,并按 bundle-<ver>-app.asar / bundle-manifest.json
 *      复制到 release 根供上传(不做 zip,应用内更新器按 manifest 拉取)
 *   ⑥ git tag v<ver> -> push -> gh release create(gh 缺失时打印资产清单后以 0 退出)
 *   ⑦ CHANGELOG.md 追加版本条目
 *
 * 全程中文日志;仅依赖 node 内置模块与项目 devDependencies(esbuild/@electron/asar)。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainDir = path.join(repoRoot, 'packages', 'main')
const releaseDir = path.join(mainDir, 'release')

// ---------------- 基础工具 ----------------
const log = (...m) => console.log(...m)
const warn = (...m) => console.warn(...m)
const die = (msg) => {
  console.error(`[release] ${msg}`)
  process.exit(1)
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`)
}

function run(cmd, args, opts = {}) {
  log(`\n==> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: repoRoot, ...opts })
  if (r.status !== 0) die(`命令失败(退出码 ${r.status}): ${cmd} ${args.join(' ')}`)
  return r
}

function gitOut(args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false })
  return r.status === 0 ? (r.stdout ?? '') : null
}

// ---------------- ① 参数 ----------------
const args = process.argv.slice(2)
const bumpType = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : 'patch'
const noUpload = args.includes('--no-upload')
const skipBundle = args.includes('--skip-bundle')

log(`[release] AgentDrove 发版: 类型=${bumpType} 上传=${noUpload ? '否' : '是'} 热更产物=${skipBundle ? '跳过' : '生成'}`)

if (!noUpload) {
  const status = gitOut(['status', '--porcelain'])
  if (status === null) die('git 不可用,请确认仓库环境')
  if (status.trim()) {
    console.error('[release] git 工作区不干净,请先提交全部改动再发版:')
    for (const line of status.split('\n').filter(Boolean)) console.error(`    ${line}`)
    process.exit(1)
  }
}

// ---------------- ② 版本同步 ----------------
const rootPkgPath = path.join(repoRoot, 'package.json')
const rootPkg = readJSON(rootPkgPath)

function bumpVersion(v, type) {
  const [maj, min, pat] = String(v).split('.').map((n) => Number.parseInt(n, 10) || 0)
  if (type === 'major') return `${maj + 1}.0.0`
  if (type === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

const newVersion = bumpVersion(rootPkg.version ?? '0.1.0', bumpType)
const syncTargets = [
  rootPkgPath,
  path.join(repoRoot, 'packages', 'core', 'package.json'),
  path.join(repoRoot, 'packages', 'shared', 'package.json'),
  path.join(repoRoot, 'packages', 'main', 'package.json'),
  path.join(repoRoot, 'packages', 'renderer', 'package.json'),
]
for (const p of syncTargets) {
  const pkg = readJSON(p)
  pkg.version = newVersion
  writeJSON(p, pkg)
}
log(`[release] 版本已同步为 ${newVersion}(根 + core/shared/main/renderer)`)

// ---------------- ③ 构建链 ----------------
log('\n[release] 步骤 1/4: 构建链(core -> shared -> renderer -> main bundle)')
const buildSteps = [
  ['pnpm', ['--filter', '@agent-drove/core', 'build']],
  ['pnpm', ['--filter', '@agent-drove/shared', 'build']],
  ['pnpm', ['--filter', '@agent-drove/renderer', 'build']],
  ['pnpm', ['--filter', '@agent-drove/main', 'bundle']],
]
for (const [cmd, stepArgs] of buildSteps) run(cmd, stepArgs)

// ---------------- ④ electron-builder NSIS ----------------
log('\n[release] 步骤 2/4: electron-builder 出 NSIS 安装包')
run('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never'], { cwd: mainDir })

// 打包过程会把 better-sqlite3 重编到 Electron ABI,发版后立即恢复 Node ABI,
// 否则本地 vitest(跑在 node 上)加载原生模块直接报 NODE_MODULE_VERSION 不匹配
log('\n[release] 恢复 better-sqlite3 的 Node ABI(打包把它重编成了 Electron ABI)')
const nodeRequire = createRequire(path.join(mainDir, 'package.json'))
const sqliteDir = path.dirname(nodeRequire.resolve('better-sqlite3/package.json'))
run('npx', ['node-gyp', 'rebuild', '--release'], { cwd: sqliteDir })

// ---------------- ⑤ 轨道 B 热更产物 ----------------
async function loadAsarLib() {
  try {
    const mod = await import('@electron/asar')
    return mod.default ?? mod
  } catch {
    die('未找到 @electron/asar,请先在仓库根目录执行 pnpm install;或使用 --skip-bundle 跳过热更产物')
  }
}

function resolveNativeDeps() {
  const candidates = [
    path.join(mainDir, 'node_modules', 'better-sqlite3', 'package.json'),
    path.join(repoRoot, 'node_modules', 'better-sqlite3', 'package.json'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return [`better-sqlite3@${readJSON(p).version}`]
  }
  warn('[release] 警告: 未找到 better-sqlite3 的 package.json,nativeDeps 置空(需 pnpm install)')
  return []
}

function resolveMinShellVersion() {
  const mainPkg = readJSON(path.join(mainDir, 'package.json'))
  const spec = readJSON(rootPkgPath).devDependencies?.electron ?? mainPkg.devDependencies?.electron
  const m = String(spec ?? '').match(/\d+\.\d+/)
  if (!m) die('未找到 electron 版本声明(main/根 package.json devDependencies.electron)')
  return `${m[0]}.0`
}

async function buildHotUpdateBundle() {
  log('\n[release] 步骤 3/4: 生成轨道 B 热更产物')
  const asar = await loadAsarLib()
  const verDir = path.join(releaseDir, `bundle-${newVersion}`)
  fs.rmSync(verDir, { recursive: true, force: true })
  fs.mkdirSync(verDir, { recursive: true })

  const asarFile = path.join(verDir, 'app.asar')
  await asar.createPackage(path.join(mainDir, 'dist'), asarFile)

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(asarFile)).digest('hex')
  const manifest = {
    version: newVersion,
    sha256,
    minShellVersion: resolveMinShellVersion(),
    nativeDeps: resolveNativeDeps(),
  }
  fs.writeFileSync(path.join(verDir, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // 复制到 release 根,作为 gh release 上传资产(命名带版本,manifest 覆盖为最新)
  fs.copyFileSync(asarFile, path.join(releaseDir, `bundle-${newVersion}-app.asar`))
  fs.copyFileSync(path.join(verDir, 'bundle-manifest.json'), path.join(releaseDir, 'bundle-manifest.json'))
  log(`[release] 热更产物: bundle-${newVersion}/(app.asar + bundle-manifest.json)`)
  log(`[release]   sha256=${sha256}`)
  log(`[release]   minShellVersion=${manifest.minShellVersion} nativeDeps=${JSON.stringify(manifest.nativeDeps)}`)
}

// ---------------- ⑥ tag + GitHub Release ----------------
function collectAssets() {
  const assets = []
  const push = (p) => fs.existsSync(p) && assets.push(p)
  const setup = fs.readdirSync(releaseDir).find((f) => /^AgentDrove-Setup-.*\.exe$/.test(f))
  if (setup) push(path.join(releaseDir, setup))
  else die(`未找到 NSIS 产物(AgentDrove-Setup-*.exe),请检查 electron-builder 输出: ${releaseDir}`)
  push(path.join(releaseDir, 'latest.yml'))
  push(path.join(releaseDir, 'latest.yml.blockmap'))
  if (!skipBundle) {
    push(path.join(releaseDir, `bundle-${newVersion}-app.asar`))
    push(path.join(releaseDir, 'bundle-manifest.json'))
  }
  return assets
}

function gitLogSummary(range) {
  const text = gitOut(['log', '--oneline', range, '-n', '50']) ?? ''
  return text.trim()
}

function publishRelease(prevTag) {
  log('\n[release] 步骤 4/4: tag + GitHub Release')
  const tag = `v${newVersion}`

  const tagExists = (gitOut(['tag', '-l', tag]) ?? '').trim() === tag
  if (tagExists) {
    warn(`[release] 标签 ${tag} 已存在,跳过创建与推送`)
  } else {
    run('git', ['tag', tag])
    run('git', ['push', 'origin', tag])
    log(`[release] 已推送标签 ${tag}`)
  }

  const ghCheck = spawnSync('gh', ['--version'], { encoding: 'utf8', shell: true })
  if (ghCheck.error || ghCheck.status !== 0) {
    log('\n[release] 未检测到 GitHub CLI(gh)。请安装 GitHub CLI 并执行 gh auth login,')
    log('[release] 或手动上传以下资产到 GitHub Releases:')
    for (const a of collectAssets()) log(`    - ${a}`)
    log('[release] (标签已推送,发版不算失败)')
    return
  }

  const notes = gitLogSummary(prevTag ? `${prevTag}..HEAD` : 'HEAD') || '首次发布'
  const assets = collectAssets()
  log(`[release] gh release create ${tag}(资产 ${assets.length} 个)`)
  run('gh', ['release', 'create', tag, ...assets, '--title', `AgentDrove ${tag}`, '--notes', notes])
}

// ---------------- ⑦ CHANGELOG ----------------
function appendChangelog(prevTag) {
  const summary = gitLogSummary(prevTag ? `${prevTag}..HEAD` : 'HEAD') || '首次发布'
  const cl = path.join(repoRoot, 'CHANGELOG.md')
  if (!fs.existsSync(cl)) fs.writeFileSync(cl, '# Changelog\n\n')
  const entry = `## v${newVersion} (${new Date().toISOString().slice(0, 10)})\n\n${summary}\n\n`
  fs.appendFileSync(cl, entry)
  log(`[release] CHANGELOG.md 已追加 v${newVersion} 条目`)
}

// ---------------- main ----------------
async function main() {
  // prevTag 必须在打新 tag 前记录,否则 describe 会拿到刚打的新 tag
  const prevTag = gitOut(['describe', '--tags', '--abbrev=0'])?.trim() ?? ''
  if (!skipBundle) await buildHotUpdateBundle()
  else warn('[release] --skip-bundle: 跳过轨道 B 热更产物')
  if (!noUpload) publishRelease(prevTag)
  else warn('[release] --no-upload: 跳过 tag/推送/上传(仅本地构建)')
  appendChangelog(prevTag)
  log(`\n[release] 完成: v${newVersion}`)
}

main().catch((error) => {
  console.error('[release] 失败:', error)
  process.exit(1)
})
