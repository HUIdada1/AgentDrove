<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useAppStore } from '../stores/app'
import Composer from './Composer.vue'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassModal from '../ui/GlassModal.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import MarkdownBubble from '../ui/MarkdownBubble.vue'
import SkillSelector from './SkillSelector.vue'
import GuidanceHub from './GuidanceHub.vue'
import SlashCommandPopup, { type SlashCommand } from './SlashCommandPopup.vue'
import ModelSelector from './ModelSelector.vue'
import ReasoningEffortPicker from './ReasoningEffortPicker.vue'
import {
  CLIENT_FOLLOW_MODEL,
  EFFORT_LABEL,
  MODE_LABEL,
  MODE_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  STATE_TEXT,
  formatModelDisplay,
  formatTokens,
  getAgentBillingType,
  isModelLocked,
  parseChannelsAndModels,
  type ChannelGroup,
} from '../labels'
import type { ReasoningEffort, ScenarioTemplate, StoredEvent, TaskRecord } from '@agent-drove/shared'
import type { TaskMode } from '@agent-drove/core'

const store = useAppStore()
const events = ref<StoredEvent[]>([])
const continueText = ref('')
/** S-06:续聊附件(仅本次发送,随 ContinueOptions.attachments 透传;不传=核心侧继承父任务) */
const continueAttachments = ref<Array<{ path: string; kind: 'file' | 'image' }>>([])
const scrollEl = ref<HTMLElement | null>(null)
const loadingOlder = ref(false)
const sending = ref(false)
const sendError = ref('')
const isRenaming = ref(false)
const renameInput = ref('')
const slashQuery = ref('')
const showSlashPopup = ref(false)
const slashPopupRef = ref<{ onKeydown: (e: KeyboardEvent) => boolean } | null>(null)
let loadId = 0

// —— 会话头部溢出元数据弹层(P0-9/F1):#id/技能/用量收进"⋯",主行任意列宽 ≤2 行 ——
const showMeta = ref(false)
/** S-22:弹层关闭后焦点归还触发按钮,键盘用户不丢位置 */
const metaToggleRef = ref<HTMLButtonElement | null>(null)

// 思考档位选项消费 labels.ts 单一来源(R09③/R06),本组件不再保留本地档位数组

const turnModelId = ref('')
const turnChannelId = ref('')
/** 本轮思考档位覆盖:''=跟随父任务(不下发),取值来自 labels.REASONING_EFFORT_OPTIONS 白名单 */
const turnEffort = ref<ReasoningEffort | ''>('')
// G3-04:本轮模式覆盖(build/edit/plan),''=跟随父任务(ContinueOptions.mode 缺省即沿用);
// 斜杠指令的 recommendedMode 也落于此,续聊/排队一并随 ContinueOptions 透传
const turnMode = ref<'' | TaskMode>('')
/** G3-04:本轮技能覆盖,null=跟随父任务(orchestrator 的 ?? parent.skills 回退可达) */
const turnSkills = ref<string[] | null>(null)
/** G3-04:进入会话(或切会话)时的全局技能快照——此后 activeSkills 的变化视为胶囊内改写 */
const turnSkillsBase = ref<string[]>([])
const turnNote = ref('')
let turnNoteTimer: ReturnType<typeof setTimeout> | null = null

// 实时计时器 (参考 AgentHub MemProgressDialog)
const nowTimestamp = ref(Date.now())
let durationTimer: ReturnType<typeof setInterval> | null = null

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  durationTimer = setInterval(() => {
    nowTimestamp.value = Date.now()
  }, 1000)
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (atBottom.value) {
        scrollBottom(false)
      }
    })
    if (scrollEl.value) {
      resizeObserver.observe(scrollEl.value)
    }
  }
})

onBeforeUnmount(() => {
  if (resizeObserver) resizeObserver.disconnect()
  if (durationTimer) clearInterval(durationTimer)
  if (turnNoteTimer) clearTimeout(turnNoteTimer)
  if (scrollRafId) cancelAnimationFrame(scrollRafId)
  // R13:确认层开着时卸载,兜底摘除 Enter 监听
  window.removeEventListener('keydown', onConfirmKeydown)
})

const runningDurationText = computed(() => {
  if (!task.value?.startedAt) return ''
  const ms = Math.max(0, nowTimestamp.value - task.value.startedAt)
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3600_000)}h${Math.floor((ms % 3600_000) / 60_000)}m`
})

function parseProgress(text: string): { percent?: number; displayText: string } {
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/i)
  if (match && match[1]) {
    const val = Math.min(100, Math.max(0, Math.round(parseFloat(match[1]))))
    return { percent: val, displayText: text }
  }
  const ratioMatch = text.match(/\[?(\d+)\s*\/\s*(\d+)\]?/)
  if (ratioMatch && ratioMatch[1] && ratioMatch[2]) {
    const d = parseInt(ratioMatch[1], 10)
    const t = parseInt(ratioMatch[2], 10)
    if (t > 0) {
      const val = Math.min(100, Math.max(0, Math.round((d / t) * 100)))
      return { percent: val, displayText: text }
    }
  }
  return { displayText: text }
}

/** G3-03:断链兜底缓存——被筛选排除的选中任务/祖先经 tasksGet 拉回后落此,链路与会话区不消失 */
const chainFallback = ref<Map<string, TaskRecord>>(new Map())

const task = computed(
  () =>
    store.tasks.value.find((t) => t.id === store.selectedTaskId.value) ??
    chainFallback.value.get(store.selectedTaskId.value ?? '') ??
    null,
)
const agentLabel = computed(
  () => store.agents.value.find((a) => a.id === task.value?.agentId)?.label ?? task.value?.agentId ?? '',
)
/** 会话区语境提示:当前对话上下文的客户端展示名 */
const contextAgentLabel = computed(
  () => store.agents.value.find((a) => a.id === store.agentContext.value)?.label ?? '',
)
const displayModel = computed(() =>
  task.value ? formatModelDisplay(task.value.modelId, task.value.agentId, store.agents.value) : '',
)

/** 计费计量模式: 'credits' (消耗点数) 还是 'tokens' (消耗 Token) 严禁混淆 */
const billingType = computed(() => getAgentBillingType(task.value?.agentId, store.agents.value))

// —— 本轮参数候选与能力门控 ——
const turnAgent = computed(() => store.agents.value.find((a) => a.id === task.value?.agentId) ?? null)

/**
 * 续聊模型选择与发布框同一套规则(R10):
 * parseChannelsAndModels 渠道级联 + agent.plan.modelIds 套餐覆盖过滤 + 「跟随客户端」哨兵,
 * 多渠道时先选渠道再选模型,杜绝"看得见却派发才报 model not available"。
 * S-10:锁定口径统一走 labels.isModelLocked,三处不再各写各的判定。
 */
const turnModelLocked = computed(() => isModelLocked(turnAgent.value))

/** disabled 触发器 title 的诚实原因(S-10):区分「无可用模型」与「不支持切换」 */
const turnModelDisabledHint = computed(() =>
  turnAgent.value && turnAgent.value.models.length === 0 ? '无可用模型' : '该客户端不支持切换模型',
)

const turnEffectiveModels = computed(() => {
  const agent = turnAgent.value
  if (!agent) return []
  if (turnModelLocked.value) return [{ id: CLIENT_FOLLOW_MODEL, label: '跟随客户端' }]
  const covered = agent.plan.modelIds
  return covered.length > 0 ? agent.models.filter((m) => covered.includes(m.id)) : agent.models
})

const turnChannelGroups = computed<ChannelGroup[]>(() => parseChannelsAndModels(turnEffectiveModels.value))

const turnCurrentGroup = computed(
  () => turnChannelGroups.value.find((g) => g.id === turnChannelId.value) ?? turnChannelGroups.value[0],
)

/** 本轮覆盖模型的展示名(仅用于摘要/气泡文案;候选渲染与哨兵项由 ModelSelector 承担) */
const turnModelLabel = computed(() => {
  if (!turnModelId.value) return ''
  const found = turnChannelGroups.value
    .flatMap((g) => g.models)
    .find((m) => m.value === turnModelId.value)
  return found?.label ?? turnModelId.value
})

/** capabilities.reasoningEffort=false/缺省 = 该客户端不支持思考档位 */
const effortSupported = computed(() => turnAgent.value?.capabilities?.reasoningEffort === true)

/** G3-04:本轮模式选项——首项哨兵「跟随父任务」+ labels.ts 单一来源 MODE_OPTIONS */
const turnModeOptions = computed(() => [{ value: '', label: '跟随父任务' }, ...MODE_OPTIONS])

/** 父任务当前档位文案:未覆盖时沿用父任务,S-07 在哨兵/触发器 title 明示 */
const parentEffortText = computed(() => {
  const effort = task.value?.reasoningEffort
  if (!effort) return '跟随客户端'
  return `${EFFORT_LABEL[effort] ?? effort}档`
})

/** S-03:模型哨兵项文案——「跟随父任务（当前X）」,当前值即父任务模型 */
const turnFollowLabel = computed(() =>
  displayModel.value ? `跟随父任务（当前${displayModel.value}）` : '跟随父任务',
)

/** S-07:未覆盖时的实际沿用值,触发器与哨兵项 title 同源 */
const turnFollowHint = computed(
  () => `未覆盖时沿用父任务：${displayModel.value || '跟随客户端'} · ${parentEffortText.value}`,
)

/** S-02:续聊哨兵「跟随父任务（当前X档）」+ 沿用说明,与发布框哨兵场景化区分 */
const turnEffortSentinelLabel = computed(() => {
  const effort = task.value?.reasoningEffort
  const name = effort ? (EFFORT_LABEL[effort] ?? effort) : '跟随客户端'
  return `跟随父任务（当前${name}）`
})

const turnEffortSentinelHint = computed(
  () => `沿用父任务档位（${parentEffortText.value}）,不作为本轮覆盖下发;选择具体档位才覆盖`,
)

// G3-05:hasTurnOverrides 驱动胶囊组高亮与「复位」——覆盖本轮 model/effort/mode/skills 任一即视为覆盖态
const hasTurnOverrides = computed(() =>
  Boolean(turnModelId.value || turnEffort.value || turnMode.value || turnSkills.value),
)

// G3-04:胶囊内技能选择器与全局共用同一份 store.activeSkills(SkillSelector 直连)。
// 会话态下发布框不可见,activeSkills 的变化即视为用户在胶囊内改写本轮技能→写入 turnSkills;
// 未动胶囊时 turnSkills 保持 null,orchestrator 沿用父任务技能集(全局开关中途被改也不影响本轮)
watch(
  () => store.activeSkills.value,
  (val) => {
    if (!task.value) return
    const base = turnSkillsBase.value
    const changed = val.length !== base.length || val.some((s) => !base.includes(s))
    if (changed) {
      turnSkills.value = [...val]
      turnSkillsBase.value = [...val]
    }
  },
)

const turnSummaryText = computed(() => {
  const parts: string[] = []
  if (turnModelId.value) {
    parts.push(`模型 ${turnModelLabel.value}`)
  }
  if (turnEffort.value) {
    const effort = turnEffort.value as ReasoningEffort
    parts.push(`${EFFORT_LABEL[effort] ?? effort}档思考`)
  }
  // S-11:mode/skills 同属本轮覆盖,摘要必须与实际下发内容对齐
  if (turnMode.value) {
    parts.push(MODE_LABEL[turnMode.value] ?? turnMode.value)
  }
  if (turnSkills.value && turnSkills.value.length > 0) {
    parts.push(`技能${turnSkills.value.length}项`)
  }
  return parts.join(' · ')
})

/**
 * R10:切换会话不清空用户上次的模型/档位选择(跨会话沿用);
 * 仅当客户端/渠道/模型列表变化导致选择失配时,由级联守卫自动回落到「跟随父任务」。
 * S-07:当前客户端不支持思考档位时一并清空 turnEffort,杜绝"界面上没有控件、参数却已存在"。
 * (R09① 曾移除切会话时的自动清空;G3-05 新增的 resetTurnOverrides 仅由「复位」按钮显式触发)
 */
watch(
  [turnChannelGroups, () => task.value?.id, effortSupported],
  () => {
    const groups = turnChannelGroups.value
    if (groups.length === 0) {
      turnChannelId.value = ''
      turnModelId.value = ''
      return
    }
    if (!groups.some((g) => g.id === turnChannelId.value)) {
      const matched = groups.find((g) => g.models.some((m) => m.value === turnModelId.value))
      turnChannelId.value = matched?.id ?? groups[0]!.id
    }
    const inChannel = turnCurrentGroup.value?.models.some((m) => m.value === turnModelId.value) ?? false
    if (turnModelId.value && !inChannel) turnModelId.value = ''
    if (turnEffort.value && !REASONING_EFFORT_OPTIONS.some((o) => o.value === turnEffort.value)) {
      turnEffort.value = ''
    }
    // S-07:能力门控兜底——客户端不支持思考时,此前选中的档位不得继续随轮次透传
    if (turnEffort.value && !effortSupported.value) turnEffort.value = ''
  },
  { immediate: true },
)

/** 轻提示:排队场景下告知本轮参数去向,8 秒自灭(新任务场景头部/详情可见,不再重复提示) */
function setTurnNote(text: string): void {
  turnNote.value = text
  if (turnNoteTimer) clearTimeout(turnNoteTimer)
  turnNoteTimer = null
  if (text) {
    turnNoteTimer = setTimeout(() => {
      turnNote.value = ''
    }, 8000)
  }
}

/** G3-05:一键复位本轮全部覆盖参数,回到「跟随父任务」态(胶囊组高亮随之消失) */
function resetTurnOverrides(): void {
  turnModelId.value = ''
  turnEffort.value = ''
  turnMode.value = ''
  turnSkills.value = null
}

const maxSeq = computed(() => (events.value.length > 0 ? events.value[events.value.length - 1]!.seq : 0))
const atBottom = ref(true)
/** S-20:非贴底期间到达新事件置 true(跳底/贴底清零),「↓ 回到最新」据此改文案「有新消息」 */
const hasUnread = ref(false)

const isRunning = computed(() => task.value?.state === 'running' || task.value?.state === 'queued')

/** 父任务已终态(R09):排队消息不再自动执行,队列条提供逐条「发送」与「全部发送」 */
const isTerminal = computed(() => {
  const s = task.value?.state
  return s === 'completed' || s === 'failed' || s === 'canceled' || s === 'interrupted'
})

// —— 多轮会话流聚合(R11):呈现层按 parentId 链拼接,底层任务记录仍是每轮独立卡 ——

/** 聚合流中的一轮 */
interface SessionTurn {
  task: TaskRecord
  /** 第 N 轮(1 起) */
  index: number
  events: StoredEvent[]
  isCurrent: boolean
}

/** 历史轮事件缓存(taskId → 事件);当前轮仍走 events ref,「加载更早」/自动跟随逻辑不变 */
const historyTurnEvents = ref<Map<string, StoredEvent[]>>(new Map())
let chainLoadId = 0

/**
 * 向上回溯 parentId 链,得到「祖先轮(旧→新)+ 当前轮」;
 * 祖先不在任务列表时从 chainFallback(G3-03:tasksGet 兜底拉取)合并,被保留期清理的
 * 祖先链在断点处停止(tasksGet 为 null),不再无限请求。
 */
const chainTasks = computed<TaskRecord[]>(() => {
  const current = task.value
  if (!current) return []
  const byId = new Map(
    [...store.tasks.value, ...chainFallback.value.values()].map((t) => [t.id, t]),
  )
  const reversed: TaskRecord[] = []
  const seen = new Set<string>([current.id])
  let cursor: TaskRecord | undefined = current
  while (cursor?.parentId) {
    if (seen.has(cursor.parentId)) break
    const parent = byId.get(cursor.parentId)
    if (!parent) break
    seen.add(parent.id)
    reversed.push(parent)
    cursor = parent
  }
  return [...reversed.reverse(), current]
})

/**
 * G3-03:补齐断链——沿 parentId 逐级检查合并源(store.tasks + chainFallback),
 * 缺失时经 tasksGet 兜底拉取写入 chainFallback;选中任务自身被筛选排除时先补本尊。
 * tasksGet 返回 null(已被保留期物理清理)即停止上溯,不再请求。
 */
async function ensureChainFallback(): Promise<void> {
  const selectedId = store.selectedTaskId.value
  if (!selectedId) return
  const byId = new Map<string, TaskRecord>()
  for (const t of store.tasks.value) byId.set(t.id, t)
  for (const t of chainFallback.value.values()) byId.set(t.id, t)
  const seen = new Set<string>([selectedId])
  let cursor: TaskRecord | undefined = byId.get(selectedId)
  if (!cursor) {
    try {
      cursor = (await window.api.tasksGet(selectedId)) ?? undefined
    } catch {
      cursor = undefined
    }
    if (!cursor) return
    chainFallback.value = new Map(chainFallback.value).set(cursor.id, cursor)
    byId.set(cursor.id, cursor)
  }
  while (cursor.parentId) {
    if (seen.has(cursor.parentId)) break
    const parent = byId.get(cursor.parentId)
    if (!parent) {
      let fetched: TaskRecord | null = null
      try {
        fetched = await window.api.tasksGet(cursor.parentId)
      } catch {
        fetched = null
      }
      if (!fetched) break
      chainFallback.value = new Map(chainFallback.value).set(fetched.id, fetched)
      byId.set(fetched.id, fetched)
      seen.add(fetched.id)
      cursor = fetched
      continue
    }
    seen.add(parent.id)
    cursor = parent
  }
}

const sessionTurns = computed<SessionTurn[]>(() => {
  const chain = chainTasks.value
  return chain.map((t, i) => ({
    task: t,
    index: i + 1,
    events: i === chain.length - 1 ? events.value : (historyTurnEvents.value.get(t.id) ?? []),
    isCurrent: i === chain.length - 1,
  }))
})

/** 按 taskId:seq 去重、seq 升序合并(历史分页与实时批推可能交叠,防互覆盖) */
function mergeEventLists(...lists: StoredEvent[][]): StoredEvent[] {
  const seen = new Set<string>()
  const out: StoredEvent[] = []
  for (const list of lists) {
    for (const ev of list) {
      const key = `${ev.taskId}:${ev.seq}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ev)
    }
  }
  return out.sort((a, b) => a.seq - b.seq)
}

