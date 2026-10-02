import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import type { Clock, FileSystem, ProcessRunner } from './ports.js'

export type WorkspaceKind = 'worktree' | 'tempcopy' | 'userdir'
export type WorkspaceStatus = 'active' | 'done' | 'cleaned'

export interface WorkspaceRow {
  id: string
  taskId: string
  path: string
  kind: WorkspaceKind
  /** worktree: JSON {repo, baseHead};tempcopy: 源目录;userdir: 不填 */
  source?: string
  status: WorkspaceStatus
  createdAt: number
  /** 到期清理时刻;userdir 永不到期(仅解除登记,不删目录) */
  cleanupAfter?: number
}

export interface WorkspaceStore {
  put(row: WorkspaceRow): void
  get(id: string): WorkspaceRow | undefined
  all(): WorkspaceRow[]
  delete(id: string): void
}

export interface WorktreeSource {
  repo: string
  baseHead: string
}

/**
 * 派生工作区管理:
 * - git 源 → worktree(agentdrove/<taskId> 分支),非 git 源 → 整拷 tempcopy 降级;
 * - 互斥判据在编排层按任务状态执行,这里只做登记与生命周期;
 * - userdir 只登记不复制,清理=解除登记(目录是用户自己的)。
 */
export class WorkspaceManager {
  constructor(
    private readonly fsx: FileSystem,
    private readonly runner: ProcessRunner,
    private readonly clock: Clock,
    private readonly store: WorkspaceStore,
  ) {}

  /**
   * 派生工作区;失败抛错由调用方决定任务去向。
   * git 不可用(非 git 目录/命令缺失)自动降级 tempcopy,派发不被阻塞。
   */
  async derive(
    source: string,
    taskId: string,
    workspacesDir: string,
    cleanupHours: number,
  ): Promise<WorkspaceRow> {
    this.fsx.ensureDir(workspacesDir)
    const dest = join(workspacesDir, `${basename(source) || 'ws'}-${taskId.slice(0, 8)}`)
    const now = this.clock.now()
    const cleanupAfter = now + cleanupHours * 3_600_000
    if (await this.isGitRepo(source)) {
      const baseHead = (await this.git(source, ['rev-parse', 'HEAD'])).trim()
      const branch = `agentdrove/${taskId.slice(0, 8)}`
      await this.git(source, ['worktree', 'add', '-b', branch, dest])
      const row: WorkspaceRow = {
        id: randomUUID(),
        taskId,
        path: dest,
        kind: 'worktree',
        source: JSON.stringify({ repo: source, baseHead } satisfies WorktreeSource),
        status: 'active',
        createdAt: now,
        cleanupAfter,
      }
      this.store.put(row)
      return row
    }
    this.fsx.copy(source, dest)
    const row: WorkspaceRow = {
      id: randomUUID(),
      taskId,
      path: dest,
      kind: 'tempcopy',
      source,
      status: 'active',
      createdAt: now,
      cleanupAfter,
    }
    this.store.put(row)
    return row
  }

  registerUserDir(path: string, taskId: string): WorkspaceRow {
    const row: WorkspaceRow = {
      id: randomUUID(),
      taskId,
      path,
      kind: 'userdir',
      status: 'active',
      createdAt: this.clock.now(),
    }
    this.store.put(row)
    return row
  }

  /** 占用任务到达终态:该任务登记行 active → done */
  markDoneForTask(taskId: string): void {
    for (const row of this.store.all()) {
      if (row.taskId === taskId && row.status === 'active') {
        this.store.put({ ...row, status: 'done' })
      }
    }
  }

  rowsForTask(taskId: string): WorkspaceRow[] {
    return this.store.all().filter((row) => row.taskId === taskId)
  }

  async cleanupExpired(now: number): Promise<string[]> {
    const cleaned: string[] = []
    for (const row of this.store.all()) {
      if (row.status === 'cleaned') continue
      if (row.cleanupAfter === undefined || row.cleanupAfter > now) continue
      await this.cleanup(row)
      cleaned.push(row.id)
    }
    return cleaned
  }

  /** userdir 仅解除登记,不删用户目录;派生工作区物理清理 */
  async cleanup(row: WorkspaceRow): Promise<void> {
    if (row.kind === 'worktree' && row.source) {
      try {
        const { repo } = JSON.parse(row.source) as WorktreeSource
        await this.git(repo, ['worktree', 'remove', '--force', row.path])
        await this.git(repo, ['branch', '-D', `agentdrove/${row.taskId.slice(0, 8)}`])
      } catch {
        // git 清理失败仍要解除登记,避免行永久滞留;残留目录由用户手动处理
        this.fsx.remove(row.path)
      }
    } else if (row.kind === 'tempcopy') {
      this.fsx.remove(row.path)
    }
    this.store.put({ ...row, status: 'cleaned' })
  }

  private async isGitRepo(path: string): Promise<boolean> {
    try {
      const out = await this.git(path, ['rev-parse', '--is-inside-work-tree'])
      return out.trim() === 'true'
    } catch {
      return false
    }
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      const errors: Buffer[] = []
      const handle = this.runner.spawn({
        command: 'git',
        args,
        cwd,
        onStdout: (chunk) => chunks.push(chunk),
        onStderr: (chunk) => errors.push(chunk),
      })
      const timer = setTimeout(() => {
        void handle.killTree()
        reject(new Error('git 调用超时(30s)'))
      }, 30_000)
      void handle.exited.then(
        (code) => {
          clearTimeout(timer)
          if (code !== 0) {
            reject(
              new Error(
                `git ${args[0]} 退出码 ${code}${errors.length > 0 ? `:${new TextDecoder().decode(Buffer.concat(errors)).trim()}` : ''}`,
              ),
            )
          } else {
            resolve(chunks.length > 0 ? new TextDecoder().decode(Buffer.concat(chunks)) : '')
          }
        },
        (error) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }
}
