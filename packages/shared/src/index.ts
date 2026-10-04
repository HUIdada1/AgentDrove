/**
 * IPC 契约单一来源(7.5):
 * main 按此实现 handlers,renderer 经 preload 拿到同一套 typed client,
 * 通道改名/入参变更在两端的编译期同时报错。
 */
import type {
  AgentProfile,
  AppConfig,
  DriverUsage,
  FollowupQueueItem as CoreFollowupQueueItem,
  HealthReport,
  LaunchChannel,
  ModelPreset,
  PlanInfo,
  Project,
  StoredEvent,
  TaskRecord as CoreTaskRecord,
  TaskUsage,
  WorkspaceRow,
} from '@agent-drove/core'

export type {
  AgentProfile,
  AppConfig,
  DriverUsage,
  HealthReport,
  LaunchChannel,
  ModelPreset,
  PlanInfo,
  Project,
  StoredEvent,
  TaskUsage,
  WorkspaceRow,
}

/**
 * core 类型的契约增量(P0-2/P0-4/P0-6):字段正式落进 core/types.ts 前,
 * 渲染层经 shared 视图先行获得类型;core 落地后两处结构一致(同名可选同型,继承合法)。
 */

/** 思考档位(P0-4):DTO 用通用四档,驱动侧各自映射到 CLI 实际参数(zcode reasoningLevel / codex effort) */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

export interface TaskRecord extends CoreTaskRecord {
  /** 组内手动排序位(P0-2):仅由 core 维护;空缺时该组仍按 createdAt 倒序 */
  orderIndex?: number
  /** 请求的思考档位(P0-4);实际生效档位以事件流 warning/info 为准,避免 UI 撒谎 */
  reasoningEffort?: ReasoningEffort
}

/**
 * 分组内展示序(P0-2):orderIndex 有值者按值升序在前(手动区),
 * 空缺者按 createdAt 倒序随后——旧数据零迁移成本,orderIndex 仅在拖过/移过之后产生。
 * 注意:这是【组内良构序】,orderIndex 是组内连续值;跨分组的全局列表序必须维持
 * createdAt 倒序,手动序只在按组过滤/分组渲染的子序列上应用
 * (main tasks:list 与 renderer TaskList.visible 共用此单一事实源)。
 */
export function compareTaskOrder(a: TaskRecord, b: TaskRecord): number {
  return (
    (a.orderIndex ?? Number.MAX_SAFE_INTEGER) - (b.orderIndex ?? Number.MAX_SAFE_INTEGER) ||
    b.createdAt - a.createdAt
  )
}

export interface FollowupQueueItem extends CoreFollowupQueueItem {
  /** 排队时随项记录的本轮覆盖参数(P0-6);缺省沿用父任务 */
  modelId?: string
  mode?: TaskRecord['mode']
  toolPolicy?: TaskRecord['toolPolicy']
  reasoningEffort?: ReasoningEffort
}

export interface SkillDefinition {
  id: string
  label: string
  icon: string
  description: string
  disallowedTools?: string[]
}

export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: 'terminal',
    label: '终端执行',
    icon: '💻',
    description: '允许在系统受控环境中执行命令行与脚本',
    disallowedTools: ['execute_command', 'run_command', 'bash', 'terminal', 'cmd'],
  },
  {
    id: 'file_editor',
    label: '代码编辑',
    icon: '📝',
    description: '允许创建、修改和重构工作区内的代码与文件',
    disallowedTools: ['edit_file', 'write_file', 'replace_file_content', 'write_to_file'],
  },
  {
    id: 'code_search',
    label: '代码检索',
    icon: '🔍',
    description: '检索符号定义、文件树与全局模式定位',
    disallowedTools: ['grep_search', 'file_search', 'search_code', 'find_by_name'],
  },
  {
    id: 'web_search',
    label: '网络搜索',
    icon: '🌐',
    description: '检索在线官方文档、技术资料与解决方案',
    disallowedTools: ['web_search', 'read_url_content', 'browser'],
  },
  {
    id: 'test_runner',
    label: '测试套件',
    icon: '🧪',
    description: '自动运行单元测试与校验执行结果',
    disallowedTools: ['run_test', 'test_runner'],
  },
  {
    id: 'git_review',
    label: '审查守护',
    icon: '🛡️',
    description: '代码质量审查、差异比对与静态规则分析',
    disallowedTools: [],
  },
]

export function skillsToDenyList(activeSkillIds: string[]): string[] {
  const activeSet = new Set(activeSkillIds)
  const denied: string[] = []
  for (const skill of BUILTIN_SKILLS) {
    if (!activeSet.has(skill.id) && skill.disallowedTools) {
      denied.push(...skill.disallowedTools)
    }
  }
  return [...new Set(denied)]
}

