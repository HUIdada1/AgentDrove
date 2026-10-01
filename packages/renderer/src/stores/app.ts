import { ref, shallowRef, watch } from 'vue'
import type {
  AgentView,
  AppConfig,
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

export function useAppStore() {
  return {
    agents,
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
    refreshAgents,
    refreshTasks,
    refreshSettings,
    refreshWorkspaces,
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
  void refreshTasks()
  void refreshSettings()
  void refreshWorkspaces()
  watch(
    () => settings.value?.ui.theme,
    (theme) => applyTheme(theme),
    { immediate: true },
  )
  window.api.onTasksEventsBatch((events) => {
    const next = new Map(liveEvents.value)
    for (const event of events) {
      const list = next.get(event.taskId) ?? []
      list.push(event)
      next.set(event.taskId, list.slice(-500))
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
