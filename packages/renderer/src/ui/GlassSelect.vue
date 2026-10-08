<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null
    options: Array<{ value: string; label: string }>
    disabled?: boolean
    placeholder?: string
    title?: string
    /** G4-04:面板顶部渲染即时过滤输入框(模型多时免肉眼滚动),缺省关闭零影响 */
    searchable?: boolean
  }>(),
  {
    modelValue: '',
    disabled: false,
    placeholder: '请选择',
    title: '',
    searchable: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

/** 面板最大高度(GlassSelect.vue:218 现状值):贴底翻转的判定基准 */
const PANEL_MAX_H = 240

/** aria-activedescendant 需要文档内唯一 id:模块级计数器生成实例前缀 */
let selectSeq = 0
const uid = `g-select-${++selectSeq}`

const isOpen = ref(false)
const containerRef = ref<HTMLElement | null>(null)
const alignRight = ref(false)
/** R02:下方空间不足面板高度时向上弹出(bottom: calc(100% + 4px)) */
const openUp = ref(false)
/** R02:面板高度 clamp 到视口内较大一侧的可用空间,翻转后顶部不再被 overflow:hidden 裁切 */
const panelMaxH = ref(PANEL_MAX_H)
/** R02:标准键盘导航的当前高亮项(仅移动高亮,Enter 才提交) */
const focusIndex = ref(-1)

/** G4-04:searchable 过滤关键字与过滤后的选项(高亮索引/Enter 确认/滚动定位均基于过滤集) */
const keyword = ref('')
const searchRef = ref<HTMLInputElement | null>(null)
const visibleOptions = computed(() => {
  const kw = keyword.value.toLowerCase()
  return kw ? props.options.filter((o) => o.label.toLowerCase().includes(kw)) : props.options
})
const emptyText = computed(() => (keyword.value ? '无匹配选项' : '暂无可选选项'))

const selectedOption = computed(() => {
  return props.options.find((opt) => String(opt.value) === String(props.modelValue))
})

const displayText = computed(() => {
  if (selectedOption.value) return selectedOption.value.label
  if (props.modelValue !== '' && props.modelValue !== null && props.modelValue !== undefined) {
    return String(props.modelValue)
  }
  return props.placeholder
})

function optionId(index: number): string {
  return `${uid}-opt-${index}`
}

/** 当前选中项在选项数组中的下标;未命中返回 -1 */
function selectedIndexOf(options: Array<{ value: string; label: string }>): number {
  return options.findIndex((o) => String(o.value) === String(props.modelValue))
}

/**
 * 打开时按触发器视口坐标测量(R02):剩余空间参照 window 而非任何滚动容器,
 * 因此不会被 .session 等祖先的 overflow:hidden 在容器顶缘裁掉;
 * 下方不足面板高度时翻转向下为向上,并把面板高度 clamp 到可用更大的一侧。
 */
function measurePanel(): void {
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return
  const spaceBelow = window.innerHeight - rect.bottom - 4
  const spaceAbove = rect.top - 4
  openUp.value = spaceBelow < PANEL_MAX_H && spaceAbove > spaceBelow
  panelMaxH.value = Math.max(80, Math.min(PANEL_MAX_H, Math.max(spaceBelow, spaceAbove)))
  // 右缘溢出保护(沿用现状 260 阈值):靠右对齐
  alignRight.value = window.innerWidth - rect.left < 260
}

function openDropdown(): void {
  measurePanel()
  // G4-04:每次打开重置过滤,选中项按过滤集(此时等于全量)重新高亮
  keyword.value = ''
  isOpen.value = true
  // 打开即高亮当前选中项(无选中停在 -1,首次 ↓ 落到第 0 项)
  focusIndex.value = selectedIndexOf(visibleOptions.value)
  if (props.searchable) {
    void nextTick(() => searchRef.value?.focus())
  }
}

function toggleDropdown(): void {
  if (props.disabled) return
  if (isOpen.value) {
    isOpen.value = false
  } else {
    openDropdown()
  }
}

function selectOption(opt: { value: string; label: string }): void {
  if (props.disabled) return
  emit('update:modelValue', opt.value)
  emit('change', opt.value)
  isOpen.value = false
}

function onClickOutside(event: MouseEvent): void {
  if (containerRef.value && !containerRef.value.contains(event.target as Node)) {
    isOpen.value = false
  }
}

/** R02:WAI-ARIA combobox 键盘惯例——↓↑ 只移动高亮,Enter/空格确认,Esc 关闭不改值,Home/End 跳首尾 */
function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (!isOpen.value) {
      openDropdown()
      return
    }
    const opt = visibleOptions.value[focusIndex.value]
    if (opt) selectOption(opt)
    else isOpen.value = false
  } else if (event.key === 'Escape') {
    // Esc 仅收起面板,不改当前值
    isOpen.value = false
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!isOpen.value) {
      openDropdown()
      return
    }
    if (visibleOptions.value.length > 0 && focusIndex.value < visibleOptions.value.length - 1) {
      focusIndex.value++
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!isOpen.value) {
      openDropdown()
      return
    }
    if (focusIndex.value > 0) {
      focusIndex.value--
    }
  } else if (event.key === 'Home' && isOpen.value) {
    event.preventDefault()
    if (visibleOptions.value.length > 0) focusIndex.value = 0
  } else if (event.key === 'End' && isOpen.value) {
    event.preventDefault()
    if (visibleOptions.value.length > 0) focusIndex.value = visibleOptions.value.length - 1
  }
}

