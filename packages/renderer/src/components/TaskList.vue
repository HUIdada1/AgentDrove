<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import TaskCard from './TaskCard.vue'
import TaskContextMenu, { type ContextMenuItem } from './ContextMenu.vue'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassModal from '../ui/GlassModal.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import { STATE_FILTER_OPTIONS, DAILY_PROJECT_ID, normalizeProjectGroupId, projectGroupLabel } from '../labels'
import { compareTaskOrder, type AgentView, type TaskRecord } from '@agent-drove/shared'

const store = useAppStore()
const searchRef = ref<{ focus: () => void } | null>(null)

/** A-17:输入焦点内不抢快捷键 */
function isTextFocus(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  const tag = el?.tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el?.isContentEditable === true
}

// 快捷键: Ctrl/Cmd+K 搜索，Alt+↑/↓ 微调当前任务顺序(同组内)，Esc 退出多选
function onHotkey(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchRef.value?.focus()
    return
  }
  // A-09:Esc 退出多选(确认层打开时让位给确认层自己的 Esc 取消;
  // B3:搜索框等文本焦点内让位给文本编辑,框内 Esc 不清空整个多选)
  if (event.key === 'Escape' && selecting.value && !confirmAsk.value && !isTextFocus(event.target)) {
    store.selection.value = new Set()
    return
  }
  // A-17:输入框/富文本焦点内让位给文本编辑,不劫持 Alt+↑↓
  if (!event.altKey || isTextFocus(event.target)) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  const selId = store.selectedTaskId.value
  if (!selId) return
  event.preventDefault()
  void nudgeTask(selId, event.key === 'ArrowUp' ? 'up' : 'down')
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
    const key = normalizeProjectGroupId(t.projectId)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(t)
    else buckets.set(key, [t])
  }
  for (const bucket of buckets.values()) bucket.sort(compareTaskOrder)
  // 按原(createdAt 倒序)骨架逐槽放回各分组排序后的元素:组内有序,组间交错不变
  const cursors = new Map<string, number>()
  return filtered.map((t) => {
    const key = normalizeProjectGroupId(t.projectId)
    const index = cursors.get(key) ?? 0
    cursors.set(key, index + 1)
    return buckets.get(key)![index]!
  })
})

/**
 * A-02:沿方向跳过异组卡取同组相邻卡——位置微调(Alt+↑↓/上移/下移)在多工作区交错视图下
 * 只能以同组卡为锚点,否则锚点异组会被 store clamp 成组尾,出现「微调反而跳到组底」。
 */
function sameGroupNeighbor(
  list: TaskRecord[],
  taskId: string,
  dir: 'up' | 'down',
): TaskRecord | null {
  const index = list.findIndex((t) => t.id === taskId)
  if (index < 0) return null
  const group = normalizeProjectGroupId(list[index]!.projectId)
  const step = dir === 'up' ? -1 : 1
  for (let i = index + step; i >= 0 && i < list.length; i += step) {
    const candidate = list[i]!
    if (normalizeProjectGroupId(candidate.projectId) === group) return candidate
  }
  return null
}

/** A-02:组内首张卡——「移至顶部」的锚点(取异组首卡等于把卡片顶到组尾) */
function sameGroupFirst(list: TaskRecord[], taskId: string): TaskRecord | null {
  const task = list.find((t) => t.id === taskId)
  if (!task) return null
  const group = normalizeProjectGroupId(task.projectId)
  return list.find((t) => normalizeProjectGroupId(t.projectId) === group) ?? null
}

/** A-02:组内位置微调——到组顶/组底只轻提示不报错(store 侧 clamp 兜底异组锚点) */
async function nudgeTask(taskId: string, dir: 'up' | 'down'): Promise<void> {
  if (dir === 'up') {
    const prev = sameGroupNeighbor(visible.value, taskId, 'up')
    if (!prev) {
      store.showToast('已在组顶')
      return
    }
    await store.reorderTask(taskId, prev.id)
    return
  }
  const next = sameGroupNeighbor(visible.value, taskId, 'down')
  if (!next) {
    store.showToast('已在组底')
    return
  }
  const after = sameGroupNeighbor(visible.value, next.id, 'down')
  await store.reorderTask(taskId, after ? after.id : null)
}

