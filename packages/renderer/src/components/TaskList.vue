<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import TaskCard from './TaskCard.vue'
import TaskContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import { STATE_FILTER_OPTIONS } from '../labels'
import { compareTaskOrder, type TaskRecord } from '@agent-drove/shared'

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

/**
 * 可见列表(P0-2):过滤后在各分组的子序列内应用手动排序位——orderIndex 是组内连续值,
 * 组间相对位置保持 tasks:list 的 createdAt 倒序,未手动排过序的组不受其他组拖拽影响;
 * 全局序若在此直接比较会把手动组的任务整体前置(复审修正,与主进程口径配套)。
 */
const visible = computed(() => {
  const filtered = store.tasks.value.filter((t) => {
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
  })
  const buckets = new Map<string, TaskRecord[]>()
  for (const t of filtered) {
    const key = t.projectId ?? ''
    const bucket = buckets.get(key)
    if (bucket) bucket.push(t)
    else buckets.set(key, [t])
  }
  for (const bucket of buckets.values()) bucket.sort(compareTaskOrder)
  // 按原(createdAt 倒序)骨架逐槽放回各分组排序后的元素:组内有序,组间交错不变
  const cursors = new Map<string, number>()
  return filtered.map((t) => {
    const key = t.projectId ?? ''
    const index = cursors.get(key) ?? 0
    cursors.set(key, index + 1)
    return buckets.get(key)![index]!
  })
})

const activeProject = computed(() => store.selectedProject.value)

const selecting = computed(() => store.selection.value.size > 0)

/** 客户端下拉与卡片展示名共用一份 id→label 映射,避免每次渲染重建数组 */
const agentLabels = computed(() => new Map(store.agents.value.map((a) => [a.id, a.label])))

const agentOptions = computed(() => [
  { value: '', label: '全部客户端' },
  ...store.agents.value.map((a) => ({ value: a.id, label: a.label })),
])

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

// ---- 拖拽归类与组内排序(P0-2) ----
/** 插入指示线:画在该卡之前;dropAtEnd=true 时画在列表末尾(组尾) */
const dropBeforeId = ref<string | null>(null)
const dropAtEnd = ref(false)

function clearDropMark(): void {
  dropBeforeId.value = null
  dropAtEnd.value = false
}

/** 悬停卡片:指针在上半部 → 插到本卡前;下半部 → 插到下一卡前(末卡=组尾) */
function onCardDragOver(task: TaskRecord, event: DragEvent): void {
  const dragId = store.draggingTaskId.value
  if (!dragId || dragId === task.id) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const idx = visible.value.findIndex((t) => t.id === task.id)
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  if (event.clientY < rect.top + rect.height / 2) {
    dropAtEnd.value = false
    dropBeforeId.value = task.id
    return
  }
  const next = visible.value[idx + 1]
  if (next) {
    dropAtEnd.value = false
    dropBeforeId.value = next.id
  } else {
    dropBeforeId.value = null
    dropAtEnd.value = true
  }
}

function onCardDrop(task: TaskRecord, event: DragEvent): void {
  event.preventDefault()
  if (!store.draggingTaskId.value) return
  const beforeId = dropBeforeId.value
  const atEnd = dropAtEnd.value
  clearDropMark()
  commitDrop(atEnd ? null : (beforeId ?? task.id))
}

/** 列表空白区(容器本体):一律视为移到组尾 */
function onListDragOver(event: DragEvent): void {
  if (!store.draggingTaskId.value || event.target !== event.currentTarget) return
  event.preventDefault()
  dropBeforeId.value = null
  dropAtEnd.value = true
}

function onListDrop(event: DragEvent): void {
  if (event.target !== event.currentTarget) return
  event.preventDefault()
  clearDropMark()
  if (!store.draggingTaskId.value) return
  commitDrop(null)
}

/** 拖拽离开列表(相关目标不在容器内)时收起指示线 */
function onListDragLeave(event: DragEvent): void {
  const to = event.relatedTarget as Node | null
  if (to && (event.currentTarget as HTMLElement).contains(to)) return
  clearDropMark()
}

/** 卡片拖拽结束(含 Esc 取消):统一清理拖拽状态 */
function onDragEnd(): void {
  clearDropMark()
}

/**
 * 落点提交:同组 → tasks:reorder 相邻插入;跨组 → 降级为 tasks:move(移入锚点卡
 * 所在工作区,core 落组尾);源已归项目而锚点无项目 → 契约不支持移出,提示说明。
 * 筛选(客户端/状态/关键词)开启时可见列表横跨多个项目,跨项目落点静默改归属
 * 与未分组锚点的拒绝行为不对称(P0-2 复审)——此时禁用移动并提示,仅工作区视图/全部
 * 未筛选视图保留静默 move 语义。
 */
