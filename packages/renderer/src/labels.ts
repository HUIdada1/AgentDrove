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
