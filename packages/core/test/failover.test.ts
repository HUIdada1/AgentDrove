import { describe, expect, it } from 'vitest'
import { Failover } from '../src/failover.js'
import { Orchestrator } from '../src/orchestrator.js'
import { Registry } from '../src/registry.js'
import { MODEL_CLIENT_FOLLOW, type AgentProfile, type TaskRecord } from '../src/index.js'
import {
  FixedClock,
  MemoryTaskRepository,
  PassthroughSink,
  waitFor,
  zcodeProfile,
  qoderProfile,
} from './helpers.js'
import { MockDriver } from '../src/drivers/mock.js'

function setup(config = { enabled: true, maxRetries: 1 }) {
  const registry = new Registry()
  registry.register(zcodeProfile)
  registry.register(qoderProfile)
  const repo = new MemoryTaskRepository()
  const clock = new FixedClock()
  const orchestrator = new Orchestrator(registry, {
    repo,
    sink: new PassthroughSink(repo),
    clock,
    defaultCwd: 'C:/tmp/ws',
  })
  const failover = new Failover(registry, orchestrator, config)
  return { registry, orchestrator, failover, repo, clock }
}

function failedTask(agentId: string): TaskRecord {
  return {
    id: 'parent-1',
    agentId,
    modelId: agentId === 'zcode' ? MODEL_CLIENT_FOLLOW : 'qwen3.7-max',
    prompt: '失败任务',
    cwd: 'C:/tmp/ws',
    state: 'failed',
    attachments: [],
    mode: 'build',
    origin: 'panel',
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
    attempt: 1,
  }
}

const healthyCtx = {
  healthOf: async () => ({ ok: true }),
  runningCwds: () => new Set<string>(),
  chargedToday: () => 0,
}

describe('Failover 候选筛选', () => {
  it('自动降级:换端派生,attempt+1、retry_of 记链、origin=failover', async () => {
    const { failover } = setup()
    const outcome = await failover.deriveFor(failedTask('zcode'), healthyCtx)
    const derived = outcome.derived
    expect(derived).not.toBeNull()
    expect(derived?.agentId).toBe('qoder')
    expect(derived?.attempt).toBe(2)
    expect(derived?.retryOf).toBe('parent-1')
    expect(derived?.origin).toBe('failover')
  })

  it('排除故障源客户端', async () => {
    const setup1 = setup()
    setup1.registry.setEnabled('qoder', false)
    const outcome = await setup1.failover.deriveFor(failedTask('zcode'), healthyCtx)
    expect(outcome.derived).toBeNull()
    expect(outcome.reason).toBe('无可用降级目标')
  })

  it('跳过不健康的候选', async () => {
    const { failover } = setup()
    const ctx = {
      ...healthyCtx,
      healthOf: async (agent: AgentProfile) =>
        agent.id === 'qoder' ? { ok: false, reason: '未登录' } : { ok: true },
    }
    const outcome = await failover.deriveFor(failedTask('zcode'), ctx)
    expect(outcome.derived).toBeNull()
  })

  it('跳过当日已满额的候选', async () => {
    const { failover } = setup()
    const ctx = {
      ...healthyCtx,
      chargedToday: (agent: AgentProfile) =>
        agent.id === 'qoder' ? agent.plan.dailyTaskCap : 0,
    }
    const outcome = await failover.deriveFor(failedTask('zcode'), ctx)
    expect(outcome.derived).toBeNull()
  })

  it('工作区被 running 任务占用时不降级', async () => {
    const { failover } = setup()
    const ctx = { ...healthyCtx, runningCwds: () => new Set(['C:/tmp/ws']) }
    const outcome = await failover.deriveFor(failedTask('zcode'), ctx)
    expect(outcome.derived).toBeNull()
    expect(outcome.reason).toContain('占用')
  })

  it('目标不支持附件时跳过;全不支持则不降级', async () => {
    const { failover, registry } = setup()
    registry.setEnabled('qoder', false)
    // 只剩 qoder 一个候选且不支持附件
    registry.register({
      ...qoderProfile,
      id: 'qoder2',
      driver: 'qoder',
      capabilities: { ...qoderProfile.capabilities, attachments: false },
    })
    const task = { ...failedTask('zcode'), attachments: [{ path: 'C:/a.png', kind: 'image' as const }] }
    const outcome = await failover.deriveFor(task, healthyCtx)
    expect(outcome.derived).toBeNull()
  })

  it('已达最大降级次数不再派生', async () => {
    const { failover } = setup({ enabled: true, maxRetries: 1 })
    const task = { ...failedTask('zcode'), attempt: 2 }
    const outcome = await failover.deriveFor(task, healthyCtx)
    expect(outcome.derived).toBeNull()
    expect(outcome.reason).toContain('最大降级次数')
  })

  it('failover 未开启时直接放弃', async () => {
    const { failover } = setup({ enabled: false, maxRetries: 1 })
    const outcome = await failover.deriveFor(failedTask('zcode'), healthyCtx)
    expect(outcome.derived).toBeNull()
  })

  it('模型映射到目标 default_model;zcode 目标为哨兵', async () => {
    const { failover } = setup()
    const fromQoder = await failover.deriveFor(failedTask('qoder'), healthyCtx)
    expect(fromQoder.derived?.agentId).toBe('zcode')
    expect(fromQoder.derived?.modelId).toBe(MODEL_CLIENT_FOLLOW)
    const fromZcode = await failover.deriveFor(failedTask('zcode'), healthyCtx)
    expect(fromZcode.derived?.modelId).toBe('qwen3.7-max')
  })

  it('换端不继承 sessionId(会话命名空间不互通)', async () => {
    const { failover } = setup()
    const task = { ...failedTask('zcode'), sessionId: 'sess-only-in-zcode' }
    const outcome = await failover.deriveFor(task, healthyCtx)
    expect(outcome.derived?.sessionId).toBeUndefined()
  })
})

describe('attachFailover 终态联动', () => {
  it('编排器任务 failed 时自动派生降级任务', async () => {
    const { orchestrator, failover, registry } = setup()
    orchestrator.registerDriver(new MockDriver('zcode', { fail: true }))
    orchestrator.registerDriver(new MockDriver('qoder'))
    const failoverModule = failover
    const { attachFailover } = await import('../src/failover.js')
    attachFailover(orchestrator, failoverModule, healthyCtx)
    void registry
    const task = orchestrator.submit({ agentId: 'zcode', prompt: '会失败' })
    await waitFor(() => task.state === 'failed')
    await waitFor(() => {
      const derived = orchestrator
        .list()
        .find((t) => t.retryOf === task.id && t.origin === 'failover')
      return derived?.state === 'completed'
    })
    const derived = orchestrator.list().find((t) => t.retryOf === task.id)
    expect(derived?.agentId).toBe('qoder')
  })
})
