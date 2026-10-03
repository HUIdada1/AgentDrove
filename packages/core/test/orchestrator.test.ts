import { describe, expect, it } from 'vitest'
import { MockDriver } from '../src/drivers/mock.js'
import { Orchestrator } from '../src/orchestrator.js'
import { Registry } from '../src/registry.js'
import { MODEL_CLIENT_FOLLOW } from '../src/index.js'
import {
  buildHarness,
  MemoryTaskRepository,
  PassthroughSink,
  qoderProfile,
  states,
  waitFor,
  zcodeProfile,
} from './helpers.js'

describe('Orchestrator 任务状态机', () => {
  it('正常任务:queued → running → completed,并记录 agent 消息', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode'))
    const task = h.orchestrator.submit({ agentId: 'zcode', prompt: '你好' })
    expect(task.state).toBe('queued')
    await waitFor(() => task.state === 'completed')
    expect(states(task, h.repo)).toEqual(['running', 'completed'])
    expect(
      h.repo
        .eventsOf(task.id)
        .some((e) => e.event.kind === 'message' && e.event.channel === 'agent'),
    ).toBe(true)
    expect(task.startedAt).toBeDefined()
    expect(task.finishedAt).toBeDefined()
  })

  it('事件经 sink 落仓库,seq 单调递增', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode'))
    const task = h.orchestrator.submit({ agentId: 'zcode', prompt: '留档' })
    await waitFor(() => task.state === 'completed')
    const events = h.repo.eventsOf(task.id)
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
    expect(events[0].event.kind).toBe('state-changed')
  })

  it('驱动失败:任务置为 failed 且记录错误', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode', { fail: true }))
    const task = h.orchestrator.submit({ agentId: 'zcode', prompt: '失败任务' })
    await waitFor(() => task.state === 'failed')
    expect(task.error).toContain('exited with code 1')
  })

  it('一个 agent 的驱动失败不影响另一个 agent 执行(故障隔离)', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode', { fail: true }))
    h.orchestrator.registerDriver(new MockDriver('qoder'))
    const bad = h.orchestrator.submit({ agentId: 'zcode', prompt: '会失败' })
    const good = h.orchestrator.submit({ agentId: 'qoder', prompt: '正常任务' })
    await waitFor(() => bad.state === 'failed' && good.state === 'completed')
    expect(bad.error).toContain('exited with code 1')
    expect(good.state).toBe('completed')
  })

  it('未注册驱动:任务立即失败并带明确错误', async () => {
    const h = buildHarness()
    const task = h.orchestrator.submit({ agentId: 'zcode', prompt: '无驱动' })
    await waitFor(() => task.state === 'failed')
    expect(task.error).toContain('no driver registered')
  })

  it('驱动抛异常:任务 failed,错误信息留档', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode', { fail: true }))
    h.orchestrator.registerDriver({
      id: 'boom',
      async detect() {
        return null
      },
      async health() {
        return { ok: true }
      },
      resolveModelArg: () => [],
      async run() {
        throw new Error('spawn 失败')
      },
    })
    const profile = { ...zcodeProfile, id: 'boom', driver: 'boom' }
    h.registry.register(profile)
    const task = h.orchestrator.submit({ agentId: 'boom', prompt: '异常' })
    await waitFor(() => task.state === 'failed')
    expect(task.error).toBe('spawn 失败')
  })

  it('cwd 缺省且无默认工作区:入队被拒绝', () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
    })
    expect(() => orchestrator.submit({ agentId: 'zcode', prompt: '无目录' })).toThrow(/工作目录/)
  })
})