export interface ScenarioTemplate {
  id: string
  category: 'feature' | 'debug' | 'refactor' | 'test' | 'review' | 'architecture'
  title: string
  desc: string
  icon: string
  prompt: string
  mode: TaskRecord['mode']
  recommendedSkills: string[]
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    id: 'sc-feat',
    category: 'feature',
    title: '功能实现',
    desc: '基于现有架构新增业务模块与类型支持，遵循 KISS 原则',
    icon: '🚀',
    prompt: '请根据业务需求在当前项目中实现以下功能，要求结构清晰、补充必要类型并处理好边界情况：',
    mode: 'build',
    recommendedSkills: ['file_editor', 'code_search', 'terminal'],
  },
  {
    id: 'sc-debug',
    category: 'debug',
    title: '排错与修复',
    desc: '深度分析错误堆栈，定位根本原因并输出热修复方案',
    icon: '🐛',
    prompt: '请分析当前遇到的异常或报错堆栈，基于第一性原理定位根本原因并输出修复补丁：',
    mode: 'edit',
    recommendedSkills: ['file_editor', 'code_search', 'test_runner'],
  },
  {
    id: 'sc-refactor',
    category: 'refactor',
    title: '代码重构',
    desc: '消除重复冗余，优化组件层级与状态流转',
    icon: '⚡',
    prompt: '请重构以下模块的代码结构，提高可读性与可维护性，避免过度工程化：',
    mode: 'edit',
    recommendedSkills: ['file_editor', 'code_search'],
  },
  {
    id: 'sc-test',
    category: 'test',
    title: '测试覆盖',
    desc: '为关键链路编写单元测试与集成测试，覆盖异常边界',
    icon: '🧪',
    prompt: '请为当前核心业务逻辑编写完备的自动化测试用例，覆盖正常分支与错误边界：',
    mode: 'build',
    recommendedSkills: ['file_editor', 'test_runner', 'terminal'],
  },
  {
    id: 'sc-review',
    category: 'review',
    title: '质量审查',
    desc: '全面审查代码质量、潜在死锁、未处理异步与安全隐患',
    icon: '🛡️',
    prompt: '请对当前工作区近期的代码修改进行全量审查，指出潜在风险、内存泄漏与可优化点：',
    mode: 'plan',
    recommendedSkills: ['code_search', 'git_review'],
  },
  {
    id: 'sc-plan',
    category: 'architecture',
    title: '架构规划',
    desc: '构思系统方案，分解为具体里程碑与落地步骤',
    icon: '📋',
    prompt: '请为即将开展的项目重构制定分步实施计划，按“构思方案 → 分解为具体任务”展开：',
    mode: 'plan',
    recommendedSkills: ['code_search'],
  },
]

export interface AgentView {
  id: string
  label: string
  driver: string
  entry: string
  cliEntry?: string
  version?: string
  logoPath?: string
  models: ModelPreset[]
  /** UI 展示的模型目录(跟随客户端的档案展示哨兵项) */
  defaultModel: string
  capabilities: AgentProfile['capabilities'] & {
    /** 思考档位能力(P0-4):false/缺省 = 该客户端不支持 reasoningEffort,渲染层隐藏"思考"下拉 */
    reasoningEffort?: boolean
  }
  plan: PlanInfo
  enabled: boolean
  /** 最近一次健康探活结果(可能为空=未探过) */
  health?: HealthReport
  /** 今日已计任务数 */
  usedToday: number
  /** 剩余点数 (Credits) */
  remainingCredits?: number
  /** 剩余 Token 数 */
  remainingTokens?: number
  /** 剩余百分比 (0-100) */
  remainingPercent?: number
  /** 今日消耗 Token 数 */
  usedTokensToday?: number
  /** 今日消耗点数 */
  usedCreditsToday?: number
  /** 今日平均缓存命中率 (0-100) */
  cacheHitRateToday?: number
}

export interface SubmitTaskDto {
  agentId: string
  prompt: string
  title?: string
  cwd?: string
  /** 侧栏选中的项目工作区:cwd 留空时回落项目目录(日常工作区未绑定则落默认目录) */
  projectId?: string
  modelId?: string
  mode?: TaskRecord['mode']
  attachments?: TaskRecord['attachments']
  skills?: string[]
  toolPolicy?: TaskRecord['toolPolicy']
  /** 思考档位(P0-4):客户端不支持时由驱动兜底回落,渲染层按 capabilities.reasoningEffort 隐藏控件 */
  reasoningEffort?: ReasoningEffort
  /** 续聊目标会话 */
  sessionId?: string
  resumeLatest?: boolean
  origin?: TaskRecord['origin']
  /** 派生工作区源目录:git 源 → worktree;非 git → tempcopy 整拷降级 */
  workspaceSource?: string
}

/** 卡片归属变更(P0-2):把任务移入另一项目工作区;不支持"移出项目"语义 */
export interface MoveTaskDto {
  taskId: string
  projectId: string
}