/** G4-04:过滤输入框内键盘——↓↑ 走既有高亮逻辑,Enter 确认,Esc 关闭;stop 阻断外层 combobox 重复处理 */
function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (visibleOptions.value.length > 0 && focusIndex.value < visibleOptions.value.length - 1) {
      focusIndex.value++
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (focusIndex.value > 0) focusIndex.value--
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const opt = visibleOptions.value[focusIndex.value]
    if (opt) selectOption(opt)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    isOpen.value = false
  }
}

// 高亮项跟随滚动:键盘移动时把焦点项滚入可视区(nearest 不产生多余滚动)
watch(focusIndex, async (idx) => {
  if (!isOpen.value || idx < 0) return
  await nextTick()
  containerRef.value
    ?.querySelector(`#${CSS.escape(optionId(idx))}`)
    ?.scrollIntoView({ block: 'nearest' })
})

// G4-04:关键字变化后过滤集变化,高亮重置;flush:sync——openDropdown 清关键字时同步重置,
// 再由其后设置的选中高亮覆盖;异步 flush 会反过来覆盖丢失打开时的高亮
watch(
  keyword,
  () => {
    focusIndex.value = -1
  },
  { flush: 'sync' },
)

/** G4-04:失焦收起——Tab 把焦点移出组件后立即收起面板(relatedTarget 为 null 视为外部) */
function onFocusout(event: FocusEvent): void {
  const related = event.relatedTarget as Node | null
  if (!related || !containerRef.value?.contains(related)) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside)
  containerRef.value?.addEventListener('focusout', onFocusout)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutside)
  containerRef.value?.removeEventListener('focusout', onFocusout)
})
</script>

