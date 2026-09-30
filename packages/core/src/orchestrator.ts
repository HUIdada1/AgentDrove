import { randomUUID } from 'node:crypto'
import { Registry } from './registry.js'
import type { AgentDriver } from './driver.js'
import type {
  AgentId,
  ModelId,
  TaskEvent,
  TaskInput,
  TaskRecord,
} from './types.js'

export interface SubmitOptions {
  modelId?: ModelId
  cwd?: string
}

/**
 * 调度核心:
 * - submit 入队并触发调度(drain),同步返回任务记录;
 * - 每个 agent 独立队列,受 maxConcurrency 限制;
 * - 驱动不存在/崩溃只让对应任务失败,不影响其他任务;
 * - 全程事件留档(task.events),支撑审计与回放。
 */
export class Orchestrator {
  private drivers = new Map<string, AgentDriver>()
  private tasks = new Map<string, TaskRecord>()
  private queues = new Map<AgentId, TaskRecord[]>()
  private running = new Map<string, TaskRecord>()
  private controllers = new Map<string, AbortController>()

  constructor(readonly registry: Registry) {}

  registerDriver(driver: AgentDriver): void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`driver already registered: ${driver.id}`)
    }
    this.drivers.set(driver.id, driver)
  }

  submit(
    agentId: AgentId,
    input: TaskInput,
    options: SubmitOptions = {},
  ): TaskRecord {
    const modelId = this.registry.resolveModel(agentId, options.modelId)
    const now = Date.now()
    const task: TaskRecord = {
      id: randomUUID(),
      agentId,
      modelId,
      input: { prompt: input.prompt, cwd: options.cwd ?? input.cwd },
      state: 'queued',
      createdAt: now,
      events: [],
    }
    this.tasks.set(task.id, task)
    const queue = this.queues.get(agentId) ?? []
    queue.push(task)
    this.queues.set(agentId, queue)
    // 异步调度:保证 submit 返回时任务仍为 queued,调度与入队解耦
    queueMicrotask(() => this.drain(agentId))
    return task
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    if (task.state === 'queued') {
      const queue = this.queues.get(task.agentId) ?? []
      const index = queue.findIndex((t) => t.id === taskId)
      if (index >= 0) queue.splice(index, 1)
      this.transition(task, 'canceled')
      return true
    }
    if (task.state === 'running') {
      this.controllers.get(taskId)?.abort()
      this.transition(task, 'canceled')
      return true
    }
    return false
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()]
  }

  getEvents(taskId: string): TaskEvent[] {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    return task.events
  }

  private drain(agentId: AgentId): void {
    const agent = this.registry.get(agentId)
    const active = this.runningCount(agentId)
    if (active >= agent.maxConcurrency) return
    const queue = this.queues.get(agentId)
    if (!queue || queue.length === 0) return
    const task = queue.shift()!
    const driver = this.drivers.get(agent.driver)
    if (!driver) {
      this.failTask(task, `no driver registered: ${agent.driver}`)
      this.drain(agentId)
      return
    }
    void this.execute(task, agent, driver)
  }

  private async execute(
    task: TaskRecord,
    agent: ReturnType<Registry['get']>,
    driver: AgentDriver,
  ): Promise<void> {
    this.transition(task, 'running')
    this.running.set(task.id, task)
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    const emit = (event: TaskEvent) => task.events.push(event)
    try {
      const code = await driver.run({
        agent,
        modelId: task.modelId,
        input: task.input,
        emit,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return // 取消已由 cancel() 落状态
      if (code === 0) {
        this.transition(task, 'completed')
      } else {
        this.failTask(task, `driver exited with code ${code}`)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.failTask(task, error instanceof Error ? error.message : String(error))
      }
    } finally {
      this.running.delete(task.id)
      this.controllers.delete(task.id)
      this.drain(task.agentId)
    }
  }

  private failTask(task: TaskRecord, error: string): void {
    task.error = error
    this.transition(task, 'failed')
  }

  private transition(task: TaskRecord, to: TaskRecord['state']): void {
    const from = task.state
    if (from === to) return
    const now = Date.now()
    task.state = to
    if (to === 'running') task.startedAt = now
    if (to === 'completed' || to === 'failed' || to === 'canceled') {
      task.finishedAt = now
    }
    task.events.push({ type: 'state-changed', from, to, at: now })
  }

  private runningCount(agentId: AgentId): number {
    let count = 0
    for (const task of this.running.values()) {
      if (task.agentId === agentId) count++
    }
    return count
  }
}