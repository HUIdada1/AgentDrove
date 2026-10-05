<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { registerExpandGuard, useAppStore } from './stores/app'
import AgentRail from './components/AgentRail.vue'
import Composer from './components/Composer.vue'
import TaskList from './components/TaskList.vue'
import SessionColumn from './components/SessionColumn.vue'
import TaskDetail from './components/TaskDetail.vue'
import TaskDetailModal from './components/TaskDetailModal.vue'
import SettingsPage from './components/SettingsPage.vue'
import MiniBar from './components/MiniBar.vue'
import FxLayers from './components/FxLayers.vue'
import TitleBar from './components/TitleBar.vue'
import Resizer from './ui/Resizer.vue'
import GlassButton from './ui/GlassButton.vue'

const store = useAppStore()
// 迷你条与主面板是不同窗口(不同入口 HTML hash),窗口存续期 hash 不变,无需响应式
const isMini = window.location.hash === '#mini'

/** 响应式断点:窄窗(<1180px)详情栏自动转为浮动抽屉,绝不挤压会话流 */
const isNarrowWindow = ref(typeof window !== 'undefined' && window.innerWidth < 1180)

// ---- 栏宽拖拽(P0-7:三条分隔条各管各的边界,手柄即锚点) ----
// 侧栏(railW)/任务列(taskW)/详情列(detailW);会话流是 minmax(360px,1fr) 弹性吸收,
// 360px 硬下限由 tryExpandDetail 守卫与缩窗再平衡保证可满足(R01)。
// 界限防拖爆窗口(最小宽 980)。RAIL_COLLAPSED_W 须与 AgentRail 的 .rail.collapsed 宽度一致。
const RAIL_W = { min: 200, max: 320, def: 236 }
const RAIL_COLLAPSED_W = 64
const TASK_W = { min: 280, max: 480, def: 328 }
const DETAIL_W = { min: 280, max: 480, def: 320 }
/** 会话流列硬下限(展开详情后低于此宽即触发阶梯降级/拒绝) */
const SESSION_MIN_W = 360
/** 三条分隔列的固定宽(与 gridCols 里的 10px 保持同一常量) */
const RESIZER_W = 10
/** shell 左右内边距(styles.css .shell padding:10px 两侧) */
const SHELL_PAD_X = 20

