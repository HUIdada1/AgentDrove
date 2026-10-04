import { randomUUID } from 'node:crypto'
import type { ThrottleConfig } from './config.js'
import type { AgentDriver } from './driver.js'
import { Journal, type JournalStore } from './journal.js'
import type { Clock, EventSink, TaskRepository } from './ports.js'
import { systemClock } from './ports.js'
import { Registry } from './registry.js'
import { MemoryUsageLedger } from './usage.js'
import { Throttle } from './throttle.js'
import type {
  AgentId,
  AgentProfile,
  FollowupQueueItem,
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

/** 节拍重试定时器的定时器精度补偿(ms):避免到点边界抖动导致空转 */
const RETRY_TIMER_SLACK_MS = 5

/** 未注入节流器(测试/无持久化冒烟)时的兜底参数:几乎不限流,只保留基本并发保护 */
const FALLBACK_THROTTLE: ThrottleConfig = {
  globalConcurrency: 4,
  minIntervalMs: 0,
  jitterMs: 0,
}

/** 单轮放行扫描的跨客户端累计量 */
interface ReleaseScan {
  globalRunning: number
  earliestRetryMs: number | undefined
}

export interface SubmitRequest {
  agentId: AgentId
  prompt: string
  title?: string
  cwd?: string
  /** 派发时所属的项目工作区(侧栏选中态),随任务落库供分组 */
  projectId?: string
  modelId?: string
  attachments?: TaskAttachment[]
  skills?: string[]
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
  /** 组合根预生成 id 的场景(派生工作区需先于任务登记) */
  id?: string
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
  /** 放行后的健康闸(6.7):不通过则任务落 failed(自动返还,可触发降级);走缓存而非 bypass */
  healthAtRelease?: (agentId: AgentId) => Promise<{ ok: boolean; reason?: string }>
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
  /** 任务运行中/排队中的追问消息队列(任务完成后自动接续派发) */
  private readonly followupQueues = new Map<string, FollowupQueueItem[]>()
  /** 已放行但还没进入 running 的任务(健康闸/基线钩子窗口);此窗口内仍算占槽 */
  private readonly starting = new Set<string>()
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
      deps.throttle ?? new Throttle(new MemoryUsageLedger(), this.clock, FALLBACK_THROTTLE)
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
    return this.addListener(this.terminalListeners, listener)
  }

  onTaskSubmitted(listener: TerminalListener): () => void {
    return this.addListener(this.submittedListeners, listener)
  }

  private addListener(list: TerminalListener[], listener: TerminalListener): () => void {
    list.push(listener)
    return () => {
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
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
    const id = request.id ?? randomUUID()
    // 组合根预生成 id 的场景必须幂等:重复 id 会覆盖既有任务记录
    if (this.live.has(id) || this.deps.repo.getTask(id)) {
      throw new Error(`任务 id 冲突:${id}`)
    }
    const now = this.clock.now()
    const task: TaskRecord = {
      id,
      agentId: profile.id,
      modelId,
      title: request.title,
      prompt: request.prompt,
      cwd,
      projectId: request.projectId,
      state: 'queued',
      attachments: request.attachments ?? [],
      skills: request.skills,
      toolPolicy: request.toolPolicy,
      mode: request.mode ?? DEFAULT_MODE,
      origin: request.origin ?? 'panel',
      createdAt: now,
      attempt: request.attempt ?? 1,
      sessionId: request.sessionId,
      resumeLatest: request.resumeLatest,
      parentId: request.parentId,
      retryOf: request.retryOf,
    }
    this.live.set(task.id, task)
    this.deps.repo.putTask(task)
    this.throttle.chargeAtSubmit(task)
    this.journal.record('task.submit', task.origin, {
      agentId: profile.id,
      taskId: task.id,
      detail: `attempt=${task.attempt}`,
    })
    this.enqueue(task)
    // 异步调度:submit 返回时任务仍为 queued,调度与入队解耦
    queueMicrotask(() => this.tryRelease())
    // 入队先于钩子:钩子抛错不能留下"已记账未入队"的孤儿任务
    this.notify(this.submittedListeners, task, '提交钩子')
    return task
  }

  cancel(taskId: string, clearFollowups = true): boolean {
    const task = this.taskOf(taskId)
    if (!task) return false
    if (clearFollowups) {
      this.clearFollowups(taskId)
    }
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
      // 槽位随状态即时释放,不等驱动收尾(驱动可能忽略 abort 长时间挂起)
      this.tryRelease()
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
   * 当任务处于 running 或 queued 时,若允许排队(queueIfRunning: true),则自动进入排队队列;
   * 否则抛出异常以维持既有行为。
   */
  continueConversation(
    taskId: string,
    prompt: string,
    options?: { queueIfRunning?: boolean; skills?: string[] },
  ): TaskRecord | FollowupQueueItem {
    const parent = this.taskOf(taskId)
    if (!parent) throw new Error(`unknown task: ${taskId}`)
    if (parent.state === 'running' || parent.state === 'queued') {
      if (options?.queueIfRunning) {
        return this.enqueueFollowup(taskId, prompt, options.skills)
      }
      throw new Error('任务运行中:请等待完成或先取消,再继续对话')
    }
    return this.submit({
      agentId: parent.agentId,
      prompt,
      cwd: parent.cwd,
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      resumeLatest: !parent.sessionId,
      modelId: parent.modelId,
      mode: parent.mode,
      toolPolicy: parent.toolPolicy,
      parentId: parent.id,
      origin: 'panel',
      skills: options?.skills ?? parent.skills,
    })
  }

  /** 加入排队消息:当父任务完成后自动接续执行 */
  enqueueFollowup(taskId: string, prompt: string, skills?: string[]): FollowupQueueItem {
    const parent = this.taskOf(taskId)
    if (!parent) throw new Error(`unknown task: ${taskId}`)
    const item: FollowupQueueItem = {
      id: randomUUID(),
      parentTaskId: taskId,
      prompt: prompt.trim(),
      skills,
      createdAt: this.clock.now(),
    }
    const queue = this.followupQueues.get(taskId) ?? []
    queue.push(item)
    this.followupQueues.set(taskId, queue)
    this.journal.record('task.followup.enqueue', parent.origin, {
      agentId: parent.agentId,
      taskId: parent.id,
      detail: `followupId=${item.id}`,
    })
    return item
  }

  getFollowups(taskId: string): FollowupQueueItem[] {
    return [...(this.followupQueues.get(taskId) ?? [])]
  }

  removeFollowup(taskId: string, followupId: string): boolean {
    const queue = this.followupQueues.get(taskId)
    if (!queue) return false
    const idx = queue.findIndex((item) => item.id === followupId)
    if (idx >= 0) {
      queue.splice(idx, 1)
      if (queue.length === 0) this.followupQueues.delete(taskId)
      return true
    }
    return false
  }

  clearFollowups(taskId: string): void {
    this.followupQueues.delete(taskId)
  }

  rename(taskId: string, title: string): TaskRecord {
    const task = this.taskOf(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    task.title = title.trim()
    this.deps.repo.putTask(task)
    return task
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
    return this.deps.repo.eventsOf(taskId)
  }

  private taskOf(taskId: string): TaskRecord | undefined {
    return this.live.get(taskId) ?? this.deps.repo.getTask(taskId)
  }

  private recover(): void {
    const resumedAgents: AgentId[] = []
    for (const task of this.deps.repo.allTasks()) {
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
    const scan: ReleaseScan = {
      globalRunning: this.countRunning(),
      earliestRetryMs: undefined,
    }
    for (const [agentId, queue] of this.queues) {
      if (queue.length === 0) continue
      if (this.releaseFromQueue(agentId, queue, scan)) return
    }
    this.scheduleRetry(scan.earliestRetryMs)
  }

  /** 扫描单客户端队列;返回 true 表示全局槽已满,本轮应停止扫描其余客户端 */
  private releaseFromQueue(agentId: AgentId, queue: TaskRecord[], scan: ReleaseScan): boolean {
    const profile = this.registry.get(agentId)
    let agentRunning = this.countRunning(agentId)
    let index = 0
    while (index < queue.length) {
      const task = queue[index]
      const decision = this.throttle.canRelease(task, profile, {
        agentRunning,
        globalRunning: scan.globalRunning,
        cwdOccupied: this.cwdOccupied(task.cwd, task.id),
      })
      if (!decision.ok) {
        if (decision.reason === 'global-concurrency') return true
        if (
          decision.reason === 'agent-concurrency' ||
          decision.reason === 'interval' ||
          decision.reason === 'daily-cap'
        ) {
          // 客户端级阻塞:整队让位,并安排节拍到期后的重试
          if (decision.retryInMs !== undefined) {
            scan.earliestRetryMs =
              scan.earliestRetryMs === undefined
                ? decision.retryInMs
                : Math.min(scan.earliestRetryMs, decision.retryInMs)
          }
          return false
        }
        // cwd-busy:只跳过该任务,后续任务可能工作区不同
        index++
        continue
      }
      queue.splice(index, 1)
      const driver = this.drivers.get(profile.driver)
      if (!driver) {
        // 驱动缺失直接失败,不推进节拍/并发计数(未实际放行)
        this.failTask(task, `no driver registered: ${profile.driver}`)
        continue
      }
      this.throttle.markReleased(agentId)
      // 进入放行窗口:健康闸/基线钩子期间按占槽计,防止同窗口内重复放行超发
      this.starting.add(task.id)
      agentRunning++
      scan.globalRunning++
      this.journal.record('task.release', task.origin, {
        agentId,
        taskId: task.id,
      })
      void this.execute(task, profile, driver)
    }
    return false
  }

  private scheduleRetry(retryInMs: number | undefined): void {
    this.clearReleaseTimer()
    if (retryInMs === undefined || retryInMs <= 0) return
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined
      this.tryRelease()
    }, retryInMs + RETRY_TIMER_SLACK_MS)
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
      if (!this.isOccupying(task)) continue
      if (agentId === undefined || task.agentId === agentId) count++
    }
    return count
  }

  /** running 与"已放行未进入 running"(健康闸/基线窗口)都占槽,放行窗口内不允许超发 */
  private isOccupying(task: TaskRecord): boolean {
    return task.state === 'running' || this.starting.has(task.id)
  }

  /** 同 cwd 互斥按占槽判定:仅 running/放行窗口占用,queued 不占(6.6) */
  private cwdOccupied(cwd: string, excludeTaskId: string): boolean {
    for (const task of this.live.values()) {
      if (task.id === excludeTaskId) continue
      if (this.isOccupying(task) && task.cwd === cwd) return true
    }
    return false
  }

  private async execute(
    task: TaskRecord,
    profile: AgentProfile,
    driver: AgentDriver,
  ): Promise<void> {
    const emit = (event: TaskEvent) => this.recordEvent(task.id, event)
    try {
      // 健康闸在进入 running 之前:不通过走 queued→failed,
      // 未运行即终态自动返还计数,并经终态钩子交给降级决策
      if (!(await this.passesHealthGate(task, profile))) return
      // 放行后到 execute 实际推进之间存在取消窗口;已离开 queued 说明已被取消,直接退出
      if (task.state !== 'queued') return
      this.transition(task, 'running')
      // 已进入 running,占槽改由任务状态承载
      this.starting.delete(task.id)
      const controller = new AbortController()
      this.controllers.set(task.id, controller)
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
      const baseline = await this.runBaselineHook(task)
      try {
        const result = await driver.run({
          agent: profile,
          modelId: task.modelId,
          input: {
            prompt: task.prompt,
            cwd: task.cwd,
            sessionId: task.sessionId,
            resumeLatest: task.resumeLatest,
            attachments: task.attachments,
            toolPolicy: task.toolPolicy,
            mode: task.mode,
          },
          emit,
          signal: controller.signal,
          timeoutMs: this.deps.defaultTimeoutMs,
        })
        if (controller.signal.aborted) return
        if (result.sessionId && !task.sessionId) {
          task.sessionId = result.sessionId
        }
        if (result.usage) {
          const inTok = result.usage.inputTokens ?? 0
          const outTok = result.usage.outputTokens ?? 0
          const cachedTok = result.usage.cachedTokens ?? 0
          const totalInput = inTok + cachedTok
          const cacheHitRate = totalInput > 0 ? Number(((cachedTok / totalInput) * 100).toFixed(1)) : 0
          const credits = result.usage.credits ?? Number(((inTok + outTok + cachedTok) / 1000).toFixed(2))
          task.usage = {
            inputTokens: inTok,
            outputTokens: outTok,
            cachedTokens: cachedTok,
            credits,
            cacheHitRate,
            cost: result.usage.cost,
          }
          emit({ kind: 'usage', ...task.usage })
        }
        this.deps.repo.putTask(task)
        if (result.code === 0) {
          this.transition(task, 'completed')
          this.processFollowupQueue(task)
        } else {
          this.failTask(task, `driver exited with code ${result.code}`)
        }
      } catch (error) {
        if (controller.signal.aborted) return
        this.failTask(task, error instanceof Error ? error.message : String(error))
      } finally {
        // 收尾钩子(产物扫描)为异步,失败只留 warning,不允许未处理拒绝击穿主进程
        void Promise.resolve(this.deps.onRunEnd?.(task, baseline)).catch((error: unknown) => {
          this.recordEvent(task.id, {
            kind: 'warning',
            text: `收尾钩子执行失败:${error instanceof Error ? error.message : String(error)}`,
          })
        })
      }
    } finally {
      // 无论走哪条返回路径都要释放占槽并让路给队列
      this.starting.delete(task.id)
      this.controllers.delete(task.id)
      this.tryRelease()
    }
  }

  /** 放行健康闸:探活自身异常按不健康收敛,任务落 failed 后返回 false */
  private async passesHealthGate(task: TaskRecord, profile: AgentProfile): Promise<boolean> {
    if (!this.deps.healthAtRelease) return true
    const report = await this.deps.healthAtRelease(profile.id).catch((error) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }))
    if (report.ok) return true
    // 放行后取消竞态:健康探活期间任务可能已被取消,此时不再落 failed
    if (task.state === 'queued') {
      this.failTask(task, `客户端不健康:${report.reason ?? '未知原因'}`)
    }
    return false
  }

  /** run 前基线钩子:失败只留 warning,不阻断执行(缺基线最多漏判产物新增) */
  private async runBaselineHook(task: TaskRecord): Promise<unknown> {
    try {
      return await this.deps.onRunStart?.(task)
    } catch (error) {
      this.recordEvent(task.id, {
        kind: 'warning',
        text: `产物基线建立失败:${error instanceof Error ? error.message : String(error)}`,
      })
      return undefined
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
    this.deps.repo.putTask(task)
    this.recordEvent(task.id, { kind: 'state-changed', from, to })
    if (to === 'completed' || to === 'failed' || to === 'canceled') {
      // 未运行即终态:返还入队计数(记回创建日)
      this.throttle.refundIfNeverRan(task)
      this.journal.record(`task.${to === 'completed' ? 'complete' : to}`, task.origin, {
        agentId: task.agentId,
        taskId: task.id,
        detail: task.error,
      })
      this.notify(this.terminalListeners, task, '终态钩子')
    }
  }

  /** 逐个调用监听器并隔离异常:钩子抛错不得回灌状态机(否则终态迁移会被二次触发) */
  private notify(listeners: TerminalListener[], task: TaskRecord, label: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(task)
      } catch (error) {
        this.recordEvent(task.id, {
          kind: 'warning',
          text: `${label}执行失败:${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  private recordEvent(taskId: string, event: TaskEvent): void {
    const seq = (this.seqCursors.get(taskId) ?? this.deps.repo.maxSeqOf(taskId)) + 1
    this.seqCursors.set(taskId, seq)
    const stored: StoredEvent = { taskId, seq, at: this.clock.now(), event }
    this.deps.sink.append([stored])
  }

  private processFollowupQueue(completedTask: TaskRecord): void {
    const queue = this.followupQueues.get(completedTask.id)
    if (!queue || queue.length === 0) return
    const nextItem = queue.shift()!
    const nextTask = this.submit({
      agentId: completedTask.agentId,
      prompt: nextItem.prompt,
      cwd: completedTask.cwd,
      projectId: completedTask.projectId,
      sessionId: completedTask.sessionId,
      resumeLatest: !completedTask.sessionId,
      modelId: completedTask.modelId,
      mode: completedTask.mode,
      toolPolicy: completedTask.toolPolicy,
      parentId: completedTask.id,
      origin: 'panel',
      skills: nextItem.skills ?? completedTask.skills,
    })
    if (queue.length > 0) {
      this.followupQueues.set(nextTask.id, queue)
    }
    this.followupQueues.delete(completedTask.id)
  }
}
