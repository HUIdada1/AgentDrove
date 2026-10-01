import { describe, expect, it } from 'vitest'
import { Launcher } from '../src/launcher.js'
import { HealthCheckService } from '../src/healthCheck.js'
import { MockDriver } from '../src/drivers/mock.js'
import { Orchestrator } from '../src/orchestrator.js'
import { Registry } from '../src/registry.js'
import type { AgentProfile } from '../src/index.js'
import {
  FixedClock,
  MemoryTaskRepository,
  PassthroughSink,
  qoderProfile,
  waitFor,
  zcodeProfile,
} from './helpers.js'

describe('Launcher 唤起', () => {
  const zcodeProfileForLaunch: AgentProfile = {
    ...zcodeProfile,
    entry: 'E:/ZCode/ZCode.exe',
  }

  it('有 deep link 的客户端优先 openExternal', async () => {
    const calls: string[] = []
    const launcher = new Launcher({
      openExternal: async (target) => {
        calls.push(`external:${target}`)
      },
      spawnDetached: (entry) => {
        calls.push(`spawn:${entry}`)
      },
    })
    const channel = await launcher.launchClient(zcodeProfileForLaunch)
    expect(channel).toBe('deep-link')
    expect(calls).toEqual(['external:zcode://'])
  })

  it('deep link 失败回退 spawn detached', async () => {
    const calls: string[] = []
    const launcher = new Launcher({
      openExternal: async () => {
        throw new Error('no protocol handler')
      },
      spawnDetached: (entry) => {
        calls.push(`spawn:${entry}`)
      },
    })
    const channel = await launcher.launchClient(zcodeProfileForLaunch)
    expect(channel).toBe('spawn')
    expect(calls).toEqual(['spawn:E:/ZCode/ZCode.exe'])
  })

  it('无 deep link 的客户端(qoder)直接 spawn', async () => {
    const calls: string[] = []
    const launcher = new Launcher({
      openExternal: async (target) => {
        calls.push(`external:${target}`)
      },
      spawnDetached: (entry) => {
        calls.push(`spawn:${entry}`)
      },
    })
    const channel = await launcher.launchClient({ ...qoderProfile, entry: 'Qoder.exe' })
    expect(channel).toBe('spawn')
    expect(calls).toEqual(['spawn:Qoder.exe'])
  })
})

describe('HealthCheckService TTL 缓存', () => {
  function makeService(ttlMs = 60_000) {
    const clock = new FixedClock()
    let probeCount = 0
    const service = new HealthCheckService(
      async (agentId) => {
        probeCount++
        return agentId === 'bad' ? { ok: false, reason: '未登录' } : { ok: true }
      },
      ttlMs,
      () => clock.now(),
    )
    return { service, clock, count: () => probeCount }
  }

  it('TTL 内命中缓存,不重复探活', async () => {
    const { service, clock, count } = makeService()
    await service.check('zcode')
    clock.advance(30_000)
    await service.check('zcode')
    expect(count()).toBe(1)
  })

  it('TTL 过期重新探活', async () => {
    const { service, clock, count } = makeService()
    await service.check('zcode')
    clock.advance(61_000)
    await service.check('zcode')
    expect(count()).toBe(2)
  })

  it('bypassCache 强制绕过(重查/降级筛选场景)', async () => {
    const { service, count } = makeService()
    await service.check('zcode')
    await service.check('zcode', { bypassCache: true })
    expect(count()).toBe(2)
  })

  it('不健康结果同样缓存,手动失效后重查', async () => {
    const { service, count } = makeService()
    const first = await service.check('bad')
    expect(first.ok).toBe(false)
    expect((await service.check('bad')).reason).toBe('未登录')
    expect(count()).toBe(1)
    service.invalidate('bad')
    await service.check('bad')
    expect(count()).toBe(2)
  })

  it('探活抛错收敛为不健康报告而非拒绝服务', async () => {
    const service = new HealthCheckService(
      async () => {
        throw new Error('CLI 崩溃')
      },
      60_000,
      () => 0,
    )
    const report = await service.check('zcode')
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('CLI 崩溃')
  })

  it('并发探活去重', async () => {
    let probeCount = 0
    const service = new HealthCheckService(
      async () => {
        probeCount++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { ok: true }
      },
      60_000,
    )
    const [a, b] = await Promise.all([service.check('zcode'), service.check('zcode')])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(probeCount).toBe(1)
  })
})

describe('续聊链', () => {
  it('running 父任务拒绝续聊', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 100 }))
    const running = orchestrator.submit({ agentId: 'zcode', prompt: '首轮' })
    await waitFor(() => running.state === 'running')
    expect(() => orchestrator.continueConversation(running.id, '继续')).toThrow(/运行中/)
  })

  it('有会话 id:透传并记 parent 链;无会话 id:降级 -c 语义', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('zcode', { sessionId: 'sess-abc12345' }))
    const first = orchestrator.submit({ agentId: 'zcode', prompt: '首轮' })
    await waitFor(() => first.state === 'completed')

    const second = orchestrator.continueConversation(first.id, '继续深入')
    expect(second.parentId).toBe(first.id)
    expect(second.sessionId).toBe('sess-abc12345')
    expect(second.cwd).toBe(first.cwd)
    await waitFor(() => second.state === 'completed')

    // second 的驱动模拟未提取到会话 id → 续聊降级 resumeLatest(-c)
    // third 继承 second 已知的会话 id
    const third = orchestrator.continueConversation(second.id, '再继续')
    expect(third.parentId).toBe(second.id)
    expect(third.sessionId).toBe('sess-abc12345')
  })

  it('驱动未产出会话 id 的任务续聊走 -c 降级路径', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    let seenInput: Record<string, unknown> = {}
    orchestrator.registerDriver({
      id: 'zcode',
      async detect() {
        return null
      },
      async health() {
        return { ok: true }
      },
      resolveModelArg: () => [],
      async run(options) {
        seenInput = { ...options.input }
        return { code: 0 }
      },
    })
    const first = orchestrator.submit({ agentId: 'zcode', prompt: '无会话输出' })
    await waitFor(() => first.state === 'completed')
    const followUp = orchestrator.continueConversation(first.id, '续')
    await waitFor(() => followUp.state === 'completed')
    expect(seenInput.sessionId).toBeUndefined()
    expect(seenInput.resumeLatest).toBe(true)
  })
})
