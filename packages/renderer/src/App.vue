<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppStore } from './stores/app'
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

// ---- 栏宽拖拽 ----
// 可拖列:任务列(taskW)与详情列(detailW);会话流是 minmax(0,1fr) 弹性吸收,
// 拖任意分隔条都是"一侧变宽、会话流反向变窄"的两边联动。界限防拖爆窗口(最小宽 980)。
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

const taskW = ref(loadW('agentdrove.layout.taskW', TASK_W.def, TASK_W.min, TASK_W.max))
const detailW = ref(loadW('agentdrove.layout.detailW', DETAIL_W.def, DETAIL_W.min, DETAIL_W.max))

/** 拖拽中只改内存,松手(Resizer end)才落盘,避免高频 localStorage 写 */
function persistLayout(): void {
  localStorage.setItem('agentdrove.layout.taskW', String(taskW.value))
  localStorage.setItem('agentdrove.layout.detailW', String(detailW.value))
}

// 列定义:auto(侧栏)+ 分隔 + 任务列 + 分隔 + 会话流(1fr)[+ 分隔 + 详情列(若未锁起收起)]
const gridCols = computed(() => {
  const base = `auto 10px minmax(${TASK_W.min}px, ${taskW.value}px) 10px minmax(0, 1fr)`
  if (store.detailCollapsed.value) {
    return base
  }
  return `${base} 10px minmax(${DETAIL_W.min}px, ${detailW.value}px)`
})
</script>

<template>
  <FxLayers />
  <MiniBar v-if="isMini" />
  <template v-else>
    <!-- 自绘标题栏:左 Logo+应用名,右窗口控制;迷你条窗口自带交互,不挂 -->
    <TitleBar />
    <!-- 栏位布局:可收缩 Agent 侧栏 / 任务列表 / 会话流 / 可锁起详情;详情锁起时会话流占满全宽 -->
    <div class="shell view" :style="{ gridTemplateColumns: gridCols }">
      <AgentRail />
      <Resizer
        @resize="taskW = clampW(taskW + $event, TASK_W.min, TASK_W.max)"
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
      <SessionColumn />
      <template v-if="!store.detailCollapsed.value">
        <Resizer
          @resize="detailW = clampW(detailW - $event, DETAIL_W.min, DETAIL_W.max)"
          @end="persistLayout"
        />
        <TaskDetail />
      </template>
    </div>
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
</style>
