import type {
  AgentDroveApi,
  AgentView,
  AppConfig,
  Project,
  StoredEvent,
  TaskRecord,
} from '@agent-drove/shared'
import { DEFAULT_CONFIG, MODEL_CLIENT_FOLLOW } from '@agent-drove/core'

/**
 * 浏览器直开(无 Electron 桥)时的样例数据,
 * 仅 import.meta.env.DEV 生效且会被产物构建剔除,不影响打包产物。
 * 所有方法按 shared 的 AgentDroveApi 契约实现,形状与真实 preload 一致。
 */
export function installDevMock(): void {
  const agents: AgentView[] = [
    {
      id: 'zcode',
      label: 'ZCode',
      driver: 'zcode',
      entry: 'E:/ZCode/ZCode.exe',
      cliEntry: 'E:/ZCode/resources/glm/zcode.cjs',
      version: '0.16.9',
      models: [{ id: MODEL_CLIENT_FOLLOW, label: '跟随客户端' }],
      defaultModel: MODEL_CLIENT_FOLLOW,
      capabilities: { headless: true, sessionResume: true, modelSwitch: 'none', attachments: true },
      plan: { name: 'GLM Coding Plan', quotaKind: 'daily', modelIds: [], dailyTaskCap: 20, maxConcurrency: 1 },
      enabled: true,
      health: { ok: true, at: Date.now() },
      usedToday: 7,
    },
    {
      id: 'trae',
      label: 'TraeCode',
      driver: 'trae',
      entry: 'E:/Trae/bin/trae.cmd',
      version: '1.107.1',
      models: [{ id: MODEL_CLIENT_FOLLOW, label: '跟随客户端' }],
      defaultModel: MODEL_CLIENT_FOLLOW,
      capabilities: { headless: false, sessionResume: false, modelSwitch: 'none', attachments: true },
      plan: { name: 'Trae 官方套餐', quotaKind: 'subscription', modelIds: [], dailyTaskCap: 20, maxConcurrency: 1 },
      enabled: true,
      health: { ok: false, reason: '未登录', at: Date.now() },
      usedToday: 2,
    },
    {
      id: 'qoder',
      label: 'Qoder CN',
      driver: 'qoder',
      entry: 'qoderclicn',
      models: [{ id: 'qoder-default', label: '默认模型' }],
      defaultModel: 'qoder-default',
      capabilities: { headless: true, sessionResume: true, modelSwitch: 'cli-arg', attachments: false },
      plan: { name: 'Qoder Credits', quotaKind: 'credits', modelIds: ['qoder-default'], dailyTaskCap: 20, maxConcurrency: 1 },
      enabled: false,
      health: { ok: true, at: Date.now() },
      usedToday: 0,
    },
  ]

  const now = Date.now()
  const tasks: TaskRecord[] = [
    ['completed', '重构 packages/core 的节流器,抽离公平放行逻辑,补 12 个单测', 'zcode', 52 * 60_000],
    ['running', '给设置页补深色对比度检查,输出修复清单', 'zcode', 3 * 60_000],
    ['failed', '把 README 的安装章节翻译成英文', 'trae', 90_000],
    ['queued', '梳理 qoder CLI 参数矩阵,回填方案 3.1 表格', 'zcode', 0],
    ['canceled', '试验 websockets 方案', 'zcode', 8_000],
    ['interrupted', '迁移 journal 表到 v3 schema', 'trae', 15 * 60_000],
  ].map(([state, prompt, agentId, runMs], i) => ({
    id: `demo-task-${i + 1}`,
    agentId: agentId as string,
    modelId: MODEL_CLIENT_FOLLOW,
    prompt: prompt as string,
    cwd: 'E:/idea work/AgentDrove',
    projectId: i % 2 === 0 ? 'demo-proj-1' : 'daily',
    state: state as TaskRecord['state'],
    sessionId: i === 0 ? 'sess-demo-0001' : undefined,
    attachments: [],
    mode: 'build' as const,
    origin: (['panel', 'hotkey', 'failover', 'panel', 'tray', 'panel'] as const)[i],
    createdAt: now - (i + 1) * 40 * 60_000,
    startedAt: now - (i + 1) * 40 * 60_000 + 5_000,
    finishedAt: (state as string) === 'queued' || (state as string) === 'running' ? undefined : now - (i + 1) * 40 * 60_000 + 5_000 + (runMs as number),
    attempt: i === 2 ? 2 : 1,
  }))

  let seq = 100
  const projects: Project[] = [
    { id: 'daily', name: '日常工作区', path: null, createdAt: now },
    { id: 'demo-proj-1', name: 'AgentDrove', path: 'E:/idea work/AgentDrove', createdAt: now - 1 },
  ]
  /** 可变配置:settingsUpdate 落地后 settingsGet 能读回,开发期验证保存链路 */
  let currentConfig: AppConfig = DEFAULT_CONFIG

  /** 每任务的样例事件流,按 seq 升序;翻页时按 beforeSeq 截取 */
  function eventsFor(taskId: string): StoredEvent[] {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return []
    const base = task.createdAt
    return [
      { taskId, seq: 1, at: base, event: { kind: 'state-changed', from: 'queued', to: 'running' } },
      { taskId, seq: 2, at: base + 6_000, event: { kind: 'message', channel: 'stdout', text: '已读取 14 个文件,定位到 throttle.ts 与 orchestrator.ts 的耦合点。' } },
      { taskId, seq: 3, at: base + 21_000, event: { kind: 'progress', text: '分析依赖图 (3/7)' } },
      { taskId, seq: 4, at: base + 40_000, event: { kind: 'warning', text: '客户端版本 0.16.9 超出驱动声明范围 >=0.16 <0.17 边缘' } },
      { taskId, seq: 5, at: base + 61_000, event: { kind: 'artifact', path: 'packages/core/src/throttle.ts', change: 'modified' } },
      { taskId, seq: 6, at: base + 62_000, event: { kind: 'usage', inputTokens: 12400, outputTokens: 3120 } },
      { taskId, seq: 7, at: base + 63_000, event: { kind: 'state-changed', from: 'running', to: 'completed' } },
    ]
  }

  function findTask(taskId: string): TaskRecord {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`mock: 任务不存在 ${taskId}`)
    return task
  }

  const mock: AgentDroveApi = {
    agentsList: async () => agents,
    agentsSetEnabled: async (agentId, enabled) => {
      const agent = agents.find((a) => a.id === agentId)
      if (agent) agent.enabled = enabled
    },
    agentsRescan: async () => agents,
    projectsList: async () => projects,
    projectsPickAndAdd: async () => null, // 浏览器环境无原生目录弹窗
    projectsBindDaily: async (path) => {
      const daily = projects.find((p) => p.id === 'daily')
      if (!daily) throw new Error('mock: 日常工作区缺失')
      daily.path = path
      return daily
    },
    projectsRename: async (projectId, name) => {
      const project = projects.find((p) => p.id === projectId)
      if (project) project.name = name
    },
    projectsRemove: async (projectId) => {
      const index = projects.findIndex((p) => p.id === projectId)
      if (index >= 0) projects.splice(index, 1)
    },
    pickDirectory: async () => null, // 浏览器环境无原生目录弹窗
    tasksList: async () => tasks,
    tasksGet: async (id) => tasks.find((t) => t.id === id) ?? null,
    tasksEventsPage: async ({ taskId, beforeSeq, limit = 200 }) => {
      const all = eventsFor(taskId)
      const page = beforeSeq === undefined ? all : all.filter((e) => e.seq < beforeSeq)
      return page.slice(-limit)
    },
    tasksSubmit: async (dto) => {
      const task: TaskRecord = {
        id: `demo-${++seq}`,
        agentId: dto.agentId,
        modelId: dto.modelId ?? MODEL_CLIENT_FOLLOW,
        prompt: dto.prompt,
        cwd: dto.cwd ?? 'E:/idea work/AgentDrove',
        projectId: dto.projectId,
        state: 'queued',
        sessionId: dto.sessionId,
        resumeLatest: dto.resumeLatest,
        attachments: dto.attachments ?? [],
        toolPolicy: dto.toolPolicy,
        mode: dto.mode ?? 'build',
        origin: dto.origin ?? 'panel',
        createdAt: Date.now(),
        attempt: 1,
      }
      tasks.unshift(task)
      return task
    },
    tasksSubmitBatch: async (dtos) => {
      const out: TaskRecord[] = []
      for (const dto of dtos) out.push(await mock.tasksSubmit(dto))
      return out
    },
    tasksRetry: async (taskId) => {
      const parent = findTask(taskId)
      return mock.tasksSubmit({ agentId: parent.agentId, prompt: parent.prompt, origin: 'panel' })
    },
    tasksContinue: async (taskId, prompt) => {
      const parent = findTask(taskId)
      return mock.tasksSubmit({
        agentId: parent.agentId,
        prompt,
        sessionId: parent.sessionId,
        resumeLatest: parent.resumeLatest,
      })
    },
    tasksCancel: async (taskId) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task || (task.state !== 'queued' && task.state !== 'running')) return false
      task.state = 'canceled'
      task.finishedAt = Date.now()
      return true
    },
    tasksMarkFailed: async (taskId, reason) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return false
      task.state = 'failed'
      task.error = reason ?? '手动标记失败'
      task.finishedAt = Date.now()
      return true
    },
    tasksBatchCancel: async (ids) => {
      let canceled = 0
      for (const task of tasks) {
        if (!ids.includes(task.id)) continue
        if (task.state !== 'queued' && task.state !== 'running') continue
        task.state = 'canceled'
        task.finishedAt = Date.now()
        canceled++
      }
      return canceled
    },
    tasksBatchDelete: async (ids) => {
      let removed = 0
      for (let i = tasks.length - 1; i >= 0; i--) {
        const task = tasks[i]!
        if (ids.includes(task.id) && task.state !== 'running') {
          tasks.splice(i, 1)
          removed++
        }
      }
      return removed
    },
    tasksResubmitOn: async (taskId, target) => {
      const parent = findTask(taskId)
      return mock.tasksSubmit({ agentId: target, prompt: parent.prompt, origin: 'failover' })
    },
    healthCheck: async () => ({ ok: true, at: Date.now() }),
    launchApp: async () => 'deep-link',
    usageGet: async () => {
      const today = new Date()
      const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      return agents.map((a) => ({
        agentId: a.id,
        label: a.label,
        day,
        taskCount: a.usedToday,
        estimated: 0,
        dailyTaskCap: a.plan.dailyTaskCap,
      }))
    },
    settingsGet: async () => currentConfig,
    settingsUpdate: async (patch) => {
      currentConfig = { ...currentConfig, ...patch }
      return currentConfig
    },
    schedulerPause: async (paused) => {
      currentConfig = { ...currentConfig, schedulerPaused: paused }
    },
    logsTail: async () => ['2026-10-01T22:00:00 info 保留期清理完成 { removedTasks: 3 }'],
    exportData: async () => ({ path: 'C:/Users/demo/Desktop/agentdrove-export.json' }),
    exportWeeklyReport: async () => ({ path: 'C:/Users/demo/Desktop/agentdrove-weekly.csv' }),
    workspacesList: async () => [
      { id: 'ws-1', taskId: 'demo-task-1', path: 'E:/ws/agentdrove-t1', kind: 'worktree', source: '{"repo":"E:/idea work/AgentDrove","baseHead":"cafe123"}', status: 'done', createdAt: now },
    ],
    workspacesClean: async () => {},
    workspacesMerge: async () => ({ merged: ['packages/core/src/throttle.ts'], conflicts: ['README.md'] }),
    updateCheck: async () => ({ phase: 'checking' }),
    updateInstall: async () => {},
    openPath: async () => {},
    onTasksEventsBatch: () => () => {},
    onTasksUpdated: () => () => {},
    onSchedulerChanged: () => () => {},
    onUpdateStatus: () => () => {},
    onPanelFocus: () => () => {},
    onHotkeyConflict: () => () => {},
    onMiniPrefill: () => () => {},
    onWindowMaximized: () => () => {},
    windowMinimize: async () => {},
    windowToggleMaximize: async () => {},
    windowClose: async () => {},
    hideMini: async () => {},
    filePath: (file) => file.name,
  }
  window.api = mock
}