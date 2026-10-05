<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import type { TaskRecord } from '@agent-drove/shared'
import { CLIENT_FOLLOW_MODEL, STATE_TEXT, formatModelDisplay, formatTokens, getAgentBillingType } from '../labels'

const props = defineProps<{
  task: TaskRecord
  selected: boolean
  checked: boolean
  /** 客户端展示名;缺省回落 agentId */
  agentLabel?: string
}>()

const emit = defineEmits<{
  click: []
  check: []
  'drag-over': [event: DragEvent]
  drop: [event: DragEvent]
  'drag-end': []
  context: [event: MouseEvent]
}>()

const store = useAppStore()

const ORIGIN_MARK: Partial<Record<TaskRecord['origin'], string>> = {
  panel: '面板',
  hotkey: '热键',
  selection: '选中',
  tray: '托盘',
  mcp: 'MCP',
  failover: '降级',
}

const summary = computed(() => (props.task.title || props.task.prompt).replace(/\s+/g, ' ').slice(0, 80))

/**
 * 运行中耗时每秒跳动(R24):事件批推不触发任务列重渲染,Date.now() 直接参与计算
 * 会把时长冻结在最后一次偶然刷新——改由组件内 1s ticker 驱动 nowTick。
 * 仅 running 时启动,进入终态/卸载即停(参照 SessionColumn 的 ticker)。
 */
const nowTick = ref(Date.now())
let durationTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.task.state === 'running',
  (running) => {
    if (running) {
      if (durationTimer) return
      nowTick.value = Date.now()
      durationTimer = setInterval(() => {
        nowTick.value = Date.now()
      }, 1000)
    } else if (durationTimer) {
      clearInterval(durationTimer)
      durationTimer = null
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (durationTimer) clearInterval(durationTimer)
})

