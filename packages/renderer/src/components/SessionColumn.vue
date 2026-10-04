<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import SkillSelector from './SkillSelector.vue'
import FollowupQueueBar from './FollowupQueueBar.vue'
import GuidanceHub from './GuidanceHub.vue'
import SlashCommandPopup, { type SlashCommand } from './SlashCommandPopup.vue'
import { STATE_TEXT } from '../labels'
import type { ScenarioTemplate, StoredEvent } from '@agent-drove/shared'

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

const maxSeq = computed(() => (events.value.length > 0 ? events.value[events.value.length - 1]!.seq : 0))
const atBottom = ref(true)

const isRunning = computed(() => task.value?.state === 'running' || task.value?.state === 'queued')

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const totalSessionTokens = computed(() => {
  if (!task.value?.usage) return 0
  return (
    (task.value.usage.inputTokens || 0) +
    (task.value.usage.outputTokens || 0) +
    (task.value.usage.cachedTokens || 0)
  )
})

// 下一步智能推荐动作
const nextStepSuggestions = [
  { label: '🧪 运行自动化测试验证', prompt: '请运行测试套件验证本次修改，确保全部用例通过且无回归隐患。' },
  { label: '🔍 审查潜在风险与改进点', prompt: '请对刚刚的代码修改进行质量与安全性审查，指出潜在风险或可优化点。' },
  { label: '📝 生成变更说明与文档', prompt: '请对本次修改的内容进行结构化总结，输出清晰的变更日志与说明。' },
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
    void nextTick(() => {
      if (atBottom.value) scrollBottom(true)
    })
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

function scrollBottom(force: boolean): void {
  const el = scrollEl.value
  if (!el) return
  if (force || atBottom.value) {
    el.scrollTop = el.scrollHeight
    atBottom.value = true
  }
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
    const skills = [...store.activeSkills.value]
    if (isRunning.value) {
      // 运行中自动走排队队列,不报错!
      await window.api.tasksEnqueueFollowup(task.value.id, text, skills)
      continueText.value = ''
      showSlashPopup.value = false
      await store.refreshFollowups(task.value.id)
    } else {
      const res = await window.api.tasksContinue(task.value.id, text, {
        skills,
        queueIfRunning: true,
      })
      continueText.value = ''
      showSlashPopup.value = false
      await store.refreshTasks()
      if ('id' in res) {
        store.selectedTaskId.value = res.id
      }
    }
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : String(error)
  } finally {
    sending.value = false
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

function startRename(): void {
  if (!task.value) return
  renameInput.value = task.value.title ?? task.value.prompt
  isRenaming.value = true
}

async function commitRename(): Promise<void> {
  if (!task.value || !renameInput.value.trim()) {
    isRenaming.value = false
    return
  }
  await store.renameTask(task.value.id, renameInput.value.trim())
  isRenaming.value = false
}

function onScenarioSelected(scenario: ScenarioTemplate): void {
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
          <div class="who">
            <span class="agent-chip">{{ agentLabel }}</span>
            <span class="badge" :class="`s-${task.state}`">{{ STATE_TEXT[task.state] }}</span>
            <span class="task-id num" :title="task.id">#{{ task.id.slice(0, 8) }}</span>

            <!-- 激活技能小微章 -->
            <div v-if="task.skills && task.skills.length > 0" class="skills-badges">
              <span v-for="s in task.skills" :key="s" class="s-tag">{{ s }}</span>
            </div>

            <!-- 对话消耗指标小徽章 -->
            <div v-if="task.usage" class="session-usage-badge num">
              <span class="u-badge-item" title="对话消耗点数">💎 {{ task.usage.credits }} 点</span>
              <span class="u-badge-item" title="总消耗 Tokens">🔤 {{ formatTokens(totalSessionTokens) }}</span>
              <span v-if="task.usage.cacheHitRate" class="u-badge-item cache" title="Prompt 缓存命中率">
                ⚡ 缓存 {{ task.usage.cacheHitRate }}%
              </span>
            </div>
          </div>

          <div class="title-row">
            <div v-if="isRenaming" class="rename-box">
              <input
                v-model="renameInput"
                class="rename-input"
                autofocus
                @keydown.enter="commitRename"
                @keydown.esc="isRenaming = false"
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
              <span class="edit-icon" title="点击重命名对话">✎</span>
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
            ■ 终止
          </GlassButton>

          <GlassButton
            variant="ghost"
            size="sm"
            title="打开当前工作区目录"
            @click="openWorkspace"
          >
            📁 目录
          </GlassButton>

          <GlassButton
            variant="ghost"
            size="sm"
            title="点击弹窗查看完整任务详情与操作"
            @click="store.openDetailModal()"
          >
            📋 详情
          </GlassButton>

          <GlassButton
            variant="ghost"
            size="sm"
            :title="store.detailCollapsed.value ? '展开详情侧栏' : '锁起详情侧栏'"
            @click="store.toggleDetailCollapsed()"
          >
            {{ store.detailCollapsed.value ? '◨ 展开' : '🔒 锁起' }}
          </GlassButton>
        </div>
      </header>

      <!-- 排队追问提示悬浮条 -->
      <FollowupQueueBar
        :task-id="task.id"
        :followups="store.activeFollowups.value"
        @remove="store.removeFollowup(task.id, $event)"
        @clear="store.clearFollowups(task.id)"
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

          <div v-else-if="event.event.kind === 'usage'" class="node usage-node">
            <div class="usage-card glass">
              <div class="usage-card-head">
                <span class="usage-title">📊 本轮用量与消耗统计</span>
                <span v-if="event.event.cacheHitRate !== undefined" class="usage-cache-badge">
                  ⚡ 缓存命中 {{ event.event.cacheHitRate }}%
                </span>
              </div>
              <div class="usage-grid num">
                <div class="u-cell">
                  <span class="u-label">输入 Tokens</span>
                  <span class="u-val">{{ (event.event.inputTokens ?? 0).toLocaleString() }}</span>
                </div>
                <div class="u-cell">
                  <span class="u-label">缓存读取 Tokens</span>
                  <span class="u-val highlight">{{ (event.event.cachedTokens ?? 0).toLocaleString() }}</span>
                </div>
                <div class="u-cell">
                  <span class="u-label">输出 Tokens</span>
                  <span class="u-val">{{ (event.event.outputTokens ?? 0).toLocaleString() }}</span>
                </div>
                <div class="u-cell">
                  <span class="u-label">消耗点数</span>
                  <span class="u-val credits">💎 {{ event.event.credits ?? '0' }} 点</span>
                </div>
              </div>
              <div v-if="event.event.cacheHitRate !== undefined" class="usage-cache-bar">
                <div class="bar-track">
                  <div class="bar-fill" :style="{ width: `${event.event.cacheHitRate}%` }" />
                </div>
                <span class="bar-text">Prompt Cache 缓存读取有效降低了计费与推理等待</span>
              </div>
            </div>
          </div>

          <div v-else-if="event.event.kind === 'artifact'" class="row">
            <span class="bubble file">
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
          <button type="button" class="run-stop-btn" title="终止当前任务" @click="stopCurrentTask">
            终止
          </button>
        </div>

        <!-- 任务完成后的下一步动作建议 -->
        <div v-if="task.state === 'completed'" class="suggestions-box">
          <span class="sug-title">💡 下一步建议：</span>
          <div class="sug-list">
            <button
              v-for="s in nextStepSuggestions"
              :key="s.label"
              type="button"
              class="sug-btn"
              @click="applySuggestion(s)"
            >
              {{ s.label }}
            </button>
          </div>
        </div>
      </div>

      <footer class="composer-container">
        <!-- 技能选择器栏 -->
        <div class="skills-wrapper">
          <SkillSelector compact />
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
            :send-label="isRunning ? '➕ 排队发送' : '发送'"
            :send-disabled="sending || !continueText.trim()"
            :placeholder="isRunning ? 'Agent 正在执行中，输入可直接排队追加对话 (Enter 发送)' : '继续对话: 输入指令或键入 / 选择快捷技能 (Enter 发送)'"
            @update:model-value="handleInput"
            @keydown="onContinueKeydown"
            @send="sendContinue"
          />
        </div>

        <div v-if="sendError" class="send-err">{{ sendError }}</div>
      </footer>
    </template>

    <!-- 未选中任何任务: 呈现 Agent 智能引导中心 -->
    <div v-else class="guidance-view">
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
  gap: 8px;
  flex-wrap: wrap;
}

.agent-chip {
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
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

.task-id {
  font-size: 11px;
  color: var(--faint);
}

.skills-badges {
  display: flex;
  gap: 4px;
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
  scroll-behavior: smooth;
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
.session-usage-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  font-size: 11px;
  color: var(--muted);
}

.u-badge-item.cache {
  color: #10b981;
  font-weight: 600;
}

/* 消息流内用量统计卡片 */
.usage-node {
  margin: 12px 0;
  display: flex;
  justify-content: center;
}

.usage-card {
  width: 100%;
  max-width: 480px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.usage-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
}

.usage-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.usage-cache-badge {
  font-size: 11px;
  font-weight: 700;
  color: #10b981;
  background: color-mix(in srgb, #10b981 12%, transparent);
  border: 1px solid color-mix(in srgb, #10b981 30%, transparent);
  padding: 1px 6px;
  border-radius: 4px;
}

.usage-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px 12px;
}

.u-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.u-label {
  font-size: 10.5px;
  color: var(--muted);
}

.u-val {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.u-val.highlight {
  color: #10b981;
}

.u-val.credits {
  color: var(--accent-strong);
}

.usage-cache-bar {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.usage-cache-bar .bar-track {
  height: 4px;
  background: var(--line);
  border-radius: 999px;
  overflow: hidden;
}

.usage-cache-bar .bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #10b981, #06b6d4);
  border-radius: 999px;
  transition: width 300ms var(--ease);
}

.usage-cache-bar .bar-text {
  font-size: 10px;
  color: var(--faint);
}
</style>
