<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import TaskCard from './TaskCard.vue'
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
  await window.api.tasksBatchDelete([...store.selection.value])
  store.selection.value = new Set()
  await store.refreshTasks()
}

function onCardClick(task: TaskRecord): void {
  if (selecting.value) toggleSelect(task.id)
  else store.selectedTaskId.value = task.id
}
</script>

<template>
  <section class="tasks">
    <div class="filters">
      <input v-model="store.filter.value.search" class="search" placeholder="搜索任务(Ctrl+K)" id="task-search" />
      <select v-model="store.filter.value.agentId">
        <option value="">全部客户端</option>
        <option v-for="a in store.agents.value" :key="a.id" :value="a.id">{{ a.label }}</option>
      </select>
      <select v-model="store.filter.value.state">
        <option value="">全部状态</option>
        <option value="queued">排队</option>
        <option value="running">运行中</option>
        <option value="completed">已完成</option>
        <option value="failed">失败</option>
        <option value="canceled">已取消</option>
        <option value="interrupted">已中断</option>
      </select>
    </div>

    <div v-if="selecting" class="batch">
      已选 {{ store.selection.value.size }}
      <span class="spacer" />
      <button @click="batchCancel">批量取消</button>
      <button class="danger" @click="batchDelete">批量删除</button>
      <button class="ghost" @click="store.selection.value = new Set()">收起</button>
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
      <div v-if="visible.length === 0" class="empty">还没有任务。从上方发布框派发第一条。</div>
    </div>
  </section>
</template>

<style scoped>
.tasks {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.filters {
  padding: 10px 14px;
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--line);
}

.search {
  flex: 1;
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.batch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: var(--accent-dim);
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}

.batch .spacer {
  flex: 1;
}

.empty {
  color: var(--muted);
  text-align: center;
  margin-top: 60px;
}
</style>
