import { randomUUID } from 'node:crypto'
import type { AgentDriver } from './driver.js'
import { Journal, type JournalStore } from './journal.js'
import type { Clock, EventSink, TaskRepository } from './ports.js'
import { systemClock } from './ports.js'
import { Registry } from './registry.js'
import { MemoryUsageLedger } from './usage.js'
import { Throttle } from './throttle.js'
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
  /** 不注入时使用零间隔/无暂停的默认节流器(测试与冒烟场景) */
  throttle?: Throttle
  journal?: JournalStore
  /** run 前建立产物基线,返回值原样递给 onRunEnd(可为 Promise) */
  onRunStart?: (task: TaskRecord) => unknown
  /** run 到达收尾(含取消/失败)后扫描产物 */
  onRunEnd?: (task: TaskRecord, baseline: unknown) => void | Promise<void>
}

export type TerminalListener = (task: TaskRecord) => void

/**
 * 调度核心:只依赖端口与注册表。
 * - 内存活跃表是运行期事实源,仓库负责持久化与崩溃恢复;
 * - 事件统一经 sink 发出,落库与批推策略在 sink 内实现;
 * - 放行一律经节流器:全局并发/每客户端并发与节拍/日上限/暂停闸/同 cwd 互斥;
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
  private readonly throttle: Throttle
  private readonly journal: Journal
  private readonly terminalListeners: TerminalListener[] = []
  private readonly submittedListeners: TerminalListener[] = []
  private releaseTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly registry: Registry,
    private readonly deps: OrchestratorDeps,
  ) {
    this.clock = deps.clock ?? systemClock
    this.throttle =
      deps.throttle ??
      new Throttle(new MemoryUsageLedger(), this.clock, {
        globalConcurrency: 4,
        minIntervalMs: 0,
        jitterMs: 0,
      })
    this.journal = new Journal(deps.journal, this.clock)
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

  get throttleState(): Throttle {
    return this.throttle
  }

  onTaskTerminal(listener: TerminalListener): () => void {
    this.terminalListeners.push(listener)
    return () => {
      const index = this.terminalListeners.indexOf(listener)
      if (index >= 0) this.terminalListeners.splice(index, 1)
    }
  }

  onTaskSubmitted(listener: TerminalListener): () => void {
    this.submittedListeners.push(listener)
    return () => {
      const index = this.submittedListeners.indexOf(listener)
      if (index >= 0) this.submittedListeners.splice(index, 1)
    }
  }

  submit(request: SubmitRequest): TaskRecord {
    const profile = this.registry.get(request.agentId)
    if (!profile.enabled) {
      throw new Error(`agent "${profile.id}" 已停用,无法派发`)
    }
    const modelId = this.registry.resolveModel(request.agentId, request.modelId)
    const cwd = request.cwd ?? this.deps.defaultCwd
    if (!cwd) throw new Error('缺少工作目录:未指定 cwd 且未配置默认工作区')
    // cap 硬闸在产生任务记录之前,超限即拒绝
    this.throttle.checkCapAtSubmit(profile)
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
    this.throttle.chargeAtSubmit(task)
    this.journal.record('task.submit', task.origin, {
      agentId: profile.id,
      taskId: task.id,
      detail: `attempt=${task.attempt}`,
    })
    for (const listener of this.submittedListeners) listener(task)
    this.enqueue(task)
    // 异步调度:submit 返回时任务仍为 queued,调度与入队解耦
    queueMicrotask(() => this.tryRelease())
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
      this.journal.record('task.cancel', task.origin, { agentId: task.agentId, taskId: task.id })
      this.tryRelease()
      return true
    }
    if (task.state === 'running') {
      // 先 abort:driver 收到信号自行杀进程树,收尾时不覆盖 canceled
      this.controllers.get(taskId)?.abort()
      this.transition(task, 'canceled')
      this.journal.record('task.cancel', task.origin, { agentId: task.agentId, taskId: task.id })
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
    this.journal.record('task.mark-failed', task.origin, { agentId: task.agentId, taskId: task.id })
    return true
  }

  /**
   * 续聊(6.5):新任务以 parent_id 记链,sessionId 透传 `--resume <id>`;
   * 无会话 id(V2 有结论前提取不到)降级 `-c` 续接该工作区最近会话,UI 需标注。
   * running 父任务拒绝续聊,不允许并发续聊。
   */
  continueConversation(taskId: string, prompt: string): TaskRecord {
    const parent = this.taskOf(taskId)
    if (!parent) throw new Error(`unknown task: ${taskId}`)
    if (parent.state === 'running') {
      throw new Error('任务运行中:请等待完成或先取消,再继续对话')
    }
    return this.submit({
      agentId: parent.agentId,
      prompt,
      cwd: parent.cwd,
      sessionId: parent.sessionId,
      resumeLatest: !parent.sessionId,
      modelId: parent.modelId,
      mode: parent.mode,
      parentId: parent.id,
      origin: 'panel',
    })
  }

  /** 托盘/IPC 的"暂停调度"入口;恢复时立即重扫队列 */
  setPaused(paused: boolean): void {
    this.throttle.setPaused(paused)
    if (!paused) this.tryRelease()
  }

  isPaused(): boolean {
    return this.throttle.isPaused()
  }

  /** 供组合根的观察者(产物扫描/失败降级)补发事件,seq 由核心统一分配 */
  emitTaskEvent(taskId: string, event: TaskEvent): void {
    this.recordEvent(taskId, event)
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
      queueMicrotask(() => this.tryRelease())
    }
  }

  private enqueue(task: TaskRecord): void {
    const queue = this.queues.get(task.agentId) ?? []
    queue.push(task)
    this.queues.set(task.agentId, queue)
  }

  /**
   * 公平放行(6.1):跨客户端按入队序扫描,跳过暂不满足条件的任务,
   * 取第一个满足者放行——防止同一客户端连续占槽饿死其他客户端。
   * 客户端级约束(并发/节拍/日上限)不满足时整队跳过;任务级(同 cwd 占用)只跳过该任务。
   */
  private tryRelease(): void {
    if (this.throttle.isPaused()) {
      this.clearReleaseTimer()
      return
    }
    let globalRunning = this.countRunning()
    let earliestRetryMs: number | undefined
    for (const [agentId, queue] of this.queues) {
      if (queue.length === 0) continue
      const profile = this.registry.get(agentId)
      let agentRunning = this.countRunning(agentId)
      let index = 0
      while (index < queue.length) {
        const task = queue[index]
        const decision = this.throttle.canRelease(task, profile, {
          agentRunning,
          globalRunning,
          cwdOccupied: this.cwdOccupied(task.cwd, task.id),
        })
        if (!decision.ok) {
          if (decision.reason === 'global-concurrency') return
          if (
            decision.reason === 'agent-concurrency' ||
            decision.reason === 'interval' ||
            decision.reason === 'daily-cap'
          ) {
            // 客户端级阻塞:整队让位,并安排节拍到期后的重试
            if (decision.retryInMs !== undefined) {
              earliestRetryMs =
                earliestRetryMs === undefined
                  ? decision.retryInMs
                  : Math.min(earliestRetryMs, decision.retryInMs)
            }
            break
          }
          // cwd-busy:只跳过该任务,后续任务可能工作区不同
          index++
          continue
        }
        queue.splice(index, 1)
        this.throttle.markReleased(agentId)
        agentRunning++
        globalRunning++
        this.journal.record('task.release', task.origin, {
          agentId,
          taskId: task.id,
        })
        const driver = this.drivers.get(profile.driver)
        if (!driver) {
          this.failTask(task, `no driver registered: ${profile.driver}`)
          continue
        }
        void this.execute(task, profile, driver)
      }
    }
    this.scheduleRetry(earliestRetryMs)
  }

  private scheduleRetry(retryInMs: number | undefined): void {
    this.clearReleaseTimer()
    if (retryInMs === undefined || retryInMs <= 0) return
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined
      this.tryRelease()
    }, retryInMs + 5)
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer !== undefined) {
      clearTimeout(this.releaseTimer)
      this.releaseTimer = undefined
    }
  }

  private countRunning(agentId?: AgentId): number {
    let count = 0
    for (const task of this.live.values()) {
      if (task.state !== 'running') continue
      if (agentId === undefined || task.agentId === agentId) count++
    }
    return count
  }

  /** 同 cwd 互斥按任务状态判定:仅 running 占用,queued 不占(6.6) */
  private cwdOccupied(cwd: string, excludeTaskId: string): boolean {
    for (const task of this.live.values()) {
      if (task.id === excludeTaskId) continue
      if (task.state === 'running' && task.cwd === cwd) return true
    }
    return false
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
    const baseline = await this.deps.onRunStart?.(task)
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
      void this.deps.onRunEnd?.(task, baseline)
      this.controllers.delete(task.id)
      this.tryRelease()
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
    if (to === 'completed' || to === 'failed' || to === 'canceled') {
      // 未运行即终态:返还入队计数(记回创建日)
      this.throttle.refundIfNeverRan(task)
      this.journal.record(`task.${to === 'completed' ? 'complete' : to}`, task.origin, {
        agentId: task.agentId,
        taskId: task.id,
        detail: task.error,
      })
      for (const listener of [...this.terminalListeners]) listener(task)
    }
  }

  private recordEvent(taskId: string, event: TaskEvent): void {
    const seq = (this.seqCursors.get(taskId) ?? this.repo.maxSeqOf(taskId)) + 1
    this.seqCursors.set(taskId, seq)
    const stored: StoredEvent = { taskId, seq, at: this.clock.now(), event }
    this.deps.sink.append([stored])
  }
}
