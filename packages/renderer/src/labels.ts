import type { TaskState } from '@agent-drove/core'
import type { ReasoningEffort } from '@agent-drove/shared'

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
 * 思考档位唯一选项源(R06):''=跟随客户端(哨兵,不随 DTO 传),
 * minimal/low/medium/high 直传 DTO 通用档位,由驱动侧映射 CLI 实参。
 * 发布框、续聊栏与设置页一律消费此常量,禁止再各自硬编码(此前三处定义已漂移的教训)。
 */
export const REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort | ''; label: string }> = [
  { value: '', label: '跟随' },
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

/**
 * 档位中文名映射(R06):枚举 → 中文,供事件流、详情与工具提示拼接(如「思考: 中」)。
 * 哨兵 '' 一并收录,消费方无需自行判空。
 */
export const EFFORT_LABEL: Record<ReasoningEffort | '', string> = {
  '': '跟随',
  off: '关闭',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
}

/**
 * 档位说明文案常量(R06):下拉项 tooltip 与详情说明统一取此,口径一致不再各写各的。
 */
export const EFFORT_HINT_TEXT: Record<ReasoningEffort | '', string> = {
  '': '跟随客户端默认档位,不随任务下发思考强度',
  off: '关闭:不启用深度推理,响应最快',
  minimal: '极简:最快响应,几乎不做深度推理',
  low: '低:轻量推理,速度优先',
  medium: '中:常规推理深度,速度与质量均衡',
  high: '高:深度推理,适合复杂任务,耗时最长',
}

/** 历史兼容别名(旧名死导入暂存):与唯一源同引用,待消费方迁移到 REASONING_EFFORT_OPTIONS 后移除 */
export const REASONING_OPTIONS = REASONING_EFFORT_OPTIONS

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

/**
 * 判断 Agent 计费计量模式:
 * - 'credits': 消耗点数(如 Qoder Credits 等)
 * - 'tokens': 消耗 Token(如 ZCode / GLM / Codex / Trae 等)
 */
export function getAgentBillingType(
  agentId?: string,
  agents?: Array<{ id: string; plan?: { quotaKind?: string } }>,
): 'credits' | 'tokens' {
  if (!agentId || !agents) return 'tokens'
  const agent = agents.find((a) => a.id === agentId)
  if (agent?.plan?.quotaKind === 'credits') {
    return 'credits'
  }
  return 'tokens'
}

/** 规范化 Token 数量紧凑显示 (如 1.2M, 45.6k, 320) */
export function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * 额度数值统一格式(P0-8):≥1000 转 x.xk,<1000 最多 1 位小数,
 * 消除同一列 "1.2k" 与 "997.53" 两种格式并存;Token 侧沿用 formatTokens 不变。
 */
export function formatQuotaNumber(n?: number): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n * 10) / 10)
}

export interface FormattedQuotaMetric {
  primaryText: string
  subText?: string
  percent?: number
  isOverridden?: boolean
}

