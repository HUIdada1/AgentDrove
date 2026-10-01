<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from './stores/app'
import AgentRail from './components/AgentRail.vue'
import Composer from './components/Composer.vue'
import TaskList from './components/TaskList.vue'
import SessionColumn from './components/SessionColumn.vue'
import TaskDetail from './components/TaskDetail.vue'
import SettingsPage from './components/SettingsPage.vue'
import MiniBar from './components/MiniBar.vue'

const store = useAppStore()
const isMini = computed(() => window.location.hash === '#mini')
</script>

<template>
  <MiniBar v-if="isMini" />
  <SettingsPage v-else-if="store.view.value === 'settings'" />
  <!-- 四栏:可收缩 Agent 侧栏 / 任务列表 / 会话流 / 详情 -->
  <div v-else class="shell view">
    <AgentRail />
    <section class="col">
      <Composer />
      <TaskList />
    </section>
    <SessionColumn />
    <TaskDetail />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: auto 328px minmax(0, 1fr) 320px;
  gap: 10px;
  height: 100vh;
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
