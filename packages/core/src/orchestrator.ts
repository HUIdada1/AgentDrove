import { randomUUID } from 'node:crypto'
import type { AgentDriver } from './driver.js'
import type { Clock, EventSink, TaskRepository } from './ports.js'
import { systemClock } from './ports.js'
import { Registry } from './registry.js'
import type {
  AgentId,
  StoredEvent,
  TaskAttachment,
  TaskEvent,
  TaskMode,
  TaskOrigin,
  TaskRecord,
  TaskState,
  ToolPolicy,
} from './types.js'
import { satisfiesRange } from './version.js'

/**
 * 合法迁移表,状态机唯一事实源;interrupted 只能被"标记为失败",
 * 重试一律派生新任务(attempt+1),不允许旧任务复活造成审计断链。
 * queued→failed 覆盖"从未运行即失败"的场景(驱动缺失、健康检查不通过)。
 */
const LEGAL_TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['running', 'canceled', 'failed'],
  running: ['completed', 'failed', 'canceled', 'interrupted'],
  interrupted: ['failed'],
  completed: [],
  failed: [],
  canceled: [],
}

const DEFAULT_MODE: TaskMode = 'build'

export interface SubmitRequest {
  agentId: AgentId
  prompt: string
  cwd?: string
  modelId?: string
  attachments?: TaskAttachment[]
  toolPolicy?: ToolPolicy
  /** 续聊目标会话(--resume) */
  sessionId?: string
  /** 无目标会话时续接该工作区最近会话(-c) */
  resumeLatest?: boolean
  mode?: TaskMode
  origin?: TaskOrigin
  parentId?: string
  retryOf?: string
  attempt?: number
}

export interface OrchestratorDeps {
  repo: TaskRepository
  sink: EventSink
  clock?: Clock
  /** cwd 缺省时落此目录(主进程注入 %BASE%\workspaces\default) */
  defaultCwd?: string
  /** driver 看门狗默认时长 */
  defaultTimeoutMs?: number
}

/**
 * 调度核心:只依赖端口与注册表。
 * - 内存活跃表是运行期事实源,仓库负责持久化与崩溃恢复;
 * - submit 入队并异步 drain,同步返回任务记录;
 * - 事件统一经 sink 发出,落库与批推策略在 sink 内实现;
 * - 驱动不存在/崩溃只让对应任务失败,不影响其他任务;
 * - 构造时从仓库恢复:running → interrupted,queued 重新参与调度。
 */
export class Orchestrator {
  private readonly drivers = new Map<string, AgentDriver>()
  private readonly live = new Map<string, TaskRecord>()
  private readonly queues = new Map<AgentId, TaskRecord[]>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly seqCursors = new Map<string, number>()
  private readonly clock: Clock

  constructor(
    readonly registry: Registry,
    private readonly deps: OrchestratorDeps,
  ) {
    this.clock = deps.clock ?? systemClock
    this.recover()
  }

