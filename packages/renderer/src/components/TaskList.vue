<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import TaskCard from './TaskCard.vue'
import TaskContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassModal from '../ui/GlassModal.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import { STATE_FILTER_OPTIONS } from '../labels'
import { compareTaskOrder, type AgentView, type TaskRecord } from '@agent-drove/shared'

const store = useAppStore()
const searchRef = ref<{ focus: () => void } | null>(null)

// 快捷键: Ctrl/Cmd+K 搜索，Alt+↑/↓ 微调当前任务顺序
function onHotkey(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchRef.value?.focus()
  } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    const selId = store.selectedTaskId.value
    if (!selId) return
    const idx = visible.value.findIndex((t) => t.id === selId)
    if (idx < 0) return
    event.preventDefault()
    if (event.key === 'ArrowUp' && idx > 0) {
      const prev = visible.value[idx - 1]
      void store.reorderTask(selId, prev ? prev.id : null).then(() => store.showToast('已上移'))
    } else if (event.key === 'ArrowDown' && idx < visible.value.length - 1) {
      const nextNext = visible.value[idx + 2]
      void store.reorderTask(selId, nextNext ? nextNext.id : null).then(() => store.showToast('已下移'))
    }
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

/**
 * G2-01:『全部』视图按工作区分组渲染——按 visible 首现顺序分桶,组内序沿用 visible
 * (各分组已按 compareTaskOrder 排好);组名口径与卡片 ws-tag 一致(daily→日常,空→未分组)。
 */
const groupedVisible = computed(() => {
  const groups: Array<{ projectId: string; name: string; tasks: TaskRecord[] }> = []
  const byId = new Map<string, { projectId: string; name: string; tasks: TaskRecord[] }>()
  for (const t of visible.value) {
    const pid = t.projectId ?? ''
    let group = byId.get(pid)
    if (!group) {
      const name =
        !pid
          ? '未分组'
          : pid === 'daily'
            ? '日常'
            : (store.projects.value.find((p) => p.id === pid)?.name ?? '未分组')
      group = { projectId: pid, name, tasks: [] }
      byId.set(pid, group)
      groups.push(group)
    }
    group.tasks.push(t)
  }
  return groups
})

/** G2-01:组头仅在多组时显示——单工作区视图(侧栏选中/仅剩一组)不添噪 */
const showGroupHeaders = computed(() => groupedVisible.value.length > 1)

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

// G2-03:筛选/工作区切换收敛 selection——否则『失败』筛选全选后切回全部,选中集仍含
// 不可见任务,全选按钮语义反转,批量删除可能命中看不见的任务(仅改写 selection,不加 store 动作)
watch(
  [() => store.filter.value, () => store.selectedProjectId.value],
  () => {
    const ids = new Set(visible.value.map((t) => t.id))
    store.selection.value = new Set([...store.selection.value].filter((id) => ids.has(id)))
  },
  { deep: true },
)

// ---- 批量/破坏性操作应用内确认层(G2-03):统一替代原生 confirm,Esc 取消、Enter 确认 ----
type ConfirmAsk = { title: string; body: string; okLabel: string; run: () => Promise<void> }
const confirmAsk = ref<ConfirmAsk | null>(null)

function cancelConfirm(): void {
  confirmAsk.value = null
}

async function acceptConfirm(): Promise<void> {
  const ask = confirmAsk.value
  if (!ask) return
  confirmAsk.value = null
  await ask.run()
}

/** Enter 确认(GlassModal 自带 Esc 取消);IME 组词态的 Enter 不算确认意图 */
function onConfirmKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter') {
    event.preventDefault()
    void acceptConfirm()
  }
}

watch(confirmAsk, (ask) => {
  if (ask) window.addEventListener('keydown', onConfirmKeydown)
  else window.removeEventListener('keydown', onConfirmKeydown)
})

