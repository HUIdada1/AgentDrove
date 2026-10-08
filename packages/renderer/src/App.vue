<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { registerExpandGuard, useAppStore } from './stores/app'
import type { ToastAction } from './stores/app'
import AgentRail from './components/AgentRail.vue'
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
import GlassTooltip, { setupGlobalTooltipListeners } from './ui/GlassTooltip.vue'

const store = useAppStore()
// 迷你条与主面板是不同窗口(不同入口 HTML hash),窗口存续期 hash 不变,无需响应式
const isMini = window.location.hash === '#mini'


// 最左侧栏固定展开宽与折叠宽(支持点击展开/收起, 不与任务卡片之间拖动)
const RAIL_EXPANDED_W = 236
const RAIL_COLLAPSED_W = 64
// 任务列(taskW)/详情列(detailW); 会话流是 minmax(--session-min-w,1fr) 弹性吸收
const TASK_W = { min: 260, max: 500, def: 320 }
const DETAIL_W = { min: 280, max: 480, def: 320 }
/** 会话流列硬下限(展开详情后低于此宽即触发阶梯降级/拒绝),同时注入 CSS 变量 --session-min-w */
const SESSION_MIN_W = 360
/** 分隔列的固定宽(与 gridCols 保持一致) */
const RESIZER_W = 10
/** shell 单侧内边距(.shell padding 消费注入的 --shell-pad,避免 JS/样式两处字面量) */
const SHELL_PAD = 10
/** shell 左右内边距合计(窗口空间计算用) */
const SHELL_PAD_X = SHELL_PAD * 2

