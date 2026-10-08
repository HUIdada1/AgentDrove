import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AgentDroveApi, FollowupContinuedEvent, UpdateStatus } from '@agent-drove/shared'
import type { StoredEvent } from '@agent-drove/core'

/**
 * contextIsolation+sandbox 开启,renderer 零 Node 能力;
 * 这里是唯一的桥,通道名与 shared 契约一一对应。
 */

function subscribe<T extends unknown[]>(
  channel: string,
  listener: (...args: T) => void,
): () => void {
  const handler = (_event: IpcRendererEvent, ...args: T) => listener(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

function safeClone<T>(val: T): T {
  if (val === undefined || val === null) return val
  try {
    return JSON.parse(JSON.stringify(val))
  } catch {
    return val
  }
}

const api: AgentDroveApi = {
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsSetEnabled: (agentId, enabled) =>
    ipcRenderer.invoke('agents:set-enabled', agentId, enabled),
  agentsRescan: () => ipcRenderer.invoke('agents:rescan'),

  projectsList: () => ipcRenderer.invoke('projects:list'),
  projectsPickAndAdd: () => ipcRenderer.invoke('projects:pick-and-add'),
  projectsBindDaily: (path) => ipcRenderer.invoke('projects:bind-daily', path),
  projectsRename: (projectId, name) => ipcRenderer.invoke('projects:rename', projectId, name),
  projectsRemove: (projectId) => ipcRenderer.invoke('projects:remove', projectId),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),

  tasksList: (filter) => ipcRenderer.invoke('tasks:list', safeClone(filter)),
  tasksGet: (taskId) => ipcRenderer.invoke('tasks:get', taskId),
  tasksEventsPage: (query) => ipcRenderer.invoke('tasks:events-page', safeClone(query)),
  tasksSubmit: (dto) => ipcRenderer.invoke('tasks:submit', safeClone(dto)),
  tasksSubmitBatch: (dtos) => ipcRenderer.invoke('tasks:submit-batch', safeClone(dtos)),
  tasksRetry: (taskId) => ipcRenderer.invoke('tasks:retry', taskId),
  tasksContinue: (taskId, prompt, options) =>
    ipcRenderer.invoke('tasks:continue', taskId, prompt, safeClone(options)),
  tasksEnqueueFollowup: (taskId, prompt, skills) =>
    ipcRenderer.invoke('tasks:enqueue-followup', taskId, prompt, safeClone(skills)),
  tasksGetFollowups: (taskId) => ipcRenderer.invoke('tasks:get-followups', taskId),
  tasksRemoveFollowup: (taskId, followupId) =>
    ipcRenderer.invoke('tasks:remove-followup', taskId, followupId),
  tasksClearFollowups: (taskId) => ipcRenderer.invoke('tasks:clear-followups', taskId),
  tasksRename: (taskId, title) => ipcRenderer.invoke('tasks:rename', taskId, title),
  tasksCancel: (taskId, clearFollowups) =>
    ipcRenderer.invoke('tasks:cancel', taskId, clearFollowups),
  tasksMarkFailed: (taskId, reason) => ipcRenderer.invoke('tasks:mark-failed', taskId, reason),
  tasksBatchCancel: (taskIds) => ipcRenderer.invoke('tasks:batch-cancel', safeClone(taskIds)),
  tasksBatchDelete: (taskIds) => ipcRenderer.invoke('tasks:batch-delete', safeClone(taskIds)),

  // 卡片移动/组内排序(P0-2)与队列编辑/移位(P0-6):通道与 shared 契约一一对应
  tasksMove: (dto) => ipcRenderer.invoke('tasks:move', safeClone(dto)),
  tasksReorder: (taskId, beforeTaskId) =>
    ipcRenderer.invoke('tasks:reorder', taskId, beforeTaskId ?? null),
  tasksUpdateFollowup: (taskId, followupId, prompt) =>
    ipcRenderer.invoke('tasks:update-followup', taskId, followupId, prompt),
  tasksReorderFollowup: (taskId, followupId, beforeFollowupId) =>
    ipcRenderer.invoke('tasks:reorder-followup', taskId, followupId, beforeFollowupId ?? null),
  tasksMigrateFollowups: (fromTaskId, toTaskId) =>
    ipcRenderer.invoke('tasks:migrate-followups', fromTaskId, toTaskId),

  healthCheck: (agentId, options) => ipcRenderer.invoke('health:check', agentId, safeClone(options)),
  launchApp: (agentId) => ipcRenderer.invoke('launch:app', agentId),
  usageGet: (opts) => ipcRenderer.invoke('usage:get', safeClone(opts)),
  quotaGet: () => ipcRenderer.invoke('quota:get'),

  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsUpdate: (patch) => ipcRenderer.invoke('settings:update', safeClone(patch)),
  // G5-02:单客户端套餐校准(含显式剩余值模式);patch=null 清除该校准恢复注册默认
  settingsSetPlanOverride: (agentId, patch) =>
    ipcRenderer.invoke('settings:set-plan-override', agentId, safeClone(patch)),
  schedulerPause: (paused) => ipcRenderer.invoke('scheduler:pause', paused),

  logsTail: (limit) => ipcRenderer.invoke('logs:tail', limit),
  exportData: () => ipcRenderer.invoke('export:data'),
  exportWeeklyReport: () => ipcRenderer.invoke('export:report'),

  workspacesList: () => ipcRenderer.invoke('workspaces:list'),
  workspacesClean: (workspaceId) => ipcRenderer.invoke('workspaces:clean', workspaceId),
  workspacesMerge: (workspaceId) => ipcRenderer.invoke('workspaces:merge', workspaceId),

  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),

  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  tasksResubmitOn: (taskId, targetAgentId) =>
    ipcRenderer.invoke('tasks:resubmit-on', taskId, targetAgentId),

  onTasksEventsBatch: (listener) =>
    subscribe<[StoredEvent[]]>('tasks:events-batch', listener),
  onTasksUpdated: (listener) => subscribe<[]>('tasks:updated', listener),
  onAgentsChanged: (listener) => subscribe<[]>('agents:changed', listener),
  onSchedulerChanged: (listener) => subscribe<[boolean]>('scheduler:changed', listener),
  onUpdateStatus: (listener) => subscribe<[UpdateStatus]>('update:status', listener),
  onPanelFocus: (listener) => subscribe<[]>('panel:focus-composer', listener),
  onHotkeyConflict: (listener) => subscribe<[string]>('hotkey:conflict', listener),
  onMiniPrefill: (listener) => subscribe<[string]>('mini:prefill', listener),
  onWindowMaximized: (listener) => subscribe<[boolean]>('window:maximized', listener),
  // 追问队列自动接续(P0-6):父任务完成后排队消息落地为新任务
  onFollowupContinued: (listener) =>
    subscribe<[FollowupContinuedEvent]>('followup:continued', listener),

  // 窗口控制(自定义标题栏右上角按钮);真实窗口由 sender 定位,主窗关闭即隐藏到托盘
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),

  // 隐藏窗口是单向通知,走 send 而非 invoke;真实路径只有主进程能解析
  hideMini: async () => ipcRenderer.send('window:hide-mini'),
  filePath: (file) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('api', api)
