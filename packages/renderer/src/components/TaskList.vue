<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import TaskCard from './TaskCard.vue'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import { STATE_FILTER_OPTIONS } from '../labels'
import type { TaskRecord } from '@agent-drove/shared'

const store = useAppStore()
const searchRef = ref<{ focus: () => void } | null>(null)

// 搜索框占位承诺了 Ctrl+K,这里兑现;Cmd+K 一并支持(Mac)
function onHotkey(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchRef.value?.focus()
  }
}

onMounted(() => window.addEventListener('keydown', onHotkey))
onBeforeUnmount(() => window.removeEventListener('keydown', onHotkey))

const visible = computed(() =>
  store.tasks.value.filter((t) => {
    if (store.filter.value.agentId && t.agentId !== store.filter.value.agentId) return false
    if (store.filter.value.state && t.state !== store.filter.value.state) return false
    if (store.filter.value.search) {
      const q = store.filter.value.search.toLowerCase()
      const matchPrompt = t.prompt.toLowerCase().includes(q)
      const matchTitle = t.title ? t.title.toLowerCase().includes(q) : false
      if (!matchPrompt && !matchTitle) return false
    }
    // 侧栏选中工作区 → 只看该项目下的任务(日常工作区未绑定目录时按 projectId 分组,不受 cwd 影响)
    if (store.selectedProjectId.value && t.projectId !== store.selectedProjectId.value) return false
    return true
  }),
)

const activeProject = computed(() => store.selectedProject.value)

const selecting = computed(() => store.selection.value.size > 0)

/** 客户端下拉与卡片展示名共用一份 id→label 映射,避免每次渲染重建数组 */
const agentLabels = computed(() => new Map(store.agents.value.map((a) => [a.id, a.label])))

const agentOptions = computed(() =>
  store.agents.value.map((a) => ({ value: a.id, label: a.label })),
)

function toggleSelect(id: string): void {
  const next = new Set(store.selection.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  store.selection.value = next
}

async function batchCancel(): Promise<void> {
  if (store.selection.value.size === 0) return
  const ids = [...store.selection.value]
  store.selection.value = new Set()
  await window.api.tasksBatchCancel(ids)
  await store.refreshTasks()
}

async function batchDelete(): Promise<void> {
  const ids = [...store.selection.value]
  if (ids.length === 0) return
  if (!window.confirm(`删除 ${ids.length} 条任务及其事件记录?运行中的任务会跳过。`)) return
  store.selection.value = new Set()
  await window.api.tasksBatchDelete(ids)
  await store.refreshTasks()
}

function onCardClick(task: TaskRecord): void {
  if (selecting.value) toggleSelect(task.id)
  else store.selectedTaskId.value = task.id
}

function onSearch(value: string): void {
  store.filter.value.search = value
}

/** 全选当前筛选结果,再点一次取消全选 */
function toggleSelectAll(): void {
  const list = visible.value
  const allSelected = list.length > 0 && list.every((t) => store.selection.value.has(t.id))
  store.selection.value = allSelected ? new Set() : new Set(list.map((t) => t.id))
}
</script>

<template>
  <section class="tasks glass">
    <div class="filters">
      <GlassInput
        ref="searchRef"
        :model-value="store.filter.value.search"
        placeholder="搜索任务(Ctrl+K)"
        @update:model-value="onSearch"
      />
      <GlassSelect
        :model-value="store.filter.value.agentId"
        :options="agentOptions"
        @update:model-value="store.filter.value.agentId = $event"
      />
      <GlassSelect
        :model-value="store.filter.value.state"
        :options="STATE_FILTER_OPTIONS"
        @update:model-value="store.filter.value.state = $event"
      />
    </div>

    <div v-if="selecting" class="batch">
      <span>已选 {{ store.selection.value.size }}</span>
      <span class="spacer" />
      <GlassButton size="sm" variant="ghost" @click="toggleSelectAll">全选</GlassButton>
      <GlassButton size="sm" @click="batchCancel">批量取消</GlassButton>
      <GlassButton size="sm" variant="danger" @click="batchDelete">批量删除</GlassButton>
      <GlassButton size="sm" variant="ghost" @click="store.selection.value = new Set()">收起</GlassButton>
    </div>

    <div v-else-if="activeProject" class="scope">
      <span class="mark">⌂</span>
      <span class="scope-name">{{ activeProject.name }}</span>
      <span class="scope-path">{{ activeProject.path ?? '未绑定目录 · 派发落默认工作区' }}</span>
      <span class="spacer" />
      <GlassButton variant="ghost" size="sm" title="回到全部工作区" @click="store.selectedProjectId.value = null">
        查看全部×
      </GlassButton>
    </div>

    <div class="list">
      <TaskCard
        v-for="task in visible"
        :key="task.id"
        :task="task"
        :agent-label="agentLabels.get(task.agentId)"
        :selected="store.selectedTaskId.value === task.id"
        :checked="store.selection.value.has(task.id)"
        @click="onCardClick(task)"
        @check="toggleSelect(task.id)"
      />
      <div v-if="visible.length === 0" class="empty">
        <p class="big">{{ activeProject ? '该工作区还没有任务' : '还没有任务' }}</p>
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
  align-items: center;
  gap: 6px;
  padding-bottom: 10px;
}

.filters > :first-child {
  flex: 1;
  min-width: 120px;
}

.filters :deep(.g-select-wrap) {
  flex: none;
  min-width: 98px;
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

.scope {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  margin-bottom: 8px;
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-md);
  font-size: 12px;
  min-width: 0;
}

.scope .mark {
  color: var(--accent-strong);
}

.scope-name {
  font-weight: 600;
  flex: none;
}

.scope-path {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.scope .spacer {
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
