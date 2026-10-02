import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AgentDroveApi, UpdateStatus } from '@agent-drove/shared'
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

const api: AgentDroveApi = {
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsSetEnabled: (agentId, enabled) =>
    ipcRenderer.invoke('agents:set-enabled', agentId, enabled),

  projectsList: () => ipcRenderer.invoke('projects:list'),
  projectsPickAndAdd: () => ipcRenderer.invoke('projects:pick-and-add'),
  projectsBindDaily: (path) => ipcRenderer.invoke('projects:bind-daily', path),
  projectsRename: (projectId, name) => ipcRenderer.invoke('projects:rename', projectId, name),
  projectsRemove: (projectId) => ipcRenderer.invoke('projects:remove', projectId),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),

  tasksList: (filter) => ipcRenderer.invoke('tasks:list', filter),
  tasksGet: (taskId) => ipcRenderer.invoke('tasks:get', taskId),
  tasksEventsPage: (query) => ipcRenderer.invoke('tasks:events-page', query),
  tasksSubmit: (dto) => ipcRenderer.invoke('tasks:submit', dto),
  tasksSubmitBatch: (dtos) => ipcRenderer.invoke('tasks:submit-batch', dtos),
  tasksRetry: (taskId) => ipcRenderer.invoke('tasks:retry', taskId),
  tasksContinue: (taskId, prompt) => ipcRenderer.invoke('tasks:continue', taskId, prompt),
  tasksCancel: (taskId) => ipcRenderer.invoke('tasks:cancel', taskId),
  tasksMarkFailed: (taskId, reason) => ipcRenderer.invoke('tasks:mark-failed', taskId, reason),
  tasksBatchCancel: (taskIds) => ipcRenderer.invoke('tasks:batch-cancel', taskIds),
  tasksBatchDelete: (taskIds) => ipcRenderer.invoke('tasks:batch-delete', taskIds),

  healthCheck: (agentId, options) => ipcRenderer.invoke('health:check', agentId, options),
  launchApp: (agentId) => ipcRenderer.invoke('launch:app', agentId),
  usageGet: () => ipcRenderer.invoke('usage:get'),

  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsUpdate: (patch) => ipcRenderer.invoke('settings:update', patch),
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
  onSchedulerChanged: (listener) => subscribe<[boolean]>('scheduler:changed', listener),
  onUpdateStatus: (listener) => subscribe<[UpdateStatus]>('update:status', listener),
  onPanelFocus: (listener) => subscribe<[]>('panel:focus-composer', listener),
  onHotkeyConflict: (listener) => subscribe<[string]>('hotkey:conflict', listener),
  onMiniPrefill: (listener) => subscribe<[string]>('mini:prefill', listener),

  // 隐藏窗口是单向通知,走 send 而非 invoke;真实路径只有主进程能解析
  hideMini: async () => ipcRenderer.send('window:hide-mini'),
  filePath: (file) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('api', api)
