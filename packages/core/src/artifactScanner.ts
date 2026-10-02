import { join } from 'node:path'
import type { FileSystem, ProcessRunner } from './ports.js'
import { decodeBuffer } from './text.js'
import type { TaskRecord } from './types.js'
import type { Orchestrator } from './orchestrator.js'
import type { WorkspaceStore, WorktreeSource } from './workspaceManager.js'

export interface ArtifactChange {
  path: string
  change: 'added' | 'modified' | 'deleted'
}

export type ArtifactBaseline =
  | { kind: 'worktree'; repo: string; worktree: string; baseHead: string }
  | { kind: 'snapshot'; dir: string; files: Map<string, SnapshotEntry> }

export interface SnapshotEntry {
  mtimeMs: number
  size: number
}

/** 扫描排除目录为内置常量,不做配置(6.2 规范 5) */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', '.cache'])

/**
 * 产物扫描:基线在 run 前建立,run 到终态后对比产出变更清单。
 * - worktree:`git status --porcelain`(未提交)∪ `git diff --name-only <创建点>`(已提交);
 * - tempcopy/userdir:目录快照 diff(mtime/size)。
 */
export class ArtifactScanner {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly fsx: FileSystem,
  ) {}

  async snapshotWorktree(repo: string, worktree: string): Promise<ArtifactBaseline> {
    const baseHead = (await this.git(repo, ['rev-parse', 'HEAD'])).trim()
    return { kind: 'worktree', repo, worktree, baseHead }
  }

  snapshotDir(dir: string): Extract<ArtifactBaseline, { kind: 'snapshot' }> {
    return { kind: 'snapshot', dir, files: this.walk(dir) }
  }

  async scan(baseline: ArtifactBaseline): Promise<ArtifactChange[]> {
    if (baseline.kind === 'worktree') return this.scanWorktree(baseline)
    return this.scanSnapshot(baseline)
  }

  private async scanWorktree(baseline: Extract<ArtifactBaseline, { kind: 'worktree' }>): Promise<ArtifactChange[]> {
    const statusOut = await this.git(baseline.worktree, [
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain',
    ])
    const changes = new Map<string, ArtifactChange['change']>()
    for (const line of statusOut.split('\n')) {
      if (line.length < 4) continue
      const x = line[0]
      const y = line[1]
      // 重命名条目形如 "R  old -> new",产物清单只关心新路径
      const rawPath = line.slice(3).trim()
      const path = x === 'R' || y === 'R' ? (rawPath.split(' -> ').pop() ?? rawPath) : rawPath
      const change =
        x === '?' || x === 'A' || y === 'A'
          ? 'added'
          : x === 'D' || y === 'D'
            ? 'deleted'
            : 'modified'
      changes.set(path, change)
    }
    // 已提交部分:与分支创建点对比;porcelain 已覆盖未提交,以 porcelain 优先
    const diffOut = await this.git(baseline.worktree, [
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-only',
      baseline.baseHead,
    ])
    for (const line of diffOut.split('\n')) {
      const path = line.trim()
      if (path && !changes.has(path)) changes.set(path, 'modified')
    }
    return [...changes].map(([path, change]) => ({ path, change }))
  }

  private scanSnapshot(baseline: Extract<ArtifactBaseline, { kind: 'snapshot' }>): ArtifactChange[] {
    const current = this.walk(baseline.dir)
    const changes: ArtifactChange[] = []
    for (const [path, entry] of current) {
      const before = baseline.files.get(path)
      if (!before) {
        changes.push({ path, change: 'added' })
      } else if (before.mtimeMs !== entry.mtimeMs || before.size !== entry.size) {
        changes.push({ path, change: 'modified' })
      }
    }
    for (const path of baseline.files.keys()) {
      if (!current.has(path)) changes.push({ path, change: 'deleted' })
    }
    return changes
  }

  /** 相对路径快照;排除目录在任意层级生效 */
  private walk(root: string): Map<string, SnapshotEntry> {
    const files = new Map<string, SnapshotEntry>()
    const visit = (dir: string, prefix: string): void => {
      for (const name of this.fsx.readDir(dir)) {
        if (EXCLUDED_DIRS.has(name)) continue
        const full = join(dir, name)
        const rel = prefix ? `${prefix}/${name}` : name
        const stat = this.fsx.stat(full)
        if (!stat) continue
        if (stat.isDirectory) {
          visit(full, rel)
        } else {
          files.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size })
        }
      }
    }
    visit(root, '')
    return files
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    const handle = this.runner.spawn({
      command: 'git',
      args,
      cwd,
      onStdout: (chunk) => chunks.push(chunk),
      onStderr: (chunk) => errors.push(chunk),
    })
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        void handle.killTree()
        reject(new Error('git 调用超时(30s)'))
      }, 30_000)
      void handle.exited.then(
        (exitCode) => {
          clearTimeout(timer)
          resolve(exitCode)
        },
        (error) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
    if (code !== 0) {
      const reason = decodeBuffer(Buffer.concat(errors)).trim()
      throw new Error(`git ${args.join(' ')} 退出码 ${code}${reason ? `:${reason}` : ''}`)
    }
    return decodeBuffer(Buffer.concat(chunks))
  }
}

