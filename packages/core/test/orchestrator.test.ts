import { describe, expect, it } from 'vitest'
import { MockDriver } from '../src/drivers/mock.js'
import { Orchestrator } from '../src/orchestrator.js'
import { Registry } from '../src/registry.js'
import type { AgentProfile, TaskRecord } from '../src/types.js'

const zcodeProfile: AgentProfile = {
  id: 'zcode',
  label: 'ZCode',
  driver: 'zcode',
  entry: 'ZCode.exe resources/glm/zcode.cjs',
  models: [
    { id: 'glm-5.3', label: 'GLM 5.3' },
    { id: 'deepseek-v3', label: 'DeepSeek V3' },
  ],
  defaultModel: 'glm-5.3',
  maxConcurrency: 1,
  capabilities: { headless: true, sessionResume: true, modelSwitch: 'cli-arg' },
}

const qoderProfile: AgentProfile = {
  id: 'qoder',
  label: 'Qoder CN',
  driver: 'qoder',
  entry: 'qoderclicn',
  models: [{ id: 'qwen3.7-max', label: 'Qwen 3.7 Max' }],
  defaultModel: 'qwen3.7-max',
  maxConcurrency: 1,
  capabilities: { headless: true, sessionResume: true, modelSwitch: 'cli-arg' },
}

function build(): { orchestrator: Orchestrator; registry: Registry } {
  const registry = new Registry()
  registry.register(zcodeProfile)
  registry.register(qoderProfile)
  const orchestrator = new Orchestrator(registry)
  return { orchestrator, registry }
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function states(task: TaskRecord): string[] {
  return task.events
    .filter((e) => e.type === 'state-changed')
    .map((e) => (e.type === 'state-changed' ? e.to : ''))
}

describe('Orchestrator 任务状态机', () => {
  it('正常任务:queued → running → completed,并记录 agent 消息', async () => {
    const { orchestrator } = build()
    orchestrator.registerDriver(new MockDriver('zcode'))
    const task = orchestrator.submit('zcode', { prompt: '你好' })
    expect(task.state).toBe('queued')
    await waitFor(() => task.state === 'completed')
    expect(states(task)).toEqual(['running', 'completed'])
    expect(task.events.some((e) => e.type === 'message' && e.channel === 'agent')).toBe(true)
    expect(task.startedAt).toBeDefined()
    expect(task.finishedAt).toBeDefined()
  })

  it('驱动失败:任务置为 failed 且记录错误', async () => {
    const { orchestrator } = build()
    orchestrator.registerDriver(new MockDriver('zcode', { fail: true }))
    const task = orchestrator.submit('zcode', { prompt: '失败任务' })
    await waitFor(() => task.state === 'failed')
    expect(task.error).toContain('exited with code 1')
  })

  it('一个 agent 的驱动失败不影响另一个 agent 执行(分级隔离)', async () => {
    const { orchestrator } = build()
    orchestrator.registerDriver(new MockDriver('zcode', { fail: true }))
    orchestrator.registerDriver(new MockDriver('qoder'))
    const bad = orchestrator.submit('zcode', { prompt: '会失败' })
    const good = orchestrator.submit('qoder', { prompt: '正常任务' })
    await waitFor(() => bad.state === 'failed' && good.state === 'completed')
    expect(bad.error).toContain('exited with code 1')
    expect(good.state).toBe('completed')
  })

  it('未注册驱动:任务立即失败并带明确错误', async () => {
    const { orchestrator } = build()
    const task = orchestrator.submit('zcode', { prompt: '无驱动' })
    await waitFor(() => task.state === 'failed')
    expect(task.error).toContain('no driver registered')
  })
})

describe('模型控制', () => {
  it('缺省使用默认模型', () => {
    const { orchestrator } = build()
    const task = orchestrator.submit('zcode', { prompt: '默认模型' })
    expect(task.modelId).toBe('glm-5.3')
  })

  it('任务级覆盖模型', () => {
    const { orchestrator } = build()
    const task = orchestrator.submit('zcode', { prompt: '指定模型' }, { modelId: 'deepseek-v3' })
    expect(task.modelId).toBe('deepseek-v3')
  })

  it('非法模型被拒绝,不下发任务', () => {
    const { orchestrator } = build()
    expect(() =>
      orchestrator.submit('zcode', { prompt: '非法模型' }, { modelId: 'no-such-model' }),
    ).toThrow(/not available/)
  })

  it('注册表拒绝 defaultModel 不在模型列表的档案', () => {
    const registry = new Registry()
    expect(() =>
      registry.register({ ...zcodeProfile, id: 'bad', defaultModel: 'ghost' }),
    ).toThrow(/defaultModel/)
  })
})

describe('并发与取消', () => {
  it('maxConcurrency=1 时第二个任务排队等待', async () => {
    const { orchestrator } = build()
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 80 }))
    const first = orchestrator.submit('zcode', { prompt: '任务一' })
    await waitFor(() => first.state === 'running')
    const second = orchestrator.submit('zcode', { prompt: '任务二' })
    expect(second.state).toBe('queued')
    await waitFor(() => second.state === 'completed')
    expect(states(first)).toEqual(['running', 'completed'])
    expect(states(second)).toEqual(['running', 'completed'])
  })

  it('取消运行中任务:终态 canceled,驱动不再完成它', async () => {
    const { orchestrator } = build()
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 200 }))
    const task = orchestrator.submit('zcode', { prompt: '长任务' })
    await waitFor(() => task.state === 'running')
    expect(orchestrator.cancel(task.id)).toBe(true)
    expect(task.state).toBe('canceled')
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(task.state).toBe('canceled') // 不被 execute 收尾覆盖
  })

  it('取消排队中任务:出队并置 canceled', async () => {
    const { orchestrator } = build()
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 60 }))
    const first = orchestrator.submit('zcode', { prompt: '占位' })
    const second = orchestrator.submit('zcode', { prompt: '待取消' })
    expect(orchestrator.cancel(second.id)).toBe(true)
    expect(second.state).toBe('canceled')
    await waitFor(() => first.state === 'completed')
    expect(states(second)).toEqual(['canceled'])
  })
})