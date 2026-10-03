import { describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/orchestrator.js'
import { Registry } from '../src/registry.js'
import { Throttle } from '../src/throttle.js'
import { MemoryUsageLedger, localDayOf } from '../src/usage.js'
import { MODEL_CLIENT_FOLLOW, type AgentProfile } from '../src/index.js'
import { MockDriver } from '../src/drivers/mock.js'
import {
  MemoryTaskRepository,
  PassthroughSink,
  waitFor,
  zcodeProfile,
  qoderProfile,
} from './helpers.js'

function setup(options: {
  dailyTaskCap?: number
  globalConcurrency?: number
  minIntervalMs?: number
  jitterMs?: number
  maxConcurrency?: number
}) {
  const registry = new Registry()
  const cap = options.dailyTaskCap ?? 100
  const concurrency = options.maxConcurrency ?? 1
  const zcode: AgentProfile = {
    ...zcodeProfile,
    plan: { ...zcodeProfile.plan, dailyTaskCap: cap, maxConcurrency: concurrency },
  }
  registry.register(zcode)
  registry.register({ ...qoderProfile, plan: { ...qoderProfile.plan, dailyTaskCap: cap, maxConcurrency: concurrency } })
  const repo = new MemoryTaskRepository()
  const ledger = new MemoryUsageLedger()
  const throttle = new Throttle(ledger, { now: () => Date.now(), monotonic: () => performance.now() }, {
    globalConcurrency: options.globalConcurrency ?? 8,
    minIntervalMs: options.minIntervalMs ?? 0,
    jitterMs: options.jitterMs ?? 0,
  })
  const orchestrator = new Orchestrator(registry, {
    repo,
    sink: new PassthroughSink(repo),
    defaultCwd: 'C:/tmp/ws',
    throttle,
  })
  return { registry, orchestrator, throttle, ledger, repo }
}

describe('编排器 × 节流器', () => {
  it('cap 入队硬闸:超限直接拒绝,不产生任务记录', () => {
    const { orchestrator, ledger } = setup({ dailyTaskCap: 1 })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 5 }))
    const first = orchestrator.submit({ agentId: 'zcode', prompt: '第一条' })
    expect(first.state).toBe('queued')
    expect(() =>
      orchestrator.submit({ agentId: 'zcode', prompt: '第二条' }),
    ).toThrow(/上限/)
    expect(orchestrator.list()).toHaveLength(1)
    expect(ledger.countOf('zcode', localDayOf(Date.now()))).toBe(1)
  })

  it('排队取消返还当日计数;running 取消不返还', async () => {
    const { orchestrator, ledger } = setup({ dailyTaskCap: 10 })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 60 }))
    const running = orchestrator.submit({ agentId: 'zcode', prompt: '占用' })
    const queued = orchestrator.submit({ agentId: 'zcode', prompt: '排队' })
    await waitFor(() => running.state === 'running')
    expect(orchestrator.cancel(queued.id)).toBe(true)
    expect(ledger.countOf('zcode', localDayOf(Date.now()))).toBe(1)
    expect(orchestrator.cancel(running.id)).toBe(true)
    expect(ledger.countOf('zcode', localDayOf(Date.now()))).toBe(1)
  })

  it('暂停闸:drain 不放行新任务,恢复后按队列继续', async () => {
    const { orchestrator } = setup({})
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 30 }))
    orchestrator.setPaused(true)
    const task = orchestrator.submit({ agentId: 'zcode', prompt: '暂停中' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(task.state).toBe('queued')
    orchestrator.setPaused(false)
    await waitFor(() => task.state === 'completed')
  })

  it('暂停状态可查询(组合根负责持久化)', async () => {
    const { orchestrator } = setup({})
    orchestrator.setPaused(true)
    expect(orchestrator.isPaused()).toBe(true)
    orchestrator.setPaused(false)
    expect(orchestrator.isPaused()).toBe(false)
  })

  it('全局并发=1 时另一客户端的任务等待', async () => {
    const { orchestrator } = setup({ globalConcurrency: 1 })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 60 }))
    orchestrator.registerDriver(new MockDriver('qoder', { delayMs: 20 }))
    const first = orchestrator.submit({ agentId: 'zcode', prompt: '占全局槽' })
    const second = orchestrator.submit({ agentId: 'qoder', prompt: '等待中' })
    await waitFor(() => first.state === 'running')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(second.state).toBe('queued')
    await waitFor(() => second.state === 'completed')
  })

  it('同 cwd 互斥:不同客户端同工作区串行(按任务状态判定)', async () => {
    const { orchestrator } = setup({ globalConcurrency: 4 })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 60 }))
    orchestrator.registerDriver(new MockDriver('qoder', { delayMs: 20 }))
    const first = orchestrator.submit({ agentId: 'zcode', prompt: '先占' })
    const second = orchestrator.submit({
      agentId: 'qoder',
      prompt: '同工作区',
      cwd: 'C:/tmp/ws',
    })
    await waitFor(() => first.state === 'running')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(second.state).toBe('queued')
    await waitFor(() => second.state === 'completed')
    expect(first.finishedAt).toBeLessThanOrEqual(second.startedAt!)
  })

  it('公平放行:cwd 被占时跳过该任务放行后续不同 cwd 的任务', async () => {
    const { orchestrator } = setup({ globalConcurrency: 4, maxConcurrency: 4 })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 80 }))
    const blocked = orchestrator.submit({ agentId: 'zcode', prompt: '同目录', cwd: 'C:/tmp/ws' })
    const bypass = orchestrator.submit({
      agentId: 'zcode',
      prompt: '其他目录',
      cwd: 'C:/tmp/other',
    })
    await waitFor(() => blocked.state === 'running')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(bypass.state).toBe('running')
  })

  it('每客户端节拍:同客户端第二任务等间隔后放行', async () => {
    const { orchestrator } = setup({ minIntervalMs: 120 })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 10 }))
    const first = orchestrator.submit({ agentId: 'zcode', prompt: '首任务' })
    const second = orchestrator.submit({ agentId: 'zcode', prompt: '次任务' })
    await waitFor(() => first.state === 'completed')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(second.state).toBe('queued') // 间隔未到
    await waitFor(() => second.state === 'completed') // 节拍定时器到点放行
  })

  it('驱动缺失:queued→failed 并返还计数', () => {
    const { orchestrator, ledger } = setup({ dailyTaskCap: 10 })
    const task = orchestrator.submit({ agentId: 'zcode', prompt: '无驱动' })
    return waitFor(() => task.state === 'failed').then(() => {
      expect(task.error).toContain('no driver registered')
      expect(ledger.countOf('zcode', localDayOf(Date.now()))).toBe(0)
    })
  })

  it('放行健康闸不通过:任务 failed、计数返还、错误带原因', async () => {
    const registry = new Registry()
    registry.register({ ...zcodeProfile })
    const repo = new MemoryTaskRepository()
    const ledger = new MemoryUsageLedger()
    const throttle = new Throttle(ledger, { now: () => Date.now(), monotonic: () => performance.now() }, {
      globalConcurrency: 4,
      minIntervalMs: 0,
      jitterMs: 0,
    })
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
      throttle,
      healthAtRelease: async () => ({ ok: false, reason: '未登录' }),
    })
    orchestrator.registerDriver(new MockDriver('zcode'))
    const task = orchestrator.submit({ agentId: 'zcode', prompt: '不健康场景' })
    await waitFor(() => task.state === 'failed')
    expect(task.error).toContain('客户端不健康')
    expect(task.error).toContain('未登录')
    expect(ledger.countOf('zcode', localDayOf(Date.now()))).toBe(0)
    expect(task.startedAt).toBeUndefined() // 未运行即失败
  })

  it('modelSwitch=none 的档案任务统一记哨兵', () => {
    const { orchestrator } = setup({})
    orchestrator.registerDriver(new MockDriver('zcode'))
    const task = orchestrator.submit({ agentId: 'zcode', prompt: '哨兵' })
    expect(task.modelId).toBe(MODEL_CLIENT_FOLLOW)
  })
})