/**
 * 产物跟踪:挂到编排器的 run 前后钩子上。
 * worktree 任务的基线可由登记行重建(分支创建点),因此重启后 markFailed 的补扫也能做;
 * 快照型工作区没有跨重启的基线,补扫只能跳过并给 warning,避免把整个目录误报成新增。
 */
export class ArtifactTracking {
  private readonly baselines = new Map<string, ArtifactBaseline | 'unavailable'>()

  constructor(
    private readonly scanner: ArtifactScanner,
    private readonly workspaces?: WorkspaceStore,
  ) {}

  /** 编排器 onRunStart 钩子:run 前建立基线 */
  async onRunStart(task: TaskRecord): Promise<unknown> {
    const baseline = await this.buildBaseline(task)
    this.baselines.set(task.id, baseline)
    return baseline
  }

  /** 编排器 onRunEnd 钩子:终态扫描并补发 artifact 事件(canceled 同样扫描) */
  async onRunEnd(task: TaskRecord, orchestrator: Orchestrator): Promise<void> {
    const baseline = this.baselines.get(task.id)
    this.baselines.delete(task.id)
    await this.scanAndEmit(task, baseline, orchestrator)
  }

  /** markFailed 的补扫:仅 worktree 可重建基线,其余跳过 */
  async rescanAfterMarkFailed(task: TaskRecord, orchestrator: Orchestrator): Promise<void> {
    const baseline = await this.buildBaseline(task)
    if (baseline === 'unavailable' || baseline.kind === 'snapshot') {
      orchestrator.emitTaskEvent(task.id, {
        kind: 'warning',
        text: '重启后无产物基线,跳过补扫',
      })
      return
    }
    await this.scanAndEmit(task, baseline, orchestrator)
  }

  private async buildBaseline(task: TaskRecord): Promise<ArtifactBaseline | 'unavailable'> {
    const row = this.workspaces
      ?.all()
      .find((r) => r.path === task.cwd && r.kind === 'worktree' && r.source)
    if (row?.source) {
      try {
        const source = JSON.parse(row.source) as WorktreeSource
        return await this.scanner.snapshotWorktree(source.repo, task.cwd)
      } catch {
        // 登记行损坏或 git 失败时按快照兜底
      }
    }
    try {
      return this.scanner.snapshotDir(task.cwd)
    } catch {
      return 'unavailable'
    }
  }

  private async scanAndEmit(
    task: TaskRecord,
    baseline: ArtifactBaseline | 'unavailable' | undefined,
    orchestrator: Orchestrator,
  ): Promise<void> {
    if (!baseline || baseline === 'unavailable') return
    try {
      const changes = await this.scanner.scan(baseline)
      for (const change of changes) {
        orchestrator.emitTaskEvent(task.id, { kind: 'artifact', ...change })
      }
    } catch (error) {
      orchestrator.emitTaskEvent(task.id, {
        kind: 'warning',
        text: `产物扫描失败:${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
}