function batchCancel(): void {
  if (store.selection.value.size === 0) return
  const ids = [...store.selection.value]
  confirmAsk.value = {
    title: '批量取消',
    body: `将终止选中的 ${ids.length} 条任务,不可恢复。`,
    okLabel: '确认取消',
    run: async () => {
      await window.api.tasksBatchCancel(ids)
      await store.refreshTasks()
      // G2-03:执行成功后才清空 selection,失败保留可重试
      store.selection.value = new Set()
    },
  }
}

function batchDelete(): void {
  const ids = [...store.selection.value]
  if (ids.length === 0) return
  confirmAsk.value = {
    title: '批量删除',
    body: `删除 ${ids.length} 条任务及其事件记录?运行中的任务会跳过。`,
    okLabel: '确认删除',
    run: async () => {
      await window.api.tasksBatchDelete(ids)
      await store.refreshTasks()
      store.selection.value = new Set()
    },
  }
}

/**
 * 批量移动到目标工作区(R22):选中项逐条走既有 tasks:move 通道(乐观更新+重拉),
 * 已在目标组的条目跳过;toast 只报真实变更条数。选完即复位下拉,便于继续操作。
 */
const batchMoveTarget = ref('')
const batchMoveOptions = computed(() =>
  store.projects.value.map((p) => ({ value: p.id, label: p.name })),
)

async function onBatchMoveTo(projectId: string): Promise<void> {
  batchMoveTarget.value = ''
  if (!projectId) return
  let moved = 0
  for (const id of [...store.selection.value]) {
    const task = store.tasks.value.find((t) => t.id === id)
    if (!task || task.projectId === projectId) continue
    await store.moveTask(id, projectId)
    moved++
  }
  if (moved > 0) store.showToast(`已移动 ${moved} 条`)
}

/** 空态「去输入」(R22):复用既有 focus-composer 事件,Composer 挂载时已监听 */
function focusComposer(): void {
  window.dispatchEvent(new CustomEvent('focus-composer'))
}

