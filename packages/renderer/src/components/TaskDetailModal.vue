<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import GlassModal from '../ui/GlassModal.vue'
import GlassButton from '../ui/GlassButton.vue'
import TaskDetailView from './TaskDetailView.vue'

const store = useAppStore()

const task = computed(() => store.tasks.value.find((t) => t.id === store.selectedTaskId.value) ?? null)

const modalTitle = computed(() => {
  if (!task.value) return '任务详情'
  return `任务详情 · #${task.value.id.slice(0, 8)}`
})

function pinToSidebar(): void {
  store.detailCollapsed.value = false
  store.closeDetailModal()
}
</script>

<template>
  <GlassModal
    :open="store.detailModalOpen.value"
    :title="modalTitle"
    width="720px"
    @close="store.closeDetailModal"
  >
    <div class="modal-wrapper">
      <div class="top-bar">
        <span class="sub-tip">弹窗预览模式 · 您可以随时将其固定到主页右侧</span>
        <GlassButton variant="ghost" size="sm" title="将详情固定在主页右侧面板" @click="pinToSidebar">
          📌 固定到侧栏
        </GlassButton>
      </div>

      <TaskDetailView mode="modal" />
    </div>

    <template #footer>
      <span class="foot-tip">按 Esc 快捷键或点击外部即可快速关闭</span>
      <span class="spacer" />
      <GlassButton variant="ghost" @click="store.closeDetailModal">关闭</GlassButton>
    </template>
  </GlassModal>
</template>

<style scoped>
.modal-wrapper {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 200px;
}

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 4px;
}

.sub-tip {
  font-size: 11.5px;
  color: var(--faint);
}

.foot-tip {
  font-size: 11px;
  color: var(--faint);
}

.spacer {
  flex: 1;
}
</style>
