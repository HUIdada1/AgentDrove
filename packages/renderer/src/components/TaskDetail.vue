<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import TaskDetailView from './TaskDetailView.vue'

const store = useAppStore()
const task = computed(() => store.tasks.value.find((t) => t.id === store.selectedTaskId.value) ?? null)

function lockAndCollapse(): void {
  store.detailCollapsed.value = true
}

function openModal(): void {
  store.openDetailModal()
}
</script>

<template>
  <aside class="detail glass">
    <header class="head">
      <div class="head-left">
        <span class="title">详情</span>
        <span v-if="task" class="id num" :title="task.id">{{ task.id.slice(0, 8) }}</span>
      </div>
      <div class="head-ops">
        <GlassButton variant="ghost" size="sm" title="放大为弹窗查看" @click="openModal">
          ↗ 弹窗
        </GlassButton>
        <GlassButton variant="ghost" size="sm" title="锁起/收起侧栏,腾出主页空间" @click="lockAndCollapse">
          🔒 锁起
        </GlassButton>
      </div>
    </header>

    <div class="body">
      <TaskDetailView mode="panel" />
    </div>
  </aside>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  height: 100%;
  padding: 12px 14px;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex: none;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
}

.head-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title {
  font-weight: 600;
  letter-spacing: 0.5px;
}

.id {
  font-size: 11px;
  color: var(--faint);
}

.head-ops {
  display: flex;
  align-items: center;
  gap: 4px;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
</style>