function clampW(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 读持久化列宽:缺省/非法值回落默认,出界值收紧到界限 */
function loadW(key: string, def: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw > 0 ? clampW(raw, min, max) : def
}

const railW = ref(loadW('agentdrove.layout.railW', RAIL_W.def, RAIL_W.min, RAIL_W.max))
const taskW = ref(loadW('agentdrove.layout.taskW', TASK_W.def, TASK_W.min, TASK_W.max))
const detailW = ref(loadW('agentdrove.layout.detailW', DETAIL_W.def, DETAIL_W.min, DETAIL_W.max))

/** 拖拽中只改内存,松手(Resizer end)才落盘,避免高频 localStorage 写 */
function persistLayout(): void {
  localStorage.setItem('agentdrove.layout.railW', String(railW.value))
  localStorage.setItem('agentdrove.layout.taskW', String(taskW.value))
  localStorage.setItem('agentdrove.layout.detailW', String(detailW.value))
}

// 列定义:侧栏(折叠时忽略 railW 用折叠宽)+ 分隔 + 任务列 + 分隔 + 会话流(minmax(360px,1fr))
// [+ 分隔 + 详情列(若未锁起收起且非窄屏)];窄窗转抽屉浮动,避免挤压会话流
const gridCols = computed(() => {
  const railCol = `${store.railCollapsed.value ? RAIL_COLLAPSED_W : railW.value}px`
  const base = `${railCol} ${RESIZER_W}px minmax(${TASK_W.min}px, ${taskW.value}px) ${RESIZER_W}px minmax(${SESSION_MIN_W}px, 1fr)`
  if (store.detailCollapsed.value || isNarrowWindow.value) {
    return base
  }
  return `${base} ${RESIZER_W}px minmax(${DETAIL_W.min}px, ${detailW.value}px)`
})

// ---- 详情展开空间守卫 + 缩窗再平衡(R01) ----
// 展开后预估会话流 <360px 时阶梯降级:自动收 Agent 侧栏 → 任务列压到 280 →
// 仍不足拒绝展开并 toast;窗口缩小时按「会话流 > 任务列 > 侧栏」保护优先级,
// 侧栏/任务列/详情列依次收缩,全部压到下限仍不足自动收起详情列(980px 最小窗才有出口)。
const sessionCol = ref<InstanceType<typeof SessionColumn> | null>(null)

/** 按当前列宽配置预估会话流宽度(窗口内容宽 − 已展示列与分隔) */
function sessionFlowW(): number {
  const contentW = window.innerWidth - SHELL_PAD_X
  const railCol = store.railCollapsed.value ? RAIL_COLLAPSED_W : railW.value
  let used = railCol + RESIZER_W + taskW.value + RESIZER_W
  if (!store.detailCollapsed.value) used += RESIZER_W + detailW.value
  return contentW - used
}

/** 展开详情列后的会话流预估宽(当前布局基础上新增一条分隔 + 详情列) */
function sessionFlowWAfterExpand(): number {
  return sessionFlowW() - RESIZER_W - detailW.value
}

function tryExpandDetail(): boolean {
  const after = sessionFlowWAfterExpand()
  if (after >= SESSION_MIN_W) return true
  // 预估阶梯收益,拒绝路径不动任何布局(不让一次被拒的点击白丢侧栏/列宽)
  let need = SESSION_MIN_W - after
  const railWasCollapsed = store.railCollapsed.value
  // 阶梯 1 收益:侧栏让渡到折叠宽;阶梯 2 收益:任务列压到 280
  const railGain = railWasCollapsed ? 0 : railW.value - RAIL_COLLAPSED_W
  const taskGain = Math.max(0, taskW.value - TASK_W.min)
  if (need > railGain + taskGain) {
    // 阶梯全开仍不足——会话流列有 minmax(360px,1fr) 硬下限,强开会挤爆窗口,拒绝并说明
    store.showToast('窗口空间不足,无法展开详情列(会话流将低于 360px)')
    return false
  }
  // 降级生效:按阶梯顺序收侧栏 → 压任务列,只做到够用为止
  // G4-02:阶梯降级前同样打快照,窗口回大时可逆还原
  snapshotBeforeDegrade()
  if (railGain > 0) {
    store.railCollapsed.value = true
    need -= railGain
    if (need <= 0) {
      store.showToast('空间不足:已自动收起侧栏')
      return true
    }
  }
  if (taskGain > 0) {
    taskW.value = TASK_W.min
    persistLayout()
    store.showToast('空间不足:已自动压紧任务列')
  }
  return true
}

/**
 * G4-02:降级前布局快照——窗口变大触发自动降级(收侧栏/压列宽/收详情)时记录,
 * 空间恢复后按逆序还原;railW 不在快照内(侧栏只还原展开态,列宽沿用收缩后的值)。
 */
type DegradedSnapshot = {
  railCollapsed: boolean
  taskW: number
  detailCollapsed: boolean
  detailW: number
}
let degradedSnapshot: DegradedSnapshot | null = null

/** 首次降级动作前抓拍当前布局;已有快照不覆盖(保留最早的用户布局,快照循环可用) */
function snapshotBeforeDegrade(): void {
  if (degradedSnapshot) return
  degradedSnapshot = {
    railCollapsed: store.railCollapsed.value,
    taskW: taskW.value,
    detailCollapsed: store.detailCollapsed.value,
    detailW: detailW.value,
  }
}

/**
 * 空间恢复(surplus≥0)时的逆序还原:详情列重新出现 → 任务列回快照宽 → 侧栏展开;
 * 每步按剩余空间核算,不足则跳过该步(详情不展开/侧栏保持折叠),快照保留待下次续还;
 * 三个降级项全部回到快照前状态才算还原完成,此时清快照、落盘并提示一次。
 */
function restoreDegradedLayout(surplus: number): void {
  const snap = degradedSnapshot
  if (!snap) return
  let free = surplus
  let didRestore = false
  // 1) 详情列重新出现:需容纳一条分隔 + 快照详情宽;不足则只还原列宽不展开详情
  if (!snap.detailCollapsed && store.detailCollapsed.value && free >= RESIZER_W + snap.detailW) {
    detailW.value = snap.detailW
    store.detailCollapsed.value = false
    free -= RESIZER_W + snap.detailW
    didRestore = true
  }
  // 2) 任务列回快照宽(受剩余空间钳制,不把会话流压回 360px 以下)
  if (taskW.value < snap.taskW) {
    const target = Math.min(snap.taskW, taskW.value + free)
    if (target > taskW.value) {
      free -= target - taskW.value
      taskW.value = target
      didRestore = true
    }
  }
  // 3) 侧栏展开:按(当前 railW − 折叠宽)核算空间,不足保持折叠
  if (!snap.railCollapsed && store.railCollapsed.value) {
    const need = railW.value - RAIL_COLLAPSED_W
    if (free >= need) {
      store.railCollapsed.value = false
      free -= need
      didRestore = true
    }
  }
  const restored =
    (!store.detailCollapsed.value || snap.detailCollapsed) &&
    taskW.value >= snap.taskW &&
    (!store.railCollapsed.value || snap.railCollapsed)
  if (restored) {
    degradedSnapshot = null
    persistLayout()
    if (didRestore) store.showToast('已恢复窗口布局')
  }
}

/**
 * 缩窗再平衡:会话流跌破 360px 时按保护优先级收缩——先侧栏、再任务列、再详情列,
 * 依次压到各自下限;全部压满仍不足则自动收起详情列,保证 980px 最小窗也有出口。
 * G4-02:空间有余(surplus≥0)且存在降级快照时,先按逆序尝试还原降级布局。
 */
function rebalanceColumns(): void {
  const surplus = sessionFlowW() - SESSION_MIN_W
  if (surplus >= 0) {
    if (degradedSnapshot) restoreDegradedLayout(surplus)
    return
  }
  let deficit = -surplus
  // 首次收缩动作前打快照(G4-02),窗口回大时可逆还原
  snapshotBeforeDegrade()
  // 1) 侧栏先让位(未折叠才有可缩空间;折叠宽 64 已是底线)
  if (!store.railCollapsed.value && railW.value > RAIL_W.min) {
    const shrink = Math.min(railW.value - RAIL_W.min, deficit)
    railW.value -= shrink
    deficit -= shrink
  }
  // 2) 任务列压到下限
  if (deficit > 0 && taskW.value > TASK_W.min) {
    const shrink = Math.min(taskW.value - TASK_W.min, deficit)
    taskW.value -= shrink
    deficit -= shrink
  }
  // 3) 详情列压到下限
  if (deficit > 0 && !store.detailCollapsed.value && detailW.value > DETAIL_W.min) {
    const shrink = Math.min(detailW.value - DETAIL_W.min, deficit)
    detailW.value -= shrink
    deficit -= shrink
  }
  // 4) 全部压满仍不足:自动收起详情列,给会话流让出整条详情宽
  if (deficit > 0 && !store.detailCollapsed.value) {
    store.detailCollapsed.value = true
    store.showToast('窗口过窄:已自动收起详情列')
  }
}

// ---- G4-01:三条分隔条拖拽统一过会话流空间守卫 ----
// 守卫 toast 节流:拖拽连续触发时相同文本 1s 内不重复
let lastGuardToastAt = 0
let lastGuardToastText = ''

function guardToast(msg: string): void {
  const now = Date.now()
  if (msg === lastGuardToastText && now - lastGuardToastAt < 1000) return
  lastGuardToastAt = now
  lastGuardToastText = msg
  store.showToast(msg)
}

function setColumnW(key: 'rail' | 'task' | 'detail', value: number): void {
  if (key === 'rail') railW.value = value
  else if (key === 'task') taskW.value = value
  else detailW.value = value
}

/**
 * 三条分隔条拖拽的统一入口:先按各列 clamp 规则算出 nextW,写入后再校验会话流;
 * 跌破 360px 时把增量回退到恰好守住下限(不低于该列自身 min),出现"拖不动"的阻力并提示。
 * 详情分隔条在详情列左侧,拖右(正增量)= 详情列收窄,与 rail/task 的同向增宽相反。
 */
function applyColumnResize(key: 'rail' | 'task' | 'detail', delta: number): void {
  const conf = key === 'rail' ? RAIL_W : key === 'task' ? TASK_W : DETAIL_W
  const cur = key === 'rail' ? railW.value : key === 'task' ? taskW.value : detailW.value
  const nextW = clampW(key === 'detail' ? cur - delta : cur + delta, conf.min, conf.max)
  if (nextW === cur) return
  setColumnW(key, nextW)
  const flow = sessionFlowW()
  if (flow < SESSION_MIN_W) {
    const clamped = Math.max(conf.min, nextW - (SESSION_MIN_W - flow))
    setColumnW(key, clamped)
    guardToast('会话流已到最小宽度,不再让渡空间')
  }
}

// G4-01:侧栏折叠钮的展开方向(64→railW)同样过会话流守卫;不足则回退折叠并提示
watch(store.railCollapsed, (val) => {
  if (isMini || val || sessionFlowW() >= SESSION_MIN_W) return
  store.railCollapsed.value = true
  store.showToast('空间不足:无法展开侧栏,已保持折叠')
})

let persistTimer: ReturnType<typeof setTimeout> | null = null

function onWindowResize(): void {
  if (isMini) return
  isNarrowWindow.value = window.innerWidth < 1180
  rebalanceColumns()
  // 拖拽缩窗高频触发:内存值即时生效,落盘 debounce
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(persistLayout, 300)
}

onMounted(() => {
  registerExpandGuard(tryExpandDetail)
  // railCollapsed 持久化的启动再校验(R01):窗口窄到保不住会话流下限时自动折叠侧栏,
  // 再走一轮列宽再平衡兜底(压任务列/收详情),避免重启即出现挤压组合
  if (!isMini) {
    if (
      !store.railCollapsed.value &&
      window.innerWidth - SHELL_PAD_X - (railW.value + RESIZER_W + taskW.value + RESIZER_W) <
        SESSION_MIN_W
    ) {
      store.railCollapsed.value = true
    }
    rebalanceColumns()
    persistLayout()
    window.addEventListener('resize', onWindowResize)
  }
})

onBeforeUnmount(() => {
  registerExpandGuard(null)
  window.removeEventListener('resize', onWindowResize)
  if (persistTimer) clearTimeout(persistTimer)
})
</script>

<template>
  <FxLayers />
  <MiniBar v-if="isMini" />
  <template v-else>
    <!-- 自绘标题栏:左 Logo+应用名,右窗口控制 -->
    <TitleBar />
    <!-- 现代化三栏布局: Agent导航侧栏 / 会话任务历史 / 中央对话工作台 / 任务详情抽屉 -->
    <div class="shell view" :style="{ gridTemplateColumns: gridCols, '--rail-w': `${railW}px` }">
      <AgentRail />
      <!-- 分隔条 1: 调侧栏宽(双击恢复推荐宽) -->
      <Resizer
        :value-now="railW"
        :min="RAIL_W.min"
        :max="RAIL_W.max"
        @resize="applyColumnResize('rail', $event)"
        @reset="railW = RAIL_W.def"
        @end="persistLayout"
      />
      <!-- 第 2 栏: 纯粹的会话与任务卡片列表(完整垂直高度) -->
      <TaskList />
      <!-- 分隔条 2: 调任务历史列宽(双击恢复推荐宽) -->
      <Resizer
        :value-now="taskW"
        :min="TASK_W.min"
        :max="TASK_W.max"
        @resize="applyColumnResize('task', $event)"
        @reset="taskW = TASK_W.def"
        @end="persistLayout"
      />
      <!-- 第 3 栏: 核心主工作台(未选中时为全功能发起台，选中时为沉浸式会话流) -->
      <SessionColumn ref="sessionCol" />
      <!-- 第 4 栏: 详情伴随栏(宽屏并列呈现) -->
      <template v-if="!store.detailCollapsed.value && !isNarrowWindow">
        <Resizer
          :value-now="detailW"
          :min="DETAIL_W.min"
          :max="DETAIL_W.max"
          @resize="applyColumnResize('detail', $event)"
          @reset="detailW = DETAIL_W.def"
          @end="persistLayout"
        />
        <TaskDetail />
      </template>
    </div>

    <!-- 窄窗模式详情抽屉:绝对定位滑出,不挤压中央会话流 -->
    <Transition name="drawer-slide">
      <div v-if="!store.detailCollapsed.value && isNarrowWindow" class="detail-drawer glass">
        <div class="drawer-header">
          <span class="drawer-title">任务详情</span>
          <GlassButton variant="ghost" size="sm" @click="store.detailCollapsed.value = true">✕</GlassButton>
        </div>
        <div class="drawer-body">
          <TaskDetail />
        </div>
      </div>
    </Transition>
    <!-- 轻提示(P0-6/P0-7):底部居中,store.showToast 触发,自动消退 -->
    <Transition name="toast-fade">
      <div v-if="store.toast.value" class="toast glass">{{ store.toast.value }}</div>
    </Transition>
    <!-- 独立弹窗模式:用户点开弹窗随时查看详情与进行全功能操作 -->
    <TaskDetailModal />
    <SettingsPage v-if="store.view.value === 'settings'" @close="store.view.value = 'panel'" />
  </template>
</template>

<style scoped>
.shell {
  display: grid;
  /* 列宽由 :style 绑定的 gridCols 动态给出(含 3 条分隔列) */
  height: calc(100vh - var(--titlebar-h));
  padding: 10px;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}

/* 轻提示浮层:不拦截点击,2.6s 自动消退(store.showToast) */
.toast {
  position: fixed;
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  z-index: 2200;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--accent-line);
  font-size: 12.5px;
  color: var(--text);
  pointer-events: none;
  box-shadow: var(--glass-shadow), 0 8px 24px rgba(0, 0, 0, 0.32);
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}

/* 窄窗详情浮动抽屉(Drawer模式) */
.detail-drawer {
  position: fixed;
  right: 12px;
  top: calc(var(--titlebar-h) + 10px);
  bottom: 12px;
  width: 380px;
  max-width: calc(100vw - 40px);
  z-index: 1500;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  border: 1px solid var(--accent-line);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), var(--glass-shadow);
  overflow: hidden;
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-dim);
}

.drawer-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}

.drawer-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 180ms ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(24px);
  opacity: 0;
}
</style>
