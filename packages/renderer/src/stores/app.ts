import { computed, ref, shallowRef, watch } from 'vue'
import type {
  AgentView,
  AppConfig,
  FollowupQueueItem,
  Project,
  ReasoningEffort,
  StoredEvent,
  TaskRecord,
  UpdateStatus,
  UsageView,
  WorkspaceRow,
} from '@agent-drove/shared'

/**
 * 全局数据仓库:模块级单例,所有组件共享同一份状态。
 * 只走 window.api 的 typed IPC;事件批推增量合并,任务列表以主进程推送信号触发重拉。
 * (早期版本每次调用新建 ref,组件间状态互不相通——点击卡片详情不刷新就是这个坑)
 */
const agents = ref<AgentView[]>([])
/** G3-10:客户端探测完成标志(签名供侧栏侧 G1-06 复用):false=首轮探活尚未返回,
 * true=至少成功拉取过一次列表——发布框/侧栏据此区分「探测中」与「未发现」两种空态 */
const agentsLoaded = ref(false)
const projects = ref<Project[]>([])
const tasks = ref<TaskRecord[]>([])
const usage = ref<UsageView[]>([])
const settings = ref<AppConfig | null>(null)
const workspaces = ref<WorkspaceRow[]>([])
const updateStatus = ref<UpdateStatus>({ phase: 'idle' })
const view = ref<'panel' | 'settings'>('panel')

export interface AgentModelPreference {
  channelId?: string
  modelId?: string
  reasoningEffort?: ReasoningEffort | ''
  mode?: TaskRecord['mode']
}

export function getAgentModelPref(agentId: string): AgentModelPreference | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(`agentdrove.agent_model_pref.${agentId}`) : null
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function saveAgentModelPref(agentId: string, pref: AgentModelPreference): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`agentdrove.agent_model_pref.${agentId}`, JSON.stringify(pref))
    }
  } catch {}
}
/** 侧栏折叠状态(R01):持久化偏好,启动时由 App.vue 按当前窗口宽再校验(不足自动折叠) */
const railCollapsed = ref(
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('agentdrove.layout.railCollapsed') === 'true'
    : false,
)
watch(railCollapsed, (val) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('agentdrove.layout.railCollapsed', String(val))
  }
})
/** 详情栏收起/锁起状态:默认 true(收起锁起,会话流视野最大化),持久化偏好 */
const detailCollapsed = ref(
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('agentdrove.layout.detailCollapsed') !== 'false'
    : true,
)
watch(detailCollapsed, (val) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('agentdrove.layout.detailCollapsed', String(val))
  }
})

/** 详情弹窗显隐状态 */
const detailModalOpen = ref(false)

function openDetailModal(taskId?: string): void {
  if (taskId) selectedTaskId.value = taskId
  detailModalOpen.value = true
}

function closeDetailModal(): void {
  detailModalOpen.value = false
}

/**
 * 详情展开前的空间守卫(P0-7/R01):由 App.vue 注册(它持有 railW/taskW/detailW 列宽状态)。
 * 守卫为真阶梯:展开后预估会话流 <360px 时先自动收侧栏 → 任务列压到 280 →
 * 仍不足返回 false 拒绝展开;守卫内部已 toast 说明,此处保持收起。
 */
let expandGuard: (() => boolean) | null = null

export function registerExpandGuard(guard: (() => boolean) | null): void {
  expandGuard = guard
}

function toggleDetailCollapsed(): void {
  // 收起不受限;展开方向先过空间守卫,不通过(已提示)则保持收起
  if (detailCollapsed.value && expandGuard && !expandGuard()) return
  detailCollapsed.value = !detailCollapsed.value
}

const selectedTaskId = ref<string | null>(null)
const selection = ref<Set<string>>(new Set())
const filter = ref({ search: '', agentId: '', state: '' })
// G3-02:筛选变更 debounce 重拉——此前筛选只改内存,列表要等主进程事件批推才带着旧筛选
// 重拉,搜索清空后列表长期停留在收窄集合;250ms debounce 避免逐字符 IPC
let filterTimer: ReturnType<typeof setTimeout> | null = null
watch(
  filter,
  () => {
    if (filterTimer) clearTimeout(filterTimer)
    filterTimer = setTimeout(() => void refreshTasks(), 250)
  },
  { deep: true },
)
const liveEvents = shallowRef(new Map<string, StoredEvent[]>())