  registerDriver(driver: AgentDriver): void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`driver already registered: ${driver.id}`)
    }
    this.drivers.set(driver.id, driver)
  }

  driver(id: string): AgentDriver | undefined {
    return this.drivers.get(id)
  }

  submit(request: SubmitRequest): TaskRecord {
    const profile = this.registry.get(request.agentId)
    if (!profile.enabled) {
      throw new Error(`agent "${profile.id}" 已停用,无法派发`)
    }
    const modelId = this.registry.resolveModel(request.agentId, request.modelId)
    const cwd = request.cwd ?? this.deps.defaultCwd
    if (!cwd) throw new Error('缺少工作目录:未指定 cwd 且未配置默认工作区')
    const now = this.clock.now()
    const task: TaskRecord = {
      id: randomUUID(),
      agentId: profile.id,
      modelId,
      prompt: request.prompt,
      cwd,
      state: 'queued',
      attachments: request.attachments ?? [],
      toolPolicy: request.toolPolicy,
      mode: request.mode ?? DEFAULT_MODE,
      origin: request.origin ?? 'panel',
      createdAt: now,
      attempt: request.attempt ?? 1,
      sessionId: request.sessionId,
      parentId: request.parentId,
      retryOf: request.retryOf,
    }
    this.live.set(task.id, task)
    this.repo.putTask(task)
    this.enqueue(task)
    // 异步调度:submit 返回时任务仍为 queued,调度与入队解耦
    queueMicrotask(() => this.drain(profile.id))
    return task
  }

  cancel(taskId: string): boolean {
    const task = this.taskOf(taskId)
    if (!task) return false
    if (task.state === 'queued') {
      const queue = this.queues.get(task.agentId) ?? []
      const index = queue.findIndex((t) => t.id === taskId)
      if (index >= 0) queue.splice(index, 1)
      this.transition(task, 'canceled')
      return true
    }
    if (task.state === 'running') {
      // 先 abort:driver 收到信号自行杀进程树,收尾时不覆盖 canceled
      this.controllers.get(taskId)?.abort()
      this.transition(task, 'canceled')
      return true
    }
    return false
  }

  /** interrupted 只允许人工收敛为 failed(产物补扫由终态钩子负责) */
  markFailed(taskId: string, reason?: string): boolean {
    const task = this.taskOf(taskId)
    if (!task || task.state !== 'interrupted') return false
    task.error = reason ?? task.error ?? '用户标记为失败'
    this.transition(task, 'failed')
    return true
  }

  get(taskId: string): TaskRecord | undefined {
    return this.taskOf(taskId)
  }

  list(): TaskRecord[] {
    return [...this.live.values()]
  }

  eventsOf(taskId: string): StoredEvent[] {
    return this.repo.eventsOf(taskId)
  }

  private get repo(): TaskRepository {
    return this.deps.repo
  }

  private taskOf(taskId: string): TaskRecord | undefined {
    return this.live.get(taskId) ?? this.repo.getTask(taskId)
  }

  private recover(): void {
    const resumedAgents: AgentId[] = []
    for (const task of this.repo.allTasks()) {
      this.live.set(task.id, task)
      if (task.state === 'running') {
        // 宿主上次未正常退出,标记中断待人工处理
        this.transition(task, 'interrupted')
      } else if (task.state === 'queued') {
        this.enqueue(task)
        if (!resumedAgents.includes(task.agentId)) resumedAgents.push(task.agentId)
      }
    }
    if (resumedAgents.length > 0) {
      queueMicrotask(() => resumedAgents.forEach((id) => this.drain(id)))
    }
  }

  private enqueue(task: TaskRecord): void {
    const queue = this.queues.get(task.agentId) ?? []
    queue.push(task)
    this.queues.set(task.agentId, queue)
  }

  /**
   * 放行:按入队序取队首,受每客户端并发(plan.maxConcurrency)约束。
   * M2 将收敛进节流器(全局并发/每客户端间隔+抖动/日上限/公平跳过),此处保持最小语义。
   */
  private drain(agentId: AgentId): void {
    const profile = this.registry.get(agentId)
    let active = 0
    for (const id of this.controllers.keys()) {
      if (this.taskOf(id)?.agentId === agentId) active++
    }
    if (active >= profile.plan.maxConcurrency) return
    const queue = this.queues.get(agentId)
    if (!queue || queue.length === 0) return
    const task = queue.shift()!
    const driver = this.drivers.get(profile.driver)
    if (!driver) {
      this.failTask(task, `no driver registered: ${profile.driver}`)
      this.drain(agentId)
      return
    }
    void this.execute(task, profile, driver)
  }

  private async execute(
    task: TaskRecord,
    profile: ReturnType<Registry['get']>,
    driver: AgentDriver,
  ): Promise<void> {
    this.transition(task, 'running')
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    const emit = (event: TaskEvent) => this.recordEvent(task.id, event)
    if (
      driver.supportedVersions &&
      profile.version &&
      !satisfiesRange(profile.version, driver.supportedVersions)
    ) {
      emit({
        kind: 'warning',
        text: `客户端版本 ${profile.version} 超出驱动声明范围 ${driver.supportedVersions},参数兼容性不保证`,
      })
    }
    try {
      const result = await driver.run({
        agent: profile,
        modelId: task.modelId,
        input: {
          prompt: task.prompt,
          cwd: task.cwd,
          sessionId: task.sessionId,
          attachments: task.attachments,
          toolPolicy: task.toolPolicy,
          mode: task.mode,
        },
        emit,
        signal: controller.signal,
        timeoutMs: this.deps.defaultTimeoutMs,
      })
      if (controller.signal.aborted) return // 取消已由 cancel() 落状态
      if (result.sessionId && !task.sessionId) {
        task.sessionId = result.sessionId
        this.repo.putTask(task)
      }
      if (result.usage) {
        emit({ kind: 'usage', ...result.usage })
      }
      if (result.code === 0) {
        this.transition(task, 'completed')
      } else {
        this.failTask(task, `driver exited with code ${result.code}`)
      }
    } catch (error) {
      if (controller.signal.aborted) return
      this.failTask(task, error instanceof Error ? error.message : String(error))
    } finally {
      this.controllers.delete(task.id)
      this.drain(task.agentId)
    }
  }

  private failTask(task: TaskRecord, error: string): void {
    task.error = error
    this.transition(task, 'failed')
  }

  private transition(task: TaskRecord, to: TaskState): void {
    const from = task.state
    if (from === to) return
    if (!LEGAL_TRANSITIONS[from].includes(to)) {
      throw new Error(`illegal transition: ${from} -> ${to}`)
    }
    const now = this.clock.now()
    task.state = to
    if (to === 'running') task.startedAt = now
    if (to === 'completed' || to === 'failed' || to === 'canceled') {
      task.finishedAt = now
    }
    this.repo.putTask(task)
    this.recordEvent(task.id, { kind: 'state-changed', from, to })
  }

  private recordEvent(taskId: string, event: TaskEvent): void {
    const seq = (this.seqCursors.get(taskId) ?? this.repo.maxSeqOf(taskId)) + 1
    this.seqCursors.set(taskId, seq)
    const stored: StoredEvent = { taskId, seq, at: this.clock.now(), event }
    this.deps.sink.append([stored])
  }
}
