import { computed, ref, shallowRef, watch } from 'vue'
import { compareTaskOrder } from '@agent-drove/shared'
import type {
  AgentView,
  AppConfig,
  FollowupQueueItem,
  Project,
  ReasoningEffort,
  StoredEvent,
  TaskRecord,
  UpdateStatus,
  UsageView,
  WorkspaceRow,
} from '@agent-drove/shared'
import {
  DAILY_PROJECT_ID,
  normalizeProjectGroupId,
  projectGroupLabel,
} from '../labels'

/**
 * 全局数据仓库:模块级单例,所有组件共享同一份状态。
 * 只走 window.api 的 typed IPC;事件批推增量合并,任务列表以主进程推送信号触发重拉。
 * (早期版本每次调用新建 ref,组件间状态互不相通——点击卡片详情不刷新就是这个坑)
 */
const agents = ref<AgentView[]>([])
/** G3-10:客户端探测完成标志(签名供侧栏侧 G1-06 复用):false=首轮探活尚未返回,
 * true=至少成功拉取过一次列表——发布框/侧栏据此区分「探测中」与「未发现」两种空态 */
const agentsLoaded = ref(false)
const projects = ref<Project[]>([])
const tasks = ref<TaskRecord[]>([])
const usage = ref<UsageView[]>([])
const settings = ref<AppConfig | null>(null)
const workspaces = ref<WorkspaceRow[]>([])
const updateStatus = ref<UpdateStatus>({ phase: 'idle' })
const view = ref<'panel' | 'settings'>('panel')

/** 侧栏折叠状态(R01):用户偏好持久化,启动时由 App.vue 按当前窗口宽再校验(不足自动折叠) */
const RAIL_COLLAPSED_KEY = 'agentdrove.layout.railCollapsed'
const railCollapsedState = ref(
  typeof localStorage !== 'undefined' ? localStorage.getItem(RAIL_COLLAPSED_KEY) === 'true' : false,
)
/**
 * 当前折叠是否由自动压缩(而非用户点击)造成(C-14):K 组恢复逻辑据此判断
 * 窗口放大后能否回弹到展开态;仅 userInitiated 的变更落盘,自动压缩不污染用户偏好。
 */
const autoRailCollapsed = ref(false)

function persistRailCollapsed(v: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, String(v))
  } catch {
    // 存储不可写(隐私模式/配额满)静默放弃:持久化是增强项,不阻塞折叠交互
  }
}

/**
 * 对外仍是可写 ref:直接赋值(尚未迁移到 setRailCollapsed 的调用点,如侧栏折叠按钮的点击)
 * 视为用户意图并落盘;需要区分自动/用户两种来源时走 setRailCollapsed。
 */
const railCollapsed = computed({
  get: () => railCollapsedState.value,
  set: (v: boolean) => {
    railCollapsedState.value = v
    autoRailCollapsed.value = false
    persistRailCollapsed(v)
  },
})

/** C-14:统一的折叠入口——仅 userInitiated 落盘,自动压缩只改生效态并留下标记 */
export function setRailCollapsed(v: boolean, opts?: { userInitiated?: boolean }): void {
  const userInitiated = opts?.userInitiated === true
  railCollapsedState.value = v
  autoRailCollapsed.value = !userInitiated
  if (userInitiated) persistRailCollapsed(v)
}
/** 详情栏收起/锁起状态:默认 true(收起锁起,会话流视野最大化),持久化偏好 */
const detailCollapsed = ref(
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('agentdrove.layout.detailCollapsed') !== 'false'
    : true,
)
watch(detailCollapsed, (val) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('agentdrove.layout.detailCollapsed', String(val))
  }
})

/** 详情弹窗显隐状态 */
const detailModalOpen = ref(false)

function openDetailModal(taskId?: string): void {
  if (taskId) selectedTaskId.value = taskId
  detailModalOpen.value = true
}

function closeDetailModal(): void {
  detailModalOpen.value = false
}

/**
 * 详情展开前的空间守卫(P0-7/R01):由 App.vue 注册(它持有 railW/taskW/detailW 列宽状态)。
 * 守卫为真阶梯:展开后预估会话流 <360px 时先自动收侧栏 → 任务列压到 280 →
 * 仍不足返回 false 拒绝展开;守卫内部已 toast 说明,此处保持收起。
 */
let expandGuard: (() => boolean) | null = null

export function registerExpandGuard(guard: (() => boolean) | null): void {
  expandGuard = guard
}

function toggleDetailCollapsed(): void {
  // 收起不受限;展开方向先过空间守卫,不通过(已提示)则保持收起
  if (detailCollapsed.value && expandGuard && !expandGuard()) return
  detailCollapsed.value = !detailCollapsed.value
}

/**
 * 打开指定任务(B-20):选中 + 按当前 detailDisplayMode 展开详情(宽屏 docked / 窄屏 drawer
 * 由 App.vue 的同一套 computed 决定,此处只驱动收起开关)。设置页打开时先回面板,
 * 否则「点击查看」类入口会看不到任何变化。
 */
function openTask(taskId: string): void {
  if (!taskId) return
  selectedTaskId.value = taskId
  view.value = 'panel'
  if (detailCollapsed.value) toggleDetailCollapsed()
}

const selectedTaskId = ref<string | null>(null)
const selection = ref<Set<string>>(new Set())
const filter = ref({ search: '', agentId: '', state: '' })
// G3-02:筛选变更 debounce 重拉——此前筛选只改内存,列表要等主进程事件批推才带着旧筛选
// 重拉,搜索清空后列表长期停留在收窄集合;250ms debounce 避免逐字符 IPC
let filterTimer: ReturnType<typeof setTimeout> | null = null
watch(
  filter,
  () => {
    if (filterTimer) clearTimeout(filterTimer)
    filterTimer = setTimeout(() => void refreshTasks(), 250)
  },
  { deep: true },
)
const liveEvents = shallowRef(new Map<string, StoredEvent[]>())

/**
 * 任务列分组折叠态(A-20):键为归一后的分组 id(normalizeProjectGroupId),localStorage 持久化,
 * 与 activeSkills 同款写盘模式(不可写时静默放弃)。
 */
