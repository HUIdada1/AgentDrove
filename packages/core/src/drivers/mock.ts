import type { AgentDriver, DriverRunOptions } from '../driver.js'
import type { ModelId } from '../types.js'

export interface MockBehavior {
  fail?: boolean
  delayMs?: number
  output?: string[]
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

/**
 * 行为可编程的假驱动:用于验证 Orchestrator 的状态机、
 * 并发限流、取消与驱动隔离,不接触任何真实客户端。
 */
export class MockDriver implements AgentDriver {
  readonly id: string

  constructor(id: string, private behavior: MockBehavior = {}) {
    this.id = id
  }

  resolveModel(modelId: ModelId): ModelId {
    return modelId
  }

  async run(options: DriverRunOptions): Promise<number> {
    await abortableSleep(this.behavior.delayMs ?? 0, options.signal)
    for (const line of this.behavior.output ?? [
      `[mock:${options.modelId}] ${options.input.prompt}`,
    ]) {
      options.emit({ type: 'message', channel: 'agent', text: line, at: Date.now() })
    }
    return this.behavior.fail ? 1 : 0
  }
}