// G2-02:选中任务迁移(追问自动接续/续聊派生新卡)后滚动跟随——新卡在视口外时,
// 用户也能立刻看到「当前对话在哪」
const listRef = ref<HTMLElement | null>(null)
watch(
  () => store.selectedTaskId.value,
  async (id) => {
    if (!id) return
    await nextTick()
    listRef.value?.querySelector(`[data-task-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  },
)

// G2-03:筛选把列表滤空时与「没有任务」区分,提供一键清除
const filteredEmpty = computed(
  () =>
    visible.value.length === 0 &&
    !!(store.filter.value.search || store.filter.value.agentId || store.filter.value.state),
)

function clearFilters(): void {
  store.filter.value.search = ''
  store.filter.value.agentId = ''
  store.filter.value.state = ''
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
/**
 * 插入指示线状态:dropBeforeId=线画在该卡之前(null+atEnd=画列表末尾);
 * dropAtEnd=true 表示落点语义是「组尾」(提交 beforeId=null),此时线锚定在
 * 本组末张同组卡之后(即下一张可见卡前)——该卡可能是异组卡,仅作视觉边界,
 * 提交语义由 dropAtEnd 单独表达,与锚点 id 解耦(R21)。
 */
const dropBeforeId = ref<string | null>(null)
const dropAtEnd = ref(false)
const dragOverGroupId = ref<string | null>(null)

function clearDropMark(): void {
  dropBeforeId.value = null
  dropAtEnd.value = false
  dragOverGroupId.value = null
}

function onGroupDragOver(projectId: string, event: DragEvent): void {
  if (!store.draggingTaskId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverGroupId.value = projectId
}

function onGroupDragLeave(projectId: string, event: DragEvent): void {
  const to = event.relatedTarget as Node | null
  if (to && (event.currentTarget as HTMLElement).contains(to)) return
  if (dragOverGroupId.value === projectId) dragOverGroupId.value = null
}

async function onGroupDrop(projectId: string, event: DragEvent): Promise<void> {
  event.preventDefault()
  dragOverGroupId.value = null
  const dragId = store.draggingTaskId.value
  if (!dragId) return
  store.draggingTaskId.value = null
  clearDropMark()

  const batchIds = store.selection.value.has(dragId) && store.selection.value.size > 1
    ? [...store.selection.value]
    : [dragId]

  let moved = 0
  for (const id of batchIds) {
    const t = store.tasks.value.find((item) => item.id === id)
    if (t && (t.projectId ?? 'daily') !== projectId) {
      await store.moveTask(id, projectId)
      moved++
    }
  }
  if (moved > 0) {
    store.showToast(`已归类 ${moved} 条任务到目标工作区`)
  }
}

/**
 * 悬停卡片(G2-01):同组/跨组一律画插入线——上半部插本卡前、下半部插到本组下一张
 * 同组卡前(本组末张=组尾);跨组落点的提交语义(改归属+组内落位)由 commitDrop 表达。
 * next 锚定同组卡而非紧邻可见卡:「全部」视图组卡交错,锚到异组卡会把组内排序
 * 落点与指示线一起带偏(复审发现 6)。
 */
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
  const next = visible.value.slice(idx + 1).find((t) => t.projectId === task.projectId)
  if (next) {
    dropAtEnd.value = false
    dropBeforeId.value = next.id
  } else {
    // 本卡即本组末张:组尾落点——线锚定其后下一张可见卡(组边界,可能是异组卡),
    // 本卡就是列表末卡时 beforeId=null 画列表末尾;提交语义由 atEnd 表达
    const nextVisible = visible.value[idx + 1]
    dropBeforeId.value = nextVisible ? nextVisible.id : null
    dropAtEnd.value = true
  }
}

function onCardDrop(task: TaskRecord, event: DragEvent): void {
  event.preventDefault()
  if (!store.draggingTaskId.value) return
  const beforeId = dropBeforeId.value
  const atEnd = dropAtEnd.value
  clearDropMark()
  void commitDrop(atEnd ? null : (beforeId ?? task.id))
}

/**
 * 列表空白区(容器本体):视为移到拖拽卡所在组的组尾(同组重排,恒合法)。
 * 指示线锚定本组末张同组卡之后——即下一张可见卡之前(可能是异组卡,仅作组边界);
 * 本组末卡就是列表末卡时 beforeId=null,线画列表末尾(复审发现 6)。
 */
function onListDragOver(event: DragEvent): void {
  if (!store.draggingTaskId.value || event.target !== event.currentTarget) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const dragTask = store.tasks.value.find((t) => t.id === store.draggingTaskId.value)
  if (dragTask) {
    for (let i = visible.value.length - 1; i >= 0; i--) {
      const t = visible.value[i]!
      if (t.projectId !== dragTask.projectId) continue
      const nextVisible = visible.value[i + 1]
      dropBeforeId.value = nextVisible ? nextVisible.id : null
      dropAtEnd.value = true
      return
    }
  }
  dropBeforeId.value = null
  dropAtEnd.value = true
}

function onListDrop(event: DragEvent): void {
  if (event.target !== event.currentTarget) return
  event.preventDefault()
  clearDropMark()
  if (!store.draggingTaskId.value) return
  void commitDrop(null)
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
 * 落点提交(P0-2/R21/G2-01):同组落点走 tasks:reorder 相邻插入;组尾落点(beforeId=null)
 * 即移到拖拽卡所在组的组尾;跨组落点直接完成归类,不生硬拦截。
 * 支持单项及多选批量拖拽。
 */
async function commitDrop(beforeId: string | null): Promise<void> {
  const dragId = store.draggingTaskId.value
  if (!dragId) return
  const dragTask = store.tasks.value.find((t) => t.id === dragId)
  if (!dragTask) return
  store.draggingTaskId.value = null

  const batchIds = store.selection.value.has(dragId) && store.selection.value.size > 1
    ? [...store.selection.value]
    : [dragId]

  if (beforeId) {
    const anchorTask = store.tasks.value.find((t) => t.id === beforeId)
    const anchorProjectId = anchorTask?.projectId ?? 'daily'
    for (const id of batchIds) {
      const t = store.tasks.value.find((item) => item.id === id)
      if (t && (t.projectId ?? 'daily') !== anchorProjectId) {
        await store.moveTask(id, anchorProjectId)
      }
    }
  }

  for (const id of batchIds) {
    await reorderAndConfirm(id, beforeId)
  }
}

/**
 * G2-01:组内落位提交;以顺序快照判断真实落位——reorderTask 失败时内部已 toast 并
 * 重拉还原(快照复原),此时不覆盖失败提示,成功才报确认。
 */
async function reorderAndConfirm(taskId: string, beforeId: string | null): Promise<void> {
  const before = store.tasks.value.map((t) => t.id).join(',')
  await store.reorderTask(taskId, beforeId)
  if (store.tasks.value.map((t) => t.id).join(',') !== before) {
    store.showToast('已在该工作区内完成排序')
  }
}

// ---- 卡片右键菜单: 移动到…/移出/取消任务/重命名/删除 ----
const ctxTask = ref<TaskRecord | null>(null)
const ctxX = ref(0)
const ctxY = ref(0)

// G2-04:右键「重命名」应用内输入层(仿 AgentRail 工作区重命名)
const renameTask = ref<TaskRecord | null>(null)
const renameText = ref('')

async function commitRename(): Promise<void> {
  const target = renameTask.value
  if (!target || !renameText.value.trim()) return
  await store.renameTask(target.id, renameText.value)
  renameTask.value = null
}

function openContextMenu(task: TaskRecord, event: MouseEvent): void {
  ctxTask.value = task
  ctxX.value = event.clientX
  ctxY.value = event.clientY
}

function deleteTask(taskId: string): void {
  const task = store.tasks.value.find((t) => t.id === taskId)
  const name = (task?.title || task?.prompt || '').replace(/\s+/g, ' ').slice(0, 24)
  confirmAsk.value = {
    title: '删除任务',
    body: `删除任务「${name}」及其事件记录?运行中的任务会跳过。`,
    okLabel: '确认删除',
    run: async () => {
      await window.api.tasksBatchDelete([taskId])
      await store.refreshTasks()
    },
  }
}

/**
 * 换客户端重跑(R23):与详情页「换客户端派发」同通道(tasksResubmitOn:attempt+1、
 * retry_of 记链、模型映射目标 default_model、附件按能力继承),成功后选中新任务,
 * 无需先展开详情栏;skills 不随重跑携带,与既有入口一致。
 */
async function resubmitOn(task: TaskRecord, agent: AgentView): Promise<void> {
  try {
    const next = await window.api.tasksResubmitOn(task.id, agent.id)
    await store.refreshTasks()
    store.selectedTaskId.value = next.id
    store.showToast(`已用 ${agent.label} 重跑`)
  } catch (error) {
    store.showToast(`重跑失败:${error instanceof Error ? error.message : String(error)}`)
  }
}

const ctxItems = computed<ContextMenuItem[]>(() => {
  const task = ctxTask.value
  if (!task) return []
  const items: ContextMenuItem[] = []

  // 换客户端重跑(R23):一级入口,置顶;运行中任务不可换跑,目标=其他已启用且可后台
  // 派发(headless)的客户端,与 TaskDetailView 的换客户端入口同口径
  if (task.state !== 'running') {
    const targets = store.agents.value.filter(
      (a) => a.id !== task.agentId && a.enabled && a.capabilities.headless,
    )
    if (targets.length > 0) {
      items.push({ key: 'grp-resubmit', label: '换客户端重跑', group: true })
      for (const a of targets) {
        items.push({
          key: `resubmit:${a.id}`,
          label: `用「${a.label}」重跑`,
          action: () => void resubmitOn(task, a),
        })
      }
    }
  }

  // 快速移动到其他工作区
  const targets = store.projects.value.filter((p) => p.id !== task.projectId)
  if (targets.length > 0) {
    items.push({ key: 'grp-move', label: '移动到工作区', group: true })
    for (const p of targets) {
      items.push({
        key: `move:${p.id}`,
        label: `「${p.name}」`,
        action: () => {
          void store.moveTask(task.id, p.id)
          store.showToast(`已移动到「${p.name}」`)
        },
      })
    }
  }

  if (task.projectId && task.projectId !== 'daily') {
    items.push({
      key: 'move-daily',
      label: '移至日常默认工作区',
      action: () => {
        void store.moveTask(task.id, 'daily')
        store.showToast('已移至日常默认工作区')
      },
    })
  }

  items.push({ key: 'grp-ops', label: '任务操作', group: true })

  if (task.state === 'queued' || task.state === 'running') {
    items.push({ key: 'cancel', label: '终止执行', action: () => void store.stopTask(task.id) })
  }

  // G2-04:补上注释承诺的「重命名」——不选中任务也能改名(应用内输入层)
  items.push({
    key: 'rename',
    label: '重命名',
    action: () => {
      renameTask.value = task
      renameText.value = task.title || task.prompt
    },
  })

  items.push({
    key: 'detail',
    label: '查看完整详情',
    action: () => store.openDetailModal(task.id),
  })

  items.push({ key: 'grp-order', label: '调整位置', group: true })
  items.push({
    key: 'order-top',
    label: '移至顶部 (置顶)',
    action: async () => {
      const first = visible.value[0]
      if (first && first.id !== task.id) {
        await store.reorderTask(task.id, first.id)
        store.showToast('已移至顶部')
      }
    },
  })
  items.push({
    key: 'order-bottom',
    label: '移至底部',
    action: async () => {
      await store.reorderTask(task.id, null)
      store.showToast('已移至底部')
    },
  })
  items.push({
    key: 'order-up',
    label: '上移一位',
    action: async () => {
      const idx = visible.value.findIndex((t) => t.id === task.id)
      if (idx > 0) {
        const prev = visible.value[idx - 1]
        await store.reorderTask(task.id, prev.id)
        store.showToast('已上移')
      }
    },
  })
  items.push({
    key: 'order-down',
    label: '下移一位',
    action: async () => {
      const idx = visible.value.findIndex((t) => t.id === task.id)
      if (idx >= 0 && idx < visible.value.length - 1) {
        const after = visible.value[idx + 2]
        await store.reorderTask(task.id, after ? after.id : null)
        store.showToast('已下移')
      }
    },
  })

  items.push({
    key: 'delete',
    label: '删除此任务',
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
      <GlassSelect
        class="batch-move"
        :model-value="batchMoveTarget"
        :options="batchMoveOptions"
        placeholder="移动到…"
        title="把选中的任务移动到目标工作区"
        @update:model-value="onBatchMoveTo"
      />
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

    <div
      ref="listRef"
      class="list"
      @dragover="onListDragOver"
      @drop="onListDrop"
      @dragleave="onListDragLeave"
    >
      <!-- G2-01:按工作区分组的组头+组块，支持整组容器作为 Drop Target 接收拖拽归类 -->
      <section
        v-for="group in groupedVisible"
        :key="group.projectId"
        class="task-group"
        :class="{ 'group-drag-active': dragOverGroupId === group.projectId }"
        @dragover="onGroupDragOver(group.projectId, $event)"
        @dragleave="onGroupDragLeave(group.projectId, $event)"
        @drop="onGroupDrop(group.projectId, $event)"
      >
        <header v-if="showGroupHeaders" class="group-head">
          <span class="band" aria-hidden="true" />
          <span class="g-name">{{ group.name }}</span>
          <span class="g-count num">{{ group.tasks.length }} 条</span>
          <span v-if="dragOverGroupId === group.projectId" class="drop-hint-tag">松手归类至此</span>
        </header>
        <template v-for="task in group.tasks" :key="task.id">
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
      </section>
      <!-- 组尾线:锚到组边界卡时画在其前,仅组尾=列表末尾时才画末尾线(避免双线) -->
      <div v-if="dropAtEnd && !dropBeforeId" class="drop-line" aria-hidden="true" />
      <div v-if="visible.length === 0" class="empty">
        <!-- G2-03:筛选把列表滤空时与「没有任务」区分,提供一键清除 -->
        <template v-if="filteredEmpty">
          <p class="big">无匹配任务</p>
          <p class="sub">当前筛选条件下没有可见任务,可一键恢复全量列表。</p>
          <GlassButton class="empty-go" size="sm" variant="ghost" @click="clearFilters">
            清除筛选
          </GlassButton>
        </template>
        <template v-else>
          <p class="big">{{ activeProject ? '该工作区还没有任务' : '还没有任务' }}</p>
          <p class="sub">在右侧发布框写下第一条,Enter 派发。</p>
          <GlassButton class="empty-go" size="sm" variant="ghost" @click="focusComposer">
            去输入
          </GlassButton>
        </template>
      </div>
    </div>

    <!-- 卡片右键菜单(P0-2/G2-04):移动到…/重命名/取消任务/删除 -->
    <TaskContextMenu
      v-if="ctxTask"
      :x="ctxX"
      :y="ctxY"
      :items="ctxItems"
      @close="ctxTask = null"
    />

    <!-- G2-04:右键「重命名」应用内输入层(Enter 提交) -->
    <GlassModal v-if="renameTask" open title="重命名任务" width="420px" @close="renameTask = null">
      <label class="rename">
        <span>名称</span>
        <GlassInput
          v-model="renameText"
          placeholder="任务名称"
          @keydown.enter.exact.prevent="commitRename"
        />
      </label>
      <template #footer>
        <span class="foot-spacer" />
        <GlassButton variant="ghost" @click="renameTask = null">取消</GlassButton>
        <GlassButton variant="primary" :disabled="!renameText.trim()" @click="commitRename">
          保存
        </GlassButton>
      </template>
    </GlassModal>

    <!-- G2-03:批量/破坏性操作应用内确认层(Esc 取消、Enter 确认) -->
    <GlassModal :open="confirmAsk !== null" :title="confirmAsk?.title" width="420px" @close="cancelConfirm">
      <p class="confirm-body">{{ confirmAsk?.body }}</p>
      <template #footer>
        <span class="foot-spacer" />
        <GlassButton variant="ghost" @click="cancelConfirm">取消</GlassButton>
        <GlassButton variant="danger" @click="acceptConfirm">{{ confirmAsk?.okLabel }}</GlassButton>
      </template>
    </GlassModal>
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
  flex-wrap: wrap;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

.filters > :first-child {
  flex: 1 1 120px;
  min-width: 0;
  max-width: 100%;
}

.filters :deep(.g-select-wrap) {
  flex: 1 1 88px;
  min-width: 0;
  max-width: 100%;
}

.batch {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
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

/* G2-01:工作区分组结构——支持整组拖拽接收与高亮 */
.task-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: var(--radius-md);
  padding: 2px;
  transition: background 160ms var(--ease), outline 160ms var(--ease);
}

.task-group.group-drag-active {
  background: var(--accent-dim);
  outline: 2px dashed var(--accent-strong);
}

.drop-hint-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  margin-left: auto;
  animation: pulseHint 0.8s ease infinite alternate;
}

@keyframes pulseHint {
  from { opacity: 0.8; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1.02); }
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 2px 0;
  user-select: none;
}

.group-head .band {
  width: 3px;
  align-self: stretch;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0.8;
}

.g-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}

.g-count {
  font-size: 11px;
  color: var(--faint);
}

/* G2-04:重命名弹窗输入行(仿 AgentRail) */
.rename {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}

/* G2-03:确认弹窗正文与 footer 弹性占位 */
.confirm-body {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;
}

.foot-spacer {
  flex: 1;
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

/* 空态「去输入」(R22):聚焦右侧发布框 */
.empty-go {
  margin-top: 12px;
}

/* 批量工具条的「移动到…」下拉(R22):略宽于 GlassSelect 默认,容纳工作区名 */
.batch-move {
  min-width: 104px;
}

/* 拖拽插入指示线:发光槽指示，醒目且不顶开卡片布局 */
.drop-line {
  height: 3px;
  margin: -5.5px 0;
  border-radius: 2px;
  background: var(--accent-strong);
  box-shadow: 0 0 10px var(--accent), 0 0 4px var(--accent-line);
  position: relative;
  z-index: 10;
  flex: none;
}
</style>