const collapsedGroups = ref<Set<string>>((() => {
  try {
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem('agentdrove.groups.collapsed')
      : null
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')
      ? new Set(parsed as string[])
      : new Set<string>()
  } catch {
    return new Set<string>()
  }
})())

function toggleGroup(groupId: string): void {
  const next = new Set(collapsedGroups.value)
  if (next.has(groupId)) next.delete(groupId)
  else next.add(groupId)
  collapsedGroups.value = next
}

watch(collapsedGroups, (val) => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem('agentdrove.groups.collapsed', JSON.stringify([...val]))
  } catch {
    // 存储不可写(隐私模式/配额满)静默放弃:折叠记忆是增强项,不阻塞分组交互
  }
})

/**
 * 刚被归类/排序的任务 id(A-10):1.2s 内保持,任务卡据此挂描边脉冲;
 * 写入用整表替换保证触发响应式,超时后清空(期间再有操作则顺延)。
 */
const lastMovedTaskIds = ref<Set<string>>(new Set())
let movedHighlightTimer: ReturnType<typeof setTimeout> | null = null

function markMoved(taskIds: string[]): void {
  if (taskIds.length === 0) return
  lastMovedTaskIds.value = new Set([...lastMovedTaskIds.value, ...taskIds])
  if (movedHighlightTimer) clearTimeout(movedHighlightTimer)
  movedHighlightTimer = setTimeout(() => {
    lastMovedTaskIds.value = new Set()
  }, 1200)
}

/**
 * 当前对话上下文的客户端(P0-1/R05/G1-01/A-03):侧栏点击=进入与该 Agent 的对话(发布框同步)并
 * 默认联动任务筛选(filter.agentId);再次点击已绑定 Agent = 保持绑定并聚焦发布框;
 * 传空字符串 = 绑定与筛选同时清除。任务列头下拉仍可独立改筛选(同一 filter 字段,行为不冲突)。
 */
const agentContext = ref('')

/** 正在拖拽的任务卡 id(P0-2):dragstart 写入、dragend/drop 清除;AgentRail 据此接住 drop */
const draggingTaskId = ref<string | null>(null)

/** 当前激活的技能清单:localStorage 持久化(G3-14),重启恢复上次选择;损坏/不可读回落默认四项 */
const DEFAULT_SKILLS = ['terminal', 'file_editor', 'code_search', 'web_search']
const activeSkills = ref<string[]>((() => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('agentdrove.skills') : null
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')
      ? (parsed as string[])
      : DEFAULT_SKILLS
  } catch {
    return DEFAULT_SKILLS
  }
})())
// toggleSkill/setSkills 均经此持久化,与 railCollapsed 同一套「落盘失败静默放弃」策略
watch(activeSkills, (val) => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem('agentdrove.skills', JSON.stringify(val))
  } catch {
    // 存储不可写(隐私模式/配额满)静默放弃:持久化是增强项,不阻塞技能切换
  }
})

/** 当前选中任务的排队追问队列 */
const activeFollowups = ref<FollowupQueueItem[]>([])

function toggleSkill(skillId: string): void {
  const current = new Set(activeSkills.value)
  if (current.has(skillId)) current.delete(skillId)
  else current.add(skillId)
  activeSkills.value = [...current]
}

function setSkills(skills: string[]): void {
  activeSkills.value = [...skills]
}

async function refreshFollowups(taskId: string): Promise<void> {
  if (!taskId || !window.api) {
    activeFollowups.value = []
    return
  }
  try {
    const list = await window.api.tasksGetFollowups(taskId)
    if (selectedTaskId.value === taskId) {
      activeFollowups.value = list
    }
  } catch {
    activeFollowups.value = []
  }
}

async function removeFollowup(taskId: string, followupId: string): Promise<void> {
  if (!window.api) return
  await window.api.tasksRemoveFollowup(taskId, followupId)
  await refreshFollowups(taskId)
}

async function clearFollowups(taskId: string): Promise<void> {
  if (!window.api) return
  await window.api.tasksClearFollowups(taskId)
  await refreshFollowups(taskId)
}

async function renameTask(taskId: string, title: string): Promise<void> {
  if (!window.api || !title.trim()) return
  await window.api.tasksRename(taskId, title.trim())
  await refreshTasks()
}

function newChat(): void {
  selectedTaskId.value = null
  activeFollowups.value = []
  // P0-1:新建对话保持 agentContext 不清除,发布框继续绑定当前客户端
}

/**
 * 选择 Agent = 进入其上下文(A-03/A-18 统一语义):
 * 1. 绑定 agentContext,并默认同步任务筛选 filter.agentId(opts.filterTasks===false 时只绑不筛);
 * 2. agentId 为空 = 绑定与筛选同时清除(「全部对话」入口);
 * 3. 当前打开的任务不属于目标 Agent 时平滑切入新会话草稿(selectedTaskId = null);
 * 4. 点击已绑定 Agent = 保持绑定并聚焦发布框(不再取消绑定)。
 */
function setAgentContext(agentId: string, opts?: { filterTasks?: boolean }): void {
  const next = agentId ?? ''
  agentContext.value = next
  if (opts?.filterTasks !== false) {
    filter.value.agentId = next
  }
  if (!next) return
  if (selectedTaskId.value) {
    const currentTask = tasks.value.find((t) => t.id === selectedTaskId.value)
    if (currentTask && currentTask.agentId !== next) {
      selectedTaskId.value = null
      activeFollowups.value = []
    }
  }
  window.dispatchEvent(new CustomEvent('focus-composer'))
}

/** 旧入口薄封装(J-01):保留导出兼容既有调用点,语义统一走 setAgentContext */
function selectAgentContext(agentId: string): void {
  setAgentContext(agentId)
}

/** 旧入口薄封装(J-01):绑定与筛选同清 */
function clearAgentContext(): void {
  setAgentContext('')
}

/** 轻提示动作按钮(A-21):App.vue 渲染为可点按钮(「撤销」/「点击查看」等) */
export interface ToastAction {
  label: string
  run: () => void
}

/**
 * 轻提示(P0-6/P0-7 配套最小实现):单条文本,App.vue 底部渲染;
 * 带动作时存续延长至 6s,给用户留出点击窗口(无动作仍 2.6s 自动消退)。
 */
