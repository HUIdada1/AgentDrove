<script setup lang="ts">
import { useAppStore } from './stores/app'
import AgentRail from './components/AgentRail.vue'
import Composer from './components/Composer.vue'
import TaskList from './components/TaskList.vue'
import SessionColumn from './components/SessionColumn.vue'
import TaskDetail from './components/TaskDetail.vue'
import SettingsPage from './components/SettingsPage.vue'
import MiniBar from './components/MiniBar.vue'
import FxLayers from './components/FxLayers.vue'
import TitleBar from './components/TitleBar.vue'

const store = useAppStore()
// 迷你条与主面板是不同窗口(不同入口 HTML hash),窗口存续期 hash 不变,无需响应式
const isMini = window.location.hash === '#mini'
</script>

<template>
  <FxLayers />
  <MiniBar v-if="isMini" />
  <template v-else>
    <!-- 自绘标题栏:左 Logo+应用名,右窗口控制;迷你条窗口自带交互,不挂 -->
    <TitleBar />
    <!-- 四栏:可收缩 Agent 侧栏 / 任务列表 / 会话流 / 详情;恒渲染,设置以弹窗叠加其上 -->
    <div class="shell view">
      <AgentRail />
      <section class="col">
        <Composer />
        <TaskList />
      </section>
      <SessionColumn />
      <TaskDetail />
    </div>
    <SettingsPage v-if="store.view.value === 'settings'" @close="store.view.value = 'panel'" />
  </template>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: auto 328px minmax(0, 1fr) 320px;
  gap: 10px;
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