/**
 * 当前对话上下文的客户端(P0-1/R05/G1-01):侧栏点击=进入与该 Agent 的对话(发布框同步);
 * 再次点击取消绑定回 ""。与任务筛选 filter.agentId 完全解耦,筛选仅由任务列头下拉控制。
 */
const agentContext = ref('')

/** 正在拖拽的任务卡 id(P0-2):dragstart 写入、dragend/drop 清除;AgentRail 据此接住 drop */
const draggingTaskId = ref<string | null>(null)

/** 当前激活的技能清单:localStorage 持久化(G3-14),重启恢复上次选择;损坏/不可读回落默认四项 */
const DEFAULT_SKILLS = ['terminal', 'file_editor', 'code_search', 'web_search']
const activeSkills = ref<string[]>((() => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('agentdrove.skills') : null
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')
      ? (parsed as string[])
      : DEFAULT_SKILLS
  } catch {
    return DEFAULT_SKILLS
  }
})())
// toggleSkill/setSkills 均经此持久化,与 railCollapsed 同款模式;存储不可写时静默放弃
watch(activeSkills, (val) => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem('agentdrove.skills', JSON.stringify(val))
  } catch {
    // 存储不可写(隐私模式/配额满)静默放弃:持久化是增强项,不阻塞技能切换
  }
})

/** 当前选中任务的排队追问队列 */
const activeFollowups = ref<FollowupQueueItem[]>([])

function toggleSkill(skillId: string): void {
  const current = new Set(activeSkills.value)
  if (current.has(skillId)) current.delete(skillId)
  else current.add(skillId)
  activeSkills.value = [...current]
}

function setSkills(skills: string[]): void {
  activeSkills.value = [...skills]
}

async function refreshFollowups(taskId: string): Promise<void> {
  if (!taskId || !window.api) {
    activeFollowups.value = []
    return
  }
  try {
    const list = await window.api.tasksGetFollowups(taskId)
    if (selectedTaskId.value === taskId) {
      activeFollowups.value = list
    }
  } catch {
    activeFollowups.value = []
  }
}

async function removeFollowup(taskId: string, followupId: string): Promise<void> {
  if (!window.api) return
  await window.api.tasksRemoveFollowup(taskId, followupId)
  await refreshFollowups(taskId)
}

async function clearFollowups(taskId: string): Promise<void> {
  if (!window.api) return
  await window.api.tasksClearFollowups(taskId)
  await refreshFollowups(taskId)
}

async function renameTask(taskId: string, title: string): Promise<void> {
  if (!window.api || !title.trim()) return
  await window.api.tasksRename(taskId, title.trim())
  await refreshTasks()
}

function newChat(): void {
  selectedTaskId.value = null
  activeFollowups.value = []
  // P0-1:新建对话保持 agentContext 不清除,发布框继续绑定当前客户端
}

/**
 * 激活 Agent 对话上下文 (符合现代 AI 客户端心智):
 * 1. 绑定 agentContext(再次点击同一 Agent 则取消绑定);
 * 2. 联动中央区: 若当前打开的任务不属于目标 Agent,平滑切入新会话草稿 (selectedTaskId = null);
 * 3. 聚焦并同步发布框;
 * 4. 保持任务列表独立,不强加粗暴的列表过滤.
 */
function selectAgentContext(agentId: string): void {
  if (agentContext.value === agentId) {
    agentContext.value = ''
    return
  }
  agentContext.value = agentId
  if (selectedTaskId.value) {
    const currentTask = tasks.value.find((t) => t.id === selectedTaskId.value)
    if (currentTask && currentTask.agentId !== agentId) {
      selectedTaskId.value = null
      activeFollowups.value = []
    }
  }
  window.dispatchEvent(new CustomEvent('focus-composer'))
}

