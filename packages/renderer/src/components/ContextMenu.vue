<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 菜单项:group=true 为不可点分组标题;danger 红色;disabled 置灰;
 * children 非空 = 二级子菜单入口(A-11),hover/→/Enter 展开,←/Esc 收回
 */
export interface ContextMenuItem {
  key: string
  label: string
  group?: boolean
  danger?: boolean
  disabled?: boolean
  title?: string
  action?: () => void
  children?: ContextMenuItem[]
}

const props = defineProps<{
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{ close: [] }>()

const menuRef = ref<HTMLElement | null>(null)
/** A-11:二级面板根节点(点外关闭需一并豁免) */
const subRef = ref<HTMLElement | null>(null)
/** A-11:一级项 DOM 实测位置,子面板不得盖住父项 */
const itemEls = ref<(HTMLElement | null)[]>([])

/** v-for 内的模板 ref 回调(卸载时 el 为 null,按 null 记录) */
function setItemEl(el: unknown, index: number): void {
  itemEls.value[index] = el instanceof HTMLElement ? el : null
}

/** G1-07:roving 高亮下标(-1=无);DOM 焦点常驻菜单容器,高亮随 ↑↓/Home/End/悬停移动 */
const activeIndex = ref(-1)
/** A-11:当前展开子菜单的父项下标;-1=未展开 */
const openIndex = ref(-1)
/** A-11:键盘焦点层级——root 走一级、sub 走子面板 */
const level = ref<'root' | 'sub'>('root')
/** A-11:子面板内的 roving 高亮下标 */
const subActiveIndex = ref(-1)

/** 可键盘导航的项下标序列:group/disabled 不参与 */
function actionableIndexes(items: ContextMenuItem[]): number[] {
  return items
    .map((item, index) => (item.group || item.disabled ? -1 : index))
    .filter((index) => index >= 0)
}

const rootIndexes = computed(() => actionableIndexes(props.items))
const subItems = computed<ContextMenuItem[]>(() => props.items[openIndex.value]?.children ?? [])
const subIndexes = computed(() => actionableIndexes(subItems.value))

/** 在可用项序列内循环移动 roving 高亮(按当前层级) */
function moveActive(step: 1 | -1): void {
  const list = level.value === 'sub' ? subIndexes.value : rootIndexes.value
  const current = level.value === 'sub' ? subActiveIndex.value : activeIndex.value
  if (list.length === 0) {
    if (level.value === 'sub') subActiveIndex.value = -1
    else activeIndex.value = -1
    return
  }
  const at = list.indexOf(current)
  const next = at < 0 ? 0 : (at + step + list.length) % list.length
  if (level.value === 'sub') subActiveIndex.value = list[next]!
  else activeIndex.value = list[next]!
}

function jumpActive(pos: 'first' | 'last'): void {
  const list = level.value === 'sub' ? subIndexes.value : rootIndexes.value
  if (list.length === 0) return
  const target = pos === 'first' ? list[0]! : list[list.length - 1]!
  if (level.value === 'sub') subActiveIndex.value = target
  else activeIndex.value = target
}

/** A-11:展开某项的子菜单并把键盘焦点交给子面板 */
function openSub(index: number): void {
  if (!props.items[index]?.children?.length) {
    openIndex.value = -1
    return
  }
  openIndex.value = index
  subActiveIndex.value = -1
}

/** A-11:收回子菜单,键盘焦点回到一级(父项高亮保留) */
function closeSub(): void {
  openIndex.value = -1
  subActiveIndex.value = -1
  level.value = 'root'
}

/** A-11:悬停一级项——带 children 展开、无 children 收回子面板,不误留悬空面板 */
function hoverItem(index: number): void {
  activeIndex.value = index
  level.value = 'root'
  if (props.items[index]?.children?.length) openSub(index)
  else if (openIndex.value !== -1) closeSub()
}

/** A-11:悬停子面板项即把键盘焦点交给子面板(鼠标/键盘两条路径语义一致) */
function hoverSubItem(index: number): void {
  subActiveIndex.value = index
  level.value = 'sub'
}

/** 执行一级项:子菜单入口只展开不关闭,叶子项执行后关闭 */
function triggerRoot(): void {
  const item = props.items[activeIndex.value]
  if (!item || item.group || item.disabled) return
  if (item.children?.length) {
    openSub(activeIndex.value)
    level.value = 'sub'
    subActiveIndex.value = subIndexes.value[0] ?? -1
    return
  }
  item.action?.()
  emit('close')
}

/** 执行子面板项 */
function triggerSub(): void {
  const item = subItems.value[subActiveIndex.value]
  if (!item || item.group || item.disabled) return
  item.action?.()
  emit('close')
}

/** 鼠标点击一级项:与键盘同语义(子菜单入口展开、叶子项执行) */
function onItem(item: ContextMenuItem, index: number): void {
  if (item.group || item.disabled) return
  if (item.children?.length) {
    openSub(index)
    level.value = 'sub'
    subActiveIndex.value = subIndexes.value[0] ?? -1
    return
  }
  item.action?.()
  emit('close')
}

function onSubItem(item: ContextMenuItem): void {
  if (item.group || item.disabled) return
  item.action?.()
  emit('close')
}

/** A-11:子面板按父项实测右缘定位;右侧放不下翻到左侧,底部超界上收 */
const subStyle = computed<Record<string, string>>(() => {
  const el = itemEls.value[openIndex.value] ?? null
  const maxHeight = Math.max(120, window.innerHeight - 16)
  if (!el) return { left: '8px', top: '8px', maxHeight: `${maxHeight}px` }
  const rect = el.getBoundingClientRect()
  const width = 208
  const height = Math.min(subItems.value.length * 30 + 16, maxHeight)
  const left =
    rect.right + 4 + width <= window.innerWidth - 8
      ? rect.right + 4
      : Math.max(8, rect.left - width - 4)
  return {
    left: `${left}px`,
    top: `${Math.max(8, Math.min(rect.top - 5, window.innerHeight - height - 8))}px`,
    maxHeight: `${maxHeight}px`,
  }
})

/**
 * A-12:视口内收口——先按估算尺寸贴边,挂载后按实测矩形校正一次;
 * 高度按视口封顶并溢出滚动,列表再长也不会把菜单顶出窗口。
 * B7:实测前先把上一次修正量清零并等一帧,量到的是无偏移真身,
 * 修正量每次从零收敛(不再在前一次位移上叠算)。
 */
const menuShift = ref({ x: 0, y: 0 })

const menuStyle = computed(() => {
  const width = 216
  const maxHeight = Math.max(120, window.innerHeight - 16)
  const height = Math.min(props.items.length * 30 + 16, maxHeight)
  const left = Math.max(8, Math.min(props.x, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(props.y, window.innerHeight - height - 8))
  return {
    left: `${left}px`,
    top: `${top}px`,
    maxHeight: `${maxHeight}px`,
    transform: `translate(${menuShift.value.x}px, ${menuShift.value.y}px)`,
  }
})

async function reflow(): Promise<void> {
  const el = menuRef.value
  if (!el) return
  menuShift.value = { x: 0, y: 0 }
  await nextTick()
  const rect = el.getBoundingClientRect()
  let dx = 0
  let dy = 0
  if (rect.right > window.innerWidth - 8) dx = window.innerWidth - 8 - rect.right
  if (rect.bottom > window.innerHeight - 8) dy = window.innerHeight - 8 - rect.bottom
  if (rect.left + dx < 8) dx = 8 - rect.left
  if (rect.top + dy < 8) dy = 8 - rect.top
  menuShift.value = { x: dx, y: dy }
}

function onDocPointerDown(event: PointerEvent): void {
  const target = event.target as Node
  if (menuRef.value?.contains(target) || subRef.value?.contains(target)) return
  emit('close')
}

/** G1-07:↑↓/Home/End 完成 roving 导航,Enter/空格执行当前项,Esc 关闭;→/← 进出子面板 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // A-11:子面板先收,再按一次才关整张菜单
    if (openIndex.value !== -1) {
      // B8:本次 Esc 已由子面板消费,不再外泄——否则同一次按键会既收面板又清空列表多选
      event.stopPropagation()
      closeSub()
    } else emit('close')
    return
  }
  if (event.key === 'ArrowRight') {
    if (level.value === 'root' && props.items[activeIndex.value]?.children?.length) {
      event.preventDefault()
      openSub(activeIndex.value)
      level.value = 'sub'
      subActiveIndex.value = subIndexes.value[0] ?? -1
    }
    return
  }
  if (event.key === 'ArrowLeft') {
    if (level.value === 'sub') {
      event.preventDefault()
      closeSub()
    }
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
    if (level.value === 'sub') triggerSub()
    else triggerRoot()
  }
}

/** B7:reflow 变为异步(先清零再等一帧实测),resize 监听走稳定的具名包装以便卸载时精确摘除 */
function onResize(): void {
  void reflow()
}

onMounted(() => {
  // capture 阶段监听:抢在卡片 click 语义前关掉,避免一次点击既开又关
  document.addEventListener('pointerdown', onDocPointerDown, true)
  // B8:capture 阶段收键盘——同层 window 监听里本组件注册最晚,冒泡阶段抢不到「先消费 Esc」的次序
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', onResize)
  // G1-07:打开即聚焦菜单容器并把高亮落在首个可用项,方向键/Enter 立即可用
  void nextTick(() => {
    menuRef.value?.focus()
    jumpActive('first')
    void reflow()
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <!-- 轻量右键菜单(P0-2):fixed 定位玻璃浮层,不引第三方库;G1-07 键盘导航;A-11 二级子菜单 -->
  <div ref="menuRef" class="ctx-menu glass" :style="menuStyle" tabindex="-1" role="menu" @contextmenu.prevent>
    <template v-for="(item, index) in items" :key="item.key">
      <div v-if="item.group" class="ctx-group">{{ item.label }}</div>
      <button
        v-else
        :ref="(el) => setItemEl(el, index)"
        type="button"
        role="menuitem"
        class="ctx-item"
        :class="{
          danger: item.danger,
          disabled: item.disabled,
          focused: index === activeIndex,
          'sub-open': index === openIndex,
        }"
        :title="item.title"
        :disabled="item.disabled"
        :aria-haspopup="item.children?.length ? 'menu' : undefined"
        :aria-expanded="item.children?.length ? index === openIndex : undefined"
        @click="onItem(item, index)"
        @mouseenter="hoverItem(index)"
      >
        <span class="ctx-label">{{ item.label }}</span>
        <span v-if="item.children?.length" class="ctx-arrow" aria-hidden="true">›</span>
      </button>
    </template>
  </div>

  <!-- A-11:二级面板——hover/→ 展开,←/Esc 收回;点它不算点外(见 onDocPointerDown) -->
  <div
    v-if="openIndex !== -1 && subItems.length > 0"
    ref="subRef"
    class="ctx-menu ctx-sub glass"
    :style="subStyle"
    role="menu"
    @contextmenu.prevent
  >
    <template v-for="(item, index) in subItems" :key="item.key">
      <div v-if="item.group" class="ctx-group">{{ item.label }}</div>
      <button
        v-else
        type="button"
        role="menuitem"
        class="ctx-item"
        :class="{ danger: item.danger, disabled: item.disabled, focused: index === subActiveIndex }"
        :title="item.title"
        :disabled="item.disabled"
        @click="onSubItem(item)"
        @mouseenter="hoverSubItem(index)"
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
  /* A-12:长菜单不出窗口——高度封顶后自身滚动 */
  overflow-y: auto;
}

/* G1-07:容器承载键盘焦点(焦点态由项级 .focused 高亮表达),自身不出轮廓 */
.ctx-menu:focus {
  outline: none;
}

.ctx-sub {
  min-width: 208px;
  border-color: var(--accent-line);
}

.ctx-group {
  font-size: 10.5px;
  color: var(--faint);
  letter-spacing: 0.06em;
  padding: 6px 10px 3px;
  user-select: none;
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
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

.ctx-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-arrow {
  flex: none;
  font-size: 13px;
  line-height: 1;
  color: var(--faint);
}

.ctx-item:hover,
.ctx-item.focused,
.ctx-item.sub-open {
  background: var(--accent-dim);
  color: var(--accent-strong);
}

.ctx-item:hover .ctx-arrow,
.ctx-item.focused .ctx-arrow,
.ctx-item.sub-open .ctx-arrow {
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