/**
 * G2-01:『全部』视图按工作区分组渲染——按 visible 首现顺序分桶,组内序沿用 visible
 * (各分组已按 compareTaskOrder 排好);组键/组名走 labels 单一口径(A-06),
 * 空归属与 daily 同组,不再出现「未分组」。
 */
const groupedVisible = computed(() => {
  const groups: Array<{ projectId: string; name: string; tasks: TaskRecord[] }> = []
  const byId = new Map<string, { projectId: string; name: string; tasks: TaskRecord[] }>()
  for (const t of visible.value) {
    const pid = normalizeProjectGroupId(t.projectId)
    let group = byId.get(pid)
    if (!group) {
      group = { projectId: pid, name: projectGroupLabel(pid, store.projects.value), tasks: [] }
      byId.set(pid, group)
      groups.push(group)
    }
    group.tasks.push(t)
  }
  return groups
})

/** G2-01:组头仅在多组时显示——单工作区视图(侧栏选中/仅剩一组)不添噪 */
const showGroupHeaders = computed(() => groupedVisible.value.length > 1)

/** A-20:组折叠态只在多组视图生效——单组视图没有组头 chevron,折叠会让卡片无处展开 */
function groupCollapsed(groupId: string): boolean {
  return showGroupHeaders.value && store.collapsedGroups.value.has(groupId)
}

/**
 * B2:渲染序 id 序列——与模板渲染顺序严格一致:按 groupedVisible 的分组顺序扁平化,
 * 折叠组整组跳过(组内卡片不可见)。Shift 范围选/全选以此为口径,
 * 避免漏选交错序两端之间的卡、避免选中折叠组内看不见的卡。
 */
const renderOrderIds = computed(() => {
  const ids: string[] = []
  for (const group of groupedVisible.value) {
    if (groupCollapsed(group.projectId)) continue
    for (const t of group.tasks) ids.push(t.id)
  }
  return ids
})

/** A-03:当前对话客户端展示名(侧栏选中即联动显示,空则整条不渲染) */
const agentContextLabel = computed(() => {
  const id = store.agentContext.value
  if (!id) return ''
  return store.agents.value.find((a) => a.id === id)?.label ?? id
})

const activeProject = computed(() => store.selectedProject.value)

const selecting = computed(() => store.selection.value.size > 0)

/** 客户端下拉与卡片展示名共用一份 id→label 映射,避免每次渲染重建数组 */
const agentLabels = computed(() => new Map(store.agents.value.map((a) => [a.id, a.label])))

const agentOptions = computed(() => [
  { value: '', label: '全部客户端' },
  ...store.agents.value.map((a) => ({ value: a.id, label: a.label })),
])

/** A-09:Shift 范围选锚点(最近一次勾选的卡) */
const lastCheckedId = ref<string | null>(null)