function commitDrop(beforeId: string | null): void {
  const dragId = store.draggingTaskId.value
  if (!dragId) return
  const dragTask = store.tasks.value.find((t) => t.id === dragId)
  if (!dragTask) return
  const filtering = Boolean(
    store.filter.value.agentId || store.filter.value.state || store.filter.value.search,
  )
  let anchorProjectId: string | undefined
  if (beforeId) {
    anchorProjectId = store.tasks.value.find((t) => t.id === beforeId)?.projectId
  } else {
    // 组尾:取可见列表末卡的分组;列表只有自己时维持原分组(纯重排到尾)
    const last = visible.value[visible.value.length - 1]
    anchorProjectId = last && last.id !== dragId ? last.projectId : dragTask.projectId
  }
  store.draggingTaskId.value = null
  if (dragTask.projectId === anchorProjectId) {
    void store.reorderTask(dragId, beforeId)
    return
  }
  if (anchorProjectId) {
    if (filtering) {
      store.showToast('筛选视图中暂不支持跨工作区移动:清除筛选后拖到侧栏工作区项即可')
      return
    }
    void store.moveTask(dragId, anchorProjectId)
    return
  }
  store.showToast('已归属工作区的任务暂不支持移回未分组')
}

// ---- 卡片右键菜单(P0-2):移动到…/取消任务/删除(置顶属 P1 不做) ----
const ctxTask = ref<TaskRecord | null>(null)
const ctxX = ref(0)
const ctxY = ref(0)

function openContextMenu(task: TaskRecord, event: MouseEvent): void {
  ctxTask.value = task
  ctxX.value = event.clientX
  ctxY.value = event.clientY
}

async function deleteTask(taskId: string): Promise<void> {
  const task = store.tasks.value.find((t) => t.id === taskId)
  const name = (task?.title || task?.prompt || '').replace(/\s+/g, ' ').slice(0, 24)
  if (!window.confirm(`删除任务「${name}」及其事件记录?运行中的任务会跳过。`)) return
  await window.api.tasksBatchDelete([taskId])
  await store.refreshTasks()
}

const ctxItems = computed<ContextMenuItem[]>(() => {
  const task = ctxTask.value
  if (!task) return []
  const items: ContextMenuItem[] = []
  const targets = store.projects.value.filter((p) => p.id !== task.projectId)
  if (targets.length > 0) {
    items.push({ key: 'grp-move', label: '移动到工作区', group: true })
    for (const p of targets) {
      items.push({
        key: `move:${p.id}`,
        label: `「${p.name}」`,
        action: () => void store.moveTask(task.id, p.id),
      })
    }
  }
  if (task.state === 'queued' || task.state === 'running') {
    items.push({ key: 'cancel', label: '取消任务', action: () => void store.stopTask(task.id) })
  }
  items.push({
    key: 'delete',
    label: '删除',
    danger: true,
    action: () => void deleteTask(task.id),
  })
  return items
})
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

    <div class="list" @dragover="onListDragOver" @drop="onListDrop" @dragleave="onListDragLeave">
      <template v-for="task in visible" :key="task.id">
        <div v-if="dropBeforeId === task.id" class="drop-line" aria-hidden="true" />
        <TaskCard
          :task="task"
          :agent-label="agentLabels.get(task.agentId)"
          :selected="store.selectedTaskId.value === task.id"
          :checked="store.selection.value.has(task.id)"
          @click="onCardClick(task)"
          @check="toggleSelect(task.id)"
          @drag-over="onCardDragOver(task, $event)"
          @drop="onCardDrop(task, $event)"
          @drag-end="onDragEnd"
          @context="openContextMenu(task, $event)"
        />
      </template>
      <div v-if="dropAtEnd" class="drop-line" aria-hidden="true" />
      <div v-if="visible.length === 0" class="empty">
        <p class="big">{{ activeProject ? '该工作区还没有任务' : '还没有任务' }}</p>
        <p class="sub">在上方发布框写下第一条,Enter 派发。</p>
      </div>
    </div>

    <!-- 卡片右键菜单(P0-2):移动到…/取消任务/删除 -->
    <TaskContextMenu
      v-if="ctxTask"
      :x="ctxX"
      :y="ctxY"
      :items="ctxItems"
      @close="ctxTask = null"
    />
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
  /* P0-7:允许换行,任何列宽下都不再横向裁切(窄列时下拉折行显示) */
  flex-wrap: wrap;
}

.filters > :first-child {
  flex: 1;
  min-width: 120px;
}

.filters :deep(.g-select-wrap) {
  flex: none;
  min-width: 88px;
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

/* 拖拽插入指示线(P0-2):负 margin 抵消自身高度,整体骑在 8px 卡片间距中央不顶开布局 */
.drop-line {
  height: 2px;
  margin: -5px 0;
  border-radius: 1px;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent-line);
  position: relative;
  z-index: 1;
  flex: none;
}
</style>
