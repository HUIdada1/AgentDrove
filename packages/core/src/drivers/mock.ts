import type { AgentDriver, DetectedAgent, DriverRunOptions, RunResult } from '../driver.js'
import type { AgentProfile, ModelId } from '../types.js'
import { MODEL_CLIENT_FOLLOW } from '../types.js'

export interface MockBehavior {
  fail?: boolean
  /** 任意非零退出码,默认 1 */
  exitCode?: number
  delayMs?: number
  output?: string[]
  /** 模拟从输出提取到的会话 id */
  sessionId?: string
  /** 挂起直到 signal abort,用于恢复/取消路径测试 */
  hangUntilAbort?: boolean
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort)
  })
}

function hangUntilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

/**
 * 行为可编程的假驱动:验证编排器的状态机、并发、取消、恢复与驱动隔离,
 * 不接触任何真实客户端。
 */
export class MockDriver implements AgentDriver {
  readonly id: string
  readonly supportedVersions?: string

  constructor(
    id: string,
    private behavior: MockBehavior = {},
    options: { supportedVersions?: string } = {},
  ) {
    this.id = id
    this.supportedVersions = options.supportedVersions
  }

  async detect(): Promise<DetectedAgent | null> {
    return null
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }

  resolveModelArg(modelId: ModelId, _agent: AgentProfile): string[] {
    return modelId === MODEL_CLIENT_FOLLOW ? [] : ['--model', modelId]
  }

  async run(options: DriverRunOptions): Promise<RunResult> {
    if (this.behavior.hangUntilAbort) {
      await hangUntilAbort(options.signal)
    }
    await abortableSleep(this.behavior.delayMs ?? 0, options.signal)
    for (const line of this.behavior.output ?? [
      `[mock:${options.modelId}] ${options.input.prompt}`,
    ]) {
      options.emit({ kind: 'message', channel: 'agent', text: line })
    }
    if (this.behavior.fail) {
      return { code: this.behavior.exitCode ?? 1 }
    }
    return { code: 0, sessionId: this.behavior.sessionId }
  }
}
