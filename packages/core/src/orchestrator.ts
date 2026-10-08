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
  ContinueOptions,
  FollowupContinuedEvent,
  FollowupQueueItem,
  ReasoningEffort,
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
  /** 请求的思考档位(P0-4);驱动侧各自映射,任务记录只存请求档位 */
  reasoningEffort?: ReasoningEffort
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
/** 追问队列自动接续推送监听(P0-6):组合根订阅后经 IPC 通道 followup:continued 转发渲染层 */
export type FollowupContinuedListener = (payload: FollowupContinuedEvent) => void

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
  /** 已提示过 daily-cap 阻塞的任务(G5-04):任务记录随终态回收,重复入队允许再提示一次 */
  private readonly capNotified = new WeakSet<TaskRecord>()
  /** 已放行但还没进入 running 的任务(健康闸/基线钩子窗口);此窗口内仍算占槽 */
  private readonly starting = new Set<string>()
  private readonly seqCursors = new Map<string, number>()
  private readonly clock: Clock
  private readonly throttle: Throttle
  private readonly journal: Journal
  private readonly terminalListeners: TerminalListener[] = []
  private readonly submittedListeners: TerminalListener[] = []
  private readonly followupContinuedListeners: FollowupContinuedListener[] = []
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

  /** 订阅追问队列自动接续推送(P0-6);监听器抛错只留 warning,不回灌状态机 */
  onFollowupContinued(listener: FollowupContinuedListener): () => void {
    this.followupContinuedListeners.push(listener)
    return () => {
      const index = this.followupContinuedListeners.indexOf(listener)
      if (index >= 0) this.followupContinuedListeners.splice(index, 1)
    }
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
      reasoningEffort: request.reasoningEffort,
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
   * options 的本轮覆盖参数(P0-6)缺省沿用父任务,完全向后兼容。
   */
  continueConversation(taskId: string, prompt: string, options?: ContinueOptions): TaskRecord | FollowupQueueItem {
    const parent = this.taskOf(taskId)
    if (!parent) throw new Error(`unknown task: ${taskId}`)
    if (parent.state === 'running' || parent.state === 'queued') {
      if (options?.queueIfRunning) {
        return this.enqueueFollowup(taskId, prompt, options.skills, {
          modelId: options.modelId,
          mode: options.mode,
          toolPolicy: options.toolPolicy,
          reasoningEffort: options.reasoningEffort,
          attachments: options.attachments,
        })
      }
      throw new Error('任务运行中:请等待完成或先取消,再继续对话')
    }
    const next = this.submit({
      agentId: parent.agentId,
      prompt,
      cwd: parent.cwd,
      projectId: parent.projectId,
      sessionId: parent.sessionId,
      resumeLatest: !parent.sessionId,
      modelId: options?.modelId ?? parent.modelId,
      mode: options?.mode ?? parent.mode,
      toolPolicy: options?.toolPolicy ?? parent.toolPolicy,
      reasoningEffort: options?.reasoningEffort ?? parent.reasoningEffort,
      // K-07:本轮附件缺省继承父任务,不传即沿用,避免续聊静默丢附件
      attachments: options?.attachments ?? parent.attachments,
      parentId: parent.id,
      origin: 'panel',
      skills: options?.skills ?? parent.skills,
    })
    // 降级续接标注(G5-06):父任务无会话 id 时按 -c 续接工作区最近会话,
    // 接到的可能完全是别的任务的上下文——写一条落库信息事件明示,与"接续自"同构呈现
    if (next.resumeLatest && !next.sessionId) {
      this.recordEvent(next.id, {
        kind: 'info',
        text: '未携带会话记录,已续接该工作区最近会话(可能与预期会话不同,请核对上下文)',
      })
    }
    return next
  }

  /** 加入排队消息:当父任务完成后自动接续执行;overrides 为本轮覆盖参数(P0-6/K-07),缺省沿用父任务 */
  enqueueFollowup(
    taskId: string,
    prompt: string,
    skills?: string[],
    overrides?: Pick<
      ContinueOptions,
      'modelId' | 'mode' | 'toolPolicy' | 'reasoningEffort' | 'attachments'
    >,
  ): FollowupQueueItem {
    const parent = this.taskOf(taskId)
    if (!parent) throw new Error(`unknown task: ${taskId}`)
    const item: FollowupQueueItem = {
      id: randomUUID(),
      parentTaskId: taskId,
      prompt: prompt.trim(),
      skills,
      createdAt: this.clock.now(),
    }
    if (overrides?.modelId !== undefined) item.modelId = overrides.modelId
    if (overrides?.mode !== undefined) item.mode = overrides.mode
    if (overrides?.toolPolicy !== undefined) item.toolPolicy = overrides.toolPolicy
    if (overrides?.reasoningEffort !== undefined) item.reasoningEffort = overrides.reasoningEffort
    if (overrides?.attachments !== undefined) item.attachments = overrides.attachments
    const queue = this.followupQueues.get(taskId) ?? []
    queue.push(item)
    this.followupQueues.set(taskId, queue)
    this.persistFollowups(taskId)
    this.journal.record('task.followup.enqueue', parent.origin, {
      agentId: parent.agentId,
      taskId: parent.id,
      detail: `followupId=${item.id}`,
    })
    return item
  }

  /** 编辑排队消息文案(P0-6/D3):prompt.trim() 归一化;任务或队列项不存在抛错 */
  updateFollowup(taskId: string, followupId: string, prompt: string): FollowupQueueItem {
    const queue = this.followupQueues.get(taskId)
    const item = queue?.find((i) => i.id === followupId)
    if (!item) throw new Error(`unknown followup: ${followupId} on task ${taskId}`)
    item.prompt = prompt.trim()
    this.persistFollowups(taskId)
    const parent = this.taskOf(taskId)
    if (parent) {
      this.journal.record('task.followup.update', parent.origin, {
        agentId: parent.agentId,
        taskId,
        detail: `followupId=${followupId}`,
      })
    }
    return item
  }

  /**
   * 队列内移动(P0-6/D3):插入到 beforeFollowupId 之前;
   * null/缺省 = 移到队尾;beforeFollowupId 须同队列,否则抛错。
   */
  reorderFollowup(taskId: string, followupId: string, beforeFollowupId: string | null): void {
    const queue = this.followupQueues.get(taskId)
    const idx = queue?.findIndex((i) => i.id === followupId) ?? -1
    if (!queue || idx < 0) throw new Error(`unknown followup: ${followupId} on task ${taskId}`)
    if (beforeFollowupId === followupId) return
    if (beforeFollowupId != null && !queue.some((i) => i.id === beforeFollowupId)) {
      throw new Error(`unknown followup: ${beforeFollowupId} on task ${taskId}`)
    }
    const [item] = queue.splice(idx, 1)
    if (beforeFollowupId == null) {
      queue.push(item!)
    } else {
      queue.splice(queue.findIndex((i) => i.id === beforeFollowupId), 0, item!)
    }
    this.persistFollowups(taskId)
    const parent = this.taskOf(taskId)
    if (parent) {
      this.journal.record('task.followup.reorder', parent.origin, {
        agentId: parent.agentId,
        taskId,
        detail: `followupId=${followupId} before=${beforeFollowupId ?? 'tail'}`,
      })
    }
  }

  getFollowups(taskId: string): FollowupQueueItem[] {
    return [...(this.followupQueues.get(taskId) ?? [])]
  }

  /** 各任务的排队追问数量(G5-05):tasks:list DTO 组装用,空队列不计入 */
  getFollowupCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const [taskId, queue] of this.followupQueues) {
      if (queue.length > 0) counts.set(taskId, queue.length)
    }
    return counts
  }

  removeFollowup(taskId: string, followupId: string): boolean {
    const queue = this.followupQueues.get(taskId)
    if (!queue) return false
    const idx = queue.findIndex((item) => item.id === followupId)
    if (idx >= 0) {
      queue.splice(idx, 1)
      if (queue.length === 0) this.followupQueues.delete(taskId)
      // 队列空时落库空数组,防止重启后已删项复活(G5-01)
      this.persistFollowups(taskId)
      return true
    }
    return false
  }

  clearFollowups(taskId: string): void {
    this.followupQueues.delete(taskId)
    // 落库空数组,防止重启后已清空队列复活(G5-01)
    this.persistFollowups(taskId)
  }

  /**
   * 队列整体迁移(P0-6 复审):打断当前轮并立即发送拿到新任务后,
   * 把旧任务遗留的排队项搬到新任务继续自动接续——被打断的父任务已终态,
   * processFollowupQueue 只在 completed 路径消费,遗留项不迁移将永远不再发送。
   * 返回迁移条数(源队列为空返回 0)。
   */
  migrateFollowups(fromTaskId: string, toTaskId: string): number {
    if (fromTaskId === toTaskId) return 0
    const queue = this.followupQueues.get(fromTaskId)
    if (!queue || queue.length === 0) return 0
    const target = this.followupQueues.get(toTaskId) ?? []
    for (const item of queue) item.parentTaskId = toTaskId
    target.push(...queue)
    this.followupQueues.set(toTaskId, target)
    this.followupQueues.delete(fromTaskId)
    // 双端同步落库:from 清空防复活,to 写入防丢失(G5-01)
    this.persistFollowups(toTaskId)
    this.persistFollowups(fromTaskId)
    return queue.length
  }

  rename(taskId: string, title: string): TaskRecord {
    const task = this.taskOf(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    task.title = title.trim()
    this.deps.repo.putTask(task)
    return task
  }

  /**
   * 归属变更同步(P0-2):tasks:move 由仓库直写 project_id,但 live 表的任务对象仍持旧值,
   * 后续状态迁移/usage 落库经 putTask 会把旧 projectId 回写,用户移动被静默回滚。
   * 任务在 live 表时同步更新(不在即无需同步,仓库已是新值);返回是否同步到。
   */
  syncTaskProject(taskId: string, projectId: string): boolean {
    const task = this.live.get(taskId)
    if (!task) return false
    task.projectId = projectId
    return true
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

  /**
   * 追问队列同步落库(G5-01):每个内存变更点后调用,以"当前内存态"全量替换该任务的库行;
   * repo 未实现(内存仓库测试)时经可选链跳过。队列不存在落空数组,防止重启复活。
   */
  private persistFollowups(taskId: string): void {
    this.deps.repo.replaceFollowups?.(taskId, this.followupQueues.get(taskId) ?? [])
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
    // 崩溃恢复内存队列(G5-01):任务记录已重载,排队追问随之复位,原序继续自动接续
    const persisted = this.deps.repo.allFollowups?.()
    if (persisted) {
      for (const [taskId, items] of persisted) {
        this.followupQueues.set(taskId, items)
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
          // daily-cap 是客户端级阻塞:任务将长时间停留"排队中",写一条去重的用户可见
          // 原因(信息事件中性呈现),避免误判应用卡死或反复点击(G5-04)
          if (decision.reason === 'daily-cap' && !this.capNotified.has(task)) {
            this.capNotified.add(task)
            this.recordEvent(task.id, {
              kind: 'info',
              text: '今日派发额度已满,任务保持排队,零点后自动派发',
            })
          }
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
          reasoningEffort: task.reasoningEffort,
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
          try {
            this.processFollowupQueue(task)
          } catch (followupError) {
            this.recordEvent(task.id, {
              kind: 'warning',
              text: `排队追问接续派发失败:${followupError instanceof Error ? followupError.message : String(followupError)}`,
            })
          }
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
      modelId: nextItem.modelId ?? completedTask.modelId,
      mode: nextItem.mode ?? completedTask.mode,
      toolPolicy: nextItem.toolPolicy ?? completedTask.toolPolicy,
      reasoningEffort: nextItem.reasoningEffort ?? completedTask.reasoningEffort,
      // K-07:排队时记录的本轮附件优先,缺省继承父任务 attachments
      attachments: nextItem.attachments ?? completedTask.attachments,
      parentId: completedTask.id,
      origin: 'panel',
      skills: nextItem.skills ?? completedTask.skills,
    })
    if (queue.length > 0) {
      this.followupQueues.set(nextTask.id, queue)
    }
    this.followupQueues.delete(completedTask.id)
    // 内联迁移同步落库(G5-01):completedTask 传 [] 防止已消费队列重启后复活(重复执行),
    // nextTask 传剩余 queue 防止新任务队列丢失;两处缺一不可
    this.persistFollowups(completedTask.id)
    this.persistFollowups(nextTask.id)
    // 在新任务事件流头部写一条"接续自"info 事件落库,会话链可回溯(P0-6/D2);
    // R16:系统提示改 kind:'info' 中性呈现,不再借 message/agent 渠道冒充 Agent 正式发言
    this.recordEvent(nextTask.id, {
      kind: 'info',
      text: `接续自 #${completedTask.id}`,
    })
    // 接续可见推送(P0-6/D2):渲染层据此切换选中并提示去处
    this.notifyFollowupContinued({ fromTaskId: completedTask.id, toTaskId: nextTask.id })
  }

  private notifyFollowupContinued(payload: FollowupContinuedEvent): void {
    for (const listener of [...this.followupContinuedListeners]) {
      try {
        listener(payload)
      } catch (error) {
        this.recordEvent(payload.toTaskId, {
          kind: 'warning',
          text: `接续推送监听器执行失败:${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }
}
