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

export async function setTheme(theme: AppConfig['ui']['theme']): Promise<void> {
  if (!settings.value) return
  settings.value = { ...settings.value, ui: { ...settings.value.ui, theme } }
  await window.api.settingsUpdate({ ui: { ...settings.value.ui, theme } })
  applyTheme(theme)
}

export async function refreshAgents(): Promise<void> {
  agents.value = await window.api.agentsList()
  usage.value = await window.api.usageGet()
}

export async function refreshProjects(): Promise<void> {
  projects.value = await window.api.projectsList()
}

export async function refreshTasks(): Promise<void> {
  const filterDto: Parameters<typeof window.api.tasksList>[0] = {}
  if (filter.value.search) filterDto.search = filter.value.search
  if (filter.value.agentId) filterDto.agentId = filter.value.agentId
  if (filter.value.state) filterDto.state = filter.value.state as TaskRecord['state']
  tasks.value = await window.api.tasksList(filterDto)
}

export async function refreshSettings(): Promise<void> {
  settings.value = await window.api.settingsGet()
}

export async function refreshWorkspaces(): Promise<void> {
  workspaces.value = await window.api.workspacesList()
}

let bridgeInstalled = false

/** 主进程事件桥 + 首轮数据拉取,应用启动时装一次;组件卸载不拆(生命周期与窗口一致) */
export function installAppBridge(): void {
  if (bridgeInstalled) return
  bridgeInstalled = true
  void refreshAgents()
  void refreshProjects()
  void refreshTasks()
  void refreshSettings()
  void refreshWorkspaces()
  watch(
    () => settings.value?.ui.theme,
    (theme) => applyTheme(theme),
    { immediate: true },
  )
  // auto 模式下跟随系统主题实时切换(仅 auto 时 applyTheme 才会取系统值,其余档无害)
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    applyTheme(settings.value?.ui.theme)
  })
  window.api.onTasksEventsBatch((events) => {
    const next = new Map(liveEvents.value)
    for (const event of events) {
      const list = next.get(event.taskId) ?? []
      list.push(event)
      next.set(event.taskId, list.slice(-LIVE_EVENTS_PER_TASK))
    }
    // 选中的任务永远保留;超槽时丢最久未动的任务缓冲(历史仍可从主进程分页拉回)
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
    void refreshTasks()
    void refreshWorkspaces()
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
