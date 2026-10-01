<script setup lang="ts">
import { computed } from 'vue'
import type { TaskRecord } from '@agent-drove/shared'

const props = defineProps<{
  task: TaskRecord
  selected: boolean
  checked: boolean
}>()

defineEmits<{ click: []; check: [] }>()

const STATE_TEXT: Record<TaskRecord['state'], string> = {
  queued: '排队',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  interrupted: '已中断',
}

const ORIGIN_MARK: Partial<Record<TaskRecord['origin'], string>> = {
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
  <article class="card" :class="[`s-${task.state}`, { selected }]" @click="$emit('click')">
    <div class="top">
      <span class="agent">{{ task.agentId }}</span>
      <span class="model">{{ task.modelId === 'client-follow' ? '跟随客户端' : task.modelId }}</span>
      <span class="badge">{{ STATE_TEXT[task.state] }}</span>
      <span v-if="duration" class="dur">{{ duration }}</span>
      <span class="time">{{ time }}</span>
    </div>
    <div class="body">{{ summary }}</div>
    <div v-if="task.error" class="err">{{ task.error.slice(0, 90) }}</div>
    <div class="foot">
      <span v-if="ORIGIN_MARK[task.origin]" class="origin">{{ ORIGIN_MARK[task.origin] }}</span>
      <span v-if="task.attempt > 1" class="origin">attempt {{ task.attempt }}</span>
      <span class="spacer" />
      <label class="pick" @click.stop>
        <input type="checkbox" :checked="checked" @change="$emit('check')" />
      </label>
    </div>
  </article>
</template>

<style scoped>
.card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg1);
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color var(--fast), transform var(--fast), background var(--fast);
}

.card:hover {
  transform: translateY(-1px);
  border-color: var(--line-strong);
}

.card.selected {
  border-color: rgba(77, 163, 255, 0.55);
  background: var(--bg2);
}

.card.s-running {
  border-left: 2px solid var(--accent);
}

.card.s-failed {
  border-left: 2px solid var(--err);
}

.card.s-completed {
  border-left: 2px solid var(--ok);
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
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(148, 174, 196, 0.12);
  color: var(--muted);
}

.s-running .badge {
  background: var(--accent-dim);
  color: var(--accent);
  animation: breathe 1.6s ease-in-out infinite;
}

.s-completed .badge {
  background: rgba(61, 220, 151, 0.14);
  color: var(--ok);
}

.s-failed .badge {
  background: rgba(255, 107, 107, 0.14);
  color: var(--err);
}

@keyframes breathe {
  50% {
    opacity: 0.55;
  }
}

.dur,
.time {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.body {
  margin-top: 6px;
  color: var(--text);
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
  border-radius: 4px;
  padding: 0 5px;
}

.spacer {
  flex: 1;
}

.pick input {
  accent-color: var(--accent);
}
</style>
