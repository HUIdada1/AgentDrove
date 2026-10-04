<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import type { TaskRecord } from '@agent-drove/shared'
import { CLIENT_FOLLOW_MODEL, STATE_TEXT } from '../labels'

const props = defineProps<{
  task: TaskRecord
  selected: boolean
  checked: boolean
  /** 客户端展示名;缺省回落 agentId */
  agentLabel?: string
}>()

defineEmits<{ click: []; check: [] }>()

const store = useAppStore()

const ORIGIN_MARK: Partial<Record<TaskRecord['origin'], string>> = {
  panel: '面板',
  hotkey: '热键',
  selection: '选中',
  tray: '托盘',
  mcp: 'MCP',
  failover: '降级',
}

const summary = computed(() => props.task.prompt.replace(/\s+/g, ' ').slice(0, 80))
const duration = computed(() => {
  if (!props.task.startedAt) return ''
  const end = props.task.finishedAt ?? Date.now()
  const ms = Math.max(0, end - props.task.startedAt)
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3600_000)}h${Math.floor((ms % 3600_000) / 60_000)}m`
})
const time = computed(() => {
  const d = new Date(props.task.createdAt)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})
</script>

<template>
  <article class="card spot" :class="[`s-${task.state}`, { selected }]" @click="$emit('click')">
    <div class="top">
      <span class="agent">{{ agentLabel ?? task.agentId }}</span>
      <span class="model">{{ task.modelId === CLIENT_FOLLOW_MODEL ? '跟随客户端' : task.modelId }}</span>
      <span class="badge">{{ STATE_TEXT[task.state] }}</span>
      <span v-if="duration" class="num dur">{{ duration }}</span>
      <span class="num time">{{ time }}</span>
    </div>
    <div class="body">{{ summary }}</div>
    <div v-if="task.error" class="err">{{ task.error.slice(0, 90) }}</div>
    <div class="foot">
      <span v-if="ORIGIN_MARK[task.origin]" class="origin">{{ ORIGIN_MARK[task.origin] }}</span>
      <span v-if="task.attempt > 1" class="origin">attempt {{ task.attempt }}</span>
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
  padding: 9px 12px;
  cursor: pointer;
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
}

.agent {
  font-weight: 600;
}

.model {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.badge {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 9px;
  border-radius: 999px;
  background: var(--chip-bg);
  color: var(--muted);
}

.s-running .badge {
  background: var(--accent-dim);
  color: var(--accent-strong);
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
  font-size: 10px;
  color: var(--muted);
  background: var(--glass-bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 6px;
  cursor: pointer;
  transition: all var(--fast) var(--ease);
}

.card-detail-btn:hover {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}
</style>