const duration = computed(() => {
  if (!props.task.startedAt) return ''
  const end = props.task.finishedAt ?? nowTick.value
  const ms = Math.max(0, end - props.task.startedAt)
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3600_000)}h${Math.floor((ms % 3600_000) / 60_000)}m`
})

/**
 * 常驻工作区徽标(R22):按 projects 映射 projectId→名称,移动后即时可见;
 * daily 固定显「日常」,归属为空(或项目已删)显「未分组」。
 */
const workspaceLabel = computed(() => {
  const pid = props.task.projectId
  if (!pid) return '未分组'
  if (pid === 'daily') return '日常'
  return store.projects.value.find((p) => p.id === pid)?.name ?? '未分组'
})
const time = computed(() => {
  const d = new Date(props.task.createdAt)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})
const displayModel = computed(() =>
  formatModelDisplay(props.task.modelId, props.task.agentId, store.agents.value),
)

/** 计费模式区分: 'credits' (点数) 还是 'tokens' (Token) */
const billingType = computed(() => getAgentBillingType(props.task.agentId, store.agents.value))

const totalTokens = computed(() => {
  if (!props.task.usage) return 0
  return (
    (props.task.usage.inputTokens || 0) +
    (props.task.usage.outputTokens || 0) +
    (props.task.usage.cachedTokens || 0)
  )
})

// ---- 拖拽归类/排序(P0-2) ----
const canDrag = computed(() => true)

/** G2-01:拖拽源视觉反馈——dragstart 置位、dragend 复位,原位卡呈半透明虚线轮廓 */
const dragging = ref(false)

/** G2-02:排队追问数徽标——契约字段由 G5-05 随 tasks:list 附带,先按可选字段消费,缺失即不渲染 */
const followupCount = computed(
  () => (props.task as TaskRecord & { followupCount?: number }).followupCount ?? 0,
)

/** G2-09:存在更新尝试(retryOf 指向本卡的新任务)则整卡淡化,重试链不再在列表堆积成噪音 */
const superseded = computed(() => store.tasks.value.some((t) => t.retryOf === props.task.id))

function onDragStart(event: DragEvent): void {
  dragging.value = true
  store.draggingTaskId.value = props.task.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    const payload = store.selection.value.has(props.task.id)
      ? [...store.selection.value]
      : [props.task.id]
    event.dataTransfer.setData('text/plain', props.task.id)
    event.dataTransfer.setData('application/json', JSON.stringify(payload))
  }
}

function onDragEnd(): void {
  dragging.value = false
  store.draggingTaskId.value = null
  emit('drag-end')
}
</script>

<template>
  <article
    class="card spot"
    :class="[`s-${task.state}`, { selected, dragging, superseded }]"
    :title="superseded ? '已有更新尝试' : undefined"
    :data-task-id="task.id"
    @click="$emit('click')"
    @dragover="$emit('drag-over', $event)"
    @drop="$emit('drop', $event)"
    @contextmenu.prevent="$emit('context', $event)"
  >
    <!-- G2-01:draggable 收窄到卡头——摘要/错误文本恢复原生选择复制,拖拽热区=卡头 -->
    <div class="top" :draggable="canDrag" @dragstart="onDragStart" @dragend="onDragEnd">
      <span class="drag-handle" title="按住拖拽调整顺序或归类" @click.stop>⋮⋮</span>
      <span class="agent">{{ agentLabel ?? task.agentId }}</span>
      <span class="ws-tag" :title="`工作区:${workspaceLabel}`">{{ workspaceLabel }}</span>
      <span class="badge" :class="{ 'is-running': task.state === 'running' }">
        <span v-if="task.state === 'running'" class="card-spin" aria-hidden="true" />
        {{ STATE_TEXT[task.state] }}
      </span>
      <!-- G2-02:排队追问常驻计数徽标——给 A 排了消息切到 B 后也能在列表里找回 -->
      <span v-if="followupCount > 0" class="fu-badge num" :title="`${followupCount} 条排队追问`">
        ⏳{{ followupCount }}
      </span>
      <span v-if="task.skills?.length" class="card-skills">
        <span v-for="s in task.skills.slice(0, 3)" :key="s" class="s-dot" :title="s">{{ s.slice(0, 1) }}</span>
      </span>
      <span v-if="duration" class="num dur">{{ duration }}</span>
      <span class="num time">{{ time }}</span>
    </div>
    <div class="body">
      <span v-if="task.title" class="custom-title-tag">标</span>
      {{ summary }}
    </div>
    <div v-if="task.error" class="err">{{ task.error.slice(0, 90) }}</div>

    <!-- 真实消耗与缓存命中率 (严格区分点数与 Token, 无 emoji) -->
    <div v-if="task.usage" class="card-usage num">
      <template v-if="billingType === 'credits'">
        <span class="usage-item" title="对话消耗点数">点数: {{ task.usage.credits }} 点</span>
      </template>
      <template v-else>
        <span class="usage-item" title="总消耗 Tokens">Token: {{ formatTokens(totalTokens) }}</span>
      </template>
      <span v-if="task.usage.cacheHitRate" class="usage-cache" title="Prompt 缓存命中率">
        缓存 {{ task.usage.cacheHitRate }}%
      </span>
    </div>
    <div class="foot">
      <span v-if="ORIGIN_MARK[task.origin]" class="origin">{{ ORIGIN_MARK[task.origin] }}</span>
      <!-- G2-09:重试/重跑链路可视化——↻N 徽标悬停可见父任务 id 与尝试次数 -->
      <span
        v-if="task.attempt > 1"
        class="origin"
        :title="`源自任务 #${task.retryOf ?? '?'} · 第 ${task.attempt} 次尝试`"
      >↻{{ task.attempt }}</span>
      <span class="spacer" />
      <button
        type="button"
        class="card-detail-btn"
        title="弹窗查看任务详情与操作"
        @click.stop="store.openDetailModal(task.id)"
      >
        详情
      </button>
      <label class="pick" @click.stop>
        <input type="checkbox" :checked="checked" @change="$emit('check')" />
      </label>
    </div>
  </article>
</template>

<style scoped>
.card {
  position: relative;
  border-radius: var(--radius-md);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-edge);
  box-shadow: inset 0 1px 0 var(--glass-specular);
  padding: 12px 14px;
  cursor: pointer;
  /* R24/G2-01:user-select 收窄到卡头拖拽热区(.top),摘要与错误文本可选中复制;
     draggable 同样收窄到 .top,article 不再整体可拖,按住摘要拖动是文本选择而非元素拖拽 */
  transition: transform var(--fast) var(--ease), border-color var(--fast) var(--ease),
    background var(--fast) var(--ease);
}

.card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.06), transparent 40%);
}

.card:hover {
  transform: translateY(-1px);
  border-color: var(--line-strong);
}

