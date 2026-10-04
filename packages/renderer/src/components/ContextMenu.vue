<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/** 菜单项:group=true 为不可点分组标题;danger 红色;disabled 置灰 */
export interface ContextMenuItem {
  key: string
  label: string
  group?: boolean
  danger?: boolean
  disabled?: boolean
  title?: string
  action?: () => void
}

const props = defineProps<{
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{ close: [] }>()

const menuRef = ref<HTMLElement | null>(null)

function onItem(item: ContextMenuItem): void {
  if (item.group || item.disabled) return
  item.action?.()
  emit('close')
}

/** 视口内收口:右/下越界时向内收,避免菜单被窗口边缘裁掉 */
const menuStyle = computed(() => {
  const width = 216
  const height = props.items.length * 30 + 16
  return {
    left: `${Math.max(8, Math.min(props.x, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, Math.min(props.y, window.innerHeight - height - 8))}px`,
  }
})

function onDocPointerDown(event: PointerEvent): void {
  if (menuRef.value && !menuRef.value.contains(event.target as Node)) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  // capture 阶段监听:抢在卡片 click 语义前关掉,避免一次点击既开又关
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <!-- 轻量右键菜单(P0-2):fixed 定位玻璃浮层,不引第三方库 -->
  <div ref="menuRef" class="ctx-menu glass" :style="menuStyle" @contextmenu.prevent>
    <template v-for="item in items" :key="item.key">
      <div v-if="item.group" class="ctx-group">{{ item.label }}</div>
      <button
        v-else
        type="button"
        class="ctx-item"
        :class="{ danger: item.danger, disabled: item.disabled }"
        :title="item.title"
        :disabled="item.disabled"
        @click="onItem(item)"
      >
        {{ item.label }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 2100;
  min-width: 216px;
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line-strong);
  box-shadow: var(--glass-shadow), 0 10px 28px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ctx-group {
  font-size: 10.5px;
  color: var(--faint);
  letter-spacing: 0.06em;
  padding: 6px 10px 3px;
  user-select: none;
}

.ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  cursor: pointer;
  transition: background var(--fast) var(--ease), color var(--fast) var(--ease);
}

.ctx-item:hover {
  background: var(--accent-dim);
  color: var(--accent-strong);
}

.ctx-item.danger {
  color: var(--err);
}

.ctx-item.danger:hover {
  background: color-mix(in srgb, var(--err) 12%, transparent);
  color: var(--err);
}

.ctx-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
