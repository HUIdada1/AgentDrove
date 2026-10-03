import { describe, expect, it } from 'vitest'
import { EventBuffer } from '../src/eventBuffer.js'
import { MemoryTaskRepository } from '../src/memory.js'
import { mergeConfig, DEFAULT_CONFIG, type AppConfig } from '../src/config.js'
import { nextDailyRun, retentionCutoffs } from '../src/retention.js'
import type { StoredEvent } from '../src/index.js'

function eventOf(taskId: string, seq: number): StoredEvent {
  return { taskId, seq, at: 0, event: { kind: 'message', channel: 'agent', text: String(seq) } }
}

describe('EventBuffer 批量策略', () => {
  it('达到 maxBatch 立即落库并批推', () => {
    const repo = new MemoryTaskRepository()
    const pushed: number[] = []
    const buffer = new EventBuffer(repo, (batch) => pushed.push(batch.length), {
      flushMs: 60_000,
      maxBatch: 3,
    })
    buffer.append([eventOf('t1', 1), eventOf('t1', 2), eventOf('t1', 3)])
    expect(repo.eventsOf('t1')).toHaveLength(3)
    expect(pushed).toEqual([3])
  })

  it('小批量在窗口到期后 flush', async () => {
    const repo = new MemoryTaskRepository()
    const pushed: number[] = []
    const buffer = new EventBuffer(repo, (batch) => pushed.push(batch.length), {
      flushMs: 30,
      maxBatch: 100,
    })
    buffer.append([eventOf('t1', 1)])
    expect(repo.eventsOf('t1')).toHaveLength(0) // 窗口内未落库
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(repo.eventsOf('t1')).toHaveLength(1)
    expect(pushed).toEqual([1])
  })

  it('flush 幂等且清空定时器', async () => {
    const repo = new MemoryTaskRepository()
    const pushed: number[] = []
    const buffer = new EventBuffer(repo, (batch) => pushed.push(batch.length), {
      flushMs: 20,
    })
    buffer.append([eventOf('t1', 1)])
    buffer.flush()
    buffer.flush()
    expect(repo.eventsOf('t1')).toHaveLength(1)
    expect(pushed).toEqual([1])
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(pushed).toEqual([1]) // 定时器被清掉,不重复推
  })

  it('落库成功但批推失败:不重复落库(幂等)', () => {
    const repo = new MemoryTaskRepository()
    let rendererDown = true
    const buffer = new EventBuffer(
      repo,
      () => {
        if (rendererDown) throw new Error('renderer down')
      },
      { flushMs: 60_000, maxBatch: 100 },
    )
    buffer.append([eventOf('t1', 1)])
    buffer.flush()
    expect(repo.eventsOf('t1')).toHaveLength(1)
    rendererDown = false
    buffer.flush()
    expect(repo.eventsOf('t1')).toHaveLength(1) // 已落库,不得重复写
  })

  it('落库失败回灌缓冲,下次 flush 补齐(不丢事件)', () => {
    class FlakyRepo extends MemoryTaskRepository {
      fail = true
      appendEvents(events: StoredEvent[]): void {
        if (this.fail) throw new Error('db down')
        super.appendEvents(events)
      }
    }
    const repo = new FlakyRepo()
    const buffer = new EventBuffer(repo, () => undefined, { flushMs: 60_000, maxBatch: 100 })
    buffer.append([eventOf('t1', 1)])
    buffer.flush()
    expect(repo.eventsOf('t1')).toHaveLength(0)
    repo.fail = false
    buffer.flush()
    expect(repo.eventsOf('t1')).toHaveLength(1)
  })

  it('deleteTask 同步清理事件,不留残留', () => {
    const repo = new MemoryTaskRepository()
    repo.appendEvents([eventOf('t1', 1)])
    repo.deleteTask('t1')
    expect(repo.eventsOf('t1')).toHaveLength(0)
  })
})

describe('Config 合并', () => {
  it('部分覆盖与默认合并,未知字段不炸', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      throttle: { minIntervalMs: 100 },
      hotkey: 'Ctrl+`',
      unknownTopLevel: 1,
    })
    expect(merged.throttle.minIntervalMs).toBe(100)
    expect(merged.throttle.globalConcurrency).toBe(DEFAULT_CONFIG.throttle.globalConcurrency)
    expect(merged.hotkey).toBe('Ctrl+`')
    expect(merged.task.defaultMode).toBe('build')
  })

  it('非对象覆盖不破坏默认', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, 'garbage')
    expect(merged).toEqual(DEFAULT_CONFIG)
  })

  it('yolo 需 Danger 开关,默认档 build', () => {
    const config: AppConfig = mergeConfig(DEFAULT_CONFIG, {
      danger: { allowYolo: true },
      task: { defaultMode: 'yolo' },
    })
    expect(config.task.defaultMode).toBe('yolo')
    expect(config.danger.allowYolo).toBe(true)
  })
})

describe('保留期', () => {
  it('默认策略为 90/180 天', () => {
    const now = 1_800_000_000_000
    const cutoffs = retentionCutoffs(now)
    expect(cutoffs.tasksBefore).toBe(now - 90 * 24 * 3600_000)
    expect(cutoffs.journalBefore).toBe(now - 180 * 24 * 3600_000)
  })

  it('每日 03:00 触发点计算', () => {
    // 2026-10-01 10:00 本地 → 次日 03:00
    const morning = new Date(2026, 9, 1, 10, 0, 0).getTime()
    const next = new Date(nextDailyRun(morning))
    expect(next.getDate()).toBe(2)
    expect(next.getHours()).toBe(3)
    // 凌晨 2 点 → 当天 03:00
    const early = new Date(2026, 9, 1, 2, 0, 0).getTime()
    const sameDay = new Date(nextDailyRun(early))
    expect(sameDay.getDate()).toBe(1)
    expect(sameDay.getHours()).toBe(3)
  })
})
