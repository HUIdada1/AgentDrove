/**
 * IPC 契约单一来源(7.5):
 * main 按此实现 handlers,renderer 经 preload 拿到同一套 typed client,
 * 通道改名/入参变更在两端的编译期同时报错。
 */
import type {
  AgentProfile,
  AppConfig,
  DriverUsage,
  HealthReport,
  LaunchChannel,
  ModelPreset,
  PlanInfo,
  Project,
  StoredEvent,
  TaskRecord,
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
  TaskRecord,
  WorkspaceRow,
}

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
  capabilities: AgentProfile['capabilities']
  plan: PlanInfo
  enabled: boolean
  /** 最近一次健康探活结果(可能为空=未探过) */
  health?: HealthReport
  /** 今日已计任务数 */
  usedToday: number
}

export interface SubmitTaskDto {
  agentId: string
  prompt: string
  cwd?: string
  /** 侧栏选中的项目工作区:cwd 留空时回落项目目录(日常工作区未绑定则落默认目录) */
  projectId?: string
  modelId?: string
  mode?: TaskRecord['mode']
  attachments?: TaskRecord['attachments']
  toolPolicy?: TaskRecord['toolPolicy']
  /** 续聊目标会话 */
  sessionId?: string
  resumeLatest?: boolean
  origin?: TaskRecord['origin']
  /** 派生工作区源目录:git 源 → worktree;非 git → tempcopy 整拷降级 */
  workspaceSource?: string
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
}

export interface AgentDroveApi extends PushEvents {
  // agents:*
  agentsList(): Promise<AgentView[]>
  agentsSetEnabled(agentId: string, enabled: boolean): Promise<void>
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
  tasksContinue(taskId: string, prompt: string): Promise<TaskRecord>
  tasksCancel(taskId: string): Promise<boolean>
  tasksMarkFailed(taskId: string, reason?: string): Promise<boolean>
  tasksBatchCancel(taskIds: string[]): Promise<number>
  tasksBatchDelete(taskIds: string[]): Promise<number>
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
  // 隐藏迷你条窗口(Esc/派发成功后调用)
  hideMini(): Promise<void>
  // 渲染层拿不到 File 真实路径,经 preload 的 webUtils 解析
  filePath(file: File): string
}

/** preload 挂载点;renderer 全局唯一入口,不直接碰 ipcRenderer */
export interface AgentDroveWindow {
  api: AgentDroveApi
}
