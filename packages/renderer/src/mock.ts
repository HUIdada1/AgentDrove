import type { AgentDroveApi, AgentView } from '@agent-drove/shared'
import type { AppConfig, StoredEvent, TaskRecord } from '@agent-drove/core'
import { DEFAULT_CONFIG, MODEL_CLIENT_FOLLOW } from '@agent-drove/core'

/**
 * 浏览器直开(无 Electron 桥)时的样例数据,
 * 仅 import.meta.env.DEV 生效且会被产物构建剔除,不影响打包产物。
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
  const mock: AgentDroveApi = {
    agentsList: async () => agents,
    agentsSetEnabled: async () => {},
    tasksList: async () => tasks,
    tasksGet: async (id) => tasks.find((t) => t.id === id) ?? null,
    tasksEventsPage: async ({ taskId, limit = 200 }) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return []
      const events: StoredEvent[] = [
        { taskId, seq: 1, at: task.createdAt, event: { kind: 'state-changed', from: 'queued', to: 'running' } },
        { taskId, seq: 2, at: task.createdAt + 6_000, event: { kind: 'message', channel: 'stdout', text: '已读取 14 个文件,定位到 throttle.ts 与 orchestrator.ts 的耦合点。' } },
        { taskId, seq: 3, at: task.createdAt + 21_000, event: { kind: 'progress', text: '分析依赖图 (3/7)' } },
        { taskId, seq: 4, at: task.createdAt + 40_000, event: { kind: 'warning', text: '客户端版本 0.16.9 超出驱动声明范围 >=0.16 <0.17 边缘' } },
        { taskId, seq: 5, at: task.createdAt + 61_000, event: { kind: 'artifact', path: 'packages/core/src/throttle.ts', change: 'modified' } },
        { taskId, seq: 6, at: task.createdAt + 62_000, event: { kind: 'usage', inputTokens: 12400, outputTokens: 3120 } },
        { taskId, seq: 7, at: task.createdAt + 63_000, event: { kind: 'state-changed', from: 'running', to: 'completed' } },
      ]
      void limit
      return events
    },
    tasksSubmit: async (dto) => {
      const task: TaskRecord = {
        id: `demo-${++seq}`,
        agentId: dto.agentId,
        modelId: MODEL_CLIENT_FOLLOW,
        prompt: dto.prompt,
        cwd: dto.cwd ?? 'E:/idea work/AgentDrove',
        state: 'queued',
        attachments: [],
        mode: dto.mode ?? 'build',
        origin: dto.origin ?? 'panel',
        createdAt: Date.now(),
        attempt: 1,
      }
      tasks.unshift(task)
      return task
    },
    tasksSubmitBatch: async (dtos) => {
      const out = []
      for (const dto of dtos) out.push(await mock.tasksSubmit!(dto))
      return out
    },
    tasksRetry: async (taskId) => {
      const parent = tasks.find((t) => t.id === taskId)!
      return mock.tasksSubmit!({ agentId: parent.agentId, prompt: parent.prompt, origin: 'panel' })
    },
    tasksContinue: async (taskId, prompt) => {
      const parent = tasks.find((t) => t.id === taskId)!
      return mock.tasksSubmit!({ agentId: parent.agentId, prompt, sessionId: parent.sessionId })
    },
    tasksCancel: async () => true,
    tasksMarkFailed: async () => true,
    tasksBatchCancel: async (ids) => ids.length,
    tasksBatchDelete: async (ids) => ids.length,
    tasksResubmitOn: async (taskId, target) => {
      const parent = tasks.find((t) => t.id === taskId)!
      return mock.tasksSubmit!({ agentId: target, prompt: parent.prompt, origin: 'failover' })
    },
    healthCheck: async () => ({ ok: true, at: Date.now() }),
    launchApp: async () => 'deep-link',
    usageGet: async () =>
      agents.map((a) => ({ agentId: a.id, label: a.label, day: '2026-10-01', taskCount: a.usedToday, estimated: 0, dailyTaskCap: a.plan.dailyTaskCap })),
    settingsGet: async () => DEFAULT_CONFIG as AppConfig,
    settingsUpdate: async (patch) => ({ ...DEFAULT_CONFIG, ...patch }),
    schedulerPause: async () => {},
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
    hideMini: async () => {},
    filePath: (file) => file.name,
  }
  window.api = mock
  void installDevMock
}
