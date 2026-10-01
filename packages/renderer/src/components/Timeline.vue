<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { StoredEvent } from '@agent-drove/shared'
import { useAppStore } from '../stores/app'

const props = defineProps<{ taskId: string }>()

const store = useAppStore()

// 与 tasks:events-page 的默认上限对齐,一次拉满最新一页
const PAGE_SIZE = 200
const BOTTOM_EPSILON = 40

const parentRef = ref<HTMLElement | null>(null)
const events = ref<StoredEvent[]>([])
const loadingOlder = ref(false)
const noMore = ref(false)
// 竞态哨兵:切任务后旧请求的返回一律丢弃
const loadId = ref(0)

type Kind = StoredEvent['event']['kind']
const KIND_META: Record<Kind, { label: string; cls: string }> = {
  'state-changed': { label: '状态', cls: 'k-state' },
  message: { label: '消息', cls: 'k-message' },
  artifact: { label: '产物', cls: 'k-artifact' },
  progress: { label: '进度', cls: 'k-progress' },
  usage: { label: '用量', cls: 'k-usage' },
  warning: { label: '警告', cls: 'k-warning' },
}

const virtualizer = useVirtualizer(
  computed(() => ({
    count: events.value.length,
    getScrollElement: () => parentRef.value,
    estimateSize: () => 28,
    overscan: 8,
  })),
)

const rows = computed(() =>
  virtualizer.value.getVirtualItems().map((vi) => ({ ...vi, event: events.value[vi.index]! })),
)
const totalSize = computed(() => virtualizer.value.getTotalSize())

watch(
  () => props.taskId,
  () => void load(),
  { immediate: true },
)

// 推送通道只保证增量到达,这里把比本地最大 seq 新的补进来
watch(
  () => store.liveEvents.value,
  () => mergeFromLive(),
)

async function load(): Promise<void> {
  const id = props.taskId
  loadId.value++
  const current = loadId.value
  events.value = []
  noMore.value = false
  if (!id) return
  const page = await window.api.tasksEventsPage({ taskId: id, limit: PAGE_SIZE })
  if (current !== loadId.value || id !== props.taskId) return
  events.value = page
  noMore.value = page.length < PAGE_SIZE
  mergeFromLive()
  await nextTick()
  scrollToBottom()
}

function mergeFromLive(): void {
  const incoming = store.liveEvents.value.get(props.taskId)
  if (!incoming?.length || loadingOlder.value) return
  const max = events.value.length > 0 ? events.value[events.value.length - 1]!.seq : -1
  const fresh = incoming.filter((event) => event.seq > max)
  if (fresh.length === 0) return
  const stick = isAtBottom()
  events.value = [...events.value, ...fresh]
  // 用户向上翻阅时不抢滚动,回到底部附近才跟随
  if (stick) void nextTick(scrollToBottom)
}

async function loadOlder(): Promise<void> {
  const first = events.value[0]
  if (!first || loadingOlder.value || noMore.value) return
  loadingOlder.value = true
  const current = loadId.value
  const el = parentRef.value
  const prevHeight = el?.scrollHeight ?? 0
  const prevTop = el?.scrollTop ?? 0
  const page = await window.api.tasksEventsPage({
    taskId: props.taskId,
    limit: PAGE_SIZE,
    beforeSeq: first.seq,
  })
  if (current !== loadId.value) {
    loadingOlder.value = false
    return
  }
  if (page.length < PAGE_SIZE) noMore.value = true
  if (page.length > 0) {
    events.value = [...page, ...events.value]
    await nextTick()
    // prepend 后按高度差补偿,视觉锚点不跳
    if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop
  }
  loadingOlder.value = false
}

function isAtBottom(): boolean {
  const el = parentRef.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_EPSILON
}

function scrollToBottom(): void {
  const el = parentRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function lineText(stored: StoredEvent): string {
  const event = stored.event
  switch (event.kind) {
    case 'message':
      return `[${event.channel}] ${event.text}`
    case 'artifact':
      return `${event.path} (${event.change})`
    case 'state-changed':
      return `${event.from} → ${event.to}`
    case 'usage':
      return `tokens in ${event.inputTokens ?? 0} / out ${event.outputTokens ?? 0}`
    default:
      return event.text
  }
}

function timeOf(stored: StoredEvent): string {
  const d = new Date(stored.at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
</script>

<template>
  <div class="tl">
    <div ref="parentRef" class="scroll">
      <div class="inner" :style="{ height: `${totalSize}px` }">
        <div
          v-for="row in rows"
          :key="row.key"
          class="row"
          :style="{ transform: `translateY(${row.start}px)`, height: `${row.size}px` }"
        >
          <span class="time">{{ timeOf(row.event) }}</span>
          <span class="kind" :class="KIND_META[row.event.event.kind].cls">
            {{ KIND_META[row.event.event.kind].label }}
          </span>
          <span class="text" :class="{ warn: row.event.event.kind === 'warning' }">
            {{ lineText(row.event) }}
          </span>
        </div>
      </div>
      <div v-if="events.length === 0" class="empty">暂无事件</div>
    </div>
    <div class="older">
      <button
        v-if="events.length > 0 && !noMore"
        class="ghost"
        :disabled="loadingOlder"
        @click="loadOlder"
      >
        {{ loadingOlder ? '加载中…' : '加载更早' }}
      </button>
      <span v-else-if="events.length > 0" class="hint">已到最早</span>
    </div>
  </div>
</template>

<style scoped>
.tl {
  flex: 1;
  min-height: 120px;
  display: flex;
  flex-direction: column;
}

.scroll {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg2);
  padding: 4px 10px;
}

.inner {
  position: relative;
  width: 100%;
}

.row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.time {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  flex-shrink: 0;
}

.kind {
  font-size: 10px;
  line-height: 16px;
  padding: 0 7px;
  border-radius: 999px;
  flex-shrink: 0;
}

.k-state {
  color: var(--accent);
  background: var(--accent-dim);
}

.k-message {
  color: var(--muted);
  background: rgba(148, 174, 196, 0.12);
}

.k-artifact {
  color: var(--ok);
  background: rgba(61, 220, 151, 0.14);
}

.k-progress {
  color: var(--text);
  background: rgba(148, 174, 196, 0.18);
}

.k-usage {
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line);
}

.k-warning {
  color: var(--warn);
  background: rgba(255, 180, 84, 0.14);
}

.text {
  flex: 1;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text.warn {
  color: var(--warn);
}

.empty {
  color: var(--muted);
  font-size: 12px;
  text-align: center;
  padding: 24px 0;
}

.older {
  display: flex;
  justify-content: center;
  padding-top: 6px;
}

.hint {
  font-size: 11px;
  color: var(--muted);
}
</style>
