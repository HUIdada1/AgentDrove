import { computed, ref, shallowRef, watch } from 'vue'
import type {
  AgentView,
  AppConfig,
  Project,
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
const projects = ref<Project[]>([])
const tasks = ref<TaskRecord[]>([])
const usage = ref<UsageView[]>([])
const settings = ref<AppConfig | null>(null)
const workspaces = ref<WorkspaceRow[]>([])
const updateStatus = ref<UpdateStatus>({ phase: 'idle' })
const view = ref<'panel' | 'settings'>('panel')
const railCollapsed = ref(false)
const selectedTaskId = ref<string | null>(null)
const selection = ref<Set<string>>(new Set())
const filter = ref({ search: '', agentId: '', state: '' })
const liveEvents = shallowRef(new Map<string, StoredEvent[]>())
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
    projects,
    tasks,
    usage,
    settings,
    workspaces,
    updateStatus,
    view,
    railCollapsed,
    selectedTaskId,
    selection,
    filter,
    liveEvents,
    selectedProjectId,
    selectedProject,
    refreshAgents,
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

/** 启动期 fire-and-forget 拉取:失败留日志,不阻断其余初始化 */
function pull(run: () => Promise<void>, label: string): void {
  void run().catch((error) => console.error(`[store] ${label} 拉取失败`, error))
}

export async function setTheme(theme: AppConfig['ui']['theme']): Promise<void> {
  const previous = settings.value
  if (!previous) return
  const next = { ...previous, ui: { ...previous.ui, theme } }
  settings.value = next
  try {
    settings.value = await window.api.settingsUpdate({ ui: next.ui })
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
  // 列表与用量一并取回,避免"新列表 + 旧用量"的中间态
  const [agentList, usageList] = await Promise.all([window.api.agentsList(), window.api.usageGet()])
  if (!isLatestPull('agents', epoch)) return
  agents.value = agentList
  usage.value = usageList
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

let bridgeInstalled = false

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
  window.api.onTasksEventsBatch((events) => {
    const next = new Map(liveEvents.value)
    for (const event of events) {
      const list = next.get(event.taskId) ?? []
      list.push(event)
      // 先删后插:Map.set 不会刷新已有键的插入顺序,重新插入才能让活跃任务移到队尾
      next.delete(event.taskId)
      next.set(event.taskId, list.slice(-LIVE_EVENTS_PER_TASK))
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