function toggleSelect(id: string, range = false): void {
  if (range && lastCheckedId.value && lastCheckedId.value !== id) {
    // B2:范围选按渲染序(可见卡序列)取区间,而非 visible 的全局交错序
    const list = renderOrderIds.value
    const from = list.findIndex((tid) => tid === lastCheckedId.value)
    const to = list.findIndex((tid) => tid === id)
    if (from >= 0 && to >= 0) {
      const next = new Set(store.selection.value)
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(list[i]!)
      store.selection.value = next
      lastCheckedId.value = id
      return
    }
  }
  const next = new Set(store.selection.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  store.selection.value = next
  lastCheckedId.value = id
}

/** 退出多选(清空选中)后范围的锚点一并失效,避免下次 Shift 拉出意外区间 */
watch(
  () => store.selection.value.size,
  (size) => {
    if (size === 0) lastCheckedId.value = null
  },
)

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
 * 批量移动到目标工作区(A-14):整批走 store.moveTasks——批量期间抑制逐条重拉,
 * 末尾统一刷新一次;成功 toast 与「撤销」动作由 store 发出,此处只在零变更时补轻提示。
 */
const batchMoveTarget = ref('')
const batchMoveOptions = computed(() =>
  store.projects.value.map((p) => ({ value: p.id, label: p.name })),
)

async function onBatchMoveTo(projectId: string): Promise<void> {
  batchMoveTarget.value = ''
  if (!projectId) return
  const ids = [...store.selection.value]
  if (ids.length === 0) return
  const moved = await store.moveTasks(ids, projectId)
  if (moved === 0) store.showToast('选中卡片已在该工作区')
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

function onCardClick(task: TaskRecord, event: MouseEvent): void {
  // A-09:Shift+点击即选择意图——尚未进入多选模式时也以本卡为锚点进入,再 Shift 点即拉范围
  if (selecting.value || event.shiftKey) {
    toggleSelect(task.id, event.shiftKey)
    return
  }
  store.selectedTaskId.value = task.id
}

function onSearch(value: string): void {
  store.filter.value.search = value
}

/** 全选当前渲染出的卡片(折叠组内不可见卡不计入),再点一次取消全选 */
function toggleSelectAll(): void {
  const list = renderOrderIds.value
  const allSelected = list.length > 0 && list.every((id) => store.selection.value.has(id))
  store.selection.value = allSelected ? new Set() : new Set(list)
}

// ---- 拖拽归类与组内排序(P0-2/A-01) ----
/**
 * 落点结构化(A-01):{ groupId, beforeId } —— beforeId=null 表示该组组尾。
 * 插入线按落点渲染(组内锚点卡之前 / 组块末尾),提交时消费同一份数据,
 * 结构上保证「线画在哪,松手就落在哪」;不再用「借异组卡当锚点」的视觉代偿。
 */
const dropTarget = ref<{ groupId: string; beforeId: string | null } | null>(null)
const dragOverGroupId = ref<string | null>(null)

function clearDropMark(): void {
  dropTarget.value = null
  dragOverGroupId.value = null
}

/** 插入线:落在目标组内某张卡之前 */
function isDropBefore(groupId: string, taskId: string): boolean {
  const target = dropTarget.value
  return !!target && target.groupId === groupId && target.beforeId === taskId
}

/** 插入线:落在目标组组尾(组块最后一张卡之后) */
function isDropAtGroupEnd(groupId: string): boolean {
  const target = dropTarget.value
  return !!target && target.groupId === groupId && target.beforeId === null
}

/** 多选拖拽:拖拽卡在选中集内且有同伴时整批走 */
function dragBatchIds(dragId: string): string[] {
  return store.selection.value.has(dragId) && store.selection.value.size > 1
    ? [...store.selection.value]
    : [dragId]
}

/**
 * A-13:dragover 性能——dragstart 时把「可见位次」与「同组后继」预计算成查表,
 * 卡片上高频 dragover 只做 O(1) 读取;拖拽期间可见集变化(筛选/重拉)时重建。
 */
let dragIndexById = new Map<string, number>()
let dragNextSameGroupId = new Map<string, string | null>()

function buildDragTables(): void {
  const list = visible.value
  dragIndexById = new Map()
  dragNextSameGroupId = new Map()
  const tailByGroup = new Map<string, string>()
  for (let i = list.length - 1; i >= 0; i--) {
    const task = list[i]!
    const group = normalizeProjectGroupId(task.projectId)
    dragIndexById.set(task.id, i)
    dragNextSameGroupId.set(task.id, tailByGroup.get(group) ?? null)
    tailByGroup.set(group, task.id)
  }
}

watch(
  () => store.draggingTaskId.value,
  (id) => {
    if (id) buildDragTables()
    else clearDropMark()
  },
)

watch(visible, () => {
  if (store.draggingTaskId.value) buildDragTables()
})

/** 组容器空白处落点:按指针 Y 与组内卡片中线比较,落在哪张卡上就插到它之前,否则组尾 */
function dropTargetFromPointer(
  groupId: string,
  clientY: number,
  container: HTMLElement,
): { groupId: string; beforeId: string | null } {
  for (const card of container.querySelectorAll<HTMLElement>('[data-task-id]')) {
    const rect = card.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return { groupId, beforeId: card.dataset.taskId ?? null }
  }
  return { groupId, beforeId: null }
}

function onGroupDragOver(projectId: string, event: DragEvent): void {
  if (!store.draggingTaskId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverGroupId.value = projectId
  // 卡片上的精确落点由 onCardDragOver 给出;其余(组容器留白、组头)按指针 Y 反推组内落点,
  // 保证任何悬停位置都有与之一致的插入线,不残留上一组的旧落点
  if ((event.target as HTMLElement | null)?.closest('[data-task-id]')) return
  dropTarget.value = dropTargetFromPointer(projectId, event.clientY, event.currentTarget as HTMLElement)
}

function onGroupDragLeave(projectId: string, event: DragEvent): void {
  const to = event.relatedTarget as Node | null
  if (to && (event.currentTarget as HTMLElement).contains(to)) return
  if (dragOverGroupId.value === projectId) dragOverGroupId.value = null
}

/** 组容器落点:优先消费当前结构化落点,缺失时按本组组尾兜底 */
async function onGroupDrop(projectId: string, event: DragEvent): Promise<void> {
  event.preventDefault()
  if (!store.draggingTaskId.value) return
  const target =
    dropTarget.value?.groupId === projectId ? dropTarget.value : { groupId: projectId, beforeId: null }
  dragOverGroupId.value = null
  clearDropMark()
  // 落进折叠组先展开:松手要能看见卡片去了哪儿
  if (store.collapsedGroups.value.has(projectId)) store.toggleGroup(projectId)
  await runDropCommit(target)
}

/**
 * 悬停卡片(A-01):上半部=插本卡前;下半部=插本组下一张同组卡前,本组末张则=组尾。
 * 落点(组 id + 锚点)一次成型,提交端不再反推,插入线与落点天然同源。
 */
function onCardDragOver(task: TaskRecord, event: DragEvent): void {
  const dragId = store.draggingTaskId.value
  if (!dragId || dragId === task.id) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  if (dragIndexById.size === 0) buildDragTables()
  const groupId = normalizeProjectGroupId(task.projectId)
  dragOverGroupId.value = groupId
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  if (event.clientY < rect.top + rect.height / 2) {
    dropTarget.value = { groupId, beforeId: task.id }
    return
  }
  dropTarget.value = { groupId, beforeId: dragNextSameGroupId.get(task.id) ?? null }
}

function onCardDrop(task: TaskRecord, event: DragEvent): void {
  event.preventDefault()
  // 阻止冒泡到组容器:否则一次松手会走两遍落点提交
  event.stopPropagation()
  if (!store.draggingTaskId.value) return
  const target = dropTarget.value ?? {
    groupId: normalizeProjectGroupId(task.projectId),
    beforeId: task.id,
  }
  clearDropMark()
  void runDropCommit(target)
}

/**
 * 列表空白区(A-01):落点固定为「最后一个可见组的组尾」——
 * 不再随拖拽卡所在组变化,插入线与落点同源。
 */
function onListDragOver(event: DragEvent): void {
  if (!store.draggingTaskId.value || event.target !== event.currentTarget) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const lastGroup = groupedVisible.value[groupedVisible.value.length - 1]
  dragOverGroupId.value = null
  dropTarget.value = lastGroup ? { groupId: lastGroup.projectId, beforeId: null } : null
}

function onListDrop(event: DragEvent): void {
  if (event.target !== event.currentTarget) return
  event.preventDefault()
  const target = dropTarget.value
  clearDropMark()
  if (!store.draggingTaskId.value || !target) return
  void runDropCommit(target)
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
 * 落点提交(A-01/A-14):先对异组卡完成归属迁移,再对整批做组内落位(beforeId=null 即组尾)。
 * B1:零变更提示只在跨组拖拽(批次内有卡不属于落点组)时补一句,不报错;
 * 同组拖拽只做组内排序,零变更由 store 保持静默,此处不得插话——
 * 否则会顶掉 store 成功 toast 里的「撤销」按钮。
 */
async function runDropCommit(target: { groupId: string; beforeId: string | null }): Promise<void> {
  const result = await commitDrop(target)
  // 通道缺失等异常路径下 store 已给出失败原因,此处不再补「已在该工作区」误导性提示
  if (result.crossGroup && result.moved === 0 && window.api?.tasksMove) {
    store.showToast('卡片已在该工作区')
  }
}

/** B4:批次按拖拽前视觉序(可见位次)升序——Set 迭代序与视觉序无关,落下后批内次序会被打乱 */
function sortByDragOrder(ids: string[]): string[] {
  const fallback = Number.MAX_SAFE_INTEGER
  return [...ids].sort(
    (a, b) => (dragIndexById.get(a) ?? fallback) - (dragIndexById.get(b) ?? fallback),
  )
}

async function commitDrop(
  target: { groupId: string; beforeId: string | null },
): Promise<{ moved: number; crossGroup: boolean }> {
  const dragId = store.draggingTaskId.value
  if (!dragId) return { moved: 0, crossGroup: false }
  store.draggingTaskId.value = null
  // B1/P-13:跨组判定取「批次内有卡不属于落点组」,不用 tasks 的 id 序列做变更检测
  // (它恒按 createdAt 倒序,orderIndex 变化检测不到);B4:dragIndexById 在此投产
  const batchIds = sortByDragOrder(dragBatchIds(dragId))

  const foreign = batchIds.filter((id) => {
    const task = store.tasks.value.find((t) => t.id === id)
    return !!task && normalizeProjectGroupId(task.projectId) !== target.groupId
  })
  let moved = 0
  if (foreign.length > 1) moved = await store.moveTasks(foreign, target.groupId)
  else if (foreign.length === 1) moved = (await store.moveTask(foreign[0]!, target.groupId)) ? 1 : 0

  // 组内落位:同一锚点逐条插入会反向,故锚点场景倒序提交,保持批次原有相对顺序;
  // 锚点自身在拖拽批次内时跳过(拿自己当锚点无意义,主进程也会拒绝)
  for (const id of target.beforeId ? [...batchIds].reverse() : batchIds) {
    if (id === target.beforeId) continue
    await store.reorderTask(id, target.beforeId)
  }
  return { moved, crossGroup: foreign.length > 0 }
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

/**
 * 右键菜单(A-11):「换客户端重跑 / 移动到工作区 / 调整位置」折叠为二级子菜单,
 * 顶层常态 ≤7 项;移动与排序的成功 toast(含「撤销」动作)统一由 store 发出,
 * 此处不再自报成功,避免顶掉撤销按钮(P-05)。
 */
const ctxItems = computed<ContextMenuItem[]>(() => {
  const task = ctxTask.value
  if (!task) return []
  const items: ContextMenuItem[] = []

  // 换客户端重跑(R23):运行中任务不可换跑,目标=其他已启用且可后台派发(headless)的客户端
  if (task.state !== 'running') {
    const targets = store.agents.value.filter(
      (a) => a.id !== task.agentId && a.enabled && a.capabilities.headless,
    )
    if (targets.length > 0) {
      items.push({
        key: 'resubmit',
        label: '换客户端重跑',
        children: targets.map((a) => ({
          key: `resubmit:${a.id}`,
          label: `用「${a.label}」重跑`,
          action: () => void resubmitOn(task, a),
        })),
      })
    }
  }

  // 快速移动到其他工作区(A-05/A-06):已在目标组不列;成功提示与「撤销」由 store 发出
  const currentGroup = normalizeProjectGroupId(task.projectId)
  const moveChildren: ContextMenuItem[] = store.projects.value
    .filter((p) => normalizeProjectGroupId(p.id) !== currentGroup)
    .map((p) => ({
      key: `move:${p.id}`,
      label: `「${p.name}」`,
      // P-05:await 真实结果——成功 toast(含「撤销」)与失败原因均由 store 统一发出,
      // 此处不再自报成功,否则会顶掉撤销动作
      action: async () => {
        await store.moveTask(task.id, p.id)
      },
    }))
  if (currentGroup !== DAILY_PROJECT_ID) {
    moveChildren.push({
      key: 'move-daily',
      label: '移至日常默认工作区',
      action: async () => {
        await store.moveTask(task.id, DAILY_PROJECT_ID)
      },
    })
  }
  if (moveChildren.length > 0) {
    items.push({ key: 'move', label: '移动到工作区', children: moveChildren })
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

  // A-02:位置微调全部走同组锚点,到边界只轻提示
  items.push({
    key: 'order',
    label: '调整位置',
    children: [
      {
        key: 'order-top',
        label: '移至顶部 (置顶)',
        action: async () => {
          const first = sameGroupFirst(visible.value, task.id)
          if (!first || first.id === task.id) {
            store.showToast('已在组顶')
            return
          }
          await store.reorderTask(task.id, first.id)
        },
      },
      {
        key: 'order-bottom',
        label: '移至底部',
        action: async () => {
          if (!sameGroupNeighbor(visible.value, task.id, 'down')) {
            store.showToast('已在组底')
            return
          }
          await store.reorderTask(task.id, null)
        },
      },
      { key: 'order-up', label: '上移一位', action: () => void nudgeTask(task.id, 'up') },
      { key: 'order-down', label: '下移一位', action: () => void nudgeTask(task.id, 'down') },
    ],
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
    <!-- A-03:选择 Agent = 进入其上下文——侧栏选中后任务列同屏可见,✕ 一键回到全部对话 -->
    <div v-if="agentContextLabel" class="ctx-bar">
      <span class="ctx-mark" aria-hidden="true">◉</span>
      <span class="ctx-text" :title="`当前对话：${agentContextLabel}`">当前对话：{{ agentContextLabel }}</span>
      <span class="spacer" />
      <button
        type="button"
        class="ctx-clear"
        title="清除对话绑定并恢复全部任务"
        @click="store.setAgentContext('')"
      >
        ✕
      </button>
    </div>

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
      <span class="batch-mode">已进入多选模式</span>
      <span class="num">已选 {{ store.selection.value.size }}</span>
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
        查看全部 ✕
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
        :class="{ 'group-drag-active': dragOverGroupId === group.projectId, collapsed: groupCollapsed(group.projectId) }"
        @dragover="onGroupDragOver(group.projectId, $event)"
        @dragleave="onGroupDragLeave(group.projectId, $event)"
        @drop="onGroupDrop(group.projectId, $event)"
      >
        <header v-if="showGroupHeaders" class="group-head">
          <button
            type="button"
            class="g-toggle"
            :class="{ collapsed: groupCollapsed(group.projectId) }"
            :aria-expanded="!groupCollapsed(group.projectId)"
            :title="groupCollapsed(group.projectId) ? `展开「${group.name}」` : `折叠「${group.name}」`"
            @click="store.toggleGroup(group.projectId)"
          >
            ▾
          </button>
          <span class="band" aria-hidden="true" />
          <span class="g-name">{{ group.name }}</span>
          <span class="g-count num">{{ group.tasks.length }} 条</span>
          <span v-if="dragOverGroupId === group.projectId" class="drop-hint-tag">松手归类至此</span>
        </header>
        <template v-if="!groupCollapsed(group.projectId)">
          <template v-for="task in group.tasks" :key="task.id">
            <div v-if="isDropBefore(group.projectId, task.id)" class="drop-line" aria-hidden="true" />
            <TaskCard
              :task="task"
              :agent-label="agentLabels.get(task.agentId)"
              :selected="store.selectedTaskId.value === task.id"
              :checked="store.selection.value.has(task.id)"
              @click="onCardClick(task, $event)"
              @check="toggleSelect(task.id)"
              @drag-over="onCardDragOver(task, $event)"
              @drop="onCardDrop(task, $event)"
              @drag-end="onDragEnd"
              @context="openContextMenu(task, $event)"
            />
          </template>
        </template>
        <!-- A-01:组尾插入线画在本组组块末尾(折叠组也照画:落点仍是本组组尾) -->
        <div v-if="isDropAtGroupEnd(group.projectId)" class="drop-line" aria-hidden="true" />
      </section>
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

/* A-03:任务列顶部的「当前对话」上下文条——侧栏选择与任务列的联动可见入口 */
.ctx-bar {
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

.ctx-bar .ctx-mark {
  color: var(--accent-strong);
  font-size: 10px;
}

.ctx-text {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-bar .spacer {
  flex: 1;
}

.ctx-clear {
  flex: none;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 4px;
  cursor: pointer;
  transition: color 140ms var(--ease), background 140ms var(--ease);
}

.ctx-clear:hover {
  color: var(--close-hover);
  background: var(--surface-dim);
}

.batch .spacer {
  flex: 1;
}

/* A-09:批量条左端标明已进入多选模式,点击卡片即勾选而非打开详情 */
.batch-mode {
  flex: none;
  font-weight: 600;
  color: var(--accent-strong);
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

/* A-20:折叠组收成一条窄带,一眼可辨「这里有收起的内容」 */
.task-group.collapsed {
  background: var(--surface-dim);
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

/* A-20:组头折叠 chevron——读写 store.collapsedGroups(localStorage 记忆折叠态) */
.g-toggle {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  transition: transform 140ms var(--ease), color 140ms var(--ease), background 140ms var(--ease);
}

.g-toggle:hover {
  color: var(--accent-strong);
  background: var(--accent-dim);
}

.g-toggle.collapsed {
  transform: rotate(-90deg);
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
