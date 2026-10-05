import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MODEL_CLIENT_FOLLOW, type TaskRecord } from '@agent-drove/core'
import { MIGRATIONS, compareTaskOrder, openStore, type StoredTask } from '../src/adapters/sqlite-repo.js'

function makeTask(partial: Partial<StoredTask> = {}): StoredTask {
  return {
    id: `t-${Math.random().toString(36).slice(2, 10)}`,
    agentId: 'zcode',
    modelId: MODEL_CLIENT_FOLLOW,
    prompt: '冒烟',
    cwd: 'C:/tmp/ws',
    state: 'queued',
    attachments: [],
    mode: 'build',
    origin: 'panel',
    createdAt: Date.now(),
    attempt: 1,
    ...partial,
  }
}

function freshStore(): { store: ReturnType<typeof openStore>['store']; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ad-order-'))
  const dbPath = join(dir, 'console.db')
  return { store: openStore(dbPath).store, dir, dbPath }
}

function backupFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('console.db.bak-'))
}

describe('迁移前整库备份(全局数据库规范)', () => {
  it('存在待执行迁移时先备份库文件,再完成迁移且旧数据保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-legacy-'))
    const dbPath = join(dir, 'console.db')
    // 手工构造 v6 历史库:只跑前 6 步迁移,插入一行旧任务(无 order_index/reasoning_effort 列)
    const legacy = new Database(dbPath)
    legacy.pragma('journal_mode = WAL')
    for (const migration of MIGRATIONS.slice(0, 6)) migration(legacy)
    legacy.pragma('user_version = 6')
    legacy
      .prepare(
        `INSERT INTO tasks (id, agent_id, model_id, prompt, cwd, state, attachments_json, mode, origin, created_at, attempt)
         VALUES ('t-legacy', 'zcode', 'client-follow', '旧数据', 'C:/old', 'completed', '[]', 'build', 'panel', 1, 1)`,
      )
      .run()
    legacy.close()

    const { store } = openStore(dbPath)
    // 备份文件已生成且非空
    const backups = backupFiles(dir)
    expect(backups).toHaveLength(1)
    expect(statSync(join(dir, backups[0]!)).size).toBeGreaterThan(0)
    // 迁移后旧数据完整读回,新列可写
    const loaded = store.getTask('t-legacy')
    expect(loaded?.prompt).toBe('旧数据')
    expect(loaded?.orderIndex).toBeUndefined()
    expect(store.reorderTask('t-legacy', null)).not.toBeNull()
    store.close()
  })

  it('无待执行迁移的重复打开不产生新备份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-nomig-'))
    const dbPath = join(dir, 'console.db')
    // 首次打开:空库从 v0 迁移,产生 1 份迁移前备份
    const first = openStore(dbPath).store
    first.close()
    expect(backupFiles(dir)).toHaveLength(1)
    // 二次打开已到最新版本,不再备份
    const second = openStore(dbPath).store
    second.close()
    expect(backupFiles(dir)).toHaveLength(1)
  })
})

