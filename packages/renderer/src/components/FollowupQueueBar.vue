<script setup lang="ts">
import { ref } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { FollowupQueueItem } from '@agent-drove/shared'
import GlassButton from '../ui/GlassButton.vue'

const props = defineProps<{
  taskId: string
  followups: FollowupQueueItem[]
  /** 父任务是否执行中:决定是否提供"打断当前轮并立即发送" */
  taskRunning?: boolean
}>()

const emit = defineEmits<{
  (e: 'remove', followupId: string): void
  (e: 'clear'): void
  /** 编辑排队文案(P0-6/D3):prompt 已由组件 trim,空串与原文不变不触发 */
  (e: 'edit', followupId: string, prompt: string): void
  /** 提前发送:移到队首(P0-6/D3) */
  (e: 'promote', followupId: string): void
  /** 打断当前轮并立即发送(P0-6/D3):确认在父层,IPC 也在父层 */
  (e: 'interrupt', followupId: string): void
}>()

const expanded = ref(false)
const editingId = ref('')
const editingText = ref('')

function startEdit(item: FollowupQueueItem): void {
  editingId.value = item.id
  editingText.value = item.prompt
}

function cancelEdit(): void {
  editingId.value = ''
  editingText.value = ''
}

function commitEdit(): void {
  const id = editingId.value
  if (!id) return
  const text = editingText.value.trim()
  const original = props.followups.find((item) => item.id === id)?.prompt ?? ''
  cancelEdit()
  // 文案未变化不触发 IPC;prompt.trim() 归一化单点在 core,这里只挡空串
  if (text && text !== original) emit('edit', id, text)
}

/** Enter 提交编辑;IME 组词态(isComposing/229)的 Enter 是选词确认,不是提交意图(与其余输入框口径一致) */
function onEditKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  commitEdit()
}

/** 函数 ref:编辑框挂载即聚焦并全选 */
function setEditRef(el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLInputElement) {
    el.focus()
    el.select()
  }
}

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
        <input
          v-if="editingId === item.id"
          :ref="setEditRef"
          v-model="editingText"
          class="edit-input"
          @keydown.enter="onEditKeydown"
          @keydown.esc="cancelEdit"
          @blur="commitEdit"
        />
        <span
          v-else
          class="text clickable"
          :title="`${item.prompt}(点击编辑文案)`"
          @click.stop="startEdit(item)"
        >
          {{ item.prompt }}
        </span>
        <span
          v-if="item.modelId || item.mode || item.reasoningEffort || item.toolPolicy"
          class="ov-tag"
          title="本条携带着本轮参数覆盖,接续时按此执行"
        >
          带参数
        </span>
        <span class="time num">{{ formatTime(item.createdAt) }}</span>
        <button
          v-if="index > 0"
          type="button"
          class="act-btn"
          title="移到队首:当前轮结束后最先发送"
          @click.stop="emit('promote', item.id)"
        >
          ↑
        </button>
        <button
          v-if="taskRunning"
          type="button"
          class="act-btn warn"
          title="打断当前轮并立即发送本条(需确认)"
          @click.stop="emit('interrupt', item.id)"
        >
          ⏵
        </button>
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
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}

.queue-item .text.clickable {
  cursor: pointer;
  transition: color var(--fast) var(--ease);
}

.queue-item .text.clickable:hover {
  color: var(--accent-strong);
}

.edit-input {
  flex: 1;
  min-width: 0;
  background: var(--field-bg);
  border: 1px solid var(--accent);
  border-radius: 4px;
  color: var(--text);
  font-size: 12px;
  padding: 2px 6px;
  outline: none;
}

.ov-tag {
  flex: none;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--accent-dim);
  color: var(--accent-strong);
}

.queue-item .time {
  font-size: 10px;
  color: var(--faint);
}

.act-btn {
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1;
  transition: all var(--fast) var(--ease);
}

.act-btn:hover {
  background: var(--accent-dim);
  color: var(--accent-strong);
}

.act-btn.warn:hover {
  background: color-mix(in srgb, var(--warn) 20%, transparent);
  color: var(--warn);
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