function clampW(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 读持久化列宽:缺省/非法值回落默认,出界值收紧到界限 */
function loadW(key: string, def: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw > 0 ? clampW(raw, min, max) : def
}

/**
 * K-04 布局偏好分层:pref = 持久化偏好(仅用户拖拽结束/双击重置时落盘),
 * eff = 生效值(拖拽与渲染的实际值,窄窗自动压缩只改它)。
 * rebalance 每次以 pref 为基准重算 eff —— 窗口放大后自动压缩自然回弹,压缩不累积、偏好不被抹掉。
 */
const taskPref = ref(loadW('agentdrove.layout.taskW', TASK_W.def, TASK_W.min, TASK_W.max))
const detailPref = ref(loadW('agentdrove.layout.detailW', DETAIL_W.def, DETAIL_W.min, DETAIL_W.max))
const taskW = ref(taskPref.value)
const detailW = ref(detailPref.value)

/**
 * 仅在对应列拖拽结束(Resizer end)/双击重置时调用:该列 eff 固化进 pref 并落盘一次。
 * A11/D3:按列回写——只写被操作的那一列;否则另一列若正处自动压缩态(eff < pref),
 * 会被顺手固化进 pref,把用户的持久化偏好悄悄改小。
 */
function persistLayout(key: 'task' | 'detail'): void {
  if (key === 'task') {
    taskPref.value = taskW.value
    localStorage.setItem('agentdrove.layout.taskW', String(taskPref.value))
    return
  }
  detailPref.value = detailW.value
  localStorage.setItem('agentdrove.layout.detailW', String(detailPref.value))
}

/** 双击分隔条恢复推荐宽度:改 eff 并立即落盘(用户显式动作,Resizer 的回调不落盘) */
function resetColumn(key: 'task' | 'detail'): void {
  if (key === 'task') taskW.value = TASK_W.def
  else detailW.value = DETAIL_W.def
  persistLayout(key)
}

const windowW = ref(typeof window !== 'undefined' ? window.innerWidth : 1280)

/** 用户主动展开详情的宽限期:刚点开就缩窗时优先尊重用户意图,照常以 drawer 呈现 */
const USER_EXPAND_GRACE_MS = 1200
let lastDetailExpandAt = 0
/** 已因窗口缩窄自动收起详情:防 resize 抖动反复弹出 drawer(用户再点开时清除) */
let drawerAutoDismissed = false

/** 响应式断点:当窗口宽度足够容纳4栏并留有充裕会话空间(>=420px)时允许并列 Docked */
const canDockDetail = computed(() => {
  const railCol = store.railCollapsed.value ? RAIL_COLLAPSED_W : RAIL_EXPANDED_W
  const needed = railCol + taskW.value + RESIZER_W + 420 + RESIZER_W + detailW.value
  return windowW.value >= needed && windowW.value >= 1260
})

/** 详情展示模式: hidden(收起) | docked(宽屏并列) | drawer(智能自适应浮动抽屉) */
const detailDisplayMode = computed<'hidden' | 'docked' | 'drawer'>(() => {
  if (store.detailCollapsed.value) return 'hidden'
  if (!canDockDetail.value) {
    // K-04:窗口缩窄掉入 drawer 时已自动收起过,不再因 resize 抖动重新弹出(用户再点开即清除该记忆)
    if (drawerAutoDismissed) return 'hidden'
    return 'drawer'
  }
  return 'docked'
})

// 列定义:最左侧栏(展开/折叠) + 任务列 + 分隔条 + 会话流(minmax(--session-min-w,1fr))
// 仅在 detailDisplayMode === 'docked' 时占用 Grid 物理列
const gridCols = computed(() => {
  const railCol = `${store.railCollapsed.value ? RAIL_COLLAPSED_W : RAIL_EXPANDED_W}px`
  // 会话流下限消费注入的 --session-min-w(JS 常量仍是唯一来源,兜底值与之一致)
  const flowCol = `minmax(var(--session-min-w, ${SESSION_MIN_W}px), 1fr)`
  const base = `${railCol} minmax(${TASK_W.min}px, ${taskW.value}px) ${RESIZER_W}px ${flowCol}`
  if (detailDisplayMode.value !== 'docked') {
    return base
  }
  return `${base} ${RESIZER_W}px minmax(${DETAIL_W.min}px, ${detailW.value}px)`
})

// ---- 详情展开空间守卫 + 智能自适应(无报错拒绝设计) ----

/**
 * 展开详情时永远成功:
 * 空间充足自动 Docked 并列，空间紧张平滑降级为抽屉 Drawer 展现，绝不弹窗报错拒绝用户意图
 */
function tryExpandDetail(): boolean {
  return true
}

/** rail 持久化偏好是否本就是收起——自动回弹只回到 pref,不擅自把用户偏好改成展开 */
function railPrefCollapsed(): boolean {
  return (
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('agentdrove.layout.railCollapsed') === 'true'
  )
}

/** 会话流当前可用宽:窗口宽 − shell 内边距 − 固定列(rail/任务列/分隔条/详情列) */
function sessionFlowW(): number {
  const railCol = store.railCollapsed.value ? RAIL_COLLAPSED_W : RAIL_EXPANDED_W
  let used = railCol + taskW.value + RESIZER_W
  if (detailDisplayMode.value === 'docked') used += RESIZER_W + detailW.value
  return windowW.value - SHELL_PAD_X - used
}

/**
 * 缩窗平滑静默再平衡:保全会话流核心可用性,不进行 Toast 弹窗打扰。
 * 每轮先以 pref 重算 eff(放大即回弹),再按空间逐级让渡;rail 只在严重过窄时自动折叠。
 */
function rebalanceColumns(): void {
  taskW.value = taskPref.value
  detailW.value = detailPref.value
  // 1) 优先紧凑任务列(只动 eff,不落盘)
  if (sessionFlowW() < SESSION_MIN_W && taskW.value > TASK_W.min) {
    taskW.value = Math.max(TASK_W.min, taskW.value - (SESSION_MIN_W - sessionFlowW()))
  }
  // 2) 严重过窄时静默折叠侧栏:走 J-14 的 setRailCollapsed(自动折叠不落盘,store 记 autoRailCollapsed 标记)
  if (sessionFlowW() < SESSION_MIN_W && windowW.value < 1000) {
    if (!store.railCollapsed.value) store.setRailCollapsed(true)
    return
  }
  // 3) 空间恢复:仅回弹"自动折叠且 pref 本就展开"的 rail(用户手动收起是偏好,不动),且展开后确实放得下
  if (
    store.autoRailCollapsed.value &&
    store.railCollapsed.value &&
    !railPrefCollapsed() &&
    sessionFlowW() + (RAIL_EXPANDED_W - RAIL_COLLAPSED_W) >= SESSION_MIN_W
  ) {
    store.setRailCollapsed(false)
  }
}

// ---- K-04 drawer 惯例:掉入 drawer 自动收起(防抖动)/ 遮罩与 Esc 退路 ----
watch(store.detailCollapsed, (collapsed) => {
  if (collapsed) return
  lastDetailExpandAt = Date.now()
  drawerAutoDismissed = false
})

// 窗口从 docked 掉入 drawer:若非用户刚打开则保持收起——抽屉突然盖住会话流不是用户意图
watch(canDockDetail, (canDock, prevCanDock) => {
  if (canDock || !prevCanDock || store.detailCollapsed.value) return
  if (Date.now() - lastDetailExpandAt < USER_EXPAND_GRACE_MS) return
  drawerAutoDismissed = true
  store.detailCollapsed.value = true
})

/** drawer 收起唯一入口:头部 ✕ / 点遮罩 / Esc 三处同路径 */
function closeDrawer(): void {
  store.detailCollapsed.value = true
}

/** K-04:Esc 挂 window,仅 drawer 模式生效;模态在上层时由模态自己处理,不越级抢关闭 */
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (store.detailModalOpen.value) return
  if (detailDisplayMode.value === 'drawer') closeDrawer()
}

