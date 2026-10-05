<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

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

/** G1-07:roving 高亮下标(-1=无);DOM 焦点常驻菜单容器,高亮随 ↑↓/Home/End/悬停移动 */
const activeIndex = ref(-1)

/** 可键盘导航的项下标序列:group/disabled 不参与 */
const actionableIndexes = computed(() =>
  props.items
    .map((item, index) => (item.group || item.disabled ? -1 : index))
    .filter((index) => index >= 0),
)

/** 在可用项序列内循环移动 roving 高亮 */
function moveActive(step: 1 | -1): void {
  const list = actionableIndexes.value
  if (list.length === 0) {
    activeIndex.value = -1
    return
  }
  const at = list.indexOf(activeIndex.value)
  const next = at < 0 ? 0 : (at + step + list.length) % list.length
  activeIndex.value = list[next]!
}

function jumpActive(pos: 'first' | 'last'): void {
  const list = actionableIndexes.value
  if (list.length === 0) return
  activeIndex.value = pos === 'first' ? list[0]! : list[list.length - 1]!
}

/** 执行当前高亮项并关闭(group/disabled 项不响应) */
function triggerActive(): void {
  const item = props.items[activeIndex.value]
  if (!item || item.group || item.disabled) return
  item.action?.()
  emit('close')
}

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

/** G1-07:↑↓/Home/End 完成 roving 导航,Enter/空格执行当前项,Esc 关闭 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    jumpActive('first')
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    jumpActive('last')
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    triggerActive()
  }
}

onMounted(() => {
  // capture 阶段监听:抢在卡片 click 语义前关掉,避免一次点击既开又关
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onKeydown)
  // G1-07:打开即聚焦菜单容器并把高亮落在首个可用项,方向键/Enter 立即可用
  void nextTick(() => {
    menuRef.value?.focus()
    jumpActive('first')
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <!-- 轻量右键菜单(P0-2):fixed 定位玻璃浮层,不引第三方库;G1-07 补齐 menu 语义与键盘导航 -->
  <div ref="menuRef" class="ctx-menu glass" :style="menuStyle" tabindex="-1" role="menu" @contextmenu.prevent>
    <template v-for="(item, index) in items" :key="item.key">
      <div v-if="item.group" class="ctx-group">{{ item.label }}</div>
      <button
        v-else
        type="button"
        role="menuitem"
        class="ctx-item"
        :class="{ danger: item.danger, disabled: item.disabled, focused: index === activeIndex }"
        :title="item.title"
        :disabled="item.disabled"
        @click="onItem(item)"
        @mouseenter="activeIndex = index"
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

/* G1-07:容器承载键盘焦点(焦点态由项级 .focused 高亮表达),自身不出轮廓 */
.ctx-menu:focus {
  outline: none;
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

.ctx-item:hover,
.ctx-item.focused {
  background: var(--accent-dim);
  color: var(--accent-strong);
}

.ctx-item.danger {
  color: var(--err);
}

.ctx-item.danger:hover,
.ctx-item.danger.focused {
  background: color-mix(in srgb, var(--err) 12%, transparent);
  color: var(--err);
}

.ctx-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