// —— G3-11:相邻 progress 折叠为可展开摘要组,agent 正文不再被进度芯片淹没 ——

/** progress 事件窄化形态(G3-11):组内渲染直接访问 text 字段,免模板逐条判别 */
type ProgressStoredEvent = StoredEvent & {
  event: Extract<StoredEvent['event'], { kind: 'progress' }>
}

/** 压缩后的渲染单元:单条事件,或连续 ≥3 条 progress 聚成的组 */
type CompressedEvent =
  | { type: 'single'; ev: StoredEvent }
  | { type: 'progress-group'; items: ProgressStoredEvent[] }

/** 相邻 progress 聚组门槛:零散进度(<3 条连续)仍逐条渲染 */
const PROGRESS_GROUP_MIN = 3

/** 纯函数:把事件序列中连续的 progress 相邻段(≥3 条)聚为组,其余逐条透传 */
function compressEvents(list: StoredEvent[]): CompressedEvent[] {
  const out: CompressedEvent[] = []
  let buffer: StoredEvent[] = []
  const flush = (): void => {
    if (buffer.length === 0) return
    if (buffer.length >= PROGRESS_GROUP_MIN) {
      // buffer 内全部为 progress(写入处已判别),此处断言为窄化类型
      out.push({ type: 'progress-group', items: buffer as ProgressStoredEvent[] })
    } else {
      for (const ev of buffer) out.push({ type: 'single', ev })
    }
    buffer = []
  }
  for (const ev of list) {
    if (ev.event.kind === 'progress') buffer.push(ev)
    else {
      flush()
      out.push({ type: 'single', ev })
    }
  }
  flush()
  return out
}

/** 进度组 key:组首事件的 taskId:seq(跨轮 seq 可能重复,带 taskId 防冲突) */
function progressGroupKey(items: StoredEvent[]): string {
  const first = items[0]
  return first ? `${first.taskId}:${first.seq}` : ''
}

/** G3-11:用户手动偏离默认展开态的进度组(key=progressGroupKey);缺省仅当前轮最后一组展开 */
const progressGroupOverrides = ref<Set<string>>(new Set())

function isProgressGroupExpanded(key: string, defaultExpanded: boolean): boolean {
  if (progressGroupOverrides.value.has(key)) return !defaultExpanded
  return defaultExpanded
}