/** 统一卡片与列表展示口径的标准工厂函数 */
export function formatAgentQuotaDisplay(agent: {
  plan?: { quotaKind: string; dailyTaskCap: number }
  remainingCredits?: number
  remainingTokens?: number
  remainingPercent?: number
  usedCreditsToday?: number
  usedTokensToday?: number
  usedToday?: number
  isOverridden?: boolean
}): FormattedQuotaMetric {
  const cap = agent.plan?.dailyTaskCap ?? 0
  const used = agent.usedToday ?? 0

  if (agent.plan?.quotaKind === 'credits') {
    if (agent.remainingCredits !== undefined) {
      return {
        primaryText: `余 ${formatQuotaNumber(agent.remainingCredits)} 点`,
        subText: agent.usedCreditsToday ? `今日 ${formatQuotaNumber(agent.usedCreditsToday)} 点` : undefined,
        percent: agent.remainingPercent,
        isOverridden: agent.isOverridden,
      }
    }
    if (agent.usedCreditsToday !== undefined) {
      return {
        primaryText: `今日 ${formatQuotaNumber(agent.usedCreditsToday)} 点`,
        percent: agent.remainingPercent,
        isOverridden: agent.isOverridden,
      }
    }
    return { primaryText: '—', percent: agent.remainingPercent }
  }

  if (agent.plan?.quotaKind === 'daily') {
    if (cap > 0) {
      return {
        primaryText: `余 ${Math.max(0, cap - used)}/${cap} 次`,
        percent: agent.remainingPercent,
        isOverridden: agent.isOverridden,
      }
    }
    return { primaryText: '未设上限', percent: undefined }
  }

  // subscription
  if (agent.remainingTokens !== undefined) {
    return {
      primaryText: `余 ${formatTokens(agent.remainingTokens)} tok`,
      subText: agent.usedTokensToday ? `今日 ${formatTokens(agent.usedTokensToday)} tok` : undefined,
      percent: agent.remainingPercent,
      isOverridden: agent.isOverridden,
    }
  }
  if (agent.usedTokensToday) {
    return {
      primaryText: `今日 ${formatTokens(agent.usedTokensToday)} tok`,
      percent: agent.remainingPercent,
      isOverridden: agent.isOverridden,
    }
  }
  if (cap > 0) {
    return {
      primaryText: `余 ${Math.max(0, cap - used)}/${cap} 次`,
      percent: agent.remainingPercent,
      isOverridden: agent.isOverridden,
    }
  }
  return { primaryText: '未配置额度', percent: undefined }
}

export interface ChannelGroup {
  id: string
  name: string
  models: Array<{ value: string; label: string }>
}

/**
 * 将 Agent 模型目录解析为「渠道(Provider) → 模型列表」级联结构:
 * 1. 复合 ID "<providerId>/<modelId>" 按渠道汇聚;
 * 2. 扁平模型归入 "默认渠道" 或 "跟随客户端";
 * 3. 彻底避免跨渠道传错模型导致上游 502/404 漏洞。
 */
export function parseChannelsAndModels(
  models: Array<{ id: string; label: string }> = [],
): ChannelGroup[] {
  if (!models || models.length === 0) {
    return [{ id: 'default', name: '默认渠道', models: [{ value: CLIENT_FOLLOW_MODEL, label: '跟随客户端' }] }]
  }

  const groupMap = new Map<string, { name: string; models: Array<{ value: string; label: string }> }>()

  for (const m of models) {
    if (m.id === CLIENT_FOLLOW_MODEL) {
      if (!groupMap.has('default')) {
        groupMap.set('default', { name: '默认渠道', models: [] })
      }
      groupMap.get('default')!.models.push({ value: m.id, label: m.label || '跟随客户端' })
      continue
    }

    if (m.id.includes('/')) {
      const slashIdx = m.id.indexOf('/')
      const providerId = m.id.slice(0, slashIdx)
      const rawModel = m.id.slice(slashIdx + 1)
      let providerName = providerId
      let modelLabel = rawModel

      if (m.label.includes(' · ')) {
        const parts = m.label.split(' · ')
        providerName = parts[0]?.trim() || providerId
        modelLabel = parts.slice(1).join(' · ').trim() || rawModel
      } else if (m.label) {
        modelLabel = m.label
      }

      if (!groupMap.has(providerId)) {
        groupMap.set(providerId, { name: providerName, models: [] })
      }
      groupMap.get(providerId)!.models.push({
        value: m.id,
        label: modelLabel,
      })
    } else {
      if (!groupMap.has('default')) {
        groupMap.set('default', { name: '默认渠道', models: [] })
      }
      groupMap.get('default')!.models.push({
        value: m.id,
        label: m.label || m.id,
      })
    }
  }

  return Array.from(groupMap.entries()).map(([id, grp]) => ({
    id,
    name: grp.name,
    models: grp.models,
  }))
}