describe('模型控制', () => {
  it('modelSwitch=none 的客户端统一记哨兵 client-follow,忽略任务级模型', () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode'))
    const task = h.orchestrator.submit({
      agentId: 'zcode',
      prompt: '跟随客户端',
      modelId: 'glm-5.3',
    })
    expect(task.modelId).toBe(MODEL_CLIENT_FOLLOW)
  })

  it('cli-arg 客户端:缺省用默认模型,任务级可覆盖', () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('qoder'))
    const plain = h.orchestrator.submit({ agentId: 'qoder', prompt: '默认' })
    const override = h.orchestrator.submit({
      agentId: 'qoder',
      prompt: '覆盖',
      modelId: 'qwen3.7-max',
    })
    expect(plain.modelId).toBe('qwen3.7-max')
    expect(override.modelId).toBe('qwen3.7-max')
  })

  it('非法模型被拒绝,不下发任务', () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('qoder'))
    expect(() =>
      h.orchestrator.submit({ agentId: 'qoder', prompt: '非法', modelId: 'no-such' }),
    ).toThrow(/not available/)
  })

  it('注册表拒绝 defaultModel 不在模型目录的档案(跟随客户端哨兵除外)', () => {
    const registry = new Registry()
    expect(() =>
      registry.register({ ...qoderProfile, id: 'bad', defaultModel: 'ghost' }),
    ).toThrow(/defaultModel/)
    expect(() => registry.register(zcodeProfile)).not.toThrow()
  })

  it('套餐声明覆盖范围时以套餐为准', () => {
    const registry = new Registry()
    registry.register({
      ...qoderProfile,
      plan: { ...qoderProfile.plan, modelIds: ['qwen3.7-max'] },
    })
    expect(registry.hasModel('qoder', 'qwen3.7-max')).toBe(true)
    expect(registry.hasModel('qoder', 'other')).toBe(false)
  })
})

describe('并发与取消', () => {
  it('plan.maxConcurrency=1 时第二个任务排队等待', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 80 }))
    const first = h.orchestrator.submit({ agentId: 'zcode', prompt: '任务一' })
    await waitFor(() => first.state === 'running')
    const second = h.orchestrator.submit({ agentId: 'zcode', prompt: '任务二' })
    expect(second.state).toBe('queued')
    await waitFor(() => second.state === 'completed')
    expect(states(first, h.repo)).toEqual(['running', 'completed'])
    expect(states(second, h.repo)).toEqual(['running', 'completed'])
  })

  it('取消运行中任务:终态 canceled,驱动不再完成它', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 200 }))
    const task = h.orchestrator.submit({ agentId: 'zcode', prompt: '长任务' })
    await waitFor(() => task.state === 'running')
    expect(h.orchestrator.cancel(task.id)).toBe(true)
    expect(task.state).toBe('canceled')
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(task.state).toBe('canceled') // 不被 execute 收尾覆盖
  })

  it('取消排队中任务:出队并置 canceled', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 60 }))
    const first = h.orchestrator.submit({ agentId: 'zcode', prompt: '占位' })
    const second = h.orchestrator.submit({ agentId: 'zcode', prompt: '待取消' })
    expect(h.orchestrator.cancel(second.id)).toBe(true)
    expect(second.state).toBe('canceled')
    await waitFor(() => first.state === 'completed')
    expect(states(second, h.repo)).toEqual(['canceled'])
  })
})

