import { describe, expect, it } from 'vitest'
import { Throttle } from '../src/throttle.js'
import { MemoryUsageLedger, localDayOf, type UsageLedger } from '../src/usage.js'
import type { TaskRecord } from '../src/index.js'
import { FixedClock, qoderProfile, zcodeProfile } from './helpers.js'

function makeThrottle(config = { globalConcurrency: 2, minIntervalMs: 0, jitterMs: 0 }) {
  const ledger = new MemoryUsageLedger()
  const clock = new FixedClock()
  const throttle = new Throttle(ledger, clock, config)
  return { throttle, ledger, clock }
}

function taskOf(partial: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't1',
    agentId: 'zcode',
    modelId: 'client-follow',
    prompt: 'p',
    cwd: 'C:/tmp/ws',
    state: 'queued',
    attachments: [],
    mode: 'build',
    origin: 'panel',
    createdAt: 0,
    attempt: 1,
    ...partial,
  } as TaskRecord
}

const free = {
  agentRunning: 0,
  globalRunning: 0,
  cwdOccupied: false,
}

describe('Throttle 日上限与记账', () => {
  it('入队达 cap 抛错,记账后计数生效', () => {
    const { throttle, ledger, clock } = makeThrottle()
    const profile = { ...zcodeProfile, plan: { ...zcodeProfile.plan, dailyTaskCap: 2 } }
    const day = localDayOf(clock.now())
    throttle.checkCapAtSubmit(profile)
    throttle.chargeAtSubmit(taskOf({ createdAt: clock.now() }))
    throttle.checkCapAtSubmit(profile)
    throttle.chargeAtSubmit(taskOf({ createdAt: clock.now() }))
    expect(ledger.countOf('zcode', day)).toBe(2)
    expect(() => throttle.checkCapAtSubmit(profile)).toThrow(/上限/)
  })

  it('未运行即终态返还,记回创建日,跨零点不写新日', () => {
    const { throttle, ledger, clock } = makeThrottle()
    const createdDay = localDayOf(clock.now())
    const task = taskOf({ createdAt: clock.now(), startedAt: undefined })
    throttle.chargeAtSubmit(task)
    clock.advance(26 * 3600_000) // 跨过本地零点
    throttle.refundIfNeverRan(task)
    expect(ledger.countOf('zcode', createdDay)).toBe(0)
    // 若错误地记到新的一天,新日会有 0 行之外的变化;这里显式验证不产生新计数
    expect(ledger.countOf('zcode', localDayOf(clock.now()))).toBe(0)
  })

  it('运行过的任务不返还', () => {
    const { throttle, ledger, clock } = makeThrottle()
    const task = taskOf({ createdAt: clock.now(), startedAt: clock.now() })
    throttle.chargeAtSubmit(task)
    throttle.refundIfNeverRan(task)
    expect(ledger.countOf('zcode', localDayOf(clock.now()))).toBe(1)
  })
})

describe('Throttle 放行条件', () => {
  it('暂停闸拦截放行,恢复后放行', () => {
    const { throttle } = makeThrottle()
    throttle.setPaused(true)
    expect(throttle.canRelease(taskOf({}), zcodeProfile, free).reason).toBe('paused')
    throttle.setPaused(false)
    expect(throttle.canRelease(taskOf({}), zcodeProfile, free).ok).toBe(true)
  })

  it('全局并发与每客户端并发分别拦截', () => {
    const { throttle } = makeThrottle()
    expect(
      throttle.canRelease(taskOf({}), zcodeProfile, { ...free, globalRunning: 2 }).reason,
    ).toBe('global-concurrency')
    expect(
      throttle.canRelease(taskOf({}), zcodeProfile, { ...free, agentRunning: 1 }).reason,
    ).toBe('agent-concurrency')
  })

  it('同 cwd 占用拦截(任务级,只跳过该任务)', () => {
    const { throttle } = makeThrottle()
    expect(
      throttle.canRelease(taskOf({}), zcodeProfile, { ...free, cwdOccupied: true }).reason,
    ).toBe('cwd-busy')
  })

  it('每客户端节拍:minInterval 内不放行并给出剩余等待,到期放行', () => {
    const { throttle, clock } = makeThrottle({ globalConcurrency: 2, minIntervalMs: 100, jitterMs: 0 })
    throttle.markReleased('zcode')
    const blocked = throttle.canRelease(taskOf({}), zcodeProfile, free)
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toBe('interval')
    expect(blocked.retryInMs).toBeGreaterThan(0)
    clock.advance(150)
    expect(throttle.canRelease(taskOf({}), zcodeProfile, free).ok).toBe(true)
  })

  it('抖动叠加在最小间隔之上', () => {
    const { throttle, clock } = makeThrottle({ globalConcurrency: 2, minIntervalMs: 100, jitterMs: 50 })
    throttle.markReleased('zcode')
    const allowedAt = throttle.nextAllowedTimeOf('zcode')!
    const gap = allowedAt - clock.monotonic()
    expect(gap).toBeGreaterThanOrEqual(100)
    expect(gap).toBeLessThanOrEqual(150)
  })

  it('客户端级别账不影响其他客户端(qoder 有独立台账)', () => {
    const { throttle, ledger, clock } = makeThrottle()
    const zcodeCapped = { ...zcodeProfile, plan: { ...zcodeProfile.plan, dailyTaskCap: 1 } }
    throttle.chargeAtSubmit(taskOf({ createdAt: clock.now() }))
    expect(
      throttle.canRelease(taskOf({}), zcodeCapped, free).reason,
    ).toBe('daily-cap')
    expect(throttle.canRelease(taskOf({ agentId: 'qoder' }), qoderProfile, free).ok).toBe(true)
    void ledger
  })
})

// UsageLedger 契约由 SQLite 适配器复测;此处锁定内存实现的语义
describe('MemoryUsageLedger 契约', () => {
  it('返还不会把计数打成负数', () => {
    const ledger: UsageLedger = new MemoryUsageLedger()
    ledger.refund('zcode', '2026-10-01')
    expect(ledger.countOf('zcode', '2026-10-01')).toBe(0)
    ledger.charge('zcode', '2026-10-01')
    ledger.refund('zcode', '2026-10-01')
    ledger.refund('zcode', '2026-10-01')
    expect(ledger.countOf('zcode', '2026-10-01')).toBe(0)
  })
})
