import type { TaskState } from '@agent-drove/core'

/**
 * 模型"跟随客户端"哨兵,必须与 core 的 MODEL_CLIENT_FOLLOW 逐字一致。
 * 此处字面量重复是有意的:renderer 从 core 做「值导入」会把整个 Node 向编排器/驱动图
 * 打进渲染产物(实测体积翻倍),故只允许 type-only 引用 core。
 */
export const CLIENT_FOLLOW_MODEL = 'client-follow'

/**
 * 任务状态中文文案:键取自 core 的 TaskState 联合,
 * core 新增状态时此处编译期报错,避免各组件各维护一份而漂移。
 */
export const STATE_TEXT: Record<TaskState, string> = {
  queued: '排队',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  interrupted: '已中断',
}

/** 档位选项:发布框与设置页共用同一份(yolo 需设置页显式放行,不入常规下拉) */
export const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'build', label: 'build' },
  { value: 'edit', label: 'edit' },
  { value: 'plan', label: 'plan' },
]

/** 状态筛选下拉(含"全部"),文案与 STATE_TEXT 同源 */
export const STATE_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  ...(Object.keys(STATE_TEXT) as TaskState[]).map((value) => ({ value, label: STATE_TEXT[value] })),
]

/**
 * 格式化任务所使用的模型名称:
 * 1. 若为 client-follow 哨兵,显示 "跟随客户端";
 * 2. 若从 agents 列表中查到对应的预设,显示友好 label (如 "默认-临时 · deepseek-v4.1-flash" 或 "GPT-5.1 Codex");
 * 3. 若为复合形式 "<providerId>/<modelId>",去除前面的 providerId 前缀显示 modelId;
 * 4. 其它情况如实显示 modelId。
 */
export function formatModelDisplay(
  modelId: string | undefined,
  agentId?: string,
  agents?: Array<{ id: string; models?: Array<{ id: string; label: string }> }>,
): string {
  if (!modelId || modelId === CLIENT_FOLLOW_MODEL) return '跟随客户端'
  if (agentId && agents) {
    const agent = agents.find((a) => a.id === agentId)
    const preset = agent?.models?.find((m) => m.id === modelId)
    if (preset?.label) return preset.label
  }
  if (modelId.includes('/')) {
    const parts = modelId.split('/')
    return parts.slice(1).join('/')
  }
  return modelId
}