.card.selected {
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

/* G2-01:拖拽源视觉反馈——原位卡半透明虚线轮廓,与落点指示线可区分 */
.card.dragging {
  opacity: 0.55;
  outline: 2px dashed var(--accent-line);
}

/* G2-09:已有更新尝试的旧卡整体淡化 */
.card.superseded {
  opacity: 0.7;
}

/* 左缘状态色条:扫一眼即知列内任务状态分布 */
.card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 2.5px;
  border-radius: 2px;
  background: var(--faint);
  opacity: 0.55;
}

.card.s-running::before {
  background: var(--accent);
  opacity: 1;
}

.card.s-completed::before {
  background: var(--ok);
}

.card.s-failed::before {
  background: var(--err);
}

.card.s-canceled::before {
  background: var(--faint);
}

.top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  /* 卡头=拖拽热区(P0-2/R24/G2-01):draggable 在此生效,禁文本原生选择,
     避免按住卡头拖动时误触发文本 drag;卡身文本不受影响 */
  user-select: none;
}

.drag-handle {
  cursor: grab;
  color: var(--faint);
  font-size: 11px;
  line-height: 1;
  padding: 0 2px;
  letter-spacing: -1px;
  opacity: 0.35;
  transition: opacity 140ms ease, color 140ms ease;
  user-select: none;
}

.card:hover .drag-handle {
  opacity: 0.85;
  color: var(--muted);
}

.drag-handle:active {
  cursor: grabbing;
}

.agent {
  font-weight: 600;
}

/* 常驻工作区徽标(R22):归属一目了然,移动后即时更新 */
.ws-tag {
  font-size: 10px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0 6px;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: none;
}

.model {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.badge {
  margin-left: auto;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--chip-bg);
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.card-spin {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--accent-line);
  border-top-color: var(--accent-strong);
  animation: cardSpin 0.8s linear infinite;
}

@keyframes cardSpin {
  to {
    transform: rotate(360deg);
  }
}

.s-running .badge {
  background: var(--accent-dim);
  color: var(--accent-strong);
  border: 1px solid var(--accent-line);
  animation: breathe 1.6s ease-in-out infinite;
}

.s-completed .badge {
  background: color-mix(in srgb, var(--ok) 15%, transparent);
  color: var(--ok);
}

.s-failed .badge {
  background: color-mix(in srgb, var(--err) 15%, transparent);
  color: var(--err);
}

@keyframes breathe {
  50% {
    opacity: 0.55;
  }
}

.dur,
.time {
  font-size: 11px;
  color: var(--faint);
}

.body {
  margin-top: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.err {
  margin-top: 4px;
  color: var(--err);
  font-size: 12px;
}

.foot {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 16px;
}

.origin {
  font-size: 10px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0 6px;
}

.spacer {
  flex: 1;
}

.pick input {
  accent-color: var(--accent);
}

.card-detail-btn {
  font-size: 11px;
  font-weight: 500;
  color: var(--text);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.05) 100%);
  border: 1px solid rgba(255, 255, 255, 0.22);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 1px 3px rgba(0, 0, 0, 0.08);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  cursor: pointer;
  user-select: none;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1),
    background 160ms cubic-bezier(0.16, 1, 0.3, 1),
    border-color 160ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 160ms cubic-bezier(0.16, 1, 0.3, 1);
}

.card-detail-btn:hover {
  color: var(--accent-strong);
  border-color: rgba(255, 255, 255, 0.45);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.25) 0%, rgba(255, 255, 255, 0.1) 100%);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.5), 0 3px 10px rgba(0, 0, 0, 0.15);
  transform: translateY(-1px);
}

.card-detail-btn:active {
  transform: translateY(0.5px) scale(0.97);
}

.card-skills {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.s-dot {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--chip-bg);
  color: var(--accent-strong);
  font-family: var(--mono);
}

/* G2-02:排队追问常驻计数徽标(复用 plan-tag 小徽标规格) */
.fu-badge {
  font-size: 10px;
  color: var(--muted);
  background: var(--accent-dim);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--accent-line);
  flex: none;
}

.custom-title-tag {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--accent-dim);
  color: var(--accent-strong);
  margin-right: 4px;
  font-weight: 600;
}

.card-usage {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted);
  flex-wrap: wrap;
}

.usage-item {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.usage-cache {
  font-weight: 700;
  font-size: 10px;
  color: #10b981;
  background: color-mix(in srgb, #10b981 12%, transparent);
  border: 1px solid color-mix(in srgb, #10b981 25%, transparent);
  padding: 0 4px;
  border-radius: 4px;
  line-height: 1.4;
}
</style>
