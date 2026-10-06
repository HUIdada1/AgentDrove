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
import GlassTooltip, { setupGlobalTooltipListeners } from './ui/GlassTooltip.vue'

const store = useAppStore()
// 迷你条与主面板是不同窗口(不同入口 HTML hash),窗口存续期 hash 不变,无需响应式
const isMini = window.location.hash === '#mini'


// 最左侧栏固定展开宽与折叠宽(支持点击展开/收起, 不与任务卡片之间拖动)
const RAIL_EXPANDED_W = 236
const RAIL_COLLAPSED_W = 64
// 任务列(taskW)/详情列(detailW); 会话流是 minmax(360px,1fr) 弹性吸收
const TASK_W = { min: 260, max: 500, def: 320 }
const DETAIL_W = { min: 280, max: 480, def: 320 }
/** 会话流列硬下限(展开详情后低于此宽即触发阶梯降级/拒绝) */
const SESSION_MIN_W = 360
/** 分隔列的固定宽(与 gridCols 保持一致) */
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

const taskW = ref(loadW('agentdrove.layout.taskW', TASK_W.def, TASK_W.min, TASK_W.max))
const detailW = ref(loadW('agentdrove.layout.detailW', DETAIL_W.def, DETAIL_W.min, DETAIL_W.max))

/** 拖拽中只改内存,松手(Resizer end)才落盘,避免高频 localStorage 写 */
function persistLayout(): void {
  localStorage.setItem('agentdrove.layout.taskW', String(taskW.value))
  localStorage.setItem('agentdrove.layout.detailW', String(detailW.value))
}

const windowW = ref(typeof window !== 'undefined' ? window.innerWidth : 1280)

/** 响应式断点:当窗口宽度足够容纳4栏并留有充裕会话空间(>=420px)时允许并列 Docked */
const canDockDetail = computed(() => {
  const railCol = store.railCollapsed.value ? RAIL_COLLAPSED_W : RAIL_EXPANDED_W
  const needed = railCol + taskW.value + RESIZER_W + 420 + RESIZER_W + detailW.value
  return windowW.value >= needed && windowW.value >= 1260
})

/** 详情展示模式: hidden(收起) | docked(宽屏并列) | drawer(智能自适应浮动抽屉) */
const detailDisplayMode = computed<'hidden' | 'docked' | 'drawer'>(() => {
  if (store.detailCollapsed.value) return 'hidden'
  return canDockDetail.value ? 'docked' : 'drawer'
})

// 列定义:最左侧栏(展开/折叠) + 任务列 + 分隔条 + 会话流(minmax(360px,1fr))
// 仅在 detailDisplayMode === 'docked' 时占用 Grid 物理列
const gridCols = computed(() => {
  const railCol = `${store.railCollapsed.value ? RAIL_COLLAPSED_W : RAIL_EXPANDED_W}px`
  const base = `${railCol} minmax(${TASK_W.min}px, ${taskW.value}px) ${RESIZER_W}px minmax(${SESSION_MIN_W}px, 1fr)`
  if (detailDisplayMode.value !== 'docked') {
    return base
  }
  return `${base} ${RESIZER_W}px minmax(${DETAIL_W.min}px, ${detailW.value}px)`
})

// ---- 详情展开空间守卫 + 智能自适应(无报错拒绝设计) ----
const sessionCol = ref<InstanceType<typeof SessionColumn> | null>(null)

/**
 * 展开详情时永远成功:
 * 空间充足自动 Docked 并列，空间紧张平滑降级为抽屉 Drawer 展现，绝不弹窗报错拒绝用户意图
 */
function tryExpandDetail(): boolean {
  return true
}

/**
 * 缩窗平滑静默再平衡:保全会话流核心可用性，不进行 Toast 弹窗打扰
 */
function rebalanceColumns(): void {
  const contentW = windowW.value - SHELL_PAD_X
  const railCol = store.railCollapsed.value ? RAIL_COLLAPSED_W : RAIL_EXPANDED_W
  let used = railCol + taskW.value + RESIZER_W
  if (detailDisplayMode.value === 'docked') {
    used += RESIZER_W + detailW.value
  }
  const flowW = contentW - used
  if (flowW < SESSION_MIN_W) {
    // 1) 优先紧凑任务列
    if (taskW.value > TASK_W.min) {
      taskW.value = Math.max(TASK_W.min, taskW.value - (SESSION_MIN_W - flowW))
    }
    // 2) 严重过窄时静默折叠侧栏
    if (windowW.value < 1000 && !store.railCollapsed.value) {
      store.railCollapsed.value = true
    }
  }
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

// 侧栏展开时平滑让渡空间，优先紧凑任务列，不报错拒绝
watch(store.railCollapsed, (val) => {
  if (isMini || val) return
  // 展开侧栏时若空间紧张，自适应压缩任务列
  const flow = sessionFlowW()
  if (flow < SESSION_MIN_W) {
    if (taskW.value > TASK_W.min) {
      taskW.value = Math.max(TASK_W.min, taskW.value - (SESSION_MIN_W - flow))
    }
  }
})

let persistTimer: ReturnType<typeof setTimeout> | null = null
let cleanupTooltip: (() => void) | null = null

function onWindowResize(): void {
  if (isMini) return
  windowW.value = window.innerWidth
  rebalanceColumns()
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(persistLayout, 300)
}

onMounted(() => {
  cleanupTooltip = setupGlobalTooltipListeners()
  registerExpandGuard(tryExpandDetail)
  if (!isMini) {
    windowW.value = window.innerWidth
    rebalanceColumns()
    persistLayout()
    window.addEventListener('resize', onWindowResize)
  }
})

onBeforeUnmount(() => {
  cleanupTooltip?.()
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
    <!-- 现代化布局: Agent导航侧栏(可展开/收起) / 会话任务历史 / 中央对话工作台 / 任务详情抽屉 -->
    <div class="shell view" :style="{ gridTemplateColumns: gridCols, '--rail-w': `${store.railCollapsed.value ? RAIL_COLLAPSED_W : RAIL_EXPANDED_W}px` }">
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
        @reset="taskW = TASK_W.def"
        @end="persistLayout"
      />
      <!-- 第 3 栏: 核心主工作台(对话卡片) -->
      <SessionColumn ref="sessionCol" />
      <!-- 第 4 栏: 详情伴随栏(宽屏并列呈现) -->
      <template v-if="detailDisplayMode === 'docked'">
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

    <!-- 自适应浮动抽屉模式:绝对定位滑出,绝不挤压中央会话流 -->
    <Transition name="drawer-slide">
      <div v-if="detailDisplayMode === 'drawer'" class="detail-drawer glass">
        <div class="drawer-header">
          <span class="drawer-title">任务详情</span>
          <GlassButton variant="ghost" size="sm" @click="store.detailCollapsed.value = true">✕</GlassButton>
        </div>
        <div class="drawer-body">
          <TaskDetail />
        </div>
      </div>
    </Transition>
    <!-- 轻提示:底部居中,store.showToast 触发,自动消退 -->
    <Transition name="toast-fade">
      <div v-if="store.toast.value" class="toast glass">{{ store.toast.value }}</div>
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
  padding: 10px;
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
