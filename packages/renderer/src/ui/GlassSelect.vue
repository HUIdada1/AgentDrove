<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null
    options: Array<{ value: string; label: string }>
    disabled?: boolean
    placeholder?: string
    title?: string
  }>(),
  {
    modelValue: '',
    disabled: false,
    placeholder: '请选择',
    title: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const isOpen = ref(false)
const containerRef = ref<HTMLElement | null>(null)

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

function toggleDropdown(): void {
  if (props.disabled) return
  isOpen.value = !isOpen.value
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

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    isOpen.value = !isOpen.value
  } else if (event.key === 'Escape') {
    isOpen.value = false
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!isOpen.value) {
      isOpen.value = true
    } else {
      const idx = props.options.findIndex((o) => String(o.value) === String(props.modelValue))
      if (idx < props.options.length - 1) {
        selectOption(props.options[idx + 1]!)
      }
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!isOpen.value) {
      isOpen.value = true
    } else {
      const idx = props.options.findIndex((o) => String(o.value) === String(props.modelValue))
      if (idx > 0) {
        selectOption(props.options[idx - 1]!)
      }
    }
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutside)
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
      <div v-if="isOpen" class="g-dropdown-popper glass">
        <div v-if="options.length === 0" class="g-option-empty">
          暂无可选选项
        </div>
        <div
          v-for="opt in options"
          :key="opt.value"
          class="g-option"
          :class="{ selected: String(opt.value) === String(modelValue) }"
          @click.stop="selectOption(opt)"
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
  z-index: 1000;
  background: var(--bg-veil), var(--bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  padding: 4px;
  box-shadow: var(--glass-shadow), 0 8px 24px rgba(0, 0, 0, 0.38);
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

.g-option:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

:root[data-theme='light'] .g-option:hover {
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