function toggleProgressGroup(key: string, defaultExpanded: boolean): void {
  const next = new Set(progressGroupOverrides.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  progressGroupOverrides.value = next
}

/** G3-11:渲染轮次=聚合轮次 + 逐轮压缩结果(相邻 progress 折组),模板直接消费 */
interface RenderTurn extends SessionTurn {
  compressed: CompressedEvent[]
}

const renderTurns = computed<RenderTurn[]>(() =>
  sessionTurns.value.map((turn) => ({ ...turn, compressed: compressEvents(turn.events) })),
)

/** G3-11:模板 key——单条用 taskId:seq,进度组用组首 seq 防跨轮冲突 */
function compressedKey(turnId: string, item: CompressedEvent): string {
  if (item.type === 'single') return `${turnId}-${item.ev.seq}`
  return `${turnId}-pg-${progressGroupKey(item.items)}`
}

/** G3-11:默认展开态——仅当前轮最后一组默认展开(其后不再有 progress-group) */
function progressGroupDefaultExpanded(turn: RenderTurn, idx: number): boolean {
  if (!turn.isCurrent) return false
  return !turn.compressed.some((c, i) => i > idx && c.type === 'progress-group')
}

// 历史轮事件补齐:逐轮走既有 tasksEventsPage;链未变(任务列表刷新)不重拉
// G3-03:回调开头先沿链补齐断链祖先(tasksGet 兜底),chainFallback 更新会使
// chainTasks 重算并再次触发本 watch,lastChainKey 幂等守卫防重复拉取
let lastChainKey = ''
watch(
  [() => store.selectedTaskId.value, chainTasks],
  async () => {
    await ensureChainFallback()
    const chain = chainTasks.value
    const key = chain.map((t) => t.id).join('>')
    if (key === lastChainKey) return
    lastChainKey = key
    const id = ++chainLoadId
    const ancestors = chain.slice(0, -1)
    const next = new Map<string, StoredEvent[]>()
    for (const t of ancestors) {
      try {
        const page = await window.api.tasksEventsPage({ taskId: t.id, limit: 200 })
        if (id !== chainLoadId) return
        next.set(t.id, mergeEventLists(page, historyTurnEvents.value.get(t.id) ?? []))
      } catch {
        if (id !== chainLoadId) return
        next.set(t.id, historyTurnEvents.value.get(t.id) ?? [])
      }
    }
    historyTurnEvents.value = next
    // 历史轮补齐会改变流高度:回到最新,保证接续迁移后看到的是新轮
    if (ancestors.length > 0) {
      await nextTick()
      scrollBottom(true)
    }
  },
  { immediate: true },
)

const totalSessionTokens = computed(() => {
  if (!task.value?.usage) return 0
  return (
    (task.value.usage.inputTokens || 0) +
    (task.value.usage.outputTokens || 0) +
    (task.value.usage.cachedTokens || 0)
  )
})

/**
 * 本轮用量与消耗统计(提取至输入框下方显示):
 * 优先取任务持久化 usage,其次取事件流最新 usage 记录
 */
const latestUsage = computed(() => {
  if (task.value?.usage) return task.value.usage
  for (let i = events.value.length - 1; i >= 0; i--) {
    const ev = events.value[i]
    if (ev && ev.event.kind === 'usage') {
      return {
        inputTokens: ev.event.inputTokens ?? 0,
        outputTokens: ev.event.outputTokens ?? 0,
        cachedTokens: ev.event.cachedTokens ?? 0,
        credits: ev.event.credits ?? 0,
        cacheHitRate: ev.event.cacheHitRate ?? 0,
      }
    }
  }
  return null
})

const latestTotalTokens = computed(() => {
  const u = latestUsage.value
  if (!u) return 0
  return (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cachedTokens || 0)
})

// 下一步智能推荐动作 (无多余 emoji)
const nextStepSuggestions = [
  { label: '运行自动化测试验证', prompt: '请运行测试套件验证本次修改，确保全部用例通过且无回归隐患。' },
  { label: '审查潜在风险与改进点', prompt: '请对刚刚的代码修改进行质量与安全性审查，指出潜在风险或可优化点。' },
  { label: '生成变更说明与文档', prompt: '请对本次修改的内容进行结构化总结，输出清晰的变更日志与说明。' },
]

async function loadInitial(taskId: string): Promise<void> {
  const id = ++loadId
  try {
    const page = await window.api.tasksEventsPage({ taskId, limit: 200 })
    if (id !== loadId) return
    events.value = page
    await nextTick()
    scrollBottom(true)
  } catch {
    if (id === loadId) events.value = []
  }
}

async function loadOlder(): Promise<void> {
  const id = task.value?.id
  if (!id || events.value.length === 0 || loadingOlder.value) return
  loadingOlder.value = true
  const firstSeq = events.value[0]!.seq
  const el = scrollEl.value
  const beforeHeight = el?.scrollHeight ?? 0
  try {
    const page = await window.api.tasksEventsPage({ taskId: id, beforeSeq: firstSeq, limit: 200 })
    if (task.value?.id !== id || events.value[0]?.seq !== firstSeq) return
    events.value = [...page, ...events.value]
    await nextTick()
    if (el) el.scrollTop += el.scrollHeight - beforeHeight
  } catch (error) {
    sendError.value = `加载更早事件失败:${error instanceof Error ? error.message : String(error)}`
  } finally {
    loadingOlder.value = false
  }
}

/** G3-12:历史轮「加载本轮更早」进行中的任务 id(空串=空闲) */
const loadingOlderTurn = ref('')

/**
 * G3-12:历史轮翻页——取该轮缓存首条 seq 作 beforeSeq 向前翻一页,
 * 经 mergeEventLists 按 taskId:seq 去重合并;各轮独立翻页互不影响。
 */
async function loadOlderForTurn(taskId: string): Promise<void> {
  if (loadingOlderTurn.value) return
  const existing = historyTurnEvents.value.get(taskId) ?? []
  const firstSeq = existing[0]?.seq
  if (!firstSeq || firstSeq <= 1) return
  loadingOlderTurn.value = taskId
  try {
    const page = await window.api.tasksEventsPage({ taskId, beforeSeq: firstSeq, limit: 200 })
    historyTurnEvents.value = new Map(historyTurnEvents.value).set(taskId, mergeEventLists(page, existing))
  } catch (error) {
    sendError.value = `加载本轮更早事件失败:${error instanceof Error ? error.message : String(error)}`
  } finally {
    loadingOlderTurn.value = ''
  }
}

watch(
  () => store.selectedTaskId.value,
  (id, prevId) => {
    // S-04:离开的会话先把续聊草稿落到 store,回选时取走回填(取走即清,不残留覆盖新输入)
    if (prevId && prevId !== id) store.setContinueDraft(prevId, continueText.value)
    events.value = []
    continueText.value = id ? store.takeContinueDraft(id) : ''
    // S-06:续聊附件不跨会话沿用(草稿契约只承载文本),切换即清空重来
    continueAttachments.value = []
    cancelQueueEdit()
    hasUnread.value = false
    sendError.value = ''
    isRenaming.value = false
    showSlashPopup.value = false
    showMeta.value = false
    // R10:模型/档位选择跨会话沿用,不再清空;失配回落交给级联守卫
    // G3-04:mode 不跨会话沿用,切会话即回「跟随父任务」;
    // 技能覆盖同步复位,基准快照取当前全局选择,此后变化视为胶囊内改写
    turnMode.value = ''
    turnSkills.value = null
    turnSkillsBase.value = [...store.activeSkills.value]
    setTurnNote('')
    if (id) {
      void loadInitial(id)
      void store.refreshFollowups(id)
    }
  },
  { immediate: true },
)

// 事件批推到达(R11):对链上每个任务槽取增量,按 taskId 归位到对应轮次;当前轮保持自动跟随
watch(
  () => store.liveEvents.value,
  (map) => {
    const chain = chainTasks.value
    if (chain.length === 0) return
    let appended = false
    for (const t of chain) {
      const incoming = map.get(t.id) ?? []
      if (incoming.length === 0) continue
      if (t.id === store.selectedTaskId.value) {
        const fresh = incoming.filter((e) => e.seq > maxSeq.value)
        if (fresh.length > 0) {
          events.value = [...events.value, ...fresh]
          appended = true
        }
      } else {
        const existing = historyTurnEvents.value.get(t.id) ?? []
        const floor = existing.length > 0 ? existing[existing.length - 1]!.seq : 0
        const fresh = incoming.filter((e) => e.seq > floor)
        if (fresh.length > 0) {
          const next = new Map(historyTurnEvents.value)
          next.set(t.id, mergeEventLists(existing, fresh))
          historyTurnEvents.value = next
          appended = true
        }
      }
    }
    if (appended) {
      // S-20:非贴底时新事件视为未读,触发悬浮按钮改文案「有新消息」
      if (!atBottom.value) hasUnread.value = true
      void nextTick(() => scrollBottom(false))
    }
  },
)

watch(
  () => task.value?.state,
  async (state) => {
    if (store.selectedTaskId.value && state && state !== 'queued' && state !== 'running') {
      await store.refreshAgents()
      await store.refreshFollowups(store.selectedTaskId.value)
    }
  },
)

/** 离底超过该阈值浮现「↓ 回到最新」(R15),贴底自动隐藏 */
const JUMP_LATEST_THRESHOLD_PX = 240
const showJumpLatest = ref(false)

watch(scrollEl, (el, prev) => {
  if (resizeObserver) {
    if (prev) resizeObserver.unobserve(prev)
    if (el) resizeObserver.observe(el)
  }
})

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  atBottom.value = distance < 80
  showJumpLatest.value = distance > JUMP_LATEST_THRESHOLD_PX
  // S-20:贴底即视为已读
  if (atBottom.value) hasUnread.value = false
}

/** 回到底部并恢复自动跟随(R15);滚动后 onScroll 会复算显隐 */
function jumpToLatest(): void {
  showJumpLatest.value = false
  hasUnread.value = false
  scrollBottom(true)
}

/** S-22:流区键盘可达——聚焦流区时 End/Home 跳底/跳顶(焦点在内部控件时不拦截) */
function onStreamKeydown(event: KeyboardEvent): void {
  if (event.target !== scrollEl.value) return
  if (event.key === 'End') {
    event.preventDefault()
    jumpToLatest()
  } else if (event.key === 'Home') {
    event.preventDefault()
    const el = scrollEl.value
    if (el) {
      el.scrollTop = 0
      showJumpLatest.value = true
    }
  }
}

/** S-22:关闭元数据弹层并把焦点交还触发按钮(点遮罩/再点 ⋯/Esc 三条退路共用) */
function closeMeta(): void {
  showMeta.value = false
  void nextTick(() => metaToggleRef.value?.focus())
}

/** 挂起的跟随滚动 rAF:高频事件批下每帧至多滚一次(P0-9/F2) */
let scrollRafId = 0

/**
 * 自动跟随(P0-9/F2):rAF 合并每帧至多一次,程序化滚动用 behavior:'auto' 即时到底;
 * CSS smooth 已移除——平滑动画反复重启是运行期跟随抖动的根因。
 */
function scrollBottom(force: boolean): void {
  const el = scrollEl.value
  if (!el) return
  if (!force && !atBottom.value) return
  if (scrollRafId) cancelAnimationFrame(scrollRafId)
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = 0
    const node = scrollEl.value
    if (!node) return
    node.scrollTo({ top: node.scrollHeight, behavior: 'auto' })
    atBottom.value = true
    // S-20:跳底即视为已读
    hasUnread.value = false
  })
}

function handleInput(val: string): void {
  continueText.value = val
  if (val.startsWith('/')) {
    slashQuery.value = val
    showSlashPopup.value = true
  } else {
    showSlashPopup.value = false
  }
}

function onContinueKeydown(event: KeyboardEvent): void {
  if (showSlashPopup.value && slashPopupRef.value?.onKeydown(event)) {
    return
  }
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendContinue()
  }
}

/** S-16:斜杠命令只替换首个斜杠词并追加模板,框内其余内容不再被整框覆盖 */
function applySlashCommand(cmd: SlashCommand): void {
  continueText.value = continueText.value.replace(/^\S*/, '') + cmd.template
  // G3-04:斜杠指令的推荐模式在会话续聊场景同样生效(此前被静默丢弃,与发布框不一致)
  if (cmd.recommendedMode) turnMode.value = cmd.recommendedMode
  showSlashPopup.value = false
}

// —— S-06:续聊附件(选文件/拖拽/粘贴三条入口,统一走 addContinueFiles) ——
const CONTINUE_IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

/** 附件只引用原路径;重复路径跳过,避免同一文件多次入队 */
function addContinueFiles(files: FileList | null): void {
  for (const file of files ?? []) {
    let path: string
    try {
      path = window.api.filePath(file)
    } catch {
      sendError.value = `无法解析附件路径:${file.name}`
      continue
    }
    if (continueAttachments.value.some((a) => a.path === path)) continue
    continueAttachments.value.push({
      path,
      kind: CONTINUE_IMAGE_EXT.test(file.name) ? 'image' : 'file',
    })
  }
}

function pickContinueAttachment(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.onchange = () => addContinueFiles(input.files)
  input.click()
}

function onContinueDrop(event: DragEvent): void {
  addContinueFiles(event.dataTransfer?.files ?? null)
}

/** GlassInput 剪贴板文件转发 → 与拖拽/选文件同一路径 */
function onContinuePaste(files: FileList): void {
  addContinueFiles(files)
}

function removeContinueAttachment(path: string): void {
  continueAttachments.value = continueAttachments.value.filter((a) => a.path !== path)
}