/**
 * 续聊本轮参数(P0-6):缺省字段沿用父任务,完全向后兼容;
 * 排队时(queueIfRunning)整组覆盖随 FollowupQueueItem 落 JSON。
 */
export interface ContinueOptions {
  queueIfRunning?: boolean
  skills?: string[]
  /** 本轮覆盖:模型;缺省沿用 parent.modelId */
  modelId?: string
  mode?: TaskRecord['mode']
  toolPolicy?: TaskRecord['toolPolicy']
  reasoningEffort?: ReasoningEffort
}

/** 追问队列自动接续推送(P0-6,通道 followup:continued):渲染层据此切换选中并提示去处 */
export interface FollowupContinuedEvent {
  /** 接续来源(父任务) */
  fromTaskId: string
  /** 接续落地的新任务 */
  toTaskId: string
}

export interface TaskFilterDto {
  /** 关键词匹配 prompt */
  search?: string
  agentId?: string
  state?: TaskRecord['state']
  /** 按项目工作区分组过滤 */
  projectId?: string
  /** 创建时间下限(本地时区日,YYYY-MM-DD) */
  sinceDay?: string
  untilDay?: string
}

export interface EventsPageDto {
  taskId: string
  /** 按 seq 倒序翻页;缺省从最新开始 */
  beforeSeq?: number
  limit?: number
}

export interface UsageView {
  agentId: string
  label: string
  day: string
  taskCount: number
  estimated: number
  dailyTaskCap: number
  /** 今日已用 Token 数 */
  usedTokensToday: number
  /** 今日已用点数 */
  usedCreditsToday: number
  /** 今日命中缓存 Token 数 */
  cachedTokensToday: number
  /** 今日平均缓存命中率 (0-100) */
  cacheHitRateToday: number
  /** 剩余点数 */
  remainingCredits?: number
  /** 剩余 Tokens */
  remainingTokens?: number
  /** 剩余百分比 */
  remainingPercent?: number
  /** 总额度点数 */
  totalCredits?: number
  /** 总额度 Tokens */
  totalTokens?: number
}

export interface MergeResult {
  merged: string[]
  /** 冲突跳过清单(目标已存在且内容不同) */
  conflicts: string[]
}

export interface ExportResult {
  path: string
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  /** 版本或错误信息 */
  detail?: string
  progress?: number
}

export interface PushEvents {
  /** tasks:events-batch:事件批推(渲染层虚拟列表增量追加) */
  onTasksEventsBatch(listener: (events: StoredEvent[]) => void): () => void
  /** 任务列表发生变化(新增/派生/状态迁移),渲染层重拉列表 */
  onTasksUpdated(listener: () => void): () => void
  /** 客户端登记变化(启动后台探测完成/重扫),渲染层重拉客户端与用量 */
  onAgentsChanged(listener: () => void): () => void
  /** 调度暂停状态变化(托盘/渲染层双向) */
  onSchedulerChanged(listener: (paused: boolean) => void): () => void
  /** 更新阶段变化 */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  /** 托盘"快速派发"→ 聚焦发布框 */
  onPanelFocus(listener: () => void): () => void
  /** 全局热键注册失败(冲突),提示改键 */
  onHotkeyConflict(listener: (accelerator: string) => void): () => void
  /** 迷你条唤起时主进程推送剪贴板预填文本 */
  onMiniPrefill(listener: (text: string) => void): () => void
  /** 自定义标题栏:主窗最大化状态变化(最大化/还原图标切换) */
  onWindowMaximized(listener: (maximized: boolean) => void): () => void
  /**
   * 追问队列自动接续(P0-6,通道 followup:continued):父任务完成后排队消息落地为新任务。
   * 可选成员:preload 实现落地后转为必需(届时渲染层调用点同步去掉可选链)。
   */
  onFollowupContinued?(listener: (payload: FollowupContinuedEvent) => void): () => void
}

