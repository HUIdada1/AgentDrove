<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import TaskCard from './TaskCard.vue'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import type { TaskRecord } from '@agent-drove/shared'

const store = useAppStore()

const visible = computed(() =>
  store.tasks.value.filter((t) => {
    if (store.filter.value.agentId && t.agentId !== store.filter.value.agentId) return false
    if (store.filter.value.state && t.state !== store.filter.value.state) return false
    if (store.filter.value.search && !t.prompt.includes(store.filter.value.search)) return false
    return true
  }),
)

const selecting = computed(() => store.selection.value.size > 0)

function toggleSelect(id: string): void {
  const next = new Set(store.selection.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  store.selection.value = next
}

async function batchCancel(): Promise<void> {
  await window.api.tasksBatchCancel([...store.selection.value])
  store.selection.value = new Set()
  await store.refreshTasks()
}

async function batchDelete(): Promise<void> {
  const count = store.selection.value.size
  if (count === 0) return
  if (!window.confirm(`删除 ${count} 条任务及其事件记录?运行中的任务会跳过。`)) return
  await window.api.tasksBatchDelete([...store.selection.value])
  store.selection.value = new Set()
  await store.refreshTasks()
}

function onCardClick(task: TaskRecord): void {
  if (selecting.value) toggleSelect(task.id)
  else store.selectedTaskId.value = task.id
}

function onSearch(value: string): void {
  store.filter.value.search = value
}

const stateOptions = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队' },
  { value: 'running', label: '运行中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
  { value: 'interrupted', label: '已中断' },
]
</script>

<template>
  <section class="tasks glass">
    <div class="filters">
      <GlassInput
        :model-value="store.filter.value.search"
        placeholder="搜索任务(Ctrl+K)"
        @update:model-value="onSearch"
      />
      <GlassSelect
        :model-value="store.filter.value.agentId"
        :options="store.agents.value.map((a) => ({ value: a.id, label: a.label }))"
        @update:model-value="store.filter.value.agentId = $event"
      />
      <GlassSelect
        :model-value="store.filter.value.state"
        :options="stateOptions"
        @update:model-value="store.filter.value.state = $event"
      />
    </div>

    <div v-if="selecting" class="batch">
      <span>已选 {{ store.selection.value.size }}</span>
      <span class="spacer" />
      <GlassButton size="sm" @click="batchCancel">批量取消</GlassButton>
      <GlassButton size="sm" variant="danger" @click="batchDelete">批量删除</GlassButton>
      <GlassButton size="sm" variant="ghost" @click="store.selection.value = new Set()">收起</GlassButton>
    </div>

    <div class="list">
      <TaskCard
        v-for="task in visible"
        :key="task.id"
        :task="task"
        :selected="store.selectedTaskId.value === task.id"
        :checked="store.selection.value.has(task.id)"
        @click="onCardClick(task)"
        @check="toggleSelect(task.id)"
      />
      <div v-if="visible.length === 0" class="empty">
        <p class="big">还没有任务</p>
        <p class="sub">在上方发布框写下第一条,Enter 派发。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tasks {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px 12px;
}

.filters {
  display: flex;
  gap: 6px;
  padding-bottom: 10px;
}

.filters > :first-child {
  flex: 1;
}

.batch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin-bottom: 8px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-md);
  font-size: 12px;
}

.batch .spacer {
  flex: 1;
}

.list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.empty {
  text-align: center;
  margin-top: 40px;
}

.empty .big {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--muted);
}

.empty .sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--faint);
}
</style>