function clearAgentContext(): void {
  agentContext.value = ''
}

/** 轻提示(P0-6/P0-7 配套最小实现):单条文本,2.6s 自动消退,App.vue 底部渲染 */
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(msg: string): void {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 2600)
}

/**
 * 任务卡归属变更(P0-2):乐观改本地 projectId(筛选视图即时反映),
 * 落库走 tasks:move 通道;core 重算受影响分组 orderIndex,客户端不传全量数组。
 */
async function moveTask(taskId: string, projectId: string): Promise<void> {
  const task = tasks.value.find((t) => t.id === taskId)
  if (!task || task.projectId === projectId) return
  const prev = task.projectId
  task.projectId = projectId
  if (!window.api?.tasksMove) {
    task.projectId = prev
    showToast('任务移动通道未就绪,请升级主进程')
    return
  }
  try {
    await window.api.tasksMove({ taskId, projectId })
  } catch (error) {
    task.projectId = prev
    showToast(`移动失败:${error instanceof Error ? error.message : String(error)}`)
  }
  await refreshTasks()
}

/**
 * 组内相邻插入排序(P0-2):乐观重排本地 tasks 数组,失败(或通道未就绪)重拉还原;
 * beforeTaskId=null = 移到组尾,与 tasks:reorder 契约语义一致。
 */
async function reorderTask(taskId: string, beforeTaskId: string | null): Promise<void> {
  const list = tasks.value
  const from = list.findIndex((t) => t.id === taskId)
  if (from < 0) return
  const [task] = list.splice(from, 1)
  let to: number
  if (beforeTaskId) {
    const anchor = list.findIndex((t) => t.id === beforeTaskId)
    to = anchor < 0 ? list.length : anchor
  } else {
    to = list.length
  }
  list.splice(to, 0, task!)
  if (!window.api?.tasksReorder) {
    showToast('任务排序通道未就绪,请升级主进程')
    await refreshTasks()
    return
  }
  try {
    await window.api.tasksReorder(taskId, beforeTaskId)
  } catch (error) {
    showToast(`排序失败,已还原:${error instanceof Error ? error.message : String(error)}`)
  }
  await refreshTasks()
}

async function stopTask(taskId: string): Promise<void> {
  if (!window.api || !taskId) return
  // R07:终止只停当前轮,排队追问保留为待发(clearFollowups 缺省按 false,主进程侧兜底)
  await window.api.tasksCancel(taskId)
  await refreshTasks()
  // 取回队列如实告知去向:不会自动执行,需手动「提前发送」或打断发送;无队列时只报已终止
  const queue = await window.api.tasksGetFollowups(taskId)
  if (selectedTaskId.value === taskId) activeFollowups.value = queue
  showToast(
    queue.length > 0 ? '已终止 · 排队消息已保留为待发(不会自动执行)' : '已终止',
  )
}

watch(selectedTaskId, (id) => {
  if (id) void refreshFollowups(id)
  else activeFollowups.value = []
})

/** 侧栏选中的工作区:选中后发布框绑定该目录,任务列表只看该项目;null=全部 */
const selectedProjectId = ref<string | null>(
  typeof localStorage !== 'undefined' ? localStorage.getItem('agentdrove.workspace') : null,
)

/** 当前选中的项目行;id 失效(项目被删)自动回落 null */
const selectedProject = computed(
  () => projects.value.find((p) => p.id === selectedProjectId.value) ?? null,
)

watch(selectedProjectId, (id) => {
  if (id) localStorage.setItem('agentdrove.workspace', id)
  else localStorage.removeItem('agentdrove.workspace')
})

// 项目列表到达后校验持久化的选中项:项目被删/换机时 id 已失效,
// 必须把 selectedProjectId 一并回落(null),否则任务列会被不存在的项目过滤成空且无提示
watch(projects, (list) => {
  if (selectedProjectId.value && !list.some((p) => p.id === selectedProjectId.value)) {
    selectedProjectId.value = null
  }
})