let lastGuardToastAt = 0
let lastGuardToastText = ''

function guardToast(msg: string): void {
  const now = Date.now()
  if (msg === lastGuardToastText && now - lastGuardToastAt < 1000) return
  lastGuardToastAt = now
  lastGuardToastText = msg
  store.showToast(msg)
}

function setColumnW(key: 'task' | 'detail', value: number): void {
  if (key === 'task') taskW.value = value
  else detailW.value = value
}

/**
 * 任务列与详情列拖拽入口
 */
function applyColumnResize(key: 'task' | 'detail', delta: number): void {
  const conf = key === 'task' ? TASK_W : DETAIL_W
  const cur = key === 'task' ? taskW.value : detailW.value
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

// ---- K-05 toast 渲染:文本 + J-08 可选动作按钮(动作型 toast 存续 6s,由 store 计时) ----
/** A12:文本与动作分两个 ref 存于 store,渲染层只做单一形状读取,不再做载荷兼容分支 */
const toastText = computed(() => store.toast.value)
const toastAction = computed<ToastAction | null>(() => store.toastAction.value)

function runToastAction(): void {
  // 只执行动作;提示的存续/消退由 store 的计时统一收口,渲染层不抢状态
  toastAction.value?.run()
}

/** K-08:折叠/展开侧栏后 180ms 内给 body 挂标记,禁掉 rail 宽度过渡(对齐既有 body.resizing 模式) */
let railAnimTimer: ReturnType<typeof setTimeout> | null = null

// 侧栏展开时平滑让渡空间,优先紧凑任务列,不报错拒绝(只动 eff,不落盘)
watch(store.railCollapsed, (val) => {
  if (isMini) return
  document.body.classList.add('rail-animating')
  if (railAnimTimer) clearTimeout(railAnimTimer)
  railAnimTimer = setTimeout(() => document.body.classList.remove('rail-animating'), 180)
  if (val) return
  // 展开侧栏时若空间紧张，自适应压缩任务列
  const flow = sessionFlowW()
  if (flow < SESSION_MIN_W) {
    if (taskW.value > TASK_W.min) {
      taskW.value = Math.max(TASK_W.min, taskW.value - (SESSION_MIN_W - flow))
    }
  }
})

let cleanupTooltip: (() => void) | null = null

function onWindowResize(): void {
  if (isMini) return
  windowW.value = window.innerWidth
  // K-04:窗口缩放只改 eff(压缩/回弹),绝不落盘 —— pref 只由用户拖拽结束/双击重置写入
  rebalanceColumns()
}

onMounted(() => {
  cleanupTooltip = setupGlobalTooltipListeners()
  registerExpandGuard(tryExpandDetail)
  if (!isMini) {
    windowW.value = window.innerWidth
    rebalanceColumns()
    window.addEventListener('resize', onWindowResize)
    window.addEventListener('keydown', onGlobalKeydown)
  }
})

onBeforeUnmount(() => {
  cleanupTooltip?.()
  registerExpandGuard(null)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('keydown', onGlobalKeydown)
  if (railAnimTimer) clearTimeout(railAnimTimer)
  document.body.classList.remove('rail-animating')
})
</script>

<template>
  <FxLayers />
  <MiniBar v-if="isMini" />
  <template v-else>
    <!-- 自绘标题栏:左 Logo+应用名,右窗口控制 -->
    <TitleBar />
    <!-- 现代化布局: Agent导航侧栏(可展开/收起) / 会话任务历史 / 中央对话工作台 / 任务详情抽屉 -->
    <div
      class="shell view"
      :style="{
        gridTemplateColumns: gridCols,
        '--rail-w': `${store.railCollapsed.value ? RAIL_COLLAPSED_W : RAIL_EXPANDED_W}px`,
        '--shell-pad': `${SHELL_PAD}px`,
        '--session-min-w': `${SESSION_MIN_W}px`,
      }"
    >
      <!-- 第 1 栏: 展开/收起 Agent 侧栏 (不与任务卡片拖动) -->
      <AgentRail />
      <!-- 第 2 栏: 会话与任务卡片列表 -->
      <TaskList />
      <!-- 分隔条: 专供任务卡片与对话工作台之间拖动调整大小 (双击恢复推荐宽) -->
      <Resizer
        :value-now="taskW"
        :min="TASK_W.min"
        :max="TASK_W.max"
        @resize="applyColumnResize('task', $event)"
        @reset="resetColumn('task')"
        @end="persistLayout('task')"
      />
      <!-- 第 3 栏: 核心主工作台(对话卡片) -->
      <SessionColumn />
      <!-- 第 4 栏: 详情伴随栏(宽屏并列呈现) -->
      <template v-if="detailDisplayMode === 'docked'">
        <Resizer
          :value-now="detailW"
          :min="DETAIL_W.min"
          :max="DETAIL_W.max"
          @resize="applyColumnResize('detail', $event)"
          @reset="resetColumn('detail')"
          @end="persistLayout('detail')"
        />
        <TaskDetail />
      </template>
    </div>

    <!-- K-04:drawer 遮罩——独立 fixed 元素,z-index 低于 drawer(K-05 令牌),点它即收起 -->
    <Transition name="drawer-fade">
      <div v-if="detailDisplayMode === 'drawer'" class="drawer-backdrop" @click="closeDrawer" />
    </Transition>
    <!-- 自适应浮动抽屉模式:绝对定位滑出,绝不挤压中央会话流 -->
    <Transition name="drawer-slide">
      <div v-if="detailDisplayMode === 'drawer'" class="detail-drawer glass">
        <div class="drawer-header">
          <span class="drawer-title">任务详情</span>
          <GlassButton variant="ghost" size="sm" @click="closeDrawer">✕</GlassButton>
        </div>
        <div class="drawer-body">
          <TaskDetail />
        </div>
      </div>
    </Transition>
    <!-- 轻提示:底部居中,store.showToast 触发,自动消退;带动作时渲染可点按钮(J-08) -->
    <Transition name="toast-fade">
      <div v-if="toastText" class="toast glass">
        <span class="toast-text">{{ toastText }}</span>
        <button v-if="toastAction" class="toast-action" @click="runToastAction">
          {{ toastAction.label }}
        </button>
      </div>
    </Transition>
    <!-- 全局悬浮提示组件:鼠标移入调用组件展示精致悬浮提示 -->
    <GlassTooltip />
    <!-- 独立弹窗模式:用户点开弹窗随时查看详情与进行全功能操作 -->
    <TaskDetailModal />
    <SettingsPage v-if="store.view.value === 'settings'" @close="store.view.value = 'panel'" />
  </template>