async function sendContinue(): Promise<void> {
  const text = continueText.value.trim()
  if (!text || !task.value || sending.value) return
  sending.value = true
  sendError.value = ''
  try {
    // 统一走 tasksContinue(P0-6/C4):queueIfRunning=true 运行中自动排队不报错,
    // 本轮覆盖参数随 ContinueOptions 传给 core——排队时随队列项落 JSON,接续时生效。
    // G3-04:mode 随胶囊选择透传;skills 仅在胶囊内改写过才传(null=跟随父任务,
    // orchestrator 的 ?? parent.skills 回退生效,全局技能开关不再静默替换父任务技能集)
    const res = await window.api.tasksContinue(task.value.id, text, {
      queueIfRunning: true,
      ...(turnSkills.value ? { skills: [...turnSkills.value] } : {}),
      // 档位/模式取值来自选项白名单,按契约类型断言;空串=跟随父任务,不下发
      ...(turnModelId.value ? { modelId: turnModelId.value } : {}),
      // S-07:effortSupported 门控——客户端不支持思考时绝不下发,避免"界面上没有控件、参数却已存在"
      ...(turnEffort.value && effortSupported.value
        ? { reasoningEffort: turnEffort.value as ReasoningEffort }
        : {}),
      ...(turnMode.value ? { mode: turnMode.value as TaskMode } : {}),
      // S-06:本轮附件随 ContinueOptions 透传;未选附件时不传字段(= 核心侧继承父任务附件)
      ...(continueAttachments.value.length > 0
        ? { attachments: continueAttachments.value.map((a) => ({ path: a.path, kind: a.kind })) }
        : {}),
    })
    continueText.value = ''
    continueAttachments.value = []
    showSlashPopup.value = false
    if ('state' in res) {
      // 新任务已落地:覆盖参数体现在新任务记录,头部与详情可见
      const summary = turnSummaryText.value
      await store.refreshTasks()
      store.selectedTaskId.value = res.id
      // 目标交互①:发送时气泡明示本轮参数;切换会话的 watch 会清 turnNote,下一拍补发(仅覆盖过参数时)
      if (summary) void nextTick(() => setTurnNote(`已派发新任务 · 本轮使用 ${summary}`))
    } else {
      // 进入排队队列:轻提示本轮参数去向
      await store.refreshFollowups(task.value.id)
      setTurnNote(turnSummaryText.value ? `已排队 · 本轮将使用 ${turnSummaryText.value}(仅本条生效)` : '')
    }
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : String(error)
  } finally {
    sending.value = false
  }
}

// —— 排队队列管理(P0-6/D3):编辑文案 / 提前发送 / 打断当前轮并立即发送 ——
// S-05:入口只有流内队列气泡一套(顶部悬浮条已删除);S-12:通道直接调用,缺失时明确提示升级。

/** S-12:队列通道缺失(旧主进程)时明确告知,不再可选链静默无响应 */
function missingQueueChannel(): void {
  store.showToast('排队消息通道未就绪,请升级主进程后重试')
}

/** S-05:流内气泡的文案编辑态(同一时刻只编辑一条) */
const queueEditingId = ref('')
const queueEditingText = ref('')

/** 函数 ref:编辑框挂载即聚焦(v-for 内字符串 ref 会退化为数组,故用回调形式) */
function setQueueEditRef(el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLTextAreaElement) el.focus()
}

function startQueueEdit(followupId: string, prompt: string): void {
  queueEditingId.value = followupId
  queueEditingText.value = prompt
}

function cancelQueueEdit(): void {
  queueEditingId.value = ''
  queueEditingText.value = ''
}

/**
 * 「编辑」按钮的切换:按钮以 mousedown.prevent 保住 textarea 焦点(避免 blur 先提交/清态导致点击反被重开),
 * 因此切换另一条时需在此显式提交上一条,不丢改好的文案。
 */
function toggleQueueEdit(followupId: string, prompt: string): void {
  if (queueEditingId.value === followupId) {
    cancelQueueEdit()
    return
  }
  if (queueEditingId.value) commitQueueEdit()
  startQueueEdit(followupId, prompt)
}

/** Enter 提交编辑(textarea 上 Shift+Enter 换行);IME 组词态的 Enter 是选词确认,不拦截 */
function onQueueEditKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  commitQueueEdit()
}

function commitQueueEdit(): void {
  const id = queueEditingId.value
  if (!id) return
  const text = queueEditingText.value.trim()
  const original = store.activeFollowups.value.find((f) => f.id === id)?.prompt ?? ''
  cancelQueueEdit()
  // 文案未变化不触发 IPC;空串不提交(取消该条请用「取消」)
  if (text && text !== original) void onQueueEdit(id, text)
}

/** S-11:排队项覆盖参数徽标——模型/模式/档位/技能条数逐段显示,组不出段时回落「参数」 */
function queueOvText(item: {
  modelId?: string
  mode?: TaskMode
  reasoningEffort?: ReasoningEffort
  skills?: string[]
  toolPolicy?: unknown
}): string {
  return (
    [
      item.modelId ? `模型:${item.modelId}` : '',
      item.mode ? (MODE_LABEL[item.mode] ?? item.mode) : '',
      item.reasoningEffort
        ? `${EFFORT_LABEL[item.reasoningEffort] ?? item.reasoningEffort}档`
        : '',
      item.skills && item.skills.length > 0 ? `技能:${item.skills.length} 项` : '',
    ]
      .filter(Boolean)
      .join('·') || '参数'
  )
}

/** 排队项是否携带本轮覆盖(有覆盖才渲染徽标) */
function hasQueueOverrides(item: {
  modelId?: string
  mode?: TaskMode
  reasoningEffort?: ReasoningEffort
  skills?: string[]
  toolPolicy?: unknown
}): boolean {
  return Boolean(
    item.modelId || item.mode || item.reasoningEffort || item.toolPolicy || item.skills?.length,
  )
}

/** S-05:组级提示随父任务状态切换(与旧悬浮条同口径) */
const queueGroupHint = computed(() =>
  isTerminal.value ? '任务已结束，排队消息不会自动执行' : '当前轮次完成后将自动接续发送',
)

/** S-05:终态「全部发送」按钮文案带条数 */
const queueSendAllLabel = computed(() => `全部发送(${store.activeFollowups.value.length})`)

// —— 破坏性操作应用内二次确认(R13):清空排队 / 打断当前轮并立即发送 / 终止当前任务(G3-13),Esc 取消、Enter 确认 ——
type ConfirmState =
  | { kind: 'clear-queue' }
  | { kind: 'interrupt'; followupId: string }
  | { kind: 'stop-task' }
const confirmState = ref<ConfirmState | null>(null)

const confirmView = computed(() => {
  if (!confirmState.value) return { title: '', body: '', okLabel: '' }
  if (confirmState.value.kind === 'clear-queue') {
    return {
      title: '清空排队消息',
      body: `将清空 ${store.activeFollowups.value.length} 条排队消息，不可恢复。`,
      okLabel: '确认清空',
    }
  }
  if (confirmState.value.kind === 'stop-task') {
    // G3-13:两处终止入口统一先过应用内确认层,杜绝单击误触不可逆终止
    return {
      title: '终止当前任务',
      body: '将立即中断当前轮执行，不可恢复。排队消息将保留为待发。',
      okLabel: '终止',
    }
  }
  return {
    title: '打断并立即发送',
    body: '将终止当前轮并立即发送该条排队消息；其余排队消息将随新任务自动接续。',
    okLabel: '终止并发送',
  }
})

function cancelConfirm(): void {
  confirmState.value = null
}

async function acceptConfirm(): Promise<void> {
  const state = confirmState.value
  if (!state) return
  confirmState.value = null
  if (state.kind === 'clear-queue') {
    if (task.value) await store.clearFollowups(task.value.id)
    return
  }
  if (state.kind === 'stop-task') {
    if (task.value) await store.stopTask(task.value.id)
    return
  }
  await performInterrupt(state.followupId)
}

/** Enter 确认(GlassModal 自带 Esc 取消);IME 组词态的 Enter 不算确认意图 */
function onConfirmKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter') {
    event.preventDefault()
    void acceptConfirm()
  }
}

watch(confirmState, (state) => {
  if (state) window.addEventListener('keydown', onConfirmKeydown)
  else window.removeEventListener('keydown', onConfirmKeydown)
})

