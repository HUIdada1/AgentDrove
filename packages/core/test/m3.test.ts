import { describe, expect, it } from 'vitest'
import { Launcher } from '../src/launcher.js'
import { HealthCheckService } from '../src/healthCheck.js'
import { MockDriver } from '../src/drivers/mock.js'
import { Orchestrator } from '../src/orchestrator.js'
import { Registry } from '../src/registry.js'
import { satisfiesRange } from '../src/version.js'
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

  it('续聊继承父任务 toolPolicy,工具策略不静默丢失', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('zcode', { sessionId: 'sess-tools1234' }))
    const first = orchestrator.submit({
      agentId: 'zcode',
      prompt: '首轮',
      toolPolicy: { denyList: ['rm'], maxTurns: 3 },
    })
    await waitFor(() => first.state === 'completed')
    const followUp = orchestrator.continueConversation(first.id, '继续')
    expect(followUp.toolPolicy).toEqual({ denyList: ['rm'], maxTurns: 3 })
  })
})

describe('版本范围解析', () => {
  it('容忍客户端版本后缀(0.16.9-beta)', () => {
    expect(satisfiesRange('0.16.9-beta', '>=0.16 <0.17')).toBe(true)
  })

  it('空范围视为全部放行', () => {
    expect(satisfiesRange('1.0.0', '')).toBe(true)
  })

  it('越界与非法子句返回 false', () => {
    expect(satisfiesRange('0.15.0', '>=0.16')).toBe(false)
    expect(satisfiesRange('0.16.0', '^0.16')).toBe(false)
  })
})

describe('Registry 重扫重建', () => {
  it('unregister 移除旧档案后可重新登记,id 不存在时静默(重扫幂等前提)', () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    registry.unregister(zcodeProfile.id)
    expect(() => registry.get(zcodeProfile.id)).toThrow('unknown agent')
    expect(() => registry.unregister('no-such-agent')).not.toThrow()
    registry.register({ ...zcodeProfile, version: '0.16.10' })
    expect(registry.get(zcodeProfile.id).version).toBe('0.16.10')
  })
})

describe('任务运行中追问排队与自动接续 (Followup Queue)', () => {
  it('running 父任务支持排队追问，完成时自动接续派发新任务', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 80, sessionId: 'sess-q1' }))
    const first = orchestrator.submit({ agentId: 'zcode', prompt: '第一步' })
    await waitFor(() => first.state === 'running')

    const followup = orchestrator.continueConversation(first.id, '第二步追问', {
      queueIfRunning: true,
    }) as any
    expect(followup.id).toBeDefined()
    expect(followup.prompt).toBe('第二步追问')
    expect(orchestrator.getFollowups(first.id)).toHaveLength(1)

    await waitFor(() => first.state === 'completed')

    await waitFor(() => {
      const all = orchestrator.list()
      return all.some((t) => t.parentId === first.id && t.prompt === '第二步追问')
    })
    const second = orchestrator.list().find((t) => t.parentId === first.id)!
    expect(second.sessionId).toBe('sess-q1')
    expect(orchestrator.getFollowups(first.id)).toHaveLength(0)
  })

  it('支持主动移除排队消息与清空排队', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 200 }))
    const first = orchestrator.submit({ agentId: 'zcode', prompt: '任务A' })
    await waitFor(() => first.state === 'running')

    const item1 = orchestrator.enqueueFollowup(first.id, '追问1')
    const item2 = orchestrator.enqueueFollowup(first.id, '追问2')
    expect(orchestrator.getFollowups(first.id)).toHaveLength(2)

    expect(orchestrator.removeFollowup(first.id, item1.id)).toBe(true)
    expect(orchestrator.getFollowups(first.id)).toHaveLength(1)
    expect(orchestrator.getFollowups(first.id)[0]!.id).toBe(item2.id)

    orchestrator.clearFollowups(first.id)
    expect(orchestrator.getFollowups(first.id)).toHaveLength(0)
  })

  it('migrateFollowups:打断发送后把遗留排队项整体迁移到新任务(P0-6 复审)', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 200 }))
    const first = orchestrator.submit({ agentId: 'zcode', prompt: '被打断的任务' })
    await waitFor(() => first.state === 'running')

    const kept = orchestrator.enqueueFollowup(first.id, '问1', undefined, { reasoningEffort: 'high' })
    const dropped = orchestrator.enqueueFollowup(first.id, '问2')
    expect(orchestrator.getFollowups(first.id)).toHaveLength(2)

    // 模拟打断发送:取消父任务(clearFollowups=false)后显式续聊发出 dropped 那条
    expect(orchestrator.cancel(first.id, false)).toBe(true)
    const next = orchestrator.continueConversation(first.id, dropped.prompt) as any
    expect(next.state).toBe('queued')
    orchestrator.removeFollowup(first.id, dropped.id)
    // 剩余排队项迁移:父任务已 canceled,processFollowupQueue 只在 completed 路径消费,不迁移则永不发送
    expect(orchestrator.migrateFollowups(first.id, next.id)).toBe(1)
    expect(orchestrator.getFollowups(first.id)).toHaveLength(0)
    const migrated = orchestrator.getFollowups(next.id)
    expect(migrated.map((i) => i.id)).toEqual([kept.id])
    expect(migrated[0]!.parentTaskId).toBe(next.id)
    expect(migrated[0]!.reasoningEffort).toBe('high')
    // 新任务完成后迁移来的项自动接续
    await waitFor(() => next.state === 'completed')
    await waitFor(() => {
      const all = orchestrator.list()
      return all.some((t) => t.parentId === next.id && t.prompt === '问1')
    })
  })

  it('migrateFollowups:源队列为空或同任务迁移返回 0', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('zcode'))
    const a = orchestrator.submit({ agentId: 'zcode', prompt: 'A' })
    const b = orchestrator.submit({ agentId: 'zcode', prompt: 'B' })
    expect(orchestrator.migrateFollowups(a.id, b.id)).toBe(0)
    expect(orchestrator.migrateFollowups(a.id, a.id)).toBe(0)
  })
})