describe('停用与恢复', () => {
  it('停用的 agent 拒绝新任务', () => {
    const h = buildHarness()
    h.registry.setEnabled('zcode', false)
    expect(() => h.orchestrator.submit({ agentId: 'zcode', prompt: '停用' })).toThrow(/停用/)
  })

  it('重启恢复:running → interrupted,可标记为失败', async () => {
    const first = buildHarness()
    first.orchestrator.registerDriver(new MockDriver('zcode', { hangUntilAbort: true }))
    const task = first.orchestrator.submit({ agentId: 'zcode', prompt: '强退前' })
    await waitFor(() => task.state === 'running')

    // 模拟宿主崩溃后重启:同一仓库新建编排器
    const second = new Orchestrator(first.registry, {
      repo: first.repo,
      sink: new PassthroughSink(first.repo),
      clock: first.clock,
    })
    const recovered = second.get(task.id)
    expect(recovered?.state).toBe('interrupted')
    expect(second.markFailed(task.id, '强退收敛')).toBe(true)
    expect(second.get(task.id)?.state).toBe('failed')
    expect(second.get(task.id)?.error).toBe('强退收敛')
    // interrupted 不允许复活
    expect(second.markFailed(task.id)).toBe(false)
  })

  it('重启恢复:queued 任务重新参与调度', async () => {
    const first = buildHarness()
    // 挂起任务永不收尾,模拟崩溃现场,避免旧编排器后续写库干扰断言
    first.orchestrator.registerDriver(new MockDriver('zcode', { hangUntilAbort: true }))
    const running = first.orchestrator.submit({ agentId: 'zcode', prompt: '占用' })
    const queued = first.orchestrator.submit({ agentId: 'zcode', prompt: '排队' })
    await waitFor(() => running.state === 'running')

    const second = new Orchestrator(first.registry, {
      repo: first.repo,
      sink: new PassthroughSink(first.repo),
      clock: first.clock,
    })
    second.registerDriver(new MockDriver('zcode', { delayMs: 30 }))
    await waitFor(() => {
      const state = second.get(queued.id)?.state
      return state === 'completed' || state === 'failed'
    })
    expect(second.get(queued.id)?.state).toBe('completed')
    expect(second.get(running.id)?.state).toBe('interrupted')
  })
})

describe('钩子异常隔离', () => {
  it('onRunStart 基线钩子抛错不阻断执行,任务仍完成并留 warning', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
      onRunStart: () => {
        throw new Error('基线扫描失败')
      },
    })
    orchestrator.registerDriver(new MockDriver('zcode'))
    const task = orchestrator.submit({ agentId: 'zcode', prompt: '基线异常' })
    await waitFor(() => task.state === 'completed')
    expect(
      repo
        .eventsOf(task.id)
        .some(
          (e) => e.event.kind === 'warning' && e.event.text.includes('产物基线建立失败'),
        ),
    ).toBe(true)
  })

  it('提交钩子抛错不回灌:任务仍入队并正常完成', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode'))
    h.orchestrator.onTaskSubmitted(() => {
      throw new Error('登记钩子炸了')
    })
    const task = h.orchestrator.submit({ agentId: 'zcode', prompt: '提交钩子异常' })
    await waitFor(() => task.state === 'completed')
    expect(h.orchestrator.list()).toHaveLength(1)
  })

  it('终态钩子抛错不破坏状态机,任务保持 completed', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode'))
    h.orchestrator.onTaskTerminal(() => {
      throw new Error('终态钩子炸了')
    })
    const task = h.orchestrator.submit({ agentId: 'zcode', prompt: '终态钩子异常' })
    await waitFor(() => task.state === 'completed')
    expect(states(task, h.repo)).toEqual(['running', 'completed'])
  })
})

describe('续聊派生请求', () => {
  it('submit 支持 origin/parentId/retryOf/attempt 透传落库', async () => {
    const h = buildHarness()
    h.orchestrator.registerDriver(new MockDriver('zcode', { sessionId: 'sess-12345678' }))
    const parent = h.orchestrator.submit({ agentId: 'zcode', prompt: '首轮' })
    await waitFor(() => parent.state === 'completed')
    expect(parent.sessionId).toBe('sess-12345678')

    const followUp = h.orchestrator.submit({
      agentId: 'zcode',
      prompt: '继续',
      sessionId: 'sess-12345678',
      parentId: parent.id,
      origin: 'panel',
      attempt: 2,
      retryOf: parent.id,
    })
    expect(followUp.parentId).toBe(parent.id)
    expect(followUp.sessionId).toBe('sess-12345678')
    expect(followUp.attempt).toBe(2)
    expect(followUp.retryOf).toBe(parent.id)
  })
})