/** 每任务在渲染层保留的实时事件条数(与主进程推送窗口配套,完整历史走分页拉取) */
const LIVE_EVENTS_PER_TASK = 500
/** 实时事件缓存的任务槽上限:长跑不清理会让已完成任务的缓冲无限堆积 */
const LIVE_EVENTS_MAX_TASKS = 50

export function useAppStore() {
  return {
    agents,
    agentsLoaded,
    projects,
    tasks,
    usage,
    settings,
    workspaces,
    updateStatus,
    view,
    railCollapsed,
    detailCollapsed,
    detailModalOpen,
    openDetailModal,
    closeDetailModal,
    toggleDetailCollapsed,
    selectedTaskId,
    selection,
    filter,
    liveEvents,
    agentContext,
    draggingTaskId,
    toast,
    showToast,
    activeSkills,
    activeFollowups,
    toggleSkill,
    setSkills,
    refreshFollowups,
    removeFollowup,
    clearFollowups,
    renameTask,
    newChat,
    selectAgentContext,
    clearAgentContext,
    stopTask,
    moveTask,
    reorderTask,
    selectedProjectId,
    selectedProject,
    refreshAgents,
    refreshUsage,
    refreshTasks,
    refreshSettings,
    refreshWorkspaces,
    refreshProjects,
    setTheme,
  }
}

/** 主题落到 <html data-theme>,auto 跟随系统;样式约定见 styles.css */
function applyTheme(theme: AppConfig['ui']['theme'] | undefined): void {
  const resolved =
    theme === 'light' || theme === 'dark'
      ? theme
      : window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
  document.documentElement.dataset.theme = resolved
}

/**
 * 并发重拉护栏:同一资源的重拉以后发请求为准,先到的过期响应直接丢弃,
 * 避免推送触发的重拉与手动刷新竞态互相覆盖。
 */
const pullEpoch = new Map<string, number>()

function beginPull(key: string): number {
  const epoch = (pullEpoch.get(key) ?? 0) + 1
  pullEpoch.set(key, epoch)
  return epoch
}

function isLatestPull(key: string, epoch: number): boolean {
  return pullEpoch.get(key) === epoch
}

/** R03:agents+usage 的空闲刷新门槛(聚焦/回前台/轮询时空闲超过该值才重拉) */
const AGENT_IDLE_REFRESH_MS = 60_000
let lastAgentsPullAt = 0
let lastAgentsPullDay = ''
/** 本地时区日界标识(跨零点强制重拉让「今日」归零) */
const todayKey = (): string => new Date().toDateString()

/** 启动期 fire-and-forget 拉取:失败留日志,不阻断其余初始化 */
function pull(run: () => Promise<void>, label: string): void {
  void run().catch((error) => console.error(`[store] ${label} 拉取失败`, error))
}

export async function setTheme(theme: AppConfig['ui']['theme']): Promise<void> {
  const previous = settings.value
  if (!previous) return
  // 只提交 ui 组且必须深拷贝:previous 是响应式代理,浅展开的顶层组字段仍是 Proxy,
  // 过 IPC 结构化克隆必抛 "An object could not be cloned"(ui 字段全为原始值,展开即纯)
  const next = { ui: { ...previous.ui, theme } }
  settings.value = { ...previous, ui: next.ui }
  try {
    settings.value = await window.api.settingsUpdate(next)
    applyTheme(theme)
  } catch (error) {
    // 落盘失败回滚乐观更新,否则界面主题与持久化配置不一致
    settings.value = previous
    applyTheme(previous.ui.theme)
    console.error('[store] 主题保存失败', error)
  }
}

export async function refreshAgents(): Promise<void> {
  const epoch = beginPull('agents')
  // 列表与用量一并取回避免"新列表 + 旧用量"中间态;R03:改为串行——主进程 agents:list
  // 组装完即按日缓存 quota,usage:get 命中缓存免双算,Promise.all 并发会与缓存建立赛跑
  const agentList = await window.api.agentsList()
  const usageList = await window.api.usageGet()
  if (!isLatestPull('agents', epoch)) return
  agents.value = agentList
  usage.value = usageList
  // G3-10:探测完成(跨零点/重扫重复置位幂等);失败路径不置位,空态保持「探测中」语义
  agentsLoaded.value = true
  lastAgentsPullAt = Date.now()
  lastAgentsPullDay = todayKey()
}