export interface AgentDroveApi extends PushEvents {
  // agents:*
  agentsList(): Promise<AgentView[]>
  agentsSetEnabled(agentId: string, enabled: boolean): Promise<void>
  /** 重新扫描本机已安装客户端(保留启停状态),返回最新列表 */
  agentsRescan(): Promise<AgentView[]>
  // projects:* 项目工作区(侧栏可选中)
  projectsList(): Promise<Project[]>
  /** 登记项目:原生目录选择弹窗选文件夹,取消返回 null */
  projectsPickAndAdd(): Promise<Project | null>
  /** 日常工作区绑定/解绑目录;path=null 回到未绑定分组态 */
  projectsBindDaily(path: string | null): Promise<Project>
  projectsRename(projectId: string, name: string): Promise<void>
  projectsRemove(projectId: string): Promise<void>
  /** 原生目录选择弹窗(日常工作区绑定等),取消返回 null */
  pickDirectory(): Promise<string | null>
  // tasks:*
  tasksList(filter?: TaskFilterDto): Promise<TaskRecord[]>
  tasksGet(taskId: string): Promise<TaskRecord | null>
  tasksEventsPage(query: EventsPageDto): Promise<StoredEvent[]>
  tasksSubmit(dto: SubmitTaskDto): Promise<TaskRecord>
  tasksSubmitBatch(dtos: SubmitTaskDto[]): Promise<TaskRecord[]>
  tasksRetry(taskId: string): Promise<TaskRecord>
  tasksContinue(
    taskId: string,
    prompt: string,
    options?: ContinueOptions,
  ): Promise<TaskRecord | FollowupQueueItem>
  tasksEnqueueFollowup(taskId: string, prompt: string, skills?: string[]): Promise<FollowupQueueItem>
  tasksGetFollowups(taskId: string): Promise<FollowupQueueItem[]>
  tasksRemoveFollowup(taskId: string, followupId: string): Promise<boolean>
  tasksClearFollowups(taskId: string): Promise<void>
  tasksRename(taskId: string, title: string): Promise<void>
  tasksCancel(taskId: string, clearFollowups?: boolean): Promise<boolean>
  tasksMarkFailed(taskId: string, reason?: string): Promise<boolean>
  tasksBatchCancel(taskIds: string[]): Promise<number>
  tasksBatchDelete(taskIds: string[]): Promise<number>
  // —— P0-2/P0-6 新增通道:可选成员,preload/mock 落地后转必需(渲染层届时去掉可选链) ——
  /** tasks:move(P0-2):任务移入另一项目工作区;受影响分组 orderIndex 由 core 重算,客户端不传全量数组 */
  tasksMove?(dto: MoveTaskDto): Promise<void>
  /** tasks:reorder(P0-2):组内相邻插入重排;beforeTaskId 须与 taskId 同组,null/缺省 = 移到该组末尾 */
  tasksReorder?(taskId: string, beforeTaskId?: string | null): Promise<void>
  /** tasks:update-followup(P0-6/D3):编辑排队消息文案;返回归一化后的队列项,目标不存在时抛错 */
  tasksUpdateFollowup?(
    taskId: string,
    followupId: string,
    prompt: string,
  ): Promise<FollowupQueueItem>
  /** tasks:reorder-followup(P0-6/D3):队列内移动;beforeFollowupId 须同队列,null/缺省 = 移到队尾 */
  tasksReorderFollowup?(
    taskId: string,
    followupId: string,
    beforeFollowupId?: string | null,
  ): Promise<void>
  /**
   * tasks:migrate-followups(P0-6 复审):把 from 任务遗留的排队项整体迁移到 to 任务继续自动接续,
   * 返回迁移条数。打断当前轮并立即发送后,被打断的父任务已终态,遗留项需迁移才能接续。
   */
  tasksMigrateFollowups?(fromTaskId: string, toTaskId: string): Promise<number>
  // health:check
  healthCheck(agentId: string, options?: { bypassCache?: boolean }): Promise<HealthReport>
  // launch:app
  launchApp(agentId: string): Promise<LaunchChannel>
  // usage:get
  usageGet(): Promise<UsageView[]>
  // settings:get/update(含 schedulerPaused)
  settingsGet(): Promise<AppConfig>
  settingsUpdate(patch: Partial<AppConfig>): Promise<AppConfig>
  schedulerPause(paused: boolean): Promise<void>
  // logs:tail
  logsTail(limit?: number): Promise<string[]>
  // export:data/report
  exportData(): Promise<ExportResult>
  exportWeeklyReport(): Promise<ExportResult>
  // workspaces:list/clean/merge
  workspacesList(): Promise<WorkspaceRow[]>
  workspacesClean(workspaceId: string): Promise<void>
  workspacesMerge(workspaceId: string): Promise<MergeResult>
  // update:check/install
  updateCheck(): Promise<UpdateStatus>
  updateInstall(): Promise<void>
  // 通用:打开目录(工作区/产物)
  openPath(targetPath: string): Promise<void>
  // 换客户端(手动指定降级目标,语义同 failover:attempt+1/retry_of 记链)
  tasksResubmitOn(taskId: string, targetAgentId: string): Promise<TaskRecord>
  // 窗口控制(自定义标题栏右上角按钮):sender 定位窗口
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
  // 隐藏迷你条窗口(Esc/派发成功后调用)
  hideMini(): Promise<void>
  // 渲染层拿不到 File 真实路径,经 preload 的 webUtils 解析
  filePath(file: File): string
}

/** preload 挂载点;renderer 全局唯一入口,不直接碰 ipcRenderer */
export interface AgentDroveWindow {
  api: AgentDroveApi
}