<template>
  <div
    ref="containerRef"
    class="g-select-wrap"
    :class="{ open: isOpen, disabled }"
    :title="title"
    tabindex="0"
    role="combobox"
    :aria-expanded="isOpen"
    :aria-activedescendant="isOpen && focusIndex >= 0 ? optionId(focusIndex) : undefined"
    @keydown="onKeydown"
  >
    <div class="g-select-trigger" @click="toggleDropdown">
      <span class="g-select-text" :class="{ placeholder: !selectedOption && !modelValue }">
        {{ displayText }}
      </span>
      <span class="g-arrow" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </span>
    </div>

    <transition name="g-popper-fade">
      <div
        v-if="isOpen"
        class="g-dropdown-popper glass"
        :class="{ 'align-right': alignRight, 'open-up': openUp }"
        role="listbox"
        :style="{ maxHeight: `${panelMaxH}px` }"
      >
        <!-- G4-04:searchable 即时过滤框,置于面板顶部并 sticky 不随选项滚走 -->
        <input
          v-if="searchable"
          ref="searchRef"
          v-model="keyword"
          class="g-search"
          type="text"
          placeholder="输入筛选…"
          @keydown.stop="onSearchKeydown"
        >
        <div v-if="visibleOptions.length === 0" class="g-option-empty">
          {{ emptyText }}
        </div>
        <div
          v-for="(opt, idx) in visibleOptions"
          :id="optionId(idx)"
          :key="opt.value"
          class="g-option"
          role="option"
          :aria-selected="String(opt.value) === String(modelValue)"
          :class="{
            selected: String(opt.value) === String(modelValue),
            focused: idx === focusIndex,
          }"
          :title="opt.label"
          @mousedown.prevent
          @click.stop="selectOption(opt)"
          @mouseenter="focusIndex = idx"
        >
          <span class="g-option-label">{{ opt.label }}</span>
          <span v-if="String(opt.value) === String(modelValue)" class="g-check" aria-hidden="true">✓</span>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.g-select-wrap {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
  min-width: 90px;
  outline: none;
  user-select: none;
  font-size: 12px;
}

.g-select-trigger {
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 10px;
  background: var(--field-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--text);
  cursor: pointer;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 -1px 0 var(--glass-specular);
  transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease), background var(--fast) var(--ease);
}

.g-select-wrap:hover .g-select-trigger {
  border-color: var(--line-strong);
}

.g-select-wrap:focus-visible .g-select-trigger,
.g-select-wrap.open .g-select-trigger {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-dim);
}

.g-select-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.g-select-text.placeholder {
  color: var(--muted);
}

.g-arrow {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  transition: transform 180ms var(--ease), color var(--fast) var(--ease);
}

.g-select-wrap.open .g-arrow {
  transform: rotate(180deg);
  color: var(--accent-strong);
}

.g-select-wrap.disabled {
  opacity: 0.55;
  cursor: not-allowed;
  pointer-events: none;
}

/* 下拉浮层面板 */
.g-dropdown-popper {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 100%;
  width: max-content;
  max-width: 320px;
  max-height: 240px;
  overflow-y: auto;
  /* C-16/A19:消费浮层令牌,确保下拉在抽屉(1100)/模态(1200)之上 */
  z-index: var(--z-popover);
  background: var(--bg-veil), var(--bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  padding: 4px;
  box-shadow: var(--glass-shadow), 0 8px 24px rgba(0, 0, 0, 0.38);
}

.g-dropdown-popper.align-right {
  left: auto;
  right: 0;
}

/* R02:贴底翻转——下方空间不足时向上弹出,配合内联 maxHeight clamp 不被视口裁切 */
.g-dropdown-popper.open-up {
  top: auto;
  bottom: calc(100% + 4px);
}

.g-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--text);
  cursor: pointer;
  transition: background var(--fast) var(--ease), color var(--fast) var(--ease);
}

/* G4-04:过滤输入框——sticky 固定面板顶部,滚动列表时不被选项盖过 */
.g-search {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: 2px 2px 4px;
  padding: 5px 8px;
  width: calc(100% - 4px);
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--field-bg);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--fast) var(--ease);
}

.g-search:focus {
  border-color: var(--accent-line);
}

.g-search::placeholder {
  color: var(--muted);
}

.g-option:hover,
.g-option.focused {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

:root[data-theme='light'] .g-option:hover,
:root[data-theme='light'] .g-option.focused {
  background: rgba(15, 23, 42, 0.06);
}

.g-option.selected {
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
}

.g-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.g-check {
  font-size: 11px;
  color: var(--accent-strong);
  font-weight: bold;
}

.g-option-empty {
  padding: 8px 10px;
  text-align: center;
  color: var(--muted);
  font-size: 11px;
}

/* 动效 */
.g-popper-fade-enter-active,
.g-popper-fade-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}

.g-popper-fade-enter-from,
.g-popper-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
</style>
