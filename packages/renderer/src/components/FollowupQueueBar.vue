<script setup lang="ts">
import { ref } from 'vue'
import type { FollowupQueueItem } from '@agent-drove/shared'
import GlassButton from '../ui/GlassButton.vue'

const props = defineProps<{
  taskId: string
  followups: FollowupQueueItem[]
}>()

const emit = defineEmits<{
  (e: 'remove', followupId: string): void
  (e: 'clear'): void
}>()

const expanded = ref(false)

function formatTime(ts?: number): string {
  if (!ts || Number.isNaN(ts)) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
</script>

<template>
  <div v-if="followups.length > 0" class="followup-bar glass">
    <div class="summary-row" @click="expanded = !expanded">
      <div class="left">
        <span class="pulse-dot" />
        <span class="title">排队追加对话 ({{ followups.length }})</span>
        <span class="hint">当前轮次完成后将自动接续发送</span>
      </div>
      <div class="right">
        <GlassButton size="sm" variant="ghost" @click.stop="expanded = !expanded">
          {{ expanded ? '收起' : '展开查看' }}
        </GlassButton>
        <GlassButton size="sm" variant="danger" title="清空所有排队消息" @click.stop="emit('clear')">
          清空
        </GlassButton>
      </div>
    </div>

    <div v-if="expanded" class="queue-list">
      <div v-for="(item, index) in followups" :key="item.id" class="queue-item">
        <span class="index num">#{{ index + 1 }}</span>
        <span class="text" :title="item.prompt">{{ item.prompt }}</span>
        <span class="time num">{{ formatTime(item.createdAt) }}</span>
        <button
          type="button"
          class="remove-btn"
          title="取消本条排队"
          @click.stop="emit('remove', item.id)"
        >
          ✕
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.followup-bar {
  margin: 6px 0;
  border-radius: var(--radius-md);
  border: 1px solid var(--accent-line);
  background: var(--accent-dim);
  overflow: hidden;
  transition: all var(--fast) var(--ease);
}

.summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  cursor: pointer;
  user-select: none;
}

.left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-strong);
  box-shadow: 0 0 8px var(--accent);
  animation: dot-pulse 1.8s ease-in-out infinite;
}

@keyframes dot-pulse {
  0% { transform: scale(0.9); opacity: 0.7; box-shadow: 0 0 4px var(--accent); }
  50% { transform: scale(1.2); opacity: 1; box-shadow: 0 0 10px var(--accent-strong); }
  100% { transform: scale(0.9); opacity: 0.7; box-shadow: 0 0 4px var(--accent); }
}

.title {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-strong);
}

.hint {
  font-size: 11px;
  color: var(--muted);
}

.right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.queue-list {
  padding: 6px 12px 10px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: var(--glass-bg);
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 8px;
  background: var(--field-bg);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
}

.queue-item .index {
  color: var(--accent);
  font-weight: 600;
  font-size: 11px;
}

.queue-item .text {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.queue-item .time {
  font-size: 10px;
  color: var(--faint);
}

.remove-btn {
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  transition: all var(--fast) var(--ease);
}

.remove-btn:hover {
  background: color-mix(in srgb, var(--err) 20%, transparent);
  color: var(--err);
}
</style>