describe('P0-2 组内排序语义', () => {
  it('reorderTask 相邻插入并重赋连续 orderIndex', () => {
    const { store } = freshStore()
    store.upsertProject({ id: 'proj-a', name: 'A', path: null, createdAt: 1 })
    // createdAt 倒序的展示序:c, b, a
    const a = makeTask({ id: 'a', projectId: 'proj-a', createdAt: 1 })
    const b = makeTask({ id: 'b', projectId: 'proj-a', createdAt: 2 })
    const c = makeTask({ id: 'c', projectId: 'proj-a', createdAt: 3 })
    for (const task of [a, b, c]) store.putTask(task)

    // 把 a 插到 c 之前 → a, c, b
    const moved = store.reorderTask('a', 'c')
    expect(moved?.orderIndex).toBe(0)
    expect(store.getTask('c')?.orderIndex).toBe(1)
    expect(store.getTask('b')?.orderIndex).toBe(2)
    store.close()
  })

  it('reorderTask null = 移到组尾', () => {
    const { store } = freshStore()
    store.upsertProject({ id: 'proj-a', name: 'A', path: null, createdAt: 1 })
    for (const task of [
      makeTask({ id: 'a', projectId: 'proj-a', createdAt: 1 }),
      makeTask({ id: 'b', projectId: 'proj-a', createdAt: 2 }),
      makeTask({ id: 'c', projectId: 'proj-a', createdAt: 3 }),
    ]) {
      store.putTask(task)
    }
    // 展示序 c,b,a;c 移到组尾 → b,a,c
    store.reorderTask('c', null)
    expect(store.getTask('b')?.orderIndex).toBe(0)
    expect(store.getTask('a')?.orderIndex).toBe(1)
    expect(store.getTask('c')?.orderIndex).toBe(2)
    store.close()
  })

  it('reorderTask 锚点跨分组抛错,任务不存在返回 null', () => {
    const { store } = freshStore()
    store.upsertProject({ id: 'proj-a', name: 'A', path: null, createdAt: 1 })
    store.upsertProject({ id: 'proj-b', name: 'B', path: null, createdAt: 2 })
    store.putTask(makeTask({ id: 'a', projectId: 'proj-a', createdAt: 1 }))
    store.putTask(makeTask({ id: 'b', projectId: 'proj-b', createdAt: 2 }))
    expect(() => store.reorderTask('a', 'b')).toThrow('排序锚点不在同一分组')
    expect(() => store.reorderTask('a', 'ghost')).toThrow('排序锚点不在同一分组')
    expect(store.reorderTask('ghost', null)).toBeNull()
    store.close()
  })

  it('orderIndex 空缺的组仍按 createdAt 倒序,拖过一次即整组切换手动序', () => {
    const { store } = freshStore()
    store.upsertProject({ id: 'proj-a', name: 'A', path: null, createdAt: 1 })
    for (const task of [
      makeTask({ id: 'old', projectId: 'proj-a', createdAt: 1 }),
      makeTask({ id: 'new', projectId: 'proj-a', createdAt: 2 }),
    ]) {
      store.putTask(task)
    }
    // 未排序:全部空缺(展示序由 tasks:list 的 createdAt 倒序保证)
    expect(store.getTask('old')?.orderIndex).toBeUndefined()
    expect(store.getTask('new')?.orderIndex).toBeUndefined()
    // 首次拖拽后整组获得连续值(空缺区按 createdAt 倒序随后):new=0, old=1
    store.reorderTask('old', null)
    expect(store.getTask('new')?.orderIndex).toBe(0)
    expect(store.getTask('old')?.orderIndex).toBe(1)
    store.close()
  })

  it('moveTask 换组:旧组剔除后重算,新组追加到组尾', () => {
    const { store } = freshStore()
    store.upsertProject({ id: 'proj-a', name: 'A', path: null, createdAt: 1 })
    store.upsertProject({ id: 'proj-b', name: 'B', path: null, createdAt: 2 })
    for (const task of [
      makeTask({ id: 'a1', projectId: 'proj-a', createdAt: 1 }),
      makeTask({ id: 'a2', projectId: 'proj-a', createdAt: 2 }),
      makeTask({ id: 'a3', projectId: 'proj-a', createdAt: 3 }),
      makeTask({ id: 'b1', projectId: 'proj-b', createdAt: 4 }),
    ]) {
      store.putTask(task)
    }
    const moved = store.moveTask('a2', 'proj-b')
    expect(moved?.projectId).toBe('proj-b')
    expect(moved?.orderIndex).toBe(1) // proj-b 展示序 b1,a2 → 追加组尾
    expect(store.getTask('b1')?.orderIndex).toBe(0)
    // 旧组剔除 a2 后重赋连续值:a3=0, a1=1(createdAt 倒序)
    expect(store.getTask('a3')?.orderIndex).toBe(0)
    expect(store.getTask('a1')?.orderIndex).toBe(1)
    store.close()
  })

  it('moveTask 同组无操作,任务不存在返回 null', () => {
    const { store } = freshStore()
    store.upsertProject({ id: 'proj-a', name: 'A', path: null, createdAt: 1 })
    store.putTask(makeTask({ id: 'a', projectId: 'proj-a', createdAt: 1 }))
    expect(store.moveTask('a', 'proj-a')?.orderIndex).toBeUndefined()
    expect(store.moveTask('ghost', 'proj-a')).toBeNull()
    store.close()
  })

  it('putTask 不抹掉已写 order_index(状态迁移场景)', () => {
    const { store } = freshStore()
    store.upsertProject({ id: 'proj-a', name: 'A', path: null, createdAt: 1 })
    store.putTask(makeTask({ id: 'a', projectId: 'proj-a', createdAt: 1 }))
    store.putTask(makeTask({ id: 'b', projectId: 'proj-a', createdAt: 2 }))
    store.reorderTask('a', 'b')
    expect(store.getTask('a')?.orderIndex).toBe(0)
    // 编排层的任务对象不带 orderIndex(如状态迁移/重命名后 putTask),不得覆盖手动排序位
    const loaded = store.getTask('a')!
    const { orderIndex: _dropped, ...withoutOrder } = loaded
    store.putTask({ ...withoutOrder, state: 'completed', finishedAt: 99 })
    const reloaded = store.getTask('a')
    expect(reloaded?.state).toBe('completed')
    expect(reloaded?.orderIndex).toBe(0)
    store.close()
  })
})

describe('P0-4 思考档位落库与展示序比较器', () => {
  it('reasoningEffort 持久化读回,putTask 更新不回退', () => {
    const { store } = freshStore()
    store.putTask(makeTask({ id: 'r1', reasoningEffort: 'high' }))
    expect(store.getTask('r1')?.reasoningEffort).toBe('high')
    const loaded = store.getTask('r1')!
    // 编排层任务对象始终带 reasoningEffort,更新 state 后档位保持
    store.putTask({ ...loaded, state: 'completed' })
    expect(store.getTask('r1')?.reasoningEffort).toBe('high')
    store.close()
  })

  it('compareTaskOrder:空缺按 createdAt 倒序置顶在前,手动区按 orderIndex 升序随后', () => {
    const manual0 = makeTask({ id: 'm0', createdAt: 1, orderIndex: 0 })
    const manual1 = makeTask({ id: 'm1', createdAt: 2, orderIndex: 1 })
    const fresh = makeTask({ id: 'fresh', createdAt: 100 })
    const stale = makeTask({ id: 'stale', createdAt: 50 })
    expect(compareTaskOrder(fresh, stale)).toBeLessThan(0) // 空缺区 createdAt 倒序
    expect(compareTaskOrder(fresh, manual0)).toBeLessThan(0) // 空缺区置顶在手动区之前
    expect(compareTaskOrder(manual0, manual1)).toBeLessThan(0) // 手动区 orderIndex 升序
    expect(compareTaskOrder(manual1, fresh)).toBeGreaterThan(0) // 手动区随后
  })
})