async function onQueueEdit(followupId: string, prompt: string): Promise<void> {
  const current = task.value
  if (!current) return
  const update = window.api.tasksUpdateFollowup
  if (!update) {
    missingQueueChannel()
    return
  }
  try {
    await update(current.id, followupId, prompt)
    await store.refreshFollowups(current.id)
  } catch (error) {
    sendError.value = `编辑排队消息失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function onQueuePromote(followupId: string): Promise<void> {
  const current = task.value
  if (!current) return
  const reorder = window.api.tasksReorderFollowup
  if (!reorder) {
    missingQueueChannel()
    return
  }
  try {
    // 契约语义:beforeFollowupId=队首项 id → 插到队首之前,即成为新队首
    const firstId = store.activeFollowups.value[0]?.id ?? null
    await reorder(current.id, followupId, firstId)
    await store.refreshFollowups(current.id)
  } catch (error) {
    sendError.value = `提前发送失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** G3-04:队列相邻调序(承接 G2-07 的 demote 事件):把该项与下一项交换位置 */
async function onQueueDemote(followupId: string): Promise<void> {
  const current = task.value
  if (!current) return
  const reorder = window.api.tasksReorderFollowup
  if (!reorder) {
    missingQueueChannel()
    return
  }
  const list = store.activeFollowups.value
  const idx = list.findIndex((f) => f.id === followupId)
  if (idx < 0 || idx === list.length - 1) return
  // 契约语义:beforeFollowupId=「再下一项」id → 该项插到其之前,恰好落在下一项之后;
  // 无再下一项(null)= 移到队尾,与 promote 的队首语义对称
  const afterNextId = list[idx + 2]?.id ?? null
  try {
    await reorder(current.id, followupId, afterNextId)
    await store.refreshFollowups(current.id)
  } catch (error) {
    sendError.value = `调序失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** 打断当前轮并立即发送(R13):只弹应用内确认层,实际执行在 performInterrupt */
function onQueueInterrupt(followupId: string): void {
  confirmState.value = { kind: 'interrupt', followupId }
}

async function performInterrupt(followupId: string): Promise<void> {
  const current = task.value
  if (!current) return
  const item = store.activeFollowups.value.find((f) => f.id === followupId)
  if (!item) return
  try {
    // 1. 取消当前轮但保留队列(clearFollowups=false);任务恰已收尾时返回 false,降级为普通续聊
    await window.api.tasksCancel(current.id, false)
    // 2. 立即续聊发送该条:排队时随项选择的覆盖参数一并透传,未设置的字段沿用父任务
    const res = await window.api.tasksContinue(current.id, item.prompt, {
      skills: [...(item.skills ?? [])],
      queueIfRunning: true,
      ...(item.modelId !== undefined ? { modelId: item.modelId } : {}),
      ...(item.mode !== undefined ? { mode: item.mode } : {}),
      ...(item.toolPolicy !== undefined ? { toolPolicy: item.toolPolicy } : {}),
      ...(item.reasoningEffort !== undefined ? { reasoningEffort: item.reasoningEffort } : {}),
    })
    // 3. 该条使命已由显式续聊承接,移除队列项防止自动接续时重复发送
    const removeFollowup = window.api.tasksRemoveFollowup
    if (!removeFollowup) {
      missingQueueChannel()
      return
    }
    await removeFollowup(current.id, followupId)
    await store.refreshTasks()
    if ('state' in res) {
      // 4. 剩余排队项迁移到新任务:被打断的父任务已终态,不会再消费队列
      const migrate = window.api.tasksMigrateFollowups
      if (!migrate) {
        missingQueueChannel()
        return
      }
      const migrated = (await migrate(current.id, res.id)) ?? 0
      store.selectedTaskId.value = res.id
      if (migrated > 0) store.showToast(`其余 ${migrated} 条排队消息已随新任务自动接续`)
    } else {
      await store.refreshFollowups(current.id)
    }
  } catch (error) {
    sendError.value = `打断发送失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * 终态队列逐条发送(R09④):父任务已终态时 tasksContinue 直接落地接续新任务,
 * 排队项携带的覆盖参数(modelId/mode/toolPolicy/reasoningEffort)随条透传,
 * 与「带参数」标签承诺一致;其余排队项留在原任务,toast 明示去处。
 */
async function sendOneFollowup(followupId: string): Promise<void> {
  const current = task.value
  if (!current || !isTerminal.value) return
  const item = store.activeFollowups.value.find((f) => f.id === followupId)
  if (!item) return
  try {
    const res = await window.api.tasksContinue(current.id, item.prompt, {
      skills: [...(item.skills ?? [])],
      queueIfRunning: true,
      ...(item.modelId !== undefined ? { modelId: item.modelId } : {}),
      ...(item.mode !== undefined ? { mode: item.mode } : {}),
      ...(item.toolPolicy !== undefined ? { toolPolicy: item.toolPolicy } : {}),
      ...(item.reasoningEffort !== undefined ? { reasoningEffort: item.reasoningEffort } : {}),
    })
    if (!('state' in res)) {
      // 极小概率竞态(父任务又回到运行/排队态):本条已按普通排队处理,刷新队列即可
      await store.refreshFollowups(current.id)
      return
    }
    const rest = store.activeFollowups.value.filter((f) => f.id !== followupId).length
    // 该条使命已由显式续聊承接,移除队列项防止留在原任务成为死项
    const removeFollowup = window.api.tasksRemoveFollowup
    if (!removeFollowup) {
      missingQueueChannel()
      return
    }
    await removeFollowup(current.id, followupId)
    await store.refreshTasks()
    store.selectedTaskId.value = res.id
    store.showToast(rest > 0 ? `已发送 · 其余 ${rest} 条仍留在原任务待发` : '已发送')
  } catch (error) {
    sendError.value = `发送排队消息失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * 终态队列全部发送(R09④):首条走 tasksContinue 落地唯一一条接续任务,
 * 其余经 tasksMigrateFollowups 并入该新任务随其完成自动接力;父任务队列清空。
 */
async function sendAllFollowups(): Promise<void> {
  const current = task.value
  if (!current || !isTerminal.value) return
  const first = store.activeFollowups.value[0]
  if (!first) return
  try {
    const total = store.activeFollowups.value.length
    // 1. 首条落地接续任务:覆盖参数随条透传
    const res = await window.api.tasksContinue(current.id, first.prompt, {
      skills: [...(first.skills ?? [])],
      queueIfRunning: true,
      ...(first.modelId !== undefined ? { modelId: first.modelId } : {}),
      ...(first.mode !== undefined ? { mode: first.mode } : {}),
      ...(first.toolPolicy !== undefined ? { toolPolicy: first.toolPolicy } : {}),
      ...(first.reasoningEffort !== undefined ? { reasoningEffort: first.reasoningEffort } : {}),
    })
    if (!('state' in res)) {
      // 竞态兜底:父任务又回到运行/排队态,整队恢复自动接续语义,无需迁移
      await store.refreshFollowups(current.id)
      return
    }
    // 2. 首条使命已承接,先移除再整体迁移,避免它随迁移被二次发送
    const removeFollowup = window.api.tasksRemoveFollowup
    const migrate = window.api.tasksMigrateFollowups
    if (!removeFollowup || !migrate) {
      missingQueueChannel()
      return
    }
    await removeFollowup(current.id, first.id)
    await migrate(current.id, res.id)
    await store.refreshTasks()
    store.selectedTaskId.value = res.id
    store.showToast(total > 1 ? `已发送 ${total} 条 · 其余将随接续任务自动接力` : '已发送')
  } catch (error) {
    sendError.value = `全部发送失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** G3-13:终止改为先弹应用内确认层(头部按钮与运行指示条两个入口自动同享),
 *  实际执行在 acceptConfirm 的 stop-task 分支;确认层 Enter 确认/Esc 取消机制沿用 R13 */
function stopCurrentTask(): void {
  if (!task.value) return
  confirmState.value = { kind: 'stop-task' }
}

let cancelRenameFlag = false

function startRename(): void {
  if (!task.value) return
  cancelRenameFlag = false
  renameInput.value = task.value.title ?? task.value.prompt
  isRenaming.value = true
}

function cancelRename(): void {
  cancelRenameFlag = true
  isRenaming.value = false
}

async function commitRename(): Promise<void> {
  if (cancelRenameFlag || !isRenaming.value) {
    cancelRenameFlag = false
    return
  }
  if (!task.value || !renameInput.value.trim()) {
    isRenaming.value = false
    return
  }
  const newTitle = renameInput.value.trim()
  isRenaming.value = false
  await store.renameTask(task.value.id, newTitle)
}

const retrying = ref(false)

async function retryFailedTask(): Promise<void> {
  if (!task.value || retrying.value) return
  retrying.value = true
  sendError.value = ''
  try {
    const next = await window.api.tasksRetry(task.value.id)
    await store.refreshTasks()
    store.selectedTaskId.value = next.id
  } catch (error) {
    sendError.value = `重试失败: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    retrying.value = false
  }
}

/**
 * 中断态一键恢复(R14):interrupted 的唯一合法收敛路径是先标记失败,
 * 再复用 retryFailedTask 的 tasksRetry 派生新任务(attempt+1),全程留在会话流内。
 */
async function markFailedAndRetry(): Promise<void> {
  const current = task.value
  if (!current || retrying.value) return
  retrying.value = true
  sendError.value = ''
  try {
    await window.api.tasksMarkFailed(current.id)
    const next = await window.api.tasksRetry(current.id)
    await store.refreshTasks()
    store.selectedTaskId.value = next.id
  } catch (error) {
    sendError.value = `恢复失败: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    retrying.value = false
  }
}

function reuseTaskPrompt(): void {
  if (!task.value) return
  continueText.value = task.value.prompt
}

async function openArtifactPath(filePath: string): Promise<void> {
  try {
    await window.api.openPath(filePath)
  } catch (error) {
    sendError.value = `打开产物失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

function onScenarioSelected(scenario: ScenarioTemplate): void {
  // 空态没有续聊输入框:草稿改投常驻发布框,Composer 监听 fill-composer 落地(P0-10/H1)
  if (!task.value) {
    window.dispatchEvent(new CustomEvent('fill-composer', { detail: scenario.prompt }))
    return
  }
  continueText.value = scenario.prompt
  if (scenario.recommendedSkills) {
    store.setSkills(scenario.recommendedSkills)
    // G3-14:场景卡整组覆盖全局技能时给出说明,用户知悉发布框下次派发的技能集已被改写
    store.showToast('已应用场景推荐技能组合(可在技能栏调整)')
  }
}

function applySuggestion(suggestion: { label: string; prompt: string }): void {
  continueText.value = suggestion.prompt
  void sendContinue()
}

async function openWorkspace(): Promise<void> {
  if (task.value?.cwd) {
    await window.api.openPath(task.value.cwd)
  }
}

/** S-21:今日只显示时分秒,非今日补 M/D(跨天会话不再两处时间无法区分) */
function timeOf(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (!sameDay) return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
  return `${hm}:${String(d.getSeconds()).padStart(2, '0')}`
}
</script>

<template>
  <section class="session glass">
    <template v-if="task">
      <header class="head">
        <div class="head-main">
          <!-- 主行只留 客户端·状态·模型,单行省略;#id/技能/用量收进"⋯"弹层(任意列宽 ≤2 行,P0-9/F1) -->
          <div class="who">
            <div class="who-main">
              <span class="agent-chip">{{ agentLabel }}</span>
              <span class="badge" :class="`s-${task.state}`">{{ STATE_TEXT[task.state] }}</span>
              <span v-if="displayModel" class="model-chip mono" :title="displayModel">{{ displayModel }}</span>
            </div>
            <button
              ref="metaToggleRef"
              type="button"
              class="meta-toggle"
              title="更多会话信息(#id / 技能 / 用量)"
              :aria-expanded="showMeta"
              @click.stop="showMeta ? closeMeta() : (showMeta = true)"
              @keydown.esc="closeMeta"
            >
              ⋯
            </button>
            <div v-if="showMeta" class="meta-pop glass">
              <div class="meta-row">
                <span class="meta-lbl">编号</span>
                <span class="num" :title="task.id">#{{ task.id }}</span>
              </div>
              <div v-if="task.skills && task.skills.length > 0" class="meta-row">
                <span class="meta-lbl">技能</span>
                <span v-for="s in task.skills" :key="s" class="s-tag">{{ s }}</span>
              </div>
              <div v-if="task.usage" class="meta-row">
                <span class="meta-lbl">用量</span>
                <!-- 对话消耗指标 (严格按 Agent 计量模式分离) -->
                <template v-if="billingType === 'credits'">
                  <span>点数 {{ task.usage.credits }} 点</span>
                </template>
                <template v-else>
                  <span>Token {{ formatTokens(totalSessionTokens) }}</span>
                </template>
                <span v-if="task.usage.cacheHitRate" class="cache-hint">缓存 {{ task.usage.cacheHitRate }}%</span>
              </div>
            </div>
          </div>

          <div class="title-row">
            <div v-if="isRenaming" class="rename-box">
              <input
                v-model="renameInput"
                class="rename-input"
                autofocus
                @keydown.enter="commitRename"
                @keydown.esc="cancelRename"
                @blur="commitRename"
              />
            </div>
            <span
              v-else
              class="prompt"
              :title="task.title || task.prompt"
              @click="startRename"
            >
              {{ task.title || task.prompt }}
              <span class="edit-hint" title="点击重命名对话">[改名]</span>
            </span>
          </div>
        </div>

        <div class="head-actions">
          <!-- R12:窄容器收为图标钮(.act-lbl 由 container query 隐藏),宽容器维持图标不显、纯文字 -->
          <GlassButton
            v-if="isRunning"
            variant="danger"
            size="sm"
            class="stop-btn"
            title="立即终止当前 Agent 任务执行"
            @click="stopCurrentTask"
          >
            <span class="act-ico" aria-hidden="true">⏹</span><span class="act-lbl">终止</span>
          </GlassButton>

          <!-- G3-06:会话头部「新任务」入口——切回发布台派发新任务无需离开当前会话,
               会话可从任务列表点回;newChat 仅清选中与队列,客户端绑定保持 -->
          <GlassButton
            variant="ghost"
            size="sm"
            title="切回发布台派发新任务,当前会话可从任务列表点回"
            @click="store.newChat()"
          >
            <span class="act-ico" aria-hidden="true">＋</span><span class="act-lbl">新任务</span>
          </GlassButton>

          <GlassButton
            variant="ghost"
            size="sm"
            title="打开当前工作区目录"
            @click="openWorkspace"
          >
            <span class="act-ico" aria-hidden="true">⌂</span><span class="act-lbl">工作区</span>
          </GlassButton>

          <GlassButton
            variant="ghost"
            size="sm"
            title="点击弹窗查看完整任务详情与操作"
            @click="store.openDetailModal()"
          >
            <span class="act-ico" aria-hidden="true">ⓘ</span><span class="act-lbl">详情</span>
          </GlassButton>

          <GlassButton
            variant="ghost"
            size="sm"
            :title="store.detailCollapsed.value ? '展开详情侧栏' : '锁起详情侧栏'"
            @click="store.toggleDetailCollapsed()"
          >
            <span class="act-ico" aria-hidden="true">◧</span>
            <span class="act-lbl">{{ store.detailCollapsed.value ? '展开详情' : '折叠详情' }}</span>
          </GlassButton>
        </div>
      </header>

      <!-- 元数据弹层遮罩:覆盖会话列内任意处点击即关闭(容器化后改为列内 absolute) -->
      <div v-if="showMeta" class="meta-mask" @click="closeMeta()" />

      <!-- S-05:队列入口只有流内气泡一套,顶部悬浮条(FollowupQueueBar)已随本整改删除 -->

      <div
        ref="scrollEl"
        class="stream"
        tabindex="0"
        aria-label="会话事件流(End 跳到底部 / Home 跳到顶部)"
        @scroll="onScroll"
        @keydown="onStreamKeydown"
      >
        <!-- 「加载更早」仅作用于当前轮(历史轮已整轮拉取,加载方式维持既有) -->
        <GlassButton
          v-if="events.length > 0 && events[0]!.seq > 1"
          variant="ghost"
          size="sm"
          class="older"
          @click="loadOlder"
        >
          {{ loadingOlder ? '加载中…' : '加载更早' }}
        </GlassButton>

        <!-- 多轮会话流聚合呈现(R11):parentId 链逐轮拼接为一条连续流,历史轮只读;
             G3-11:逐轮事件经 compressEvents 压缩,相邻 progress 折为可展开摘要组 -->
        <template v-for="turn in renderTurns" :key="turn.task.id">
          <div v-if="renderTurns.length > 1" class="turn-divider">
            <span class="turn-divider-line" aria-hidden="true" />
            <span class="turn-divider-chip num">
              第 {{ turn.index }} 轮 ·
              {{ formatModelDisplay(turn.task.modelId, turn.task.agentId, store.agents.value) }} ·
              {{ STATE_TEXT[turn.task.state] }} ·
              {{ timeOf(turn.task.createdAt) }}
            </span>
            <span class="turn-divider-line" aria-hidden="true" />
          </div>

          <!-- G3-12:历史轮翻页——该轮缓存首条 seq > 1 时给出「加载本轮更早」,各轮独立 -->
          <GlassButton
            v-if="!turn.isCurrent && (turn.events[0]?.seq ?? 1) > 1"
            variant="ghost"
            size="sm"
            class="older"
            :disabled="loadingOlderTurn === turn.task.id"
            @click="loadOlderForTurn(turn.task.id)"
          >
            {{ loadingOlderTurn === turn.task.id ? '加载中…' : '加载本轮更早' }}
          </GlassButton>

          <!-- 每轮的用户指令气泡(首轮/接续轮同构) -->
          <div class="row mine">
            <div class="bubble user-prompt">
              <span class="bubble-header">用户指令</span>
              <div class="text">{{ turn.task.prompt }}</div>
              <span class="num t">{{ timeOf(turn.task.createdAt) }}</span>
            </div>
          </div>

          <template v-for="(item, idx) in turn.compressed" :key="compressedKey(turn.task.id, item)">
            <div v-if="item.type === 'single' && item.ev.event.kind === 'state-changed'" class="node">
              <span class="node-chip">
                {{ STATE_TEXT[item.ev.event.from] }} → {{ STATE_TEXT[item.ev.event.to] }}
                <span class="num t">{{ timeOf(item.ev.at) }}</span>
              </span>
            </div>

            <!-- G3-11:零散 progress(<3 条连续)保持逐条渲染,样式不变 -->
            <div v-else-if="item.type === 'single' && item.ev.event.kind === 'progress'" class="node prog-node">
              <div class="node-chip soft prog-chip">
                <span class="node-spin" aria-hidden="true" />
                <span class="prog-text">{{ parseProgress(item.ev.event.text).displayText }}</span>
                <span v-if="parseProgress(item.ev.event.text).percent !== undefined" class="prog-pct num">
                  {{ parseProgress(item.ev.event.text).percent }}%
                </span>
                <span class="num t">{{ timeOf(item.ev.at) }}</span>
              </div>
              <div v-if="parseProgress(item.ev.event.text).percent !== undefined" class="prog-track">
                <i :style="{ width: `${parseProgress(item.ev.event.text).percent}%` }" />
              </div>
            </div>

            <div v-else-if="item.type === 'single' && item.ev.event.kind === 'artifact'" class="row">
              <span
                class="bubble file clickable"
                :title="`${item.ev.event.path}（点击在系统中定位或打开产物）`"
                @click="openArtifactPath(item.ev.event.path)"
              >
                <span class="kind-tag artifact">产物</span>
                <span class="mono-path">{{ item.ev.event.path }}</span>
                <span class="change" :class="item.ev.event.change">{{ item.ev.event.change }}</span>
              </span>
            </div>

            <div v-else-if="item.type === 'single' && item.ev.event.kind === 'warning'" class="row">
              <span class="bubble warn">
                <span class="text">{{ item.ev.event.text }}</span>
                <span class="num t">{{ timeOf(item.ev.at) }}</span>
              </span>
            </div>

            <!-- 系统说明节点(P0-4/R16):实际下发参数与「接续自」等运行期事实,中性居中呈现 -->
            <div v-else-if="item.type === 'single' && item.ev.event.kind === 'info'" class="node">
              <span class="node-chip soft" :title="item.ev.event.text">
                {{ item.ev.event.text }}
                <span class="num t">{{ timeOf(item.ev.at) }}</span>
              </span>
            </div>

            <!-- 对话气泡方向修正(R16):Agent 正文回复居左并带标识;stderr 保持错误样式;用户指令/追问居右
                 S-18:仅 agent 频道启用轻量 Markdown 渲染,stdout/stderr 一律保持纯文本 -->
            <div v-else-if="item.type === 'single' && item.ev.event.kind === 'message'" class="row">
              <div class="bubble msg" :class="{ err: item.ev.event.channel === 'stderr' }">
                <span v-if="item.ev.event.channel === 'agent'" class="bubble-header agent-name">
                  <span class="agent-dot" aria-hidden="true" /> Agent
                </span>
                <MarkdownBubble
                  v-if="item.ev.event.channel === 'agent'"
                  :text="item.ev.event.text"
                  class="msg-markdown"
                />
                <div v-else class="msg-content">{{ item.ev.event.text }}</div>
                <span class="num t">{{ timeOf(item.ev.at) }}</span>
              </div>
            </div>

            <!-- G3-11:相邻 progress 折叠摘要组——一行摘要芯片,点击展开/折叠组内全部进度条目 -->
            <div v-else-if="item.type === 'progress-group'" class="node prog-node">
              <button
                type="button"
                class="node-chip soft prog-chip prog-group-chip"
                :title="isProgressGroupExpanded(progressGroupKey(item.items), progressGroupDefaultExpanded(turn, idx))
                  ? '点击折叠本轮进度'
                  : `点击展开 ${item.items.length} 条进度`"
                @click="toggleProgressGroup(progressGroupKey(item.items), progressGroupDefaultExpanded(turn, idx))"
              >
                <span class="node-spin" aria-hidden="true" />
                <span class="prog-text">
                  ⚙ {{ item.items.length }} 条进度 · 最新：{{ parseProgress(item.items[item.items.length - 1]!.event.text).displayText }}
                </span>
                <span class="num t">{{ timeOf(item.items[item.items.length - 1]!.at) }}</span>
              </button>
              <template
                v-if="isProgressGroupExpanded(progressGroupKey(item.items), progressGroupDefaultExpanded(turn, idx))"
              >
                <div v-for="gev in item.items" :key="`${gev.taskId}-${gev.seq}`" class="node prog-node">
                  <div class="node-chip soft prog-chip">
                    <span class="node-spin" aria-hidden="true" />
                    <span class="prog-text">{{ parseProgress(gev.event.text).displayText }}</span>
                    <span v-if="parseProgress(gev.event.text).percent !== undefined" class="prog-pct num">
                      {{ parseProgress(gev.event.text).percent }}%
                    </span>
                    <span class="num t">{{ timeOf(gev.at) }}</span>
                  </div>
                  <div v-if="parseProgress(gev.event.text).percent !== undefined" class="prog-track">
                    <i :style="{ width: `${parseProgress(gev.event.text).percent}%` }" />
                  </div>
                </div>
              </template>
            </div>
          </template>
        </template>

        <!-- 运行中的状态指示条 (参考 AgentHub MemProgressDialog) -->
        <div v-if="isRunning" class="running-indicator">
          <span class="run-spin" aria-hidden="true" />
          <div class="run-info">
            <span class="run-title">Agent 正在执行中…</span>
            <span v-if="runningDurationText" class="run-time num">已耗时 {{ runningDurationText }}</span>
          </div>
          <GlassButton variant="danger" size="sm" class="run-stop-btn" title="终止当前任务" @click="stopCurrentTask">
            终止
          </GlassButton>
        </div>

        <!-- 任务异常失败/中断恢复栏(R14):failed 与 interrupted 都在流内联给出一键恢复 -->
        <div v-if="task.state === 'failed' || task.state === 'interrupted'" class="failure-alert-box glass">
          <div class="fail-info">
            <span class="fail-badge">
              {{ task.state === 'interrupted' ? '已中断（应用异常退出）' : '任务失败' }}
            </span>
            <span class="fail-msg" :title="task.error || '执行过程中断'">
              {{ task.error || (task.state === 'interrupted' ? '应用异常退出导致本轮执行中断,可标记失败后重试' : '任务执行异常终止,可能是上游模型服务超时或进程意外退出') }}
            </span>
          </div>
          <div class="fail-actions">
            <GlassButton
              variant="primary"
              size="sm"
              :disabled="retrying"
              :title="task.state === 'interrupted' ? '标记为失败并派生重试任务(中断态唯一合法收敛路径)' : ''"
              @click="task.state === 'interrupted' ? markFailedAndRetry() : retryFailedTask()"
            >
              {{ retrying ? '恢复中…' : task.state === 'interrupted' ? '标记失败并重试' : '立即重试' }}
            </GlassButton>
            <GlassButton variant="ghost" size="sm" @click="reuseTaskPrompt">
              填入输入框微调
            </GlassButton>
          </div>
        </div>

        <!-- 任务完成后的下一步动作建议 (精简无 emoji) -->
        <div v-if="task.state === 'completed'" class="suggestions-box">
          <span class="sug-title">下一步建议：</span>
          <div class="sug-list">
            <GlassButton
              v-for="s in nextStepSuggestions"
              :key="s.label"
              variant="ghost"
              size="sm"
              class="sug-btn"
              @click="applySuggestion(s)"
            >
              {{ s.label }}
            </GlassButton>
          </div>
        </div>

        <!-- S-05:流内排队追问 = 队列唯一 UI:组级「全部发送(N)/清空」+ 逐条「编辑/上移/插队执行/取消」 -->
        <div v-if="store.activeFollowups.value.length > 0" class="queue-block">
          <div class="queue-group-row">
            <span class="queue-group-title">⏳ 排队追加对话 ({{ store.activeFollowups.value.length }})</span>
            <span class="queue-group-hint">{{ queueGroupHint }}</span>
            <span class="queue-group-actions">
              <!-- 仅终态显示全部发送:运行/排队态队列会自动接续,不需要手动发送 -->
              <GlassButton
                v-if="isTerminal"
                variant="primary"
                size="sm"
                title="按队列顺序发送全部排队消息,合并为一条接续任务"
                @click="sendAllFollowups"
              >
                {{ queueSendAllLabel }}
              </GlassButton>
              <GlassButton
                variant="danger"
                size="sm"
                title="清空所有排队消息"
                @click="confirmState = { kind: 'clear-queue' }"
              >
                清空
              </GlassButton>
            </span>
          </div>

          <div
            v-for="(fq, idx) in store.activeFollowups.value"
            :key="fq.id"
            class="row mine queue-bubble-row"
          >
            <div class="bubble queue-bubble glass">
              <div class="queue-status-tag">
                <span class="queue-spin" aria-hidden="true" />
                <span>#{{ idx + 1 }} · {{ isTerminal ? '任务已结束，排队消息不会自动执行' : '排队追问中 · 当前轮完成后自动接续' }}</span>
              </div>
              <!-- 编辑态:多行 textarea,Enter 提交 / Shift+Enter 换行 / Esc 取消 -->
              <textarea
                v-if="queueEditingId === fq.id"
                :ref="setQueueEditRef"
                v-model="queueEditingText"
                class="queue-edit-input"
                rows="3"
                @keydown.enter.exact="onQueueEditKeydown"
                @keydown.esc="cancelQueueEdit"
                @blur="commitQueueEdit"
              />
              <div v-else class="text queue-text clickable" :title="`${fq.prompt}（点击编辑文案）`" @click="startQueueEdit(fq.id, fq.prompt)">
                {{ fq.prompt }}
              </div>
              <!-- S-11:覆盖参数徽标含技能条数 -->
              <span
                v-if="hasQueueOverrides(fq)"
                class="ov-tag"
                title="本条携带着本轮参数覆盖,发送时按此执行"
              >
                {{ queueOvText(fq) }}
              </span>
              <div class="queue-quick-actions" @click.stop>
                <button
                  type="button"
                  class="q-btn"
                  :class="{ editing: queueEditingId === fq.id }"
                  title="编辑本条排队文案"
                  @mousedown.prevent
                  @click="toggleQueueEdit(fq.id, fq.prompt)"
                >
                  编辑
                </button>
                <button
                  v-if="idx > 0"
                  type="button"
                  class="q-btn"
                  title="移到队首:当前轮结束后最先发送"
                  @click="onQueuePromote(fq.id)"
                >
                  ↑ 上移
                </button>
                <button
                  v-if="idx < store.activeFollowups.value.length - 1"
                  type="button"
                  class="q-btn"
                  title="与下一项交换顺序"
                  @click="onQueueDemote(fq.id)"
                >
                  ↓ 下移
                </button>
                <button
                  v-if="isRunning"
                  type="button"
                  class="q-btn primary"
                  title="立即打断当前任务并插队执行"
                  @click="onQueueInterrupt(fq.id)"
                >
                  ⚡ 插队执行
                </button>
                <button
                  v-if="isTerminal"
                  type="button"
                  class="q-btn primary"
                  title="立即发送本条排队消息"
                  @click="sendOneFollowup(fq.id)"
                >
                  发送
                </button>
                <button
                  type="button"
                  class="q-btn danger"
                  title="从队列中取消此追问"
                  @click="store.removeFollowup(task.id, fq.id)"
                >
                  ✕ 取消
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 回到最新悬浮按钮(R15/S-20):离底超阈值或存在未读时出现,未读文案改为「有新消息」 -->
        <button
          v-if="showJumpLatest || hasUnread"
          type="button"
          class="jump-latest"
          :class="{ unread: hasUnread }"
          @click="jumpToLatest"
        >
          {{ hasUnread ? '↓ 有新消息' : '↓ 回到最新' }}
        </button>
      </div>

      <footer class="composer-container" @dragover.prevent @drop.prevent="onContinueDrop">
        <div class="input-wrapper">
          <!-- 斜杠指令浮层 -->
          <SlashCommandPopup
            v-if="showSlashPopup"
            ref="slashPopupRef"
            :query="slashQuery"
            @select="applySlashCommand"
            @close="showSlashPopup = false"
          />

          <GlassInput
            :model-value="continueText"
            multiline
            :rows="2"
            auto-grow
            :max-grow-height="180"
            :send-label="isRunning ? '追加排队' : '发送'"
            :send-disabled="sending || !continueText.trim()"
            :placeholder="isRunning ? 'Agent 正在执行中，输入可直接排队追加对话 (Enter 发送)' : '继续对话: 输入指令或键入 / 选择快捷技能 (Enter 发送)'"
            @update:model-value="handleInput"
            @keydown="onContinueKeydown"
            @send="sendContinue"
            @paste="onContinuePaste"
          />
        </div>

        <!-- S-06:续聊附件行——选文件/拖拽/粘贴三入口,未选则不传 attachments(= 继承父任务) -->
        <div class="continue-attach-row">
          <GlassButton variant="ghost" size="sm" title="添加本轮附件(不选则沿用父任务附件)" @click="pickContinueAttachment">
            附件{{ continueAttachments.length ? ` ${continueAttachments.length}` : '' }}
          </GlassButton>
          <!-- B6:客户端不具备附件能力时就地说明,避免选了附件却静默不随本轮下发 -->
          <span v-if="turnAgent?.capabilities.attachments === false" class="attach-warn">
            该客户端不支持附件，附件不会随本轮下发
          </span>
          <span v-for="a in continueAttachments" :key="a.path" class="chip attach-chip">
            <span class="chip-kind">{{ a.kind === 'image' ? '[图]' : '[文]' }}</span>
            {{ a.path.split(/[\\/]/).pop() }}
            <button class="x" title="移除附件" @click="removeContinueAttachment(a.path)">×</button>
          </span>
        </div>

        <!-- 排队反馈(R09②):setTurnNote 写入后在此渲染,8 秒自灭 -->
        <div v-if="turnNote" class="turn-note">{{ turnNote }}</div>

        <!-- 现代化操作胶囊条: 一体化模型选择器与思考强度分段控制 -->
        <div class="bottom-action-bar">
          <div class="pills-group" :class="{ overridden: hasTurnOverrides }">
            <span class="pill-chip agent-chip" :title="`当前对话客户端: ${agentLabel}`">
              🤖 {{ agentLabel }}
            </span>
            <!-- 现代化一体式模型选择器:单胶囊呼出搜索面板，渠道模型不再割裂;
                 S-03:顶部哨兵「跟随父任务（当前X）」可直接清除本轮模型覆盖(不再制造伪覆盖);
                 S-07:trigger title 明示未覆盖时沿用的父任务模型与档位 -->
            <ModelSelector
              :channel-groups="turnChannelGroups"
              :current-channel-id="turnChannelId"
              :current-model-id="turnModelId"
              :disabled="turnModelLocked"
              :disabled-hint="turnModelDisabledHint"
              :trigger-title="turnFollowHint"
              :follow-slot="{ label: turnFollowLabel, hint: turnFollowHint }"
              @select="({ channelId, modelId: mId }) => {
                turnChannelId = channelId
                turnModelId = mId
              }"
            />
            <GlassSelect
              v-model="turnMode"
              class="pill-select mode-pill"
              title="本轮模式,缺省跟随父任务"
              :options="turnModeOptions"
            />
            <!-- 现代化思考强度分段控制胶囊:支持时展示，不支持时自然隐藏;
                 S-02:续聊哨兵「跟随父任务（当前X档）」+ 沿用父任务档位说明 -->
            <ReasoningEffortPicker
              v-model="turnEffort"
              :supported="effortSupported"
              :sentinel-label="turnEffortSentinelLabel"
              :sentinel-hint="turnEffortSentinelHint"
            />
            <div class="skills-pill" :class="{ overridden: turnSkills !== null }">
              <SkillSelector
                compact
                :deny-supported="turnAgent ? !['codex', 'qoder', 'trae'].includes(turnAgent.id) : true"
              />
              <span v-if="turnSkills !== null" class="ov-tag">技能定制</span>
            </div>
            <GlassButton
              v-if="hasTurnOverrides"
              variant="ghost"
              size="sm"
              title="恢复跟随父任务配置"
              @click="resetTurnOverrides"
            >
              还原默认
            </GlassButton>
          </div>

          <!-- 精简高质感用量指示徽标，不再挤占巨大面板 -->
          <div v-if="latestUsage" class="usage-mini-badge num" :title="`输入: ${formatTokens(latestUsage.inputTokens)} | 缓存: ${formatTokens(latestUsage.cachedTokens)} | 输出: ${formatTokens(latestUsage.outputTokens)}`">
            <template v-if="billingType === 'credits'">
              <span>{{ latestUsage.credits ?? '0' }} 点</span>
            </template>
            <template v-else>
              <span>{{ formatTokens(latestTotalTokens) }} tok</span>
            </template>
            <span v-if="latestUsage.cacheHitRate" class="cache-rate">缓存 {{ latestUsage.cacheHitRate }}%</span>
          </div>
        </div>

        <div v-if="sendError" class="send-err">{{ sendError }}</div>
      </footer>
    </template>

    <!-- 未选中任何任务: 呈现 Agent 智能引导中心 + 常驻底部发布工作台(内容独立滚动,发布框不滚出视野) -->
    <div v-else class="guidance-view">
      <div v-if="contextAgentLabel" class="ctx-bar glass">
        正在与 <b>{{ contextAgentLabel }}</b> 对话 · 发布框已绑定该客户端
      </div>
      <div class="guidance-scroll">
        <GuidanceHub />
      </div>
      <div class="center-composer-card">
        <Composer />
      </div>
    </div>

    <!-- 破坏性操作确认层(R13):清空排队 / 打断并立即发送,Esc 取消、Enter 确认 -->
    <GlassModal :open="confirmState !== null" :title="confirmView.title" width="420px" @close="cancelConfirm">
      <p class="confirm-body">{{ confirmView.body }}</p>
      <template #footer>
        <GlassButton variant="ghost" size="sm" @click="cancelConfirm">取消</GlassButton>
        <GlassButton variant="danger" size="sm" @click="acceptConfirm">{{ confirmView.okLabel }}</GlassButton>
      </template>
    </GlassModal>
  </section>
</template>

<style scoped>
.session {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding: 12px 14px;
  position: relative;
  /* R12:容器查询基准 + 横向溢出守卫(长路径/窄列一律内部收缩,不撑破面板) */
  container-type: inline-size;
  overflow: hidden;
}

/* R12⑥:空态 = 提示条(不滚)+ 引导内容(独立滚动)+ 发布框(常驻底部不滚出视野) */
.guidance-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.guidance-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* 会话区语境提示条(P0-1):轻量单行,不抢引导中心视觉 */
.ctx-bar {
  flex: none;
  margin-bottom: 10px;
  padding: 7px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--muted);
}

.ctx-bar b {
  color: var(--accent-strong);
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap; /* R12①:窄容器允许换行,头部按钮不压详情栏 */
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 6px;
}

.head-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.who {
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
  min-width: 0;
}

/* 主行单行省略:窄列不再换行挤压消息流(P0-9/F1) */
.who-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
}

/* 模型 chip 允许收缩省略,其余元素恒不收缩 */
.who-main .model-chip {
  flex: 0 1 auto;
  min-width: 0;
}

.meta-toggle {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  transition: all var(--fast) var(--ease);
}

.meta-toggle:hover {
  background: var(--glass-bg-strong);
  color: var(--text);
  border-color: var(--accent-line);
}

.meta-mask {
  /* R12:.session 已 container 化(fixed 会退化),显式改为列内 absolute:点击会话列任意处关闭弹层 */
  position: absolute;
  inset: 0;
  z-index: 40;
}

.meta-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 41;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 220px;
  max-width: 320px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  font-size: 11.5px;
  color: var(--muted);
}

.meta-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  word-break: break-all;
}

.meta-lbl {
  flex: none;
  font-size: 10.5px;
  color: var(--faint);
}

.cache-hint {
  color: var(--ok);
  font-weight: 600;
}

.agent-chip {
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
  flex: none;
}

.badge {
  font-size: 11px;
  padding: 1px 9px;
  border-radius: 999px;
  background: var(--chip-bg);
  color: var(--muted);
}

.badge.s-running {
  background: var(--accent-dim);
  color: var(--accent-strong);
  animation: breathe 1.6s ease-in-out infinite;
}

.badge.s-completed {
  background: color-mix(in srgb, var(--ok) 16%, transparent);
  color: var(--ok);
}

.badge.s-failed {
  background: color-mix(in srgb, var(--err) 16%, transparent);
  color: var(--err);
}

.s-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--chip-bg);
  color: var(--faint);
}

.title-row {
  display: flex;
  align-items: center;
}

.prompt {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}

.prompt:hover {
  color: var(--text);
}

.rename-box {
  flex: 1;
  min-width: 0;
}

.rename-input {
  background: var(--field-bg);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
  padding: 2px 6px;
  outline: none;
  /* R12②:跟随容器宽度自适应,窄列不再写死像素撑出面板 */
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* R12①:宽容器隐藏图标纯文字;≤420px 收为图标钮(title 兜底语义) */
.act-ico {
  display: none;
  font-size: 12px;
  line-height: 1;
}

@container (max-width: 520px) {
  .head-actions {
    gap: 4px;
    flex-wrap: nowrap;
  }

  .head-actions .act-lbl {
    display: none;
  }

  .head-actions .act-ico {
    display: inline;
  }
}

.stop-btn {
  animation: pulse-red 1.8s infinite;
}

@keyframes pulse-red {
  0% { box-shadow: 0 0 0 0 rgba(224, 106, 99, 0.4); }
  70% { box-shadow: 0 0 0 6px rgba(224, 106, 99, 0); }
  100% { box-shadow: 0 0 0 0 rgba(224, 106, 99, 0); }
}

.stream {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 2px;
  /* 不设 scroll-behavior:smooth——程序化跟随必须即时到底,平滑动画反复重启即抖动(P0-9/F2) */
  outline: none;
}

/* S-22:流区可聚焦(End/Home 快捷键),聚焦态给轻描边而不抢视觉 */
.stream:focus-visible {
  border-radius: var(--radius-sm);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

.older {
  align-self: center;
}

.node {
  display: flex;
  justify-content: center;
}

.node-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
  background: var(--glass-bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 11px;
}

.node-chip.soft {
  color: var(--faint);
}

.t {
  color: var(--faint);
  font-size: 10px;
}

.row {
  display: flex;
  padding-right: 12%;
}

.row.mine {
  justify-content: flex-end;
  padding-right: 0;
  padding-left: 12%;
}

/* R12④:容器 ≤420px(R01 最小会话流 ≈360px 仍可触发)降为固定小值 */
@container (max-width: 420px) {
  .row {
    padding-right: 12px;
  }

  .row.mine {
    padding-left: 12px;
  }
}

.bubble {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--glass-bg);
  border: 1px solid var(--line);
  max-width: 100%;
}

.bubble.user-prompt {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}

.bubble-header {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-strong);
  text-transform: uppercase;
}

.bubble.msg {
  background: var(--glass-bg-strong);
}

.bubble.msg.err {
  border-color: color-mix(in srgb, var(--err) 40%, transparent);
  color: var(--err);
}

.bubble.warn {
  border-color: color-mix(in srgb, var(--warn) 40%, transparent);
  color: var(--warn);
}

.msg-content {
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble.file {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  /* R12③:窄列不再被长路径撑出横向滚动,全路径看 title */
  min-width: 0;
  max-width: 100%;
}

.mono-path {
  font-family: var(--mono);
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bubble.file.clickable {
  cursor: pointer;
  transition: all var(--fast) var(--ease);
}

.bubble.file.clickable:hover {
  background: var(--glass-bg-strong);
  border-color: var(--accent-line);
  transform: translateY(-1px);
}

.failure-alert-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--err) 40%, transparent);
  background: color-mix(in srgb, var(--err) 8%, var(--glass-bg));
  margin-top: 8px;
}

.fail-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.fail-badge {
  font-size: 11px;
  font-weight: 700;
  color: var(--err);
  background: color-mix(in srgb, var(--err) 15%, transparent);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}

.fail-msg {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.kind-tag.artifact {
  color: var(--accent-strong);
  font-weight: 600;
}

.change.added { color: var(--ok); }
.change.modified { color: var(--warn); }
.change.deleted { color: var(--err); }

.suggestions-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  background: var(--field-bg);
  border: 1px dashed var(--line-strong);
  margin-top: 8px;
}

.sug-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--faint);
}

.sug-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.sug-btn {
  background: var(--chip-bg);
  border: 1px solid var(--line);
  color: var(--muted);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
  transition: all var(--fast) var(--ease);
}

.sug-btn:hover {
  background: var(--glass-bg-strong);
  color: var(--text);
  border-color: var(--accent-line);
}

.composer-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.skills-wrapper {
  padding: 0 4px;
}

.input-wrapper {
  position: relative;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.send-err {
  font-size: 11px;
  color: var(--err);
  margin-top: 4px;
}

@keyframes breathe {
  50% { opacity: 0.55; }
}

/* 进度节点样式：转圈 + 百分比 + 进度条 (参考 AgentHub mpd-spin / mem-progress) */
.prog-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.prog-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.node-spin {
  width: 11px;
  height: 11px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--accent-line);
  border-top-color: var(--accent-strong);
  animation: nodeSpin 0.85s linear infinite;
}

@keyframes nodeSpin {
  to { transform: rotate(360deg); }
}

.prog-pct {
  font-weight: 600;
  color: var(--accent-strong);
  font-family: var(--mono);
}

.prog-track {
  width: 220px;
  max-width: 80%;
  height: 5px;
  border-radius: 999px;
  background: var(--field-bg);
  border: 1px solid var(--line);
  overflow: hidden;
}

.prog-track > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent-strong), var(--accent));
  transition: width var(--fast) var(--ease);
}

/* 运行态指示条 */
.running-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  margin-top: 6px;
  animation: runBarBreathe 2s ease-in-out infinite;
}

@keyframes runBarBreathe {
  0%, 100% { opacity: 0.92; }
  50% { opacity: 1; box-shadow: 0 0 12px var(--accent-dim); }
}

.run-spin {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 50%;
  border: 2px solid var(--accent-line);
  border-top-color: var(--accent-strong);
  animation: runSpin 0.85s linear infinite;
}

@keyframes runSpin {
  to { transform: rotate(360deg); }
}

.run-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.run-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-strong);
}

.run-time {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
}

.run-stop-btn {
  background: color-mix(in srgb, var(--err) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--err) 40%, transparent);
  color: var(--err);
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: all var(--fast) var(--ease);
}

.run-stop-btn:hover {
  background: var(--err);
  color: #fff;
}

/* 顶部 header 用量微章 */
.model-chip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--chip-bg);
  border: 1px solid var(--line);
  color: var(--muted);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.edit-hint {
  font-size: 10.5px;
  color: var(--faint);
  opacity: 0.7;
}

.edit-hint:hover {
  color: var(--accent);
  opacity: 1;
}

/* 排队反馈轻提示(R09②):setTurnNote 写入、发送区渲染、8 秒自灭 */
.turn-note {
  font-size: 11px;
  color: var(--accent-strong);
}

/* 多轮聚合分组线(R11):「第 N 轮 · 模型 · 状态」 */
.turn-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 2px;
}

.turn-divider-line {
  flex: 1;
  height: 1px;
  background: var(--line);
}

.turn-divider-chip {
  flex: none;
  font-size: 10.5px;
  color: var(--faint);
  background: var(--glass-bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 10px;
}

/* Agent 气泡名称标识(R16):与用户指令 header 同构,绿色圆点区分对话方向 */
.agent-name {
  color: var(--ok);
  text-transform: none;
}

.agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
  display: inline-block;
  flex: none;
}

/* 回到最新(R15):sticky 悬浮于流区右下,贴底随 v-if 移除 */
.jump-latest {
  position: sticky;
  bottom: 10px;
  align-self: flex-end;
  z-index: 6;
  margin: 6px 6px 0 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--accent-strong);
  background: var(--glass-bg-strong);
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  padding: 5px 12px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  transition: all var(--fast) var(--ease);
}

.jump-latest:hover {
  background: var(--accent-dim);
}

/* S-20:未读态用实心强调色,与「回到最新」的普通态区分 */
.jump-latest.unread {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
  animation: breathe 1.6s ease-in-out infinite;
}

/* S-18:agent 频道 Markdown 正文占满气泡宽度 */
.msg-markdown {
  font-size: 13px;
}

/* S-06:续聊附件行:按钮 + 附件芯片同行折行 */
.continue-attach-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

/* B6:客户端不支持附件时的就地轻提示(与发布框能力提示同色) */
.attach-warn {
  font-size: 11px;
  color: var(--warn);
  min-width: 0;
}

.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-edge);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.attach-chip .chip-kind {
  color: var(--faint);
  flex: none;
}

.attach-chip .x {
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--muted);
  cursor: pointer;
  flex: none;
}

.bottom-action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 0 2px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.pills-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
  max-width: 100%;
}

.pill-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: var(--glass-bg);
  border: 1px solid var(--accent-line);
  color: var(--accent-strong);
  white-space: nowrap;
}

.pill-select {
  min-width: 100px;
}

.model-pill {
  max-width: 220px;
}

/* 续聊渠道选择器 */
.channel-pill {
  min-width: 90px;
  max-width: 140px;
}

.effort-pill {
  min-width: 90px;
  max-width: 140px;
}

/* 本轮模式下拉 */
.mode-pill {
  min-width: 90px;
  max-width: 140px;
}

/* G3-05:覆盖态胶囊组——描边高亮 + 「已覆盖」角标持续可见,R10 跨会话沿用不再无感 */
.pills-group.overridden {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

.ov-indicator {
  font-size: 10.5px;
  color: var(--accent-strong);
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
}

/* G3-04:技能被本轮覆盖时以同款高亮标出 */
.skills-pill.overridden {
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-sm);
  box-shadow: 0 0 0 2px var(--accent-dim);
  padding: 1px 3px;
}

.ov-tag {
  font-size: 10px;
  color: var(--accent-strong);
  white-space: nowrap;
}

/* G3-15:单渠道只读渠道徽标(与发布框 .channel-badge 同款) */
.channel-badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  color: var(--faint);
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  white-space: nowrap;
  cursor: help;
}

/* G3-11:进度摘要组芯片可点击(button 承载 node-chip 外观) */
.prog-group-chip {
  cursor: pointer;
  font-family: inherit;
  transition: all var(--fast) var(--ease);
}

.prog-group-chip:hover {
  background: var(--glass-bg-strong);
  border-color: var(--accent-line);
  color: var(--muted);
}

.skills-pill {
  flex-shrink: 0;
}

.usage-mini-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  background: var(--glass-bg);
  border: 1px solid var(--line);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  margin-left: auto;
  flex-shrink: 0;
}

.usage-mini-badge .cache-rate {
  color: var(--ok);
  font-weight: 600;
}

.center-composer-card {
  margin-top: 12px;
  /* R12⑥:发布框常驻底部,引导内容在独立滚动区内滚动 */
  flex: none;
}

/* R13:应用内确认层正文 */
.confirm-body {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text);
}

/* 流内排队追问样式(S-05:队列唯一 UI,组级行 + 逐条完整操作) */
.queue-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.queue-group-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.queue-group-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--accent-strong);
}

.queue-group-hint {
  font-size: 11px;
  color: var(--muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-group-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

@container (max-width: 420px) {
  /* R12:窄列隐藏提示语,防折行推高挤压消息流(与旧悬浮条同口径) */
  .queue-group-hint {
    display: none;
  }
}

.queue-bubble-row {
  margin-top: 0;
}

.queue-bubble {
  border: 1px dashed var(--accent-line);
  background: var(--surface-dim);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 85%;
}

.queue-text {
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: pointer;
}

.queue-text:hover {
  color: var(--accent-strong);
}

.queue-edit-input {
  width: 100%;
  min-height: 56px;
  resize: vertical;
  background: var(--field-bg);
  border: 1px solid var(--accent);
  border-radius: 4px;
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
  line-height: 1.5;
  padding: 3px 7px;
  outline: none;
  box-sizing: border-box;
}

.queue-status-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-strong);
}

.queue-spin {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--accent-line);
  border-top-color: var(--accent-strong);
  animation: probeSpin 0.8s linear infinite;
}

@keyframes probeSpin {
  to { transform: rotate(360deg); }
}

.queue-quick-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--line);
}

.q-btn {
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 4px;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  color: var(--muted);
  font-family: inherit;
  transition: all 120ms;
}

.q-btn:hover {
  background: var(--surface);
  color: var(--text);
  border-color: var(--accent-line);
}

.q-btn.editing {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

.q-btn.primary {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

.q-btn.danger {
  color: var(--err);
}

.q-btn.danger:hover {
  border-color: var(--err);
}
</style>
