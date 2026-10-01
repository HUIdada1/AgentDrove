<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from './stores/app'
import AgentsPanel from './components/AgentsPanel.vue'
import Composer from './components/Composer.vue'
import TaskList from './components/TaskList.vue'
import TaskDetail from './components/TaskDetail.vue'
import SettingsPage from './components/SettingsPage.vue'
import MiniBar from './components/MiniBar.vue'

const store = useAppStore()
const isMini = computed(() => window.location.hash === '#mini')
</script>

<template>
  <MiniBar v-if="isMini" />
  <SettingsPage v-else-if="store.view.value === 'settings'" />
  <div v-else class="shell view">
    <AgentsPanel />
    <main class="mid">
      <Composer />
      <TaskList />
    </main>
    <TaskDetail />
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 236px 1fr 336px;
  height: 100vh;
}

.mid {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-inline: 1px solid var(--line);
  background: var(--bg0);
}
</style>