/** R03:usage:get 单独轻量刷新(不触发探活),设置页用量表打开时保鲜 */
export async function refreshUsage(): Promise<void> {
  const epoch = beginPull('usage')
  const list = await window.api.usageGet()
  if (!isLatestPull('usage', epoch)) return
  usage.value = list
}

export async function refreshProjects(): Promise<void> {
  const epoch = beginPull('projects')
  const list = await window.api.projectsList()
  if (!isLatestPull('projects', epoch)) return
  projects.value = list
}

export async function refreshTasks(): Promise<void> {
  const epoch = beginPull('tasks')
  const filterDto: Parameters<typeof window.api.tasksList>[0] = {}
  if (filter.value.search) filterDto.search = filter.value.search
  if (filter.value.agentId) filterDto.agentId = filter.value.agentId
  if (filter.value.state) filterDto.state = filter.value.state as TaskRecord['state']
  const list = await window.api.tasksList(filterDto)
  if (!isLatestPull('tasks', epoch)) return
  tasks.value = list
}

export async function refreshSettings(): Promise<void> {
  const epoch = beginPull('settings')
  const config = await window.api.settingsGet()
  if (!isLatestPull('settings', epoch)) return
  settings.value = config
}

export async function refreshWorkspaces(): Promise<void> {
  const epoch = beginPull('workspaces')
  const list = await window.api.workspacesList()
  if (!isLatestPull('workspaces', epoch)) return
  workspaces.value = list
}

/** 渠道/模型/思考档位三元组记忆(P0-5):按客户端落 localStorage,重启自动恢复 */
export interface ModelPref {
  channelId: string
  modelId: string
  reasoningEffort?: ReasoningEffort
}

