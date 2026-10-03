import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ArtifactScanner,
  ArtifactTracking,
  MemoryTaskRepository,
  Orchestrator,
  PassthroughSink,
  Registry,
  WorkspaceManager,
  type DriverRunOptions,
  type OrchestratorDeps,
  type TaskRecord,
  type WorkspaceRow,
} from '../src/index.js'
import { MockDriver } from '../src/drivers/mock.js'
import {
  FixedClock,
  ScriptedRunner,
  waitFor,
  zcodeProfile,
} from './helpers.js'
import { TempFs, mkdirSync, rmSync } from './node-fs.js'

function makeWorkspaceMemoryStore() {
  const rows = new Map<string, WorkspaceRow>()
  return {
    put: (row: WorkspaceRow) => void rows.set(row.id, { ...row }),
    get: (id: string) => (rows.has(id) ? { ...rows.get(id)! } : undefined),
    all: () => [...rows.values()].map((r) => ({ ...r })),
    delete: (id: string) => void rows.delete(id),
  }
}

describe('ArtifactScanner 快照基线', () => {
  it('目录快照 diff:新增/修改/删除,排除目录不进快照', async () => {
    const fsx = new TempFs()
    const runner = new ScriptedRunner()
    const scanner = new ArtifactScanner(runner, fsx)
    const dir = mkdtempSync(join(tmpdir(), 'ad-scan-'))
    writeFileSync(join(dir, 'a.txt'), 'v1')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'x.js'), 'ignored')

    const baseline = scanner.snapshotDir(dir)
    writeFileSync(join(dir, 'a.txt'), 'v2')
    writeFileSync(join(dir, 'new.txt'), 'n')
    rmSync(join(dir, 'a.txt'))
    writeFileSync(join(dir, 'a.txt'), 'recreated') // 先删后建:快照口径为 modified
    // 重建后 mtime/size 变化
    const changes = await scanner.scan(baseline)
    const byPath = new Map(changes.map((c) => [c.path, c.change]))
    expect(byPath.get('a.txt')).toBe('modified')
    expect(byPath.get('new.txt')).toBe('added')
    expect(byPath.has(join('node_modules', 'x.js'))).toBe(false)
  })

  it('worktree 基线:porcelain ∪ diff(baseHead)', async () => {
    const fsx = new TempFs()
    const runner = new ScriptedRunner()
    const scanner = new ArtifactScanner(runner, fsx)
    runner.enqueue((_req, io) => {
      io.stdout('cafe1234\n')
      io.exit(0)
    })
    const baseline = await scanner.snapshotWorktree('C:/repo', 'C:/repo-wt')
    expect(baseline).toMatchObject({ kind: 'worktree', baseHead: 'cafe1234' })

    runner.enqueue((_req, io) => {
      io.stdout(' M a.txt\n?? b.txt\n D c.txt\n')
      io.exit(0)
    })
    runner.enqueue((_req, io) => {
      io.stdout('d.txt\n')
      io.exit(0)
    })
    const changes = await scanner.scan(baseline)
    const byPath = new Map(changes.map((c) => [c.path, c.change]))
    expect(byPath.get('a.txt')).toBe('modified')
    expect(byPath.get('b.txt')).toBe('added')
    expect(byPath.get('c.txt')).toBe('deleted')
    expect(byPath.get('d.txt')).toBe('modified')
  })

  it('git 失败时扫描抛错,由跟踪器转 warning', async () => {
    const fsx = new TempFs()
    const runner = new ScriptedRunner()
    const scanner = new ArtifactScanner(runner, fsx)
    const baseline = {
      kind: 'worktree' as const,
      repo: 'C:/repo',
      worktree: 'C:/wt',
      baseHead: 'x',
    }
    runner.enqueue((_req, io) => {
      io.stderr('fatal: not a git repository\n')
      io.exit(128)
    })
    await expect(scanner.scan(baseline)).rejects.toThrow(/128/)
  })

  it('补扫复用登记行的分支创建点,不重新 rev-parse HEAD(否则漏报已提交产物)', async () => {
    const fsx = new TempFs()
    const runner = new ScriptedRunner()
    const scanner = new ArtifactScanner(runner, fsx)
    const rows: WorkspaceRow[] = [
      {
        id: 'ws-1',
        taskId: 'task-wt-1',
        path: 'C:/wt',
        kind: 'worktree',
        source: JSON.stringify({ repo: 'C:/repo', baseHead: 'cafe1234' }),
        status: 'done',
        createdAt: 0,
      },
    ]
    const store = {
      put: (row: WorkspaceRow) => void rows.push(row),
      get: (id: string) => rows.find((r) => r.id === id),
      all: () => rows,
      delete: (id: string) => void rows.splice(0, rows.length, ...rows.filter((r) => r.id !== id)),
    }
    const tracking = new ArtifactTracking(scanner, store)
    const events: string[] = []
    const orchestrator = {
      emitTaskEvent: (_id: string, event: { kind: string }) => void events.push(event.kind),
    } as unknown as Orchestrator
    // status --porcelain 与 diff <baseHead> 两次调用,无 rev-parse HEAD
    runner.enqueue((_req, io) => {
      io.stdout('?? new.txt\n')
      io.exit(0)
    })
    runner.enqueue((_req, io) => {
      io.stdout('')
      io.exit(0)
    })
    await tracking.rescanAfterMarkFailed(
      { id: 'task-wt-1', cwd: 'C:/wt' } as TaskRecord,
      orchestrator,
    )
    expect(runner.requests).toHaveLength(2)
    expect(runner.requests.map((r) => r.args.join(' ')).join('|')).toContain('cafe1234')
    expect(events).toEqual(['artifact'])
  })
})

