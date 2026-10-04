<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import SkillSelector from './SkillSelector.vue'
import FollowupQueueBar from './FollowupQueueBar.vue'
import GuidanceHub from './GuidanceHub.vue'
import SlashCommandPopup, { type SlashCommand } from './SlashCommandPopup.vue'
import { STATE_TEXT, formatModelDisplay, formatTokens, getAgentBillingType } from '../labels'
import type { ReasoningEffort, ScenarioTemplate, StoredEvent } from '@agent-drove/shared'

const store = useAppStore()
const events = ref<StoredEvent[]>([])
const continueText = ref('')
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

// —— 本轮参数芯片(P0-6/C4):仅对下一次发送生效,发送后复位为"沿用上一轮" ——
/** 思考档位通用四档文案(契约 ReasoningEffort);选项即白名单,发送时按值断言 */
const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]
const turnPanelOpen = ref(false)
const turnModelId = ref('')
const turnEffort = ref('')
const turnNote = ref('')
let turnNoteTimer: ReturnType<typeof setTimeout> | null = null

// 实时计时器 (参考 AgentHub MemProgressDialog)
const nowTimestamp = ref(Date.now())
let durationTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  durationTimer = setInterval(() => {
    nowTimestamp.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (durationTimer) clearInterval(durationTimer)
  if (turnNoteTimer) clearTimeout(turnNoteTimer)
  if (scrollRafId) cancelAnimationFrame(scrollRafId)
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

const task = computed(() => store.tasks.value.find((t) => t.id === store.selectedTaskId.value) ?? null)
const agentLabel = computed(
  () => store.agents.value.find((a) => a.id === task.value?.agentId)?.label ?? task.value?.agentId ?? '',
)
/** 会话区语境提示(P0-1):当前对话上下文的客户端展示名;空串=未绑定,不渲染提示条 */
const contextAgentLabel = computed(
  () => store.agents.value.find((a) => a.id === store.agentContext.value)?.label ?? '',
)
const displayModel = computed(() =>
  task.value ? formatModelDisplay(task.value.modelId, task.value.agentId, store.agents.value) : '',
)

/** 计费计量模式: 'credits' (消耗点数) 还是 'tokens' (消耗 Token) 严禁混淆 */
const billingType = computed(() => getAgentBillingType(task.value?.agentId, store.agents.value))

// —— 本轮参数候选与能力门控(P0-6/P0-4) ——
const turnAgent = computed(() => store.agents.value.find((a) => a.id === task.value?.agentId) ?? null)
const turnModelOptions = computed(() => [
  { value: '', label: '沿用上一轮' },
  ...(turnAgent.value?.models ?? []).map((m) => ({ value: m.id, label: m.label || m.id })),
])
/** capabilities.reasoningEffort=false/缺省 = 该客户端不支持思考档位,隐藏下拉并说明原因 */
const effortSupported = computed(() => turnAgent.value?.capabilities?.reasoningEffort === true)
const turnEffortOptions = computed(() => [
  { value: '', label: '沿用上一轮' },
  ...EFFORT_OPTIONS,
])
const hasTurnOverrides = computed(() => Boolean(turnModelId.value || turnEffort.value))
const turnSummaryText = computed(() => {
  const parts: string[] = []
  if (turnModelId.value) {
    parts.push(`模型 ${turnModelOptions.value.find((o) => o.value === turnModelId.value)?.label ?? turnModelId.value}`)
  }
  if (turnEffort.value) {
    parts.push(`${EFFORT_OPTIONS.find((o) => o.value === turnEffort.value)?.label ?? turnEffort.value}档思考`)
  }
  return parts.join(' · ')
})

function resetTurnOverrides(): void {
  turnModelId.value = ''
  turnEffort.value = ''
  turnPanelOpen.value = false
}

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

const maxSeq = computed(() => (events.value.length > 0 ? events.value[events.value.length - 1]!.seq : 0))
const atBottom = ref(true)

const isRunning = computed(() => task.value?.state === 'running' || task.value?.state === 'queued')

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

watch(
  () => store.selectedTaskId.value,
  (id) => {
    events.value = []
    continueText.value = ''
    sendError.value = ''
    isRenaming.value = false
    showSlashPopup.value = false
    showMeta.value = false
    resetTurnOverrides()
    setTurnNote('')
    if (id) {
      void loadInitial(id)
      void store.refreshFollowups(id)
    }
  },
  { immediate: true },
)

// 事件批推到达
watch(
  () => store.liveEvents.value,
  (map) => {
    const id = store.selectedTaskId.value
    if (!id) return
    const incoming = map.get(id) ?? []
    const fresh = incoming.filter((e) => e.seq > maxSeq.value)
    if (fresh.length === 0) return
    events.value = [...events.value, ...fresh]
    void nextTick(() => scrollBottom(false))
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

function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
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

function applySlashCommand(cmd: SlashCommand): void {
  continueText.value = cmd.template
  showSlashPopup.value = false
}

async function sendContinue(): Promise<void> {
  const text = continueText.value.trim()
  if (!text || !task.value || sending.value) return
  sending.value = true
  sendError.value = ''
  try {
    // 统一走 tasksContinue(P0-6/C4):queueIfRunning=true 运行中自动排队不报错,
    // 本轮覆盖参数随 ContinueOptions 传给 core——排队时随队列项落 JSON,接续时生效。
    const res = await window.api.tasksContinue(task.value.id, text, {
      skills: [...store.activeSkills.value],
      queueIfRunning: true,
      // 档位取值来自选项白名单,按契约类型断言;空串=沿用上一轮,不下发
      ...(turnModelId.value ? { modelId: turnModelId.value } : {}),
      ...(turnEffort.value ? { reasoningEffort: turnEffort.value as ReasoningEffort } : {}),
    })
    continueText.value = ''
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
// 契约新通道为可选成员(preload/mock 落地后转必需),此处一律可选链调用。

async function onQueueEdit(followupId: string, prompt: string): Promise<void> {
  if (!task.value) return
  try {
    await window.api.tasksUpdateFollowup?.(task.value.id, followupId, prompt)
    await store.refreshFollowups(task.value.id)
  } catch (error) {
    sendError.value = `编辑排队消息失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function onQueuePromote(followupId: string): Promise<void> {
  if (!task.value) return
  try {
    // 契约语义:beforeFollowupId=队首项 id → 插到队首之前,即成为新队首
    const firstId = store.activeFollowups.value[0]?.id ?? null
    await window.api.tasksReorderFollowup?.(task.value.id, followupId, firstId)
    await store.refreshFollowups(task.value.id)
  } catch (error) {
    sendError.value = `提前发送失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function onQueueInterrupt(followupId: string): Promise<void> {
  const current = task.value
  if (!current) return
  const item = store.activeFollowups.value.find((f) => f.id === followupId)
  if (!item) return
  // 破坏性操作二次确认:文案必须明示"将终止当前执行"(P0-6 验收标准);
  // 剩余排队项将迁移到新任务自动接续,不再悬挂在已取消的父任务上(P0-6 复审)
  const confirmed = window.confirm(
    '打断当前轮并立即发送该条排队消息?\n\n将终止当前执行;该条立即发送,其余排队消息将随新任务自动接续。',
  )
  if (!confirmed) return
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
    await window.api.tasksRemoveFollowup?.(current.id, followupId)
    await store.refreshTasks()
    if ('state' in res) {
      // 4. 剩余排队项迁移到新任务:被打断的父任务已终态,不会再消费队列
      const migrated = (await window.api.tasksMigrateFollowups?.(current.id, res.id)) ?? 0
      store.selectedTaskId.value = res.id
      if (migrated > 0) store.showToast(`其余 ${migrated} 条排队消息已随新任务自动接续`)
    } else {
      await store.refreshFollowups(current.id)
    }
  } catch (error) {
    sendError.value = `打断发送失败: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function stopCurrentTask(): Promise<void> {
  if (!task.value) return
  try {
    await store.stopTask(task.value.id)
  } catch (error) {
    sendError.value = `终止失败: ${error instanceof Error ? error.message : String(error)}`
  }
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

function timeOf(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
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
              type="button"
              class="meta-toggle"
              title="更多会话信息(#id / 技能 / 用量)"
              @click.stop="showMeta = !showMeta"
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
          <!-- 运行中显示醒目的终止按钮 -->
          <GlassButton
            v-if="isRunning"
            variant="danger"
            size="sm"
            class="stop-btn"
            title="立即终止当前 Agent 任务执行"
            @click="stopCurrentTask"
          >
            终止
          </GlassButton>

          <GlassButton
            variant="ghost"
            size="sm"
            title="打开当前工作区目录"
            @click="openWorkspace"
          >
            工作区
          </GlassButton>

          <GlassButton
            variant="ghost"
            size="sm"
            title="点击弹窗查看完整任务详情与操作"
            @click="store.openDetailModal()"
          >
            详情
          </GlassButton>

          <GlassButton
            variant="ghost"
            size="sm"
            :title="store.detailCollapsed.value ? '展开详情侧栏' : '锁起详情侧栏'"
            @click="store.toggleDetailCollapsed()"
          >
            {{ store.detailCollapsed.value ? '展开详情' : '折叠详情' }}
          </GlassButton>
        </div>
      </header>

      <!-- 元数据弹层透明遮罩:点击任意处关闭 -->
      <div v-if="showMeta" class="meta-mask" @click="showMeta = false" />

      <!-- 排队追问提示悬浮条 -->
      <FollowupQueueBar
        :task-id="task.id"
        :task-running="isRunning"
        :followups="store.activeFollowups.value"
        @remove="store.removeFollowup(task.id, $event)"
        @clear="store.clearFollowups(task.id)"
        @edit="onQueueEdit"
        @promote="onQueuePromote"
        @interrupt="onQueueInterrupt"
      />

      <div ref="scrollEl" class="stream" @scroll="onScroll">
        <GlassButton
          v-if="events.length > 0 && events[0]!.seq > 1"
          variant="ghost"
          size="sm"
          class="older"
          @click="loadOlder"
        >
          {{ loadingOlder ? '加载中…' : '加载更早' }}
        </GlassButton>

        <!-- 首轮提问气泡展示 -->
        <div class="row mine">
          <div class="bubble user-prompt">
            <span class="bubble-header">用户指令</span>
            <div class="text">{{ task.prompt }}</div>
            <span class="num t">{{ timeOf(task.createdAt) }}</span>
          </div>
        </div>

        <template v-for="event in events" :key="event.seq">
          <div v-if="event.event.kind === 'state-changed'" class="node">
            <span class="node-chip">
              {{ STATE_TEXT[event.event.from] }} → {{ STATE_TEXT[event.event.to] }}
              <span class="num t">{{ timeOf(event.at) }}</span>
            </span>
          </div>

          <div v-else-if="event.event.kind === 'progress'" class="node prog-node">
            <div class="node-chip soft prog-chip">
              <span class="node-spin" aria-hidden="true" />
              <span class="prog-text">{{ parseProgress(event.event.text).displayText }}</span>
              <span v-if="parseProgress(event.event.text).percent !== undefined" class="prog-pct num">
                {{ parseProgress(event.event.text).percent }}%
              </span>
              <span class="num t">{{ timeOf(event.at) }}</span>
            </div>
            <div v-if="parseProgress(event.event.text).percent !== undefined" class="prog-track">
              <i :style="{ width: `${parseProgress(event.event.text).percent}%` }" />
            </div>
          </div>

          <div v-else-if="event.event.kind === 'artifact'" class="row">
            <span
              class="bubble file clickable"
              title="点击在系统中定位或打开产物"
              @click="openArtifactPath(event.event.path)"
            >
              <span class="kind-tag artifact">产物</span>
              <span class="mono-path">{{ event.event.path }}</span>
              <span class="change" :class="event.event.change">{{ event.event.change }}</span>
            </span>
          </div>

          <div v-else-if="event.event.kind === 'warning'" class="row">
            <span class="bubble warn">
              <span class="text">{{ event.event.text }}</span>
              <span class="num t">{{ timeOf(event.at) }}</span>
            </span>
          </div>

          <!-- 系统说明节点(P0-4):实际下发参数(如思考档位)等运行期事实,中性呈现不惊扰 -->
          <div v-else-if="event.event.kind === 'info'" class="node">
            <span class="node-chip soft" :title="event.event.text">
              {{ event.event.text }}
              <span class="num t">{{ timeOf(event.at) }}</span>
            </span>
          </div>

          <div v-else-if="event.event.kind === 'message'" class="row" :class="{ mine: event.event.channel === 'agent' }">
            <div class="bubble msg" :class="{ err: event.event.channel === 'stderr' }">
              <div class="msg-content">{{ event.event.text }}</div>
              <span class="num t">{{ timeOf(event.at) }}</span>
            </div>
          </div>
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

        <!-- 任务异常失败恢复栏 (最符合人类排障心智直觉: 显示原因 + 一键重试 / 改词重发) -->
        <div v-if="task.state === 'failed'" class="failure-alert-box glass">
          <div class="fail-info">
            <span class="fail-badge">任务中断</span>
            <span class="fail-msg" :title="task.error || '执行过程中断'">
              {{ task.error || '任务执行异常终止，可能是上游模型服务超时或进程意外退出' }}
            </span>
          </div>
          <div class="fail-actions">
            <GlassButton variant="primary" size="sm" :disabled="retrying" @click="retryFailedTask">
              {{ retrying ? '重试中…' : '立即重试' }}
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
      </div>

      <footer class="composer-container">
        <!-- 技能选择器栏 -->
        <div class="skills-wrapper">
          <SkillSelector compact />
        </div>

        <!-- 本轮参数芯片(P0-6/C4):默认沿用上一轮,点开可改模型/思考档位,仅对下一次发送生效 -->
        <div class="turn-opts">
          <button
            type="button"
            class="turn-chip"
            :class="{ active: hasTurnOverrides || turnPanelOpen }"
            title="仅对下一次发送生效,缺省沿用父任务的模型与思考档位"
            @click="turnPanelOpen = !turnPanelOpen"
          >
            本轮参数{{ turnSummaryText ? ` · ${turnSummaryText}` : '' }}
          </button>
          <span v-if="turnNote" class="turn-note">{{ turnNote }}</span>
        </div>
        <div v-if="turnPanelOpen" class="turn-panel glass">
          <div class="turn-field">
            <span class="turn-lbl">模型</span>
            <GlassSelect v-model="turnModelId" :options="turnModelOptions" />
          </div>
          <div v-if="effortSupported" class="turn-field">
            <span class="turn-lbl">思考</span>
            <GlassSelect v-model="turnEffort" :options="turnEffortOptions" />
          </div>
          <span v-else class="turn-hint">当前客户端不支持思考档位</span>
          <GlassButton
            variant="ghost"
            size="sm"
            :disabled="!hasTurnOverrides"
            title="清空本轮覆盖,恢复沿用上一轮参数"
            @click="resetTurnOverrides"
          >
            恢复沿用
          </GlassButton>
        </div>

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
            :send-label="isRunning ? '排队发送' : '发送'"
            :send-disabled="sending || !continueText.trim()"
            :placeholder="isRunning ? 'Agent 正在执行中，输入可直接排队追加对话 (Enter 发送)' : '继续对话: 输入指令或键入 / 选择快捷技能 (Enter 发送)'"
            @update:model-value="handleInput"
            @keydown="onContinueKeydown"
            @send="sendContinue"
          />
        </div>

        <!-- 本轮用量与消耗统计 (输入框正下方卡片) -->
        <div v-if="latestUsage" class="turn-usage-panel glass num">
          <div class="u-panel-head">
            <span class="u-panel-title">本轮用量与消耗统计</span>
            <span v-if="latestUsage.cacheHitRate !== undefined && latestUsage.cacheHitRate > 0" class="u-cache-tag">
              缓存命中 {{ latestUsage.cacheHitRate }}%
            </span>
          </div>
          <div class="u-panel-body">
            <!-- 点数 Agent: 严格展示点数, 严禁混淆 Token -->
            <template v-if="billingType === 'credits'">
              <div class="u-stat-item">
                <span class="u-stat-lbl">本轮消耗点数</span>
                <span class="u-stat-val highlight-credits">{{ latestUsage.credits ?? '0' }} 点</span>
              </div>
            </template>
            <!-- Token Agent: 严格展示 Token 细分与总计, 严禁混淆点数 -->
            <template v-else>
              <div class="u-stat-item">
                <span class="u-stat-lbl">输入</span>
                <span class="u-stat-val">{{ formatTokens(latestUsage.inputTokens) }}</span>
              </div>
              <div class="u-stat-item">
                <span class="u-stat-lbl">缓存读取</span>
                <span class="u-stat-val highlight-cache">{{ formatTokens(latestUsage.cachedTokens) }}</span>
              </div>
              <div class="u-stat-item">
                <span class="u-stat-lbl">输出</span>
                <span class="u-stat-val">{{ formatTokens(latestUsage.outputTokens) }}</span>
              </div>
              <div class="u-stat-item">
                <span class="u-stat-lbl">总计消耗</span>
                <span class="u-stat-val highlight-total">{{ formatTokens(latestTotalTokens) }} Token</span>
              </div>
            </template>
          </div>
        </div>

        <div v-if="sendError" class="send-err">{{ sendError }}</div>
      </footer>
    </template>

    <!-- 未选中任何任务: 呈现 Agent 智能引导中心 -->
    <div v-else class="guidance-view">
      <!-- 会话区语境提示(P0-1):发布框已绑定的当前对话对象,轻量单行 -->
      <div v-if="contextAgentLabel" class="ctx-bar glass">
        正在与 <b>{{ contextAgentLabel }}</b> 对话 · 发布框已绑定该客户端
      </div>
      <GuidanceHub @select-scenario="onScenarioSelected" />
    </div>
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
}

.guidance-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
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
  position: fixed;
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
  color: #10b981;
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

.edit-icon {
  font-size: 11px;
  color: var(--faint);
  opacity: 0.6;
}

.rename-input {
  background: var(--field-bg);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
  padding: 2px 6px;
  outline: none;
  width: 280px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
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

.mono-path {
  font-family: var(--mono);
  color: var(--text);
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
}

.skills-wrapper {
  padding: 0 4px;
}

.input-wrapper {
  position: relative;
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

/* 本轮参数芯片行(P0-6):轻量不抢输入框视觉 */
.turn-opts {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 4px;
}

.turn-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--chip-bg);
  border: 1px solid var(--line);
  color: var(--muted);
  cursor: pointer;
  user-select: none;
  transition: all var(--fast) var(--ease);
}

.turn-chip:hover {
  border-color: var(--accent-line);
  color: var(--text);
}

.turn-chip.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
}

.turn-note {
  font-size: 11px;
  color: var(--accent-strong);
}

.turn-panel {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
}

.turn-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.turn-lbl {
  color: var(--muted);
}

.turn-hint {
  color: var(--faint);
}

/* 输入框下方本轮用量与消耗统计面板 */
.turn-usage-panel {
  margin-top: 8px;
  padding: 8px 12px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-sm);
  box-shadow: inset 0 1px 0 var(--glass-specular);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.u-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.u-panel-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
}

.u-cache-tag {
  font-size: 10.5px;
  font-weight: 600;
  color: #10b981;
  background: color-mix(in srgb, #10b981 12%, transparent);
  border: 1px solid color-mix(in srgb, #10b981 30%, transparent);
  padding: 1px 6px;
  border-radius: 4px;
}

.u-panel-body {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.u-stat-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
}

.u-stat-lbl {
  color: var(--muted);
  font-size: 11px;
}

.u-stat-val {
  font-weight: 600;
  color: var(--text);
}

.u-stat-val.highlight-credits {
  color: var(--accent-strong);
}

.u-stat-val.highlight-cache {
  color: #10b981;
}

.u-stat-val.highlight-total {
  color: var(--accent-strong);
}
</style>