describe('放行窗口占槽(健康闸期间不超发)', () => {
  it('全局并发=1:健康探活窗口内第二个任务不得并行执行', async () => {
    const registry = new Registry()
    registry.register({ ...zcodeProfile, plan: { ...zcodeProfile.plan, maxConcurrency: 4 } })
    const repo = new MemoryTaskRepository()
    const throttle = new Throttle(
      new MemoryUsageLedger(),
      { now: () => Date.now(), monotonic: () => performance.now() },
      { globalConcurrency: 1, minIntervalMs: 0, jitterMs: 0 },
    )
    let active = 0
    let maxActive = 0
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
      throttle,
      healthAtRelease: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return { ok: true }
      },
    })
    orchestrator.registerDriver({
      id: 'zcode',
      async detect() {
        return null
      },
      async health() {
        return { ok: true }
      },
      resolveModelArg: () => [],
      async run() {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 30))
        active--
        return { code: 0 }
      },
    })
    const first = orchestrator.submit({ agentId: 'zcode', prompt: 'a', cwd: 'C:/tmp/ws' })
    const second = orchestrator.submit({ agentId: 'zcode', prompt: 'b', cwd: 'C:/tmp/other' })
    await waitFor(() => first.state === 'completed' && second.state === 'completed')
    expect(maxActive).toBe(1)
  })

  it('取消 running 立即释放槽位,不等驱动收尾', async () => {
    const registry = new Registry()
    registry.register({ ...zcodeProfile, plan: { ...zcodeProfile.plan, maxConcurrency: 1 } })
    const repo = new MemoryTaskRepository()
    const throttle = new Throttle(
      new MemoryUsageLedger(),
      { now: () => Date.now(), monotonic: () => performance.now() },
      { globalConcurrency: 4, minIntervalMs: 0, jitterMs: 0 },
    )
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
      throttle,
    })
    // 忽略 abort、永不收尾的驱动:模拟挂死进程
    orchestrator.registerDriver({
      id: 'zcode',
      async detect() {
        return null
      },
      async health() {
        return { ok: true }
      },
      resolveModelArg: () => [],
      run: () => new Promise<never>(() => {}),
    })
    const running = orchestrator.submit({ agentId: 'zcode', prompt: '挂死', cwd: 'C:/tmp/ws' })
    await waitFor(() => running.state === 'running')
    const queued = orchestrator.submit({ agentId: 'zcode', prompt: '等待', cwd: 'C:/tmp/other' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(queued.state).toBe('queued')
    expect(orchestrator.cancel(running.id)).toBe(true)
    await waitFor(() => queued.state === 'running')
  })
})