export function readModelPref(agentId: string): ModelPref | null {
  try {
    const raw = localStorage.getItem(`agentdrove.modelPref.${agentId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ModelPref>
    if (typeof parsed.channelId !== 'string' || typeof parsed.modelId !== 'string') return null
    return parsed as ModelPref
  } catch {
    return null
  }
}

export function writeModelPref(agentId: string, pref: ModelPref): void {
  try {
    localStorage.setItem(`agentdrove.modelPref.${agentId}`, JSON.stringify(pref))
  } catch {
    // 存储不可写(隐私模式/配额满)时静默放弃:记忆是增强项,不阻塞派发
  }
}

let bridgeInstalled = false
/** P0-8:任务高频事件下 agents/usage 重拉的 debounce 定时器 */
let agentsRefreshTimer: ReturnType<typeof setTimeout> | null = null

/** 主进程事件桥 + 首轮数据拉取,应用启动时装一次;组件卸载不拆(生命周期与窗口一致) */
export function installAppBridge(): void {
  if (bridgeInstalled) return
  bridgeInstalled = true
  // 主题不依赖 IPC,先行安装(缺 api 时仍能跟随系统主题)
  watch(
    () => settings.value?.ui.theme,
    (theme) => applyTheme(theme),
    { immediate: true },
  )
  // auto 模式下跟随系统主题实时切换(仅 auto 时 applyTheme 才会取系统值,其余档无害)
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    applyTheme(settings.value?.ui.theme)
  })
  // preload 未注入时(浏览器直开且 mock 加载失败)直接返回:后续 window.api.* 同步抛错会
  // 让 main.ts 的 installAppBridge() 在挂载前中断,整屏白掉;此处退化为空态展示
  if (!window.api) {
    console.error('[store] window.api 未注入,跳过 IPC 桥与首轮拉取(页面显示空态)')
    return
  }
  pull(refreshAgents, 'agents')
  pull(refreshProjects, 'projects')
  pull(refreshTasks, 'tasks')
  pull(refreshSettings, 'settings')
  pull(refreshWorkspaces, 'workspaces')
  // R03:主动刷新——用户直接在 CLI 干活时没有任何任务事件,侧栏用量会一直冻结;
  // 聚焦/回前台时空闲 >60s 重拉 agents+usage,60s 低频轮询兜底,跨零点立即重拉让「今日」归零。
  // 桥与窗口同生命周期(与上方 matchMedia 监听一致),不随组件卸载拆除。
  const idleRefreshAgents = (): void => {
    const dayChanged = todayKey() !== lastAgentsPullDay
    if (!dayChanged && Date.now() - lastAgentsPullAt < AGENT_IDLE_REFRESH_MS) return
    pull(refreshAgents, 'agents')
  }
  window.addEventListener('focus', idleRefreshAgents)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) idleRefreshAgents()
  })
  window.setInterval(idleRefreshAgents, AGENT_IDLE_REFRESH_MS)
  let quotaRefreshTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleQuotaRefresh = (): void => {
    if (quotaRefreshTimer) clearTimeout(quotaRefreshTimer)
    quotaRefreshTimer = setTimeout(async () => {
      if (!window.api || !window.api.quotaGet) return
      try {
        const quotaList = await window.api.quotaGet()
        if (Array.isArray(quotaList)) {
          for (const q of quotaList) {
            const target = agents.value.find((a) => a.id === q.agentId)
            if (target) {
              Object.assign(target, q)
            }
          }
        }
      } catch {}
    }, 250)
  }

  window.api.onTasksEventsBatch((events) => {
    const next = new Map(liveEvents.value)
    let hasUsage = false
    for (const event of events) {
      if (event.event.kind === 'usage') hasUsage = true
      const list = next.get(event.taskId) ?? []
      list.push(event)
      // 先删后插:Map.set 不会刷新已有键的插入顺序,重新插入才能让活跃任务移到队尾
      next.delete(event.taskId)
      next.set(event.taskId, list.slice(-LIVE_EVENTS_PER_TASK))
    }
    if (hasUsage) {
      scheduleQuotaRefresh()
    }
    // 选中的任务永远保留;超槽时从队首(最久未动)丢弃(历史仍可从主进程分页拉回)
    if (next.size > LIVE_EVENTS_MAX_TASKS) {
      const keep = selectedTaskId.value
      for (const key of next.keys()) {
        if (next.size <= LIVE_EVENTS_MAX_TASKS) break
        if (key !== keep) next.delete(key)
      }
    }
    liveEvents.value = next
  })
  window.api.onTasksUpdated(() => {
    pull(refreshTasks, 'tasks')
    pull(refreshWorkspaces, 'workspaces')
    scheduleQuotaRefresh()
    // P0-8:任务流(派发/完成/取消/失败)后 500ms debounce 重拉 agents+usage,
    // 侧栏"余 N 次/点数/Token" 1~2s 内跟随;pullEpoch 护栏兜住与手动刷新的竞态
    if (agentsRefreshTimer) clearTimeout(agentsRefreshTimer)
    agentsRefreshTimer = setTimeout(() => pull(refreshAgents, 'agents'), 500)
  })
  // P0-6 配套:父任务完成后排队消息自动接续为新任务。G3-01:改为条件迁移——仅当用户
  // 正在看源任务时才把选中迁到新任务(该会话在排队接续,切走时清空草稿属预期);
  // 其余情况视图不跳走、正在输入的草稿绝不因后台事件丢失,用户经列表 ⏳ 徽标与新卡定位
  window.api.onFollowupContinued?.((payload) => {
    if (selectedTaskId.value === payload.fromTaskId) {
      selectedTaskId.value = payload.toTaskId
    }
    showToast('追问已自动接续为新任务')
  })
  // 启动期客户端探测后台完成/重扫/启停切换:主进程广播后重拉,侧栏从空态自愈
  window.api.onAgentsChanged(() => {
    pull(refreshAgents, 'agents')
  })
  window.api.onSchedulerChanged((paused) => {
    if (settings.value) settings.value = { ...settings.value, schedulerPaused: paused }
  })
  window.api.onUpdateStatus((status) => {
    updateStatus.value = status
  })
  window.api.onPanelFocus(() => {
    view.value = 'panel'
    window.dispatchEvent(new CustomEvent('focus-composer'))
  })
}