const toast = ref('')
const toastAction = ref<ToastAction | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

const TOAST_DURATION_MS = 2600
const TOAST_ACTION_DURATION_MS = 6000

function showToast(msg: string, opts?: { action?: ToastAction }): void {
  const action = opts?.action ?? null
  toast.value = msg
  toastAction.value = action
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
    toastAction.value = null
  }, action ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS)
}

/** A-21 撤销栈条目:记录操作前的归属分组与「组内后继」锚点(见 sameGroupAnchor 注释) */
interface CardOpSnapshot {
  taskId: string
  /** 操作前的归属分组(缺省=旧数据的日常组) */
  projectId?: string
  /** 操作前的组内插位锚点:插到该卡片之前;null = 原在组尾 */
  beforeId: string | null
}

const UNDO_STACK_MAX = 20
/**
 * A-21/D1 撤销栈:一条 = 一次用户操作,条目内可含多张卡片——批量移动整批并为一条,
 * 回放时批内逆序;单卡移动/排序仍是「一条一元素」,行为不变。
 */
const undoStack: CardOpSnapshot[][] = []
/** 撤销回放期间抑制再次入栈与撤销 toast,避免「撤销的撤销」递归 */
let replayingUndo = false

/** 可下发给 tasks:move 的分组 id:空串(旧数据/未选工作区)按日常处理,绝不把空 id 发给主进程 */
function movableProjectId(pid?: string | null): string {
  const id = normalizeProjectGroupId(pid)
  return id === '' ? DAILY_PROJECT_ID : id
}

/**
 * 任务在「组内展示序」(与 TaskList.visible 同一 compareTaskOrder 口径)中的后继 id。
 * tasks:reorder 是「插入到锚点之前」语义,故还原原位必须用后继当锚点
 * (用前驱会把卡片插到前驱之前,整体前移一位);已是组尾则返回 null(=移到组尾)。
 */
function sameGroupAnchor(taskId: string): string | null {
  const task = tasks.value.find((t) => t.id === taskId)
  if (!task) return null
  const group = normalizeProjectGroupId(task.projectId)
  const peers = tasks.value
    .filter((t) => normalizeProjectGroupId(t.projectId) === group)
    .sort(compareTaskOrder)
  const index = peers.findIndex((t) => t.id === taskId)
  if (index < 0 || index === peers.length - 1) return null
  return peers[index + 1]!.id ?? null
}

/** 入栈一次操作(单卡 [snapshot] / 批量 = 整批快照);栈上限按「操作数」裁掉最旧条目 */
function pushUndo(snapshots: CardOpSnapshot[]): void {
  if (replayingUndo || snapshots.length === 0) return
  undoStack.push(snapshots)
  if (undoStack.length > UNDO_STACK_MAX) undoStack.shift()
}

/** 移动/排序成功收尾:卡片脉冲 + 附「撤销」动作的 toast(回放撤销时不重复弹出) */
function afterCardOpSuccess(message: string, movedIds: string[]): void {
  markMoved(movedIds)
  if (replayingUndo) return
  showToast(message, { action: { label: '撤销', run: () => void undoLastCardOp() } })
}

/**
 * 任务卡归属变更(P0-2):乐观改本地 projectId(筛选视图即时反映),
 * 落库走 tasks:move 通道;core 重算受影响分组 orderIndex,客户端不传全量数组。
 * 返回 true = 真实移动成功(A-05/P-05 据此决定是否补成功提示);
 * false = 未移动(任务不存在/已在该分组)或失败(内部已 toast)。
 */
async function moveTask(taskId: string, projectId: string): Promise<boolean> {
  const task = tasks.value.find((t) => t.id === taskId)
  if (!task) return false
  const target = movableProjectId(projectId)
  if (movableProjectId(task.projectId) === target) return false
  const snapshot: CardOpSnapshot = {
    taskId,
    projectId: task.projectId,
    beforeId: sameGroupAnchor(taskId),
  }
  const prev = task.projectId
  task.projectId = target
  if (!window.api?.tasksMove) {
    task.projectId = prev
    showToast('任务移动通道未就绪,请升级主进程')
    return false
  }
  try {
    await window.api.tasksMove({ taskId, projectId: target })
  } catch (error) {
    task.projectId = prev
    showToast(`移动失败:${error instanceof Error ? error.message : String(error)}`)
    await refreshTasks()
    return false
  }
  pushUndo([snapshot])
  afterCardOpSuccess(`已移到「${projectGroupLabel(target, projects.value)}」`, [taskId])
  await refreshTasks()
  return true
}

/**
 * 组内相邻插入排序(P0-2):乐观重排本地 tasks 数组,失败(或通道未就绪)重拉还原;
 * beforeTaskId=null = 移到组尾,与 tasks:reorder 契约语义一致。
 * A-02:锚点与目标异组(多工作区视图下位置微调误取他组卡)时按组尾处理,绝不把异组锚点发给主进程。
 * 返回 true = 排序成功;false = 任务不存在或失败(内部已 toast)。
 */
async function reorderTask(taskId: string, beforeTaskId: string | null): Promise<boolean> {
  const list = tasks.value
  const from = list.findIndex((t) => t.id === taskId)
  if (from < 0) return false
  const target = list[from]!
  let beforeId = beforeTaskId ?? null
  if (beforeId) {
    const anchorTask = list.find((t) => t.id === beforeId)
    if (
      anchorTask &&
      normalizeProjectGroupId(anchorTask.projectId) !== normalizeProjectGroupId(target.projectId)
    ) {
      beforeId = null
    }
  }
  const snapshot: CardOpSnapshot = {
    taskId,
    projectId: target.projectId,
    beforeId: sameGroupAnchor(taskId),
  }
  const [task] = list.splice(from, 1)
  let to: number
  if (beforeId) {
    const anchor = list.findIndex((t) => t.id === beforeId)
    to = anchor < 0 ? list.length : anchor
  } else {
    to = list.length
  }
  list.splice(to, 0, task!)
  const unchanged = to === from
  if (!window.api?.tasksReorder) {
    showToast('任务排序通道未就绪,请升级主进程')
    await refreshTasks()
    return false
  }
  try {
    await window.api.tasksReorder(taskId, beforeId)
  } catch (error) {
    showToast(`排序失败,已还原:${error instanceof Error ? error.message : String(error)}`)
    await refreshTasks()
    return false
  }
  // 落位未变(已是该位置)不算一次操作:不入撤销栈、不报「已调整」
  if (!unchanged) {
    pushUndo([snapshot])
    afterCardOpSuccess('已调整卡片位置', [taskId])
  }
  await refreshTasks()
  return true
}

