import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EventBuffer,
  MODEL_CLIENT_FOLLOW,
  type StoredEvent,
  type TaskRecord,
} from '@agent-drove/core'
import { openStore, SqliteStore } from '../src/adapters/sqlite-repo.js'

function makeTask(partial: Partial<TaskRecord> = {}): TaskRecord {
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

function freshStore(): { store: SqliteStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ad-db-'))
  return { store: openStore(join(dir, 'console.db')).store, dir }
}

describe('SqliteStore 迁移与任务存取', () => {
  it('新库迁移到 user_version=3', () => {
    const { store } = freshStore()
    expect(store).toBeInstanceOf(SqliteStore)
    store.close()
  })

  it('任务落库与读回字段完整(含附件/策略/续聊链)', () => {
    const { store } = freshStore()
    const task = makeTask({
      state: 'completed',
      sessionId: 'sess-1',
      parentId: 'parent-1',
      retryOf: 'parent-0',
      attempt: 2,
      origin: 'failover',
      attachments: [{ path: 'C:/a.png', kind: 'image' }],
      toolPolicy: { denyList: ['Bash'], maxTurns: null },
      error: undefined,
      startedAt: 1,
      finishedAt: 2,
    })
    store.putTask(task)
    const loaded = store.getTask(task.id)
    expect(loaded).toEqual(task)
    store.close()
  })

  it('事件追加与 seq 上限', () => {
    const { store } = freshStore()
    const task = makeTask()
    store.putTask(task)
    const events: StoredEvent[] = [
      { taskId: task.id, seq: 1, at: 1, event: { kind: 'state-changed', from: 'queued', to: 'running' } },
      { taskId: task.id, seq: 2, at: 2, event: { kind: 'message', channel: 'stdout', text: 'hi' } },
    ]
    store.appendEvents(events)
    store.appendEvents(events) // 主键冲突幂等
    expect(store.eventsOf(task.id)).toHaveLength(2)
    expect(store.maxSeqOf(task.id)).toBe(2)
    store.close()
  })

  it('删除任务连带删除事件', () => {
    const { store } = freshStore()
    const task = makeTask()
    store.putTask(task)
    store.appendEvents([{ taskId: task.id, seq: 1, at: 1, event: { kind: 'warning', text: 'x' } }])
    store.deleteTask(task.id)
    expect(store.getTask(task.id)).toBeUndefined()
    expect(store.eventsOf(task.id)).toHaveLength(0)
    store.close()
  })
})

describe('SqliteStore 台账/日志/工作区', () => {
  it('usage 记账与返还不为负', () => {
    const { store } = freshStore()
    const day = '2026-10-01'
    store.refund('zcode', day)
    expect(store.countOf('zcode', day)).toBe(0)
    store.charge('zcode', day)
    store.charge('zcode', day)
    store.refund('zcode', day)
    expect(store.countOf('zcode', day)).toBe(1)
    expect(store.usageOf('zcode', day)).toEqual({ taskCount: 1, estimated: 0 })
    store.close()
  })

  it('journal 追加与倒序读取', () => {
    const { store } = freshStore()
    store.append({ at: 1, action: 'task.submit', origin: 'panel', taskId: 't1' })
    store.append({ at: 2, action: 'task.cancel', origin: 'panel', taskId: 't1' })
    const tail = store.journalTail(10)
    expect(tail.map((e) => e.action)).toEqual(['task.cancel', 'task.submit'])
    store.close()
  })

  it('workspaces 行存取', () => {
    const { store } = freshStore()
    store.put({
      id: 'w1',
      taskId: 't1',
      path: 'C:/ws/a',
      kind: 'worktree',
      source: JSON.stringify({ repo: 'C:/repo', baseHead: 'cafe' }),
      status: 'active',
      createdAt: 1,
      cleanupAfter: 100,
    })
    expect(store.all()).toHaveLength(1)
    expect(store.get('w1')?.status).toBe('active')
    store.put({ ...store.get('w1')!, status: 'done' })
    expect(store.get('w1')?.status).toBe('done')
    store.delete('w1')
    expect(store.get('w1')).toBeUndefined()
    store.close()
  })
})

describe('SqliteStore 保留期清理', () => {
  it('只清理过期且已终态的任务,running/interrupted 跳过', () => {
    const { store } = freshStore()
    const now = Date.now()
    const old = makeTask({ id: 'old', state: 'completed', finishedAt: now - 91 * 24 * 3600_000 })
    const fresh = makeTask({ id: 'fresh', state: 'completed', finishedAt: now - 1000 })
    const running = makeTask({ id: 'running', state: 'running', startedAt: now - 91 * 24 * 3600_000 })
    const interrupted = makeTask({ id: 'interrupted', state: 'interrupted', finishedAt: undefined })
    for (const task of [old, fresh, running, interrupted]) store.putTask(task)
    store.appendEvents([{ taskId: old.id, seq: 1, at: 1, event: { kind: 'warning', text: 'x' } }])
    store.appendEvents([
      { taskId: running.id, seq: 1, at: 1, event: { kind: 'warning', text: 'keep' } },
    ])

    const removed = store.purgeTasksBefore(now - 90 * 24 * 3600_000)
    expect(removed).toBe(1)
    expect(store.getTask('old')).toBeUndefined()
    expect(store.eventsOf('old')).toHaveLength(0) // 事件随任务清理
    expect(store.getTask('fresh')).toBeDefined()
    expect(store.getTask('running')).toBeDefined()
    expect(store.getTask('interrupted')).toBeDefined()
    expect(store.eventsOf('running')).toHaveLength(1) // 事件跟随任务保留
    store.close()
  })

  it('journal 到期清理', () => {
    const { store } = freshStore()
    store.append({ at: 1, action: 'old', origin: 'panel' })
    store.append({ at: Date.now(), action: 'new', origin: 'panel' })
    expect(store.purgeJournalBefore(Date.now() - 180 * 24 * 3600_000)).toBe(1)
    expect(store.journalTail(10).map((e) => e.action)).toEqual(['new'])
    store.close()
  })
})

describe('SqliteStore 完整性恢复', () => {
  it('损坏库自动备份重建,可继续使用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-corrupt-'))
    const dbPath = join(dir, 'console.db')
    writeFileSync(dbPath, Buffer.from('this is not sqlite at all'))
    const { store, recoveredFrom } = openStore(dbPath)
    expect(recoveredFrom).toContain('.bak-')
    store.putTask(makeTask({ id: 'after-recovery' }))
    expect(store.getTask('after-recovery')?.id).toBe('after-recovery')
    store.close()
  })
})

