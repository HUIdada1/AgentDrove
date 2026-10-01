import type { AgentId } from './types.js'

export interface HealthReport {
  ok: boolean
  reason?: string
  at: number
}

export interface HealthProbe {
  (agentId: AgentId): Promise<{ ok: boolean; reason?: string }>
}

/**
 * 健康检查缓存:TTL 60s,放行前探活走缓存避免重复 spawn doctor。
 * 手动"重查"与 failover 候选筛选必须 bypass——命中旧缓存会造成降级死循环。
 */
export class HealthCheckService {
  private readonly cache = new Map<AgentId, HealthReport>()
  private readonly inFlight = new Map<AgentId, Promise<HealthReport>>()

  constructor(
    private readonly probe: HealthProbe,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async check(agentId: AgentId, options: { bypassCache?: boolean } = {}): Promise<HealthReport> {
    if (!options.bypassCache) {
      const cached = this.cache.get(agentId)
      if (cached && this.now() - cached.at < this.ttlMs) return cached
    }
    const pending = this.inFlight.get(agentId)
    // 并发探活去重:同一客户端同时只跑一个 doctor
    if (pending) return pending
    const report = this.probeAndCache(agentId)
    this.inFlight.set(agentId, report)
    return report
  }

  private async probeAndCache(agentId: AgentId): Promise<HealthReport> {
    try {
      const result = await this.probe(agentId)
      const report: HealthReport = { ...result, at: this.now() }
      this.cache.set(agentId, report)
      return report
    } catch (error) {
      const report: HealthReport = {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        at: this.now(),
      }
      this.cache.set(agentId, report)
      return report
    } finally {
      this.inFlight.delete(agentId)
    }
  }

  invalidate(agentId?: AgentId): void {
    if (agentId === undefined) this.cache.clear()
    else this.cache.delete(agentId)
  }

  cachedOf(agentId: AgentId): HealthReport | undefined {
    return this.cache.get(agentId)
  }
}
