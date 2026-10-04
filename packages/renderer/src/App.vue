<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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

const store = useAppStore()
// 迷你条与主面板是不同窗口(不同入口 HTML hash),窗口存续期 hash 不变,无需响应式
const isMini = window.location.hash === '#mini'

// ---- 栏宽拖拽(P0-7:三条分隔条各管各的边界,手柄即锚点) ----
// 侧栏(railW)/任务列(taskW)/详情列(detailW);会话流是 minmax(0,1fr) 弹性吸收。
// 界限防拖爆窗口(最小宽 980)。RAIL_COLLAPSED_W 须与 AgentRail 的 .rail.collapsed 宽度一致。
const RAIL_W = { min: 200, max: 320, def: 236 }
const RAIL_COLLAPSED_W = 64
const TASK_W = { min: 280, max: 480, def: 328 }
const DETAIL_W = { min: 280, max: 480, def: 320 }

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

// 列定义:侧栏(折叠时忽略 railW 用折叠宽)+ 分隔 + 任务列 + 分隔 + 会话流(1fr)
// [+ 分隔 + 详情列(若未锁起收起)];侧栏宽经 --rail-w 下传 AgentRail,CSS 变量不干扰折叠类
const gridCols = computed(() => {
  const railCol = `${store.railCollapsed.value ? RAIL_COLLAPSED_W : railW.value}px`
  const base = `${railCol} 10px minmax(${TASK_W.min}px, ${taskW.value}px) 10px minmax(0, 1fr)`
  if (store.detailCollapsed.value) {
    return base
  }
  return `${base} 10px minmax(${DETAIL_W.min}px, ${detailW.value}px)`
})

// ---- 详情展开空间守卫(P0-7) ----
// ResizeObserver 持续测会话流实际宽;展开后预估 <360px 时阶梯降级:
// 收 Agent 侧栏 → 任务列压到最小 → 仍不足则拒绝展开并 toast 说明。
const SESSION_MIN_W = 360
const sessionCol = ref<InstanceType<typeof SessionColumn> | null>(null)
const sessionWidth = ref(0)
let sessionObserver: ResizeObserver | null = null

function tryExpandDetail(): boolean {
  if (!sessionWidth.value) return true
  const afterExpand = sessionWidth.value - (detailW.value + 10)
  if (afterExpand >= SESSION_MIN_W) return true
  let need = SESSION_MIN_W - afterExpand
  // 阶梯一:收起 Agent 侧栏(让渡 railW − 折叠宽);最终拒绝展开时须回滚本阶梯的折叠(P0-7 复审)
  const railWasCollapsed = store.railCollapsed.value
  if (!railWasCollapsed) {
    const gain = railW.value - RAIL_COLLAPSED_W
    store.railCollapsed.value = true
    if (need <= gain) {
      store.showToast('空间不足,已自动收起 Agent 侧栏')
      return true
    }
    need -= gain
  }
  // 阶梯二:任务列压到最小宽
  if (need <= taskW.value - TASK_W.min) {
    taskW.value = TASK_W.min
    store.showToast('空间不足,已收起侧栏并压缩任务列')
    return true
  }
  // 拒绝展开:回滚本轮为探测而收起的侧栏,不让"展开详情"一次点击白丢侧栏
  if (!railWasCollapsed) store.railCollapsed.value = false
  store.showToast('窗口空间不足,展开详情会话流将低于 360px,已保持收起')
  return false
}

/**
 * 反向降级(P0-7 目标交互②):详情已展开时窗口缩窄、会话流被压到 360px 以下,
 * 按同阶梯反向让位:任务列回最小 → 收 Agent 侧栏 → 仍不足则收起详情并 toast。
 * 每步幂等且降级动作改变布局会再次触发观察器,空间恢复后不再进入,天然收敛。
 */
function degradeOnShrink(): void {
  if (store.detailCollapsed.value || !sessionWidth.value) return
  if (sessionWidth.value >= SESSION_MIN_W) return
  if (taskW.value > TASK_W.min) {
    taskW.value = TASK_W.min
    return
  }
  if (!store.railCollapsed.value) {
    store.railCollapsed.value = true
    return
  }
  store.detailCollapsed.value = true
  store.showToast('窗口过窄,已收起详情侧栏以保证会话流可读')
}

onMounted(() => {
  const el = sessionCol.value?.$el as HTMLElement | undefined
  if (el && typeof ResizeObserver !== 'undefined') {
    sessionObserver = new ResizeObserver((entries) => {
      sessionWidth.value = entries[0]?.contentRect.width ?? 0
      degradeOnShrink()
    })
    sessionObserver.observe(el)
  }
  registerExpandGuard(tryExpandDetail)
})

onBeforeUnmount(() => {
  sessionObserver?.disconnect()
  registerExpandGuard(null)
})
</script>

<template>
  <FxLayers />
  <MiniBar v-if="isMini" />
  <template v-else>
    <!-- 自绘标题栏:左 Logo+应用名,右窗口控制;迷你条窗口自带交互,不挂 -->
    <TitleBar />
    <!-- 栏位布局:可收缩 Agent 侧栏 / 任务列表 / 会话流 / 可锁起详情;详情锁起时会话流占满全宽 -->
    <div class="shell view" :style="{ gridTemplateColumns: gridCols, '--rail-w': `${railW}px` }">
      <AgentRail />
      <!-- 第一条:调侧栏宽(手柄即锚点,P0-7);第二条:调任务列;第三条:调详情列 -->
      <Resizer
        @resize="railW = clampW(railW + $event, RAIL_W.min, RAIL_W.max)"
        @end="persistLayout"
      />
      <section class="col">
        <Composer />
        <TaskList />
      </section>
      <Resizer
        @resize="taskW = clampW(taskW + $event, TASK_W.min, TASK_W.max)"
        @end="persistLayout"
      />
      <SessionColumn ref="sessionCol" />
      <template v-if="!store.detailCollapsed.value">
        <Resizer
          @resize="detailW = clampW(detailW - $event, DETAIL_W.min, DETAIL_W.max)"
          @end="persistLayout"
        />
        <TaskDetail />
      </template>
    </div>
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
</style>