describe('ArtifactTracking 与编排器联动', () => {
  it('run 前建基线,终态扫描产出 artifact 事件', async () => {
    const fsx = new TempFs()
    const runner = new ScriptedRunner()
    const scanner = new ArtifactScanner(runner, fsx)
    const tracking = new ArtifactTracking(scanner)
    const repo = new MemoryTaskRepository()
    const clock = new FixedClock()
    const registry = new Registry()
    registry.register(zcodeProfile)
    const dir = mkdtempSync(join(tmpdir(), 'ad-track-'))
    const deps: OrchestratorDeps = {
      repo,
      sink: new PassthroughSink(repo),
      clock,
      onRunStart: (task) => tracking.onRunStart(task),
      onRunEnd: (task) => tracking.onRunEnd(task, orchestrator),
    }
    const orchestrator = new Orchestrator(registry, deps)
    // 驱动执行期间写入文件,模拟 agent 产物
    orchestrator.registerDriver({
      id: 'zcode',
      async detect() {
        return null
      },
      async health() {
        return { ok: true }
      },
      resolveModelArg: () => [],
      async run(options: DriverRunOptions) {
        writeFileSync(join(options.input.cwd, 'generated.txt'), 'artifact')
        return { code: 0 }
      },
    })
    const task = orchestrator.submit({ agentId: 'zcode', prompt: '生成', cwd: dir })
    await waitFor(() => task.state === 'completed')
    await waitFor(() => {
      const artifacts = repo
        .eventsOf(task.id)
        .filter((e) => e.event.kind === 'artifact')
      return artifacts.some(
        (e) => e.event.kind === 'artifact' && e.event.path === 'generated.txt',
      )
    })
  })
})

describe('WorkspaceManager', () => {
  it('非 git 源自动降级 tempcopy,清理即删除', async () => {
    const fsx = new TempFs()
    const runner = new ScriptedRunner()
    const clock = new FixedClock()
    const store = makeWorkspaceMemoryStore()
    const manager = new WorkspaceManager(fsx, runner, clock, store)

    // rev-parse 失败 → 非 git
    runner.enqueue((_req, io) => io.exit(128))
    const source = mkdtempSync(join(tmpdir(), 'ad-src-'))
    writeFileSync(join(source, 'f.txt'), 'data')
    const row = await manager.derive(source, 'task-12345678', join(source, '..', 'ws'), 24)
    expect(row.kind).toBe('tempcopy')
    expect(fsx.exists(row.path)).toBe(true)

    await manager.cleanup(row)
    expect(fsx.exists(row.path)).toBe(false)
    expect(store.get(row.id)?.status).toBe('cleaned')
  })

  it('git 源走 worktree,清理调用 worktree remove + branch -D', async () => {
    const fsx = new TempFs()
    const runner = new ScriptedRunner()
    const clock = new FixedClock()
    const store = makeWorkspaceMemoryStore()
    const manager = new WorkspaceManager(fsx, runner, clock, store)

    const fake = (request: { args: string[] }, io: { stdout: (s: string) => void; exit: (c: number) => void }) => {
      if (request.args.includes('--is-inside-work-tree')) {
        io.stdout('true\n')
        io.exit(0)
      } else if (request.args.includes('HEAD')) {
        io.stdout('cafe1234\n')
        io.exit(0)
      } else {
        io.exit(0)
      }
    }
    runner.enqueue(fake) // rev-parse --is-inside-work-tree
    runner.enqueue(fake) // rev-parse HEAD
    runner.enqueue(fake) // worktree add
    const source = mkdtempSync(join(tmpdir(), 'ad-git-'))
    const row = await manager.derive(source, 'task-87654321', join(source, '..', 'ws'), 24)
    expect(row.kind).toBe('worktree')
    const stored = JSON.parse(row.source!) as { repo: string; baseHead: string }
    expect(stored.baseHead).toBe('cafe1234')

    runner.enqueue(fake) // worktree remove
    runner.enqueue(fake) // branch -D
    await manager.cleanup(row)
    expect(store.get(row.id)?.status).toBe('cleaned')
  })

  it('userdir 只登记,清理仅解除登记不删目录', async () => {
    const fsx = new TempFs()
    const runner = new ScriptedRunner()
    const clock = new FixedClock()
    const store = makeWorkspaceMemoryStore()
    const manager = new WorkspaceManager(fsx, runner, clock, store)
    const dir = mkdtempSync(join(tmpdir(), 'ad-user-'))
    const row = manager.registerUserDir(dir, 'task-x')
    expect(row.kind).toBe('userdir')
    await manager.cleanup(row)
    expect(fsx.exists(dir)).toBe(true)
    expect(store.get(row.id)?.status).toBe('cleaned')
  })

  it('到期清理只处理过期行', async () => {
    const fsx = new TempFs()
    const runner = new ScriptedRunner()
    const clock = new FixedClock()
    const store = makeWorkspaceMemoryStore()
    const manager = new WorkspaceManager(fsx, runner, clock, store)
    runner.enqueue((_req, io) => io.exit(128))
    const source = mkdtempSync(join(tmpdir(), 'ad-exp-'))
    const row = await manager.derive(source, 'task-old', join(source, '..', 'ws'), 24)
    // 未到期
    expect(await manager.cleanupExpired(clock.now() + 1000)).toEqual([])
    // 到期
    const cleaned = await manager.cleanupExpired(clock.now() + 25 * 3600_000)
    expect(cleaned).toEqual([row.id])
  })
})