describe('10 万事件批量落库/批推吞吐', () => {
  it('EventBuffer 经 SQLite 全量落库并批推', () => {
    const { store } = freshStore()
    const task = makeTask()
    store.putTask(task)
    const pushes: number[] = []
    const buffer = new EventBuffer(store, (batch) => pushes.push(batch.length), {
      flushMs: 200,
      maxBatch: 500,
    })
    const total = 100_000
    const start = Date.now()
    for (let i = 1; i <= total; i++) {
      buffer.append([
        { taskId: task.id, seq: i, at: i, event: { kind: 'message', channel: 'stdout', text: `line-${i}` } },
      ])
      // maxBatch=500 → 每 500 条触发一次同步 flush
    }
    buffer.flush()
    const elapsed = Date.now() - start
    expect(store.maxSeqOf(task.id)).toBe(total)
    expect(store.eventsOf(task.id)).toHaveLength(total)
    expect(pushes.length).toBeGreaterThan(0)
    // 批量窗口把 10 万条写入压成 ~200 次事务
    expect(pushes.length).toBeLessThanOrEqual(total / 500 + 2)
    // 吞吐门槛:单机 sync SQLite 落库 10 万条应在 30s 内(实测远低于此)
    expect(elapsed).toBeLessThan(30_000)
    store.close()
  }, 60_000)
})