/**
 * 批量归类(A-14):循环走既有 tasks:move 通道,批量期间以模块级 suppressTasksUpdatedPull
 * 抑制 tasks:updated 触发的全量重拉(否则每移一张都重拉一次列表),结束后统一 refreshTasks 一次。
 * 返回真实移动条数(任务不存在/已在该分组不计入,单条失败不中断剩余条目)。
 */
async function moveTasks(taskIds: string[], projectId: string): Promise<number> {
  const target = movableProjectId(projectId)
  const targets = taskIds
    .map((id) => tasks.value.find((t) => t.id === id))
    .filter((t): t is TaskRecord => !!t && movableProjectId(t.projectId) !== target)
  if (targets.length === 0) return 0
  if (!window.api?.tasksMove) {
    showToast('任务移动通道未就绪,请升级主进程')
    return 0
  }
  const snapshots: CardOpSnapshot[] = []
  const movedIds: string[] = []
  suppressTasksUpdatedPull += 1
  try {
    for (const task of targets) {
      const prev = task.projectId
      const snapshot: CardOpSnapshot = {
        taskId: task.id,
        projectId: prev,
        beforeId: sameGroupAnchor(task.id),
      }
      task.projectId = target
      try {
        await window.api.tasksMove({ taskId: task.id, projectId: target })
        snapshots.push(snapshot)
        movedIds.push(task.id)
      } catch (error) {
        task.projectId = prev
        showToast(`移动失败:${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    suppressTasksUpdatedPull -= 1
  }
  await refreshTasks()
  if (movedIds.length === 0) return 0
  // D1:整批并入一条撤销条目——一次「撤销」还原整批,而不是逐张撤销
  pushUndo(snapshots)
  afterCardOpSuccess(`已移动 ${movedIds.length} 张卡片`, movedIds)
  return movedIds.length
}

/** 单条快照的回放结果:restored=已还原;missing=任务确实不存在;failed=回滚 IPC 失败(快照须保留) */
type CardOpReplay = 'restored' | 'missing' | 'failed'

/** 回放单条快照:先回原分组再回原插位(走既有通道,内部已 toast 失败原因) */
async function replayCardSnapshot(snapshot: CardOpSnapshot): Promise<CardOpReplay> {
  const task = tasks.value.find((t) => t.id === snapshot.taskId)
  if (!task) return 'missing'
  if (movableProjectId(task.projectId) !== movableProjectId(snapshot.projectId)) {
    if (!(await moveTask(snapshot.taskId, movableProjectId(snapshot.projectId)))) return 'failed'
  }
  return (await reorderTask(snapshot.taskId, snapshot.beforeId)) ? 'restored' : 'failed'
}

/**
 * 撤销最近一次卡片归类/排序(A-21):D1 一次撤销整批,批内逆序回放(先撤后移动的卡片,
 * 再撤先移动的);回放走 moveTask/reorderTask 既有通道(replayingUndo 保证不再入栈、不重复弹撤销 toast)。
 * D12:失败的条目不丢——仅「任务确实不存在」的条目丢弃,回滚 IPC 失败的快照回推栈顶待重试。
 */
async function undoLastCardOp(): Promise<boolean> {
  const batch = undoStack.pop()
  if (!batch || batch.length === 0) {
    showToast('没有可撤销的卡片操作')
    return false
  }
  let restored = 0
  const failed: CardOpSnapshot[] = []
  replayingUndo = true
  try {
    for (const snapshot of [...batch].reverse()) {
      const result = await replayCardSnapshot(snapshot)
      if (result === 'restored') restored++
      else if (result === 'failed') failed.push(snapshot)
    }
  } finally {
    replayingUndo = false
  }
  if (failed.length > 0) {
    // 回推为一条新条目(还原成原有回放顺序),pushUndo 内部按栈上限裁剪
    pushUndo([...failed].reverse())
    return false
  }
  if (restored === 0) {
    showToast('原任务已不存在,无法撤销')
    return false
  }
  return true
}

/**
 * 发布框草稿(B-04):切换视图/会话不销毁正在输入的内容;字段与 Composer 本地 ref 一一对应,
 * 由 S 组在卸载/切换前 saveComposerDraft、挂载时 takeComposerDraft 回填。
 * mode 取发布框可选三档(TaskMode 的 yolo 不在发布框集合内)。
 */
export interface ComposerDraft {
  prompt: string
  attachments: Array<{ path: string; kind: 'file' | 'image' }>
  mode: 'build' | 'edit' | 'plan'
  workspace: string
  workspaceSource: string
  batchMode: boolean
}

const composerDraft = ref<ComposerDraft | null>(null)

function saveComposerDraft(draft: ComposerDraft): void {
  composerDraft.value = draft
}

/** 取走即清:恢复只发生一次,不残留草稿反复覆盖用户新输入 */
function takeComposerDraft(): ComposerDraft | null {
  const draft = composerDraft.value
  composerDraft.value = null
  return draft
}

/** 各会话续聊输入草稿(按 taskId 存文本;浅引用避免长文本深响应化) */
const continueDrafts = shallowRef(new Map<string, string>())

function setContinueDraft(taskId: string, text: string): void {
  if (!taskId) return
  const next = new Map(continueDrafts.value)
  if (text) next.set(taskId, text)
  else next.delete(taskId) // 清空输入即清草稿,回选时不会被空串覆盖
  continueDrafts.value = next
}

/** 取走即清(B-04):返回该会话草稿文本,无草稿返回空串 */
function takeContinueDraft(taskId: string): string {
  const text = continueDrafts.value.get(taskId) ?? ''
  if (continueDrafts.value.has(taskId)) {
    const next = new Map(continueDrafts.value)
    next.delete(taskId)
    continueDrafts.value = next
  }
  return text
}

async function stopTask(taskId: string): Promise<void> {
  if (!window.api || !taskId) return
  // R07:终止只停当前轮,排队追问保留为待发(clearFollowups 缺省按 false,主进程侧兜底)
  await window.api.tasksCancel(taskId)
  await refreshTasks()
  // 取回队列如实告知去向:不会自动执行,需手动「提前发送」或打断发送;无队列时只报已终止
  const queue = await window.api.tasksGetFollowups(taskId)
  if (selectedTaskId.value === taskId) activeFollowups.value = queue
  showToast(
    queue.length > 0 ? '已终止 · 排队消息已保留为待发(不会自动执行)' : '已终止',
  )
}

watch(selectedTaskId, (id) => {
  if (id) void refreshFollowups(id)
  else activeFollowups.value = []
})

/** 侧栏选中的工作区:选中后发布框绑定该目录,任务列表只看该项目;null=全部 */
const selectedProjectId = ref<string | null>(
  typeof localStorage !== 'undefined' ? localStorage.getItem('agentdrove.workspace') : null,
)

/** 当前选中的项目行;id 失效(项目被删)自动回落 null */
const selectedProject = computed(
  () => projects.value.find((p) => p.id === selectedProjectId.value) ?? null,
)

watch(selectedProjectId, (id) => {
  if (id) localStorage.setItem('agentdrove.workspace', id)
  else localStorage.removeItem('agentdrove.workspace')
})

// 项目列表到达后校验持久化的选中项:项目被删/换机时 id 已失效,
// 必须把 selectedProjectId 一并回落(null),否则任务列会被不存在的项目过滤成空且无提示
watch(projects, (list) => {
  if (selectedProjectId.value && !list.some((p) => p.id === selectedProjectId.value)) {
    selectedProjectId.value = null
  }
})

/** 每任务在渲染层保留的实时事件条数(与主进程推送窗口配套,完整历史走分页拉取) */
const LIVE_EVENTS_PER_TASK = 500
/** 实时事件缓存的任务槽上限:长跑不清理会让已完成任务的缓冲无限堆积 */
const LIVE_EVENTS_MAX_TASKS = 50

export function useAppStore() {
  return {
    agents,
    agentsLoaded,
    projects,
    tasks,
    usage,
    settings,
    workspaces,
    updateStatus,
    view,
    railCollapsed,
    autoRailCollapsed,
    setRailCollapsed,
    detailCollapsed,
    detailModalOpen,
    openDetailModal,
    closeDetailModal,
    toggleDetailCollapsed,
    openTask,
    selectedTaskId,
    selection,
    filter,
    liveEvents,
    collapsedGroups,
    toggleGroup,
    lastMovedTaskIds,
    agentContext,
    setAgentContext,
    draggingTaskId,
    toast,
    toastAction,
    showToast,
    activeSkills,
    activeFollowups,
    toggleSkill,
    setSkills,
    refreshFollowups,
    removeFollowup,
    clearFollowups,
    renameTask,
    newChat,
    composerDraft,
    saveComposerDraft,
    takeComposerDraft,
    continueDrafts,
    setContinueDraft,
    takeContinueDraft,
    selectAgentContext,
    clearAgentContext,
    stopTask,
    moveTask,
    moveTasks,
    reorderTask,
    undoLastCardOp,
    selectedProjectId,
    selectedProject,
    quotaByAgent,
    quotaOf,
    refreshAgents,
    refreshUsage,
    refreshTasks,
    refreshSettings,
    refreshWorkspaces,
    refreshProjects,
    setTheme,
  }
}

/** 主题落到 <html data-theme>,auto 跟随系统;样式约定见 styles.css */
function applyTheme(theme: AppConfig['ui']['theme'] | undefined): void {
  const resolved =
    theme === 'light' || theme === 'dark'
      ? theme
      : window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
  document.documentElement.dataset.theme = resolved
}

/**
 * 并发重拉护栏:同一资源的重拉以后发请求为准,先到的过期响应直接丢弃,
 * 避免推送触发的重拉与手动刷新竞态互相覆盖。
 */
const pullEpoch = new Map<string, number>()

function beginPull(key: string): number {
  const epoch = (pullEpoch.get(key) ?? 0) + 1
  pullEpoch.set(key, epoch)
  return epoch
}

function isLatestPull(key: string, epoch: number): boolean {
  return pullEpoch.get(key) === epoch
}

/** R03:agents+usage 的空闲刷新门槛(聚焦/回前台/轮询时空闲超过该值才重拉) */
const AGENT_IDLE_REFRESH_MS = 60_000
let lastAgentsPullAt = 0
let lastAgentsPullDay = ''
/** 本地时区日界标识(跨零点强制重拉让「今日」归零) */
const todayKey = (): string => new Date().toDateString()

/** 启动期 fire-and-forget 拉取:失败留日志,不阻断其余初始化 */
function pull(run: () => Promise<void>, label: string): void {
  void run().catch((error) => console.error(`[store] ${label} 拉取失败`, error))
}

export async function setTheme(theme: AppConfig['ui']['theme']): Promise<void> {
  const previous = settings.value
  if (!previous) return
  // 只提交 ui 组且必须深拷贝:previous 是响应式代理,浅展开的顶层组字段仍是 Proxy,
  // 过 IPC 结构化克隆必抛 "An object could not be cloned"(ui 字段全为原始值,展开即纯)
  const next = { ui: { ...previous.ui, theme } }
  settings.value = { ...previous, ui: next.ui }
  try {
    settings.value = await window.api.settingsUpdate(next)
    applyTheme(theme)
  } catch (error) {
    // 落盘失败回滚乐观更新,否则界面主题与持久化配置不一致
    settings.value = previous
    applyTheme(previous.ui.theme)
    console.error('[store] 主题保存失败', error)
  }
}

/**
 * 额度单一事实源快照(C-06):字段取 quota:get / usage:get 现有口径,全部可缺省;
 * 周期字段(cycleStartAt/cycleResetAt)随 K 组契约补齐,缺省=尚未提供(不做强依赖)。
 */
export interface QuotaSnapshot {
  remainingCredits?: number
  remainingTokens?: number
  totalCredits?: number
  totalTokens?: number
  remainingPercent?: number
  /** 今日已计任务数 */
  taskCount?: number
  /** 周期起点;缺省=自首次任务累计口径(近似) */
  cycleStartAt?: string
  /** 周期重置时间;缺省=无固定重置点 */
  cycleResetAt?: string
}

/** 按 agentId 归口的额度快照:usage:get / quota:get 现算后整条写入 */
const quotaByAgent = ref<Map<string, QuotaSnapshot>>(new Map())

/** 只读取用(C-06/C-08):侧栏等展示层据此渲染余量与周期,不再读 agents 上的零散旧字段 */
function quotaOf(agentId: string): QuotaSnapshot | null {
  return quotaByAgent.value.get(agentId) ?? null
}

/** quota:get 回包(周期字段随 K 组补齐,缺失即 undefined) */
type QuotaWire = Partial<AgentView> & {
  agentId?: string
  cycleStartAt?: string
  cycleResetAt?: string
}

/** quota:get 回包 → 整条新快照(不再往 agents 上零散 Object.assign 之外再合并字段) */
function quotaFromWire(wire: QuotaWire): QuotaSnapshot {
  return {
    remainingCredits: wire.remainingCredits,
    remainingTokens: wire.remainingTokens,
    totalCredits: wire.totalCredits,
    totalTokens: wire.totalTokens,
    remainingPercent: wire.remainingPercent,
    taskCount: wire.usedToday,
    cycleStartAt: wire.cycleStartAt,
    cycleResetAt: wire.cycleResetAt,
  }
}

/**
 * D5:quota:get 回包 → agents 元素的双写白名单(仅 AgentView 上真实存在的额度字段)。
 * 回包本身是「额度体 + agentId」的包装结构(还带 cachedTokensToday 之类 AgentView 未声明的字段),
 * 一律不挂进 agents 元素——完整快照由 quotaByAgent 承载,展示层走 quotaOf(agentId)。
 */
const QUOTA_AGENT_SYNC_KEYS: Array<keyof AgentView> = [
  'remainingCredits',
  'remainingTokens',
  'remainingPercent',
  'totalCredits',
  'totalTokens',
  'usedToday',
  'usedTokensToday',
  'usedCreditsToday',
  'cacheHitRateToday',
  'usedTokensCycle',
  'usedCreditsCycle',
  'cycleStartAt',
  'cycleResetAt',
  'isOverridden',
]

/**
 * usage:get 行 → 快照(额度口径与 agents 列表同源,避免两处漂移)。
 * D8:不写 taskCount——该字段口径统一为 quota:get 的 usedToday(任务计数),
 * 此处再写一份另一来源的计数会让同一字段随刷新通道来回跳;缺省交由 writeQuotaRows
 * 保留已有/首次值,两条通道对同一 agent 因此恒为同一口径。
 */
function quotaFromUsage(row: UsageView): QuotaSnapshot {
  const wire = row as UsageView & { cycleStartAt?: string; cycleResetAt?: string }
  return {
    remainingCredits: row.remainingCredits,
    remainingTokens: row.remainingTokens,
    totalCredits: row.totalCredits,
    totalTokens: row.totalTokens,
    remainingPercent: row.remainingPercent,
    cycleStartAt: wire.cycleStartAt,
    cycleResetAt: wire.cycleResetAt,
  }
}

/**
 * 整表替换额度快照:每次都是一批完整性写入(不再往 agents 上零散 Object.assign);
 * 新回包缺省的字段(如 usage:get 尚未带的周期字段)不覆盖已算出的旧值。
 */
function writeQuotaRows(rows: Array<{ agentId: string; snapshot: QuotaSnapshot }>): void {
  const next = new Map<string, QuotaSnapshot>()
  for (const { agentId, snapshot } of rows) {
    const prev = quotaByAgent.value.get(agentId)
    next.set(
      agentId,
      prev
        ? {
            ...snapshot,
            cycleStartAt: snapshot.cycleStartAt ?? prev.cycleStartAt,
            cycleResetAt: snapshot.cycleResetAt ?? prev.cycleResetAt,
            taskCount: snapshot.taskCount ?? prev.taskCount,
          }
        : snapshot,
    )
  }
  quotaByAgent.value = next
}

/** 额度预警阈值(C-05):余量 ≤20% 提醒校准 */
const QUOTA_WARN_PERCENT = 20
const quotaWarnKey = (agentId: string): string => `agentdrove.quota.warned.${agentId}`

/** 余量告警:每 agent 每日一次(localStorage 记日),同一轮多个客户端合并为一条 toast 避免刷屏 */
function warnLowQuota(): void {
  if (typeof localStorage === 'undefined') return
  const day = new Date().toDateString()
  const fresh: string[] = []
  for (const [agentId, snapshot] of quotaByAgent.value) {
    if (snapshot.remainingPercent === undefined || snapshot.remainingPercent > QUOTA_WARN_PERCENT) continue
    try {
      if (localStorage.getItem(quotaWarnKey(agentId)) === day) continue
    } catch {
      return // 存储不可读(隐私模式)整体放弃:预警是增强项,不阻塞刷新
    }
    fresh.push(agentId)
  }
  if (fresh.length === 0) return
  for (const agentId of fresh) {
    try {
      localStorage.setItem(quotaWarnKey(agentId), day)
    } catch {}
  }
  const first = fresh[0]!
  const snapshot = quotaByAgent.value.get(first)
  const percent = snapshot?.remainingPercent ?? 0
  const label = agents.value.find((a) => a.id === first)?.label ?? first
  const subject = fresh.length > 1 ? `「${label}」等 ${fresh.length} 个客户端` : `「${label}」`
  // D9:按额度口径分支——快照有总量(点数/Token)才是"可校准的额度",沿用校准引导文案;
  // 无总量时百分比是按每日任务上限反推的,只报今日任务额度,不再引导去设置页校准
  const hasTotal = snapshot?.totalCredits !== undefined || snapshot?.totalTokens !== undefined
  const rounded = Math.round(percent)
  showToast(
    hasTotal
      ? `${subject}${percent <= 0 ? '额度已用尽' : `额度仅剩 ${rounded}%`},可在设置页校准额度`
      : `${subject}${percent <= 0 ? '今日任务额度已用尽' : `今日任务额度仅剩 ${rounded}%`}`,
  )
}

export async function refreshAgents(): Promise<void> {
  const epoch = beginPull('agents')
  // 列表与用量一并取回避免"新列表 + 旧用量"中间态;R03:改为串行——主进程 agents:list
  // 组装完即按日缓存 quota,usage:get 命中缓存免双算,Promise.all 并发会与缓存建立赛跑
  const agentList = await window.api.agentsList()
  const usageList = await window.api.usageGet()
  if (!isLatestPull('agents', epoch)) return
  agents.value = agentList
  usage.value = usageList
  writeQuotaRows(usageList.map((row) => ({ agentId: row.agentId, snapshot: quotaFromUsage(row) })))
  // G3-10:探测完成(跨零点/重扫重复置位幂等);失败路径不置位,空态保持「探测中」语义
  agentsLoaded.value = true
  lastAgentsPullAt = Date.now()
  lastAgentsPullDay = todayKey()
  warnLowQuota()
}

/**
 * R03:usage:get 单独轻量刷新(不触发探活),设置页用量表打开时保鲜。
 * C-01:force=true 透传 usage:get({force:true}) 绕过主进程按日 quotaCache 现算(手动 ⟳ 用)。
 */
export async function refreshUsage(force = false): Promise<void> {
  const epoch = beginPull('usage')
  // K-01 契约:usage:get 支持 force 参数;契约落地前该参数被主进程忽略,调用无害
  const usageGet = window.api.usageGet as (opts?: { force?: boolean }) => Promise<UsageView[]>
  const list = await usageGet(force ? { force: true } : undefined)
  if (!isLatestPull('usage', epoch)) return
  usage.value = list
  writeQuotaRows(list.map((row) => ({ agentId: row.agentId, snapshot: quotaFromUsage(row) })))
  warnLowQuota()
}

export async function refreshProjects(): Promise<void> {
  const epoch = beginPull('projects')
  const list = await window.api.projectsList()
  if (!isLatestPull('projects', epoch)) return
  projects.value = list
}

export async function refreshTasks(): Promise<void> {
  const epoch = beginPull('tasks')
  const filterDto: Parameters<typeof window.api.tasksList>[0] = {}
  if (filter.value.search) filterDto.search = filter.value.search
  if (filter.value.agentId) filterDto.agentId = filter.value.agentId
  if (filter.value.state) filterDto.state = filter.value.state as TaskRecord['state']
  const list = await window.api.tasksList(filterDto)
  if (!isLatestPull('tasks', epoch)) return
  tasks.value = list
}

export async function refreshSettings(): Promise<void> {
  const epoch = beginPull('settings')
  const config = await window.api.settingsGet()
  if (!isLatestPull('settings', epoch)) return
  settings.value = config
}

export async function refreshWorkspaces(): Promise<void> {
  const epoch = beginPull('workspaces')
  const list = await window.api.workspacesList()
  if (!isLatestPull('workspaces', epoch)) return
  workspaces.value = list
}

/** 渠道/模型/思考档位三元组记忆(P0-5):按客户端落 localStorage,重启自动恢复 */
export interface ModelPref {
  channelId: string
  modelId: string
  reasoningEffort?: ReasoningEffort
}

export function readModelPref(agentId: string): ModelPref | null {
  try {
    const raw = localStorage.getItem(`agentdrove.modelPref.${agentId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ModelPref>
    if (typeof parsed.channelId !== 'string' || typeof parsed.modelId !== 'string') return null
    return parsed as ModelPref
  } catch {
    return null
  }
}

export function writeModelPref(agentId: string, pref: ModelPref): void {
  try {
    localStorage.setItem(`agentdrove.modelPref.${agentId}`, JSON.stringify(pref))
  } catch {
    // 存储不可写(隐私模式/配额满)时静默放弃:记忆是增强项,不阻塞派发
  }
}

let bridgeInstalled = false
/** P0-8:任务高频事件下 agents/usage 重拉的 debounce 定时器 */
let agentsRefreshTimer: ReturnType<typeof setTimeout> | null = null
/**
 * A-14/D11:批量移动期间抑制 tasks:updated 触发的列表重拉,批量末尾统一 refreshTasks 一次;
 * 深度计数而非布尔——并发批次各自 +1/-1,先结束的一批不会把抑制提前复位而让其余批次逐条重拉。
 * 其余推送副作用(workspaces/quota/agents)不受影响。
 */
let suppressTasksUpdatedPull = 0

/** 主进程事件桥 + 首轮数据拉取,应用启动时装一次;组件卸载不拆(生命周期与窗口一致) */
export function installAppBridge(): void {
  if (bridgeInstalled) return
  bridgeInstalled = true
  // 主题不依赖 IPC,先行安装(缺 api 时仍能跟随系统主题)
  watch(
    () => settings.value?.ui.theme,
    (theme) => applyTheme(theme),
    { immediate: true },
  )
  // auto 模式下跟随系统主题实时切换(仅 auto 时 applyTheme 才会取系统值,其余档无害)
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    applyTheme(settings.value?.ui.theme)
  })
  // preload 未注入时(浏览器直开且 mock 加载失败)直接返回:后续 window.api.* 同步抛错会
  // 让 main.ts 的 installAppBridge() 在挂载前中断,整屏白掉;此处退化为空态展示
  if (!window.api) {
    console.error('[store] window.api 未注入,跳过 IPC 桥与首轮拉取(页面显示空态)')
    return
  }
  pull(refreshAgents, 'agents')
  pull(refreshProjects, 'projects')
  pull(refreshTasks, 'tasks')
  pull(refreshSettings, 'settings')
  pull(refreshWorkspaces, 'workspaces')
  // R03:主动刷新——用户直接在 CLI 干活时没有任何任务事件,侧栏用量会一直冻结;
  // 聚焦/回前台时空闲 >60s 重拉 agents+usage,60s 低频轮询兜底,跨零点立即重拉让「今日」归零。
  // 桥与窗口同生命周期(与上方 matchMedia 监听一致),不随组件卸载拆除。
  const idleRefreshAgents = (): void => {
    const dayChanged = todayKey() !== lastAgentsPullDay
    if (!dayChanged && Date.now() - lastAgentsPullAt < AGENT_IDLE_REFRESH_MS) return
    pull(refreshAgents, 'agents')
  }
  window.addEventListener('focus', idleRefreshAgents)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) idleRefreshAgents()
  })
  window.setInterval(idleRefreshAgents, AGENT_IDLE_REFRESH_MS)
  // A-21:全局 Ctrl/Cmd+Z 撤销最近一次卡片归类/排序;输入焦点内让位给原生撤销
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return
    const target = e.target as HTMLElement | null
    const tag = target?.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
    // D13:焦点在按钮/分隔条上时不抢——按钮的撤销语义归组件自身(如 toast 动作按钮),
    // 分隔条的键盘步进也在此列(target 非元素时直接跳过判定,与上面的 tagName 判空同款兜底)
    if (target?.closest?.('button, [role="separator"]')) return
    // D13:模态遮罩(.g-modal-mask)与详情抽屉遮罩(.drawer-backdrop)在场时不越过浮层撤销
    if (document.querySelector('.g-modal-mask, .drawer-backdrop')) return
    e.preventDefault()
    void undoLastCardOp()
  })
  let quotaRefreshTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * C-01/C-06:额度事件到达后走 quota:get 现算通道(不触发慢速探活),整表替换 quotaByAgent,
   * 并对 agents 上旧内嵌 quota 字段双写(保留一个版本周期,待展示层全部迁移到 quotaOf 后删)。
   */
  const scheduleQuotaRefresh = (): void => {
    if (quotaRefreshTimer) clearTimeout(quotaRefreshTimer)
    quotaRefreshTimer = setTimeout(async () => {
      if (!window.api || !window.api.quotaGet) return
      try {
        const quotaList = await window.api.quotaGet()
        if (!Array.isArray(quotaList)) return
        const rows: Array<{ agentId: string; snapshot: QuotaSnapshot }> = []
        for (const q of quotaList) {
          if (!q?.agentId) continue
          rows.push({ agentId: q.agentId, snapshot: quotaFromWire(q) })
          const target = agents.value.find((a) => a.id === q.agentId)
          if (target) {
            // D5:只按白名单双写 AgentView 真实存在的额度字段——回包的包装字段(agentId 等)
            // 与 AgentView 未声明的字段绝不整条 Object.assign 进 agents 元素
            for (const key of QUOTA_AGENT_SYNC_KEYS) {
              const value = q[key]
              if (value !== undefined) Object.assign(target, { [key]: value })
            }
          }
        }
        writeQuotaRows(rows)
      } catch {}
    }, 250)
  }

  window.api.onTasksEventsBatch((events) => {
    const next = new Map(liveEvents.value)
    let hasUsage = false
    for (const event of events) {
      if (event.event.kind === 'usage') hasUsage = true
      const list = next.get(event.taskId) ?? []
      list.push(event)
      // 先删后插:Map.set 不会刷新已有键的插入顺序,重新插入才能让活跃任务移到队尾
      next.delete(event.taskId)
      next.set(event.taskId, list.slice(-LIVE_EVENTS_PER_TASK))
    }
    if (hasUsage) {
      scheduleQuotaRefresh()
    }
    // 选中的任务永远保留;超槽时从队首(最久未动)丢弃(历史仍可从主进程分页拉回)
    if (next.size > LIVE_EVENTS_MAX_TASKS) {
      const keep = selectedTaskId.value
      for (const key of next.keys()) {
        if (next.size <= LIVE_EVENTS_MAX_TASKS) break
        if (key !== keep) next.delete(key)
      }
    }
    liveEvents.value = next
  })
  window.api.onTasksUpdated(() => {
    // 批量移动期间由 moveTasks 统一收尾重拉(A-14),此处不再逐条重拉列表
    if (suppressTasksUpdatedPull === 0) pull(refreshTasks, 'tasks')
    pull(refreshWorkspaces, 'workspaces')
    scheduleQuotaRefresh()
    // P0-8:任务流(派发/完成/取消/失败)后 500ms debounce 重拉 agents+usage,
    // 侧栏"余 N 次/点数/Token" 1~2s 内跟随;pullEpoch 护栏兜住与手动刷新的竞态
    if (agentsRefreshTimer) clearTimeout(agentsRefreshTimer)
    agentsRefreshTimer = setTimeout(() => pull(refreshAgents, 'agents'), 500)
  })
  // P0-6 配套:父任务完成后排队消息自动接续为新任务。G3-01:改为条件迁移——仅当用户
  // 正在看源任务时才把选中迁到新任务(该会话在排队接续,切走时清空草稿属预期);
  // 其余情况视图不跳走、正在输入的草稿绝不因后台事件丢失,用户经列表 ⏳ 徽标与新卡定位
  window.api.onFollowupContinued?.((payload) => {
    if (selectedTaskId.value === payload.fromTaskId) {
      selectedTaskId.value = payload.toTaskId
    }
    // B-20:toast 报出源任务标题并附「点击查看」直达接续出的新任务
    const source = tasks.value.find((t) => t.id === payload.fromTaskId)
    const title = source?.title?.trim() || '该任务'
    showToast(`「${title}」的追问已接续为新任务`, {
      action: { label: '点击查看', run: () => openTask(payload.toTaskId) },
    })
  })
  // 启动期客户端探测后台完成/重扫/启停切换:主进程广播后重拉,侧栏从空态自愈
  window.api.onAgentsChanged(() => {
    pull(refreshAgents, 'agents')
  })
  window.api.onSchedulerChanged((paused) => {
    if (settings.value) settings.value = { ...settings.value, schedulerPaused: paused }
  })
  window.api.onUpdateStatus((status) => {
    updateStatus.value = status
  })
  window.api.onPanelFocus(() => {
    view.value = 'panel'
    window.dispatchEvent(new CustomEvent('focus-composer'))
  })
}