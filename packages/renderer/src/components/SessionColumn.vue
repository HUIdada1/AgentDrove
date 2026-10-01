<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import type { StoredEvent } from '@agent-drove/shared'

/**
 * 中栏会话流:选中任务的全部实时内容(事件流以对话形态呈现)。
 * 分页拉旧 + 事件批推增量追加;只有用户停在底部时才自动跟随。
 */
const store = useAppStore()
const events = ref<StoredEvent[]>([])
const continueText = ref('')
const scrollEl = ref<HTMLElement | null>(null)
const loadingOlder = ref(false)
let loadId = 0

const task = computed(() => store.tasks.value.find((t) => t.id === store.selectedTaskId.value) ?? null)
const agentLabel = computed(
  () => store.agents.value.find((a) => a.id === task.value?.agentId)?.label ?? task.value?.agentId ?? '',
)

const maxSeq = computed(() => (events.value.length > 0 ? events.value[events.value.length - 1]!.seq : 0))
const atBottom = ref(true)

async function loadInitial(taskId: string): Promise<void> {
  const id = ++loadId
  const page = await window.api.tasksEventsPage({ taskId, limit: 200 })
  if (id !== loadId) return
  events.value = page
  await nextTick()
  scrollBottom(true)
}

async function loadOlder(): Promise<void> {
  if (!task.value || events.value.length === 0 || loadingOlder.value) return
  loadingOlder.value = true
  const firstSeq = events.value[0]!.seq
  const el = scrollEl.value
  const beforeHeight = el?.scrollHeight ?? 0
  const page = await window.api.tasksEventsPage({ taskId: task.value.id, beforeSeq: firstSeq, limit: 200 })
  events.value = [...page, ...events.value]
  await nextTick()
  // prepend 后补偿滚动位置,避免视觉跳动
  if (el) el.scrollTop += el.scrollHeight - beforeHeight
  loadingOlder.value = false
}

watch(
  () => store.selectedTaskId.value,
  (id) => {
    events.value = []
    continueText.value = ''
    if (id) void loadInitial(id)
  },
  { immediate: true },
)

// 事件批推到达:补进比本地最大 seq 新的部分
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
  async () => {
    if (store.selectedTaskId.value) await store.refreshAgents()
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
  if (force || atBottom.value) el.scrollTop = el.scrollHeight
}

async function sendContinue(): Promise<void> {
  const text = continueText.value.trim()
  if (!text || !task.value) return
  const next = await window.api.tasksContinue(task.value.id, text)
  continueText.value = ''
  await store.refreshTasks()
  store.selectedTaskId.value = next.id
}

function timeOf(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const STATE_TEXT: Record<string, string> = {
  queued: '排队',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  interrupted: '已中断',
}
</script>

<template>
  <section class="session glass">
    <template v-if="task">
      <header class="head">
        <div class="who">
          <span class="agent">{{ agentLabel }}</span>
          <span class="badge" :class="`s-${task.state}`">{{ STATE_TEXT[task.state] }}</span>
        </div>
        <span class="prompt" :title="task.prompt">{{ task.prompt }}</span>
      </header>

      <div ref="scrollEl" class="stream" @scroll="onScroll">
        <button v-if="events.length >= 200" class="older" @click="loadOlder">
          {{ loadingOlder ? '加载中…' : '加载更早' }}
        </button>

        <template v-for="event in events" :key="event.seq">
          <!-- 状态迁移:系统节点居中,不参与对话气泡 -->
          <div v-if="event.event.kind === 'state-changed'" class="node">
            <span class="node-chip">
              {{ STATE_TEXT[event.event.from] ?? event.event.from }} → {{ STATE_TEXT[event.event.to] ?? event.event.to }}
              <span class="num t">{{ timeOf(event.at) }}</span>
            </span>
          </div>

          <div v-else-if="event.event.kind === 'progress'" class="node">
            <span class="node-chip soft">{{ event.event.text }}<span class="num t">{{ timeOf(event.at) }}</span></span>
          </div>

          <div v-else-if="event.event.kind === 'usage'" class="node">
            <span class="node-chip soft num">
              用量 {{ event.event.inputTokens ?? '?' }} in / {{ event.event.outputTokens ?? '?' }} out
            </span>
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
            <span class="bubble msg" :class="{ err: event.event.channel === 'stderr' }">
              <span class="text">{{ event.event.text }}</span>
              <span class="num t">{{ timeOf(event.at) }}</span>
            </span>
          </div>
        </template>
      </div>

      <footer class="composer">
        <GlassInput
          v-model="continueText"
          multiline
          :rows="2"
          :placeholder="task.sessionId ? '继续对话:追加提示词(Enter 发送)' : '续聊未拿到会话 id,发送后按 -c 续接最近会话'"
          @keydown.enter.exact.prevent="sendContinue"
        />
        <GlassButton variant="primary" :disabled="!continueText.trim()" @click="sendContinue">发送</GlassButton>
      </footer>
    </template>

    <div v-else class="empty">
      <p class="big">会话流</p>
      <p class="sub">从左侧选择一个任务,这里会实时滚动它的全部对话、产物与状态变化。</p>
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
}

.head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 10px;
}

.who {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent {
  font-weight: 600;
}

.badge {
  font-size: 11px;
  padding: 1px 9px;
  border-radius: 999px;
  background: rgba(148, 174, 196, 0.12);
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

@keyframes breathe {
  50% {
    opacity: 0.55;
  }
}

.prompt {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stream {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 2px;
  scroll-behavior: smooth;
}

.older {
  align-self: center;
  font-size: 11px;
  color: var(--muted);
  background: var(--glass-bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 12px;
  cursor: pointer;
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

/* 对话气泡:玻璃面,尾部不做小箭头,靠错位与色调区分 */
.bubble {
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
  max-width: 100%;
  background: var(--glass-bg-strong);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-md);
  padding: 7px 12px;
  box-shadow: inset 0 1px 0 var(--glass-specular);
  word-break: break-word;
  white-space: pre-wrap;
}

.row.mine .bubble {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}

.bubble.err {
  border-color: color-mix(in srgb, var(--err) 35%, transparent);
}

.bubble.warn {
  border-color: color-mix(in srgb, var(--warn) 38%, transparent);
  color: var(--warn);
}

.bubble .text {
  font-size: 12.5px;
}

.kind-tag {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid var(--line);
  color: var(--muted);
  align-self: flex-start;
}

.mono-path {
  font-family: var(--mono);
  font-size: 12px;
}

.change.added {
  color: var(--ok);
}

.change.modified {
  color: var(--warn);
}

.change.deleted {
  color: var(--err);
}

.composer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.composer :deep(.g-field) {
  background: var(--glass-bg);
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  padding: 0 30px;
}

.big {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--muted);
}

.sub {
  margin: 0;
  font-size: 12px;
  color: var(--faint);
}
</style>