describe('P0-4/P0-6: 思考档位透传与本轮覆盖', () => {
  it('submit 透传 reasoningEffort 落库并传入驱动', async () => {
    const registry = new Registry()
    registry.register(qoderProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    let seenEffort: string | undefined
    orchestrator.registerDriver({
      id: 'qoder',
      async detect() {
        return null
      },
      async health() {
        return { ok: true }
      },
      resolveModelArg: () => [],
      async run(options) {
        seenEffort = options.reasoningEffort
        return { code: 0 }
      },
    })
    const task = orchestrator.submit({ agentId: 'qoder', prompt: '带档位', reasoningEffort: 'medium' })
    await waitFor(() => task.state === 'completed')
    expect(task.reasoningEffort).toBe('medium')
    expect(seenEffort).toBe('medium')
  })

  it('续聊缺省沿用父任务参数,显式覆盖仅本轮生效且不污染父任务', async () => {
    const registry = new Registry()
    registry.register(qoderProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('qoder', { sessionId: 'sess-c1' }))
    const parent = orchestrator.submit({
      agentId: 'qoder',
      prompt: '首轮',
      mode: 'build',
      toolPolicy: { denyList: ['Bash'], maxTurns: null },
      reasoningEffort: 'low',
    })
    await waitFor(() => parent.state === 'completed')

    // 缺省:完全沿用父任务
    const child = orchestrator.continueConversation(parent.id, '缺省续聊') as any
    expect(child.mode).toBe('build')
    expect(child.toolPolicy).toEqual({ denyList: ['Bash'], maxTurns: null })
    expect(child.reasoningEffort).toBe('low')
    await waitFor(() => child.state === 'completed')

    // 覆盖:仅本轮生效
    const child2 = orchestrator.continueConversation(parent.id, '覆盖续聊', {
      mode: 'plan',
      reasoningEffort: 'high',
      toolPolicy: { denyList: ['Write'] },
    }) as any
    expect(child2.mode).toBe('plan')
    expect(child2.reasoningEffort).toBe('high')
    expect(child2.toolPolicy).toEqual({ denyList: ['Write'] })
    expect(child2.modelId).toBe('qwen3.7-max') // modelId 未覆盖仍沿用
    // 父任务记录不被污染
    expect(parent.mode).toBe('build')
    expect(parent.reasoningEffort).toBe('low')
  })

  it('排队追问携带本轮覆盖参数,自动接续的新任务按覆盖提交', async () => {
    const registry = new Registry()
    registry.register(qoderProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('qoder', { delayMs: 80, sessionId: 'sess-q9' }))
    const first = orchestrator.submit({
      agentId: 'qoder',
      prompt: '第一步',
      mode: 'build',
      reasoningEffort: 'low',
    })
    await waitFor(() => first.state === 'running')

    const item = orchestrator.continueConversation(first.id, '换档追问', {
      queueIfRunning: true,
      mode: 'plan',
      reasoningEffort: 'high',
    }) as any
    expect(item.mode).toBe('plan')
    expect(item.reasoningEffort).toBe('high')

    await waitFor(() => first.state === 'completed')
    await waitFor(() => {
      const all = orchestrator.list()
      return all.some((t) => t.parentId === first.id && t.prompt === '换档追问')
    })
    const second = orchestrator.list().find((t) => t.parentId === first.id)!
    expect(second.mode).toBe('plan')
    expect(second.reasoningEffort).toBe('high')
  })

  it('接续成功后推送 followup:continued,新任务事件流头部写"接续自"message 事件', async () => {
    const registry = new Registry()
    registry.register(qoderProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('qoder', { delayMs: 80 }))
    const first = orchestrator.submit({ agentId: 'qoder', prompt: '首问' })
    await waitFor(() => first.state === 'running')
    orchestrator.enqueueFollowup(first.id, '接续问')
    const continued: Array<{ fromTaskId: string; toTaskId: string }> = []
    orchestrator.onFollowupContinued((p) => continued.push(p))

    await waitFor(() => first.state === 'completed')
    await waitFor(() => {
      const all = orchestrator.list()
      return all.some((t) => t.parentId === first.id && t.prompt === '接续问')
    })
    const second = orchestrator.list().find((t) => t.parentId === first.id)!
    expect(continued).toEqual([{ fromTaskId: first.id, toTaskId: second.id }])
    // message 事件落库且位于事件流头部(seq=1),会话链可回溯
    const events = repo.eventsOf(second.id)
    expect(events[0]!.seq).toBe(1)
    expect(events[0]!.event.kind).toBe('message')
    expect(
      events[0]!.event.kind === 'message' && events[0]!.event.text,
    ).toBe(`接续自 #${first.id}`)
  })

  it('updateFollowup 归一化文案,目标不存在抛错', async () => {
    const registry = new Registry()
    registry.register(qoderProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('qoder'))
    const first = orchestrator.submit({ agentId: 'qoder', prompt: '主任务' })
    const item = orchestrator.enqueueFollowup(first.id, '  原始文案  ')
    const updated = orchestrator.updateFollowup(first.id, item.id, ' 改后文案 ')
    expect(updated.prompt).toBe('改后文案')
    expect(orchestrator.getFollowups(first.id)[0]!.prompt).toBe('改后文案')
    expect(() => orchestrator.updateFollowup(first.id, 'no-such', 'x')).toThrow(/unknown followup/)
  })

  it('reorderFollowup:插入到 before 之前,null 移到队尾,自身为 no-op,非法 before 抛错', async () => {
    const registry = new Registry()
    registry.register(qoderProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('qoder'))
    const first = orchestrator.submit({ agentId: 'qoder', prompt: '主任务' })
    const i1 = orchestrator.enqueueFollowup(first.id, '问1')
    const i2 = orchestrator.enqueueFollowup(first.id, '问2')
    const i3 = orchestrator.enqueueFollowup(first.id, '问3')
    // 提前发送:i3 移到 i1 之前(队首)
    orchestrator.reorderFollowup(first.id, i3.id, i1.id)
    expect(orchestrator.getFollowups(first.id).map((i) => i.id)).toEqual([i3.id, i1.id, i2.id])
    // null/缺省 = 移到队尾
    orchestrator.reorderFollowup(first.id, i3.id, null)
    expect(orchestrator.getFollowups(first.id).map((i) => i.id)).toEqual([i1.id, i2.id, i3.id])
    // 自身 = no-op
    orchestrator.reorderFollowup(first.id, i2.id, i2.id)
    expect(orchestrator.getFollowups(first.id).map((i) => i.id)).toEqual([i1.id, i2.id, i3.id])
    expect(() => orchestrator.reorderFollowup(first.id, i1.id, 'no-such')).toThrow(/unknown followup/)
    expect(() => orchestrator.reorderFollowup(first.id, 'no-such', null)).toThrow(/unknown followup/)
  })
})

describe('P0-2 复审: 归属变更后 live 表同步', () => {
  it('syncTaskProject 更新 live 任务对象的 projectId,后续 putTask 不再把旧归属回写', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    orchestrator.registerDriver(new MockDriver('zcode', { delayMs: 200 }))
    const task = orchestrator.submit({ agentId: 'zcode', prompt: '跨组移动的任务', projectId: 'proj-a' })
    await waitFor(() => task.state === 'running')

    // 模拟 tasks:move:仓库直写新归属后同步 live 表
    expect(orchestrator.syncTaskProject(task.id, 'proj-b')).toBe(true)
    expect(orchestrator.get(task.id)?.projectId).toBe('proj-b')

    // 运行收尾的状态迁移会再走 putTask:若 live 未同步,project_id 会被回写为 proj-a
    await waitFor(() => task.state === 'completed')
    expect(repo.getTask(task.id)?.projectId).toBe('proj-b')
  })

  it('syncTaskProject:任务不在 live 表时返回 false(仓库已是新值,无需同步)', async () => {
    const registry = new Registry()
    registry.register(zcodeProfile)
    const repo = new MemoryTaskRepository()
    const orchestrator = new Orchestrator(registry, {
      repo,
      sink: new PassthroughSink(repo),
      defaultCwd: 'C:/tmp/ws',
    })
    expect(orchestrator.syncTaskProject('no-such-task', 'proj-b')).toBe(false)
  })
})