</template>

<style scoped>
.shell {
  display: grid;
  height: calc(100vh - var(--titlebar-h));
  /* K-05:内边距消费 App.vue 注入的 --shell-pad(JS 常量 SHELL_PAD 是唯一来源) */
  padding: var(--shell-pad);
  box-sizing: border-box;
  max-width: 100vw;
  overflow: hidden;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}

/* 轻提示浮层:不拦截点击,2.6s 自动消退(store.showToast);带动作时为 6s 并存续可点按钮 */
.toast {
  position: fixed;
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--accent-line);
  font-size: 12.5px;
  color: var(--text);
  pointer-events: none;
  box-shadow: var(--glass-shadow), 0 8px 24px rgba(0, 0, 0, 0.32);
}

/* 动作按钮单独放行点击:容器仍不拦截,保证底部区域其余位置可正常操作 */
.toast-action {
  pointer-events: auto;
  padding: 2px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--accent-line);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--fast) var(--ease), border-color var(--fast) var(--ease);
}

.toast-action:hover {
  color: var(--accent);
  border-color: var(--accent);
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

/* K-04:drawer 遮罩——独立 fixed 元素,层级比 drawer 低一层(K-05 令牌),点它收起 */
.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-drawer) - 1);
  background: rgba(4, 10, 16, 0.32);
}

/* 窄窗详情浮动抽屉(Drawer模式) */
.detail-drawer {
  position: fixed;
  right: 12px;
  top: calc(var(--titlebar-h) + 10px);
  bottom: 12px;
  width: 380px;
  max-width: calc(100vw - 40px);
  z-index: var(--z-drawer);
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

/* 遮罩只淡入淡出,不跟随抽屉位移 */
.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity 180ms ease;
}

.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}
</style>

<style>
/* K-05/K-08:折叠/展开侧栏后的 180ms 内关掉 rail 宽度过渡(对齐既有 body.resizing 模式)——
   rail 宽度与 grid 列同步跳变,不出现"rail 先动、任务列后到"的拖影 */
body.rail-animating .rail {
  transition: none;
}
</style>
