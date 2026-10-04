import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SqliteStore } from '../src/adapters/sqlite-repo.js'
import type { TaskRecord, TaskUsage } from '@agent-drove/core'

describe('用量统计与缓存命中率验证 (Usage Tracking & Cache Hit Rate)', () => {
  it('SQLite 能够完整持久化并读出 TaskUsage 及其缓存命中率', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agentdrove-usage-test-'))
    const dbPath = join(tempDir, 'test.db')
    try {
      const store = new SqliteStore(dbPath)

      const sampleUsage: TaskUsage = {
        inputTokens: 12500,
        outputTokens: 850,
        cachedTokens: 10200,
        credits: 14.2,
        cacheHitRate: 44.9, // 10200 / (12500 + 10200) * 100
      }

      const task: TaskRecord = {
        id: 'task-usage-1',
        agentId: 'zcode',
        modelId: 'client-follow',
        prompt: '测试用量保存',
        cwd: 'C:\\test',
        state: 'completed',
        attachments: [],
        mode: 'build',
        origin: 'panel',
        createdAt: Date.now() - 1000,
        finishedAt: Date.now(),
        attempt: 1,
        usage: sampleUsage,
      }

      store.putTask(task)

      const retrieved = store.getTask('task-usage-1')
      expect(retrieved).toBeDefined()
      expect(retrieved?.usage).toEqual(sampleUsage)
      expect(retrieved?.usage?.cachedTokens).toBe(10200)
      expect(retrieved?.usage?.cacheHitRate).toBe(44.9)
      expect(retrieved?.usage?.credits).toBe(14.2)

      store.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('agentUsageStats 能正确聚合客户端指定时间以来的消耗与平均缓存命中率', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agentdrove-usage-stats-'))
    const dbPath = join(tempDir, 'test.db')
    try {
      const store = new SqliteStore(dbPath)
      const now = Date.now()
      const since = now - 3600_000

      // 任务 1: 输入 1000, 输出 200, 缓存读取 4000, 点数 5.2
      const task1: TaskRecord = {
        id: 'task-stat-1',
        agentId: 'codex',
        modelId: 'gpt-4o',
        prompt: '任务 1',
        cwd: 'C:\\test',
        state: 'completed',
        attachments: [],
        mode: 'build',
        origin: 'panel',
        createdAt: now - 1800_000,
        attempt: 1,
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cachedTokens: 4000,
          credits: 5.2,
          cacheHitRate: 80, // 4000 / (1000 + 4000)
        },
      }

      // 任务 2: 输入 3000, 输出 500, 缓存读取 2000, 点数 5.5
      const task2: TaskRecord = {
        id: 'task-stat-2',
        agentId: 'codex',
        modelId: 'gpt-4o',
        prompt: '任务 2',
        cwd: 'C:\\test',
        state: 'completed',
        attachments: [],
        mode: 'build',
        origin: 'panel',
        createdAt: now - 600_000,
        attempt: 1,
        usage: {
          inputTokens: 3000,
          outputTokens: 500,
          cachedTokens: 2000,
          credits: 5.5,
          cacheHitRate: 40, // 2000 / (3000 + 2000)
        },
      }

      // 任务 3: 属于其他客户端，不应被计入
      const task3: TaskRecord = {
        id: 'task-stat-3',
        agentId: 'qoder',
        modelId: 'qmodel_38max',
        prompt: '任务 3',
        cwd: 'C:\\test',
        state: 'completed',
        attachments: [],
        mode: 'build',
        origin: 'panel',
        createdAt: now - 300_000,
        attempt: 1,
        usage: {
          inputTokens: 2000,
          outputTokens: 400,
          cachedTokens: 1000,
          credits: 3.4,
          cacheHitRate: 33.3,
        },
      }

      store.putTask(task1)
      store.putTask(task2)
      store.putTask(task3)

      const stats = store.agentUsageStats('codex', since)

      // 总 tokens = 1000 + 200 + 4000 + 3000 + 500 + 2000 = 10700
      expect(stats.usedTokens).toBe(10700)
      // 总点数 = 5.2 + 5.5 = 10.7
      expect(stats.usedCredits).toBe(10.7)
      // 总缓存读取 tokens = 4000 + 2000 = 6000
      expect(stats.cachedTokens).toBe(6000)
      // 综合缓存命中率 = 6000 / ((1000 + 3000) + 6000) = 6000 / 10000 = 60%
      expect(stats.cacheHitRate).toBe(60)

      store.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
