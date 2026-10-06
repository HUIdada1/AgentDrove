<script lang="ts">
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, Transition } from 'vue'

export interface TooltipState {
  visible: boolean
  content: string
  targetRect: DOMRect | null
  placement: 'top' | 'bottom'
  x: number
  y: number
  arrowX: number
}

const state = reactive<TooltipState>({
  visible: false,
  content: '',
  targetRect: null,
  placement: 'top',
  x: 0,
  y: 0,
  arrowX: 0,
})

let showTimer: ReturnType<typeof setTimeout> | null = null
let currentTarget: HTMLElement | null = null

function clearTimer(): void {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
}

export function hideTooltip(): void {
  clearTimer()
  state.visible = false
  currentTarget = null
}

export function showTooltipForElement(el: HTMLElement, text: string): void {
  if (!text || !text.trim()) {
    hideTooltip()
    return
  }
  clearTimer()
  currentTarget = el
  // 微小延迟 100ms: 既保证快速呼出, 又防止鼠标划过密集区域乱闪
  showTimer = setTimeout(() => {
    if (currentTarget !== el) return
    state.content = text.trim()
    updatePosition(el)
    state.visible = true
  }, 100)
}

function updatePosition(el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  state.targetRect = rect

  const vw = window.innerWidth
  const vh = window.innerHeight
  const padding = 8
  const offset = 8

  // 估算或按默认居中对齐
  const centerX = rect.left + rect.width / 2
  // 上方可用空间与下方可用空间
  const spaceAbove = rect.top
  const spaceBelow = vh - rect.bottom

  // 默认向上弹出, 若上方空间小于 60px 且下方空间更大则向下弹出
  if (spaceAbove < 60 && spaceBelow > spaceAbove) {
    state.placement = 'bottom'
    state.y = rect.bottom + offset
  } else {
    state.placement = 'top'
    state.y = rect.top - offset
  }

  // x 坐标先取中心
  state.x = Math.max(padding, Math.min(vw - padding, centerX))
  state.arrowX = 0
}

/**
 * 全局监听事件初始化:
 * 自动拦截页面上所有带 title 或 data-tooltip 的元素,
 * 将原生 title 清空转为 data-tooltip 并唤起组件悬浮提示, 彻底解决原生提示丑陋/迟钝问题。
 */
export function setupGlobalTooltipListeners(): () => void {
  function findTooltipTarget(node: EventTarget | null): { el: HTMLElement; text: string } | null {
    let cur = node as HTMLElement | null
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const rawTitle = cur.getAttribute('title')
      if (rawTitle && rawTitle.trim()) {
        const text = rawTitle.trim()
        cur.removeAttribute('title')
        cur.dataset.tooltip = text
        return { el: cur, text }
      }
      if (cur.dataset && cur.dataset.tooltip) {
        return { el: cur, text: cur.dataset.tooltip }
      }
      cur = cur.parentElement
    }
    return null
  }

  function onMouseOver(e: MouseEvent): void {
    const target = findTooltipTarget(e.target)
    if (!target) {
      if (currentTarget && !currentTarget.contains(e.target as Node)) {
        hideTooltip()
      }
      return
    }
    if (currentTarget !== target.el) {
      showTooltipForElement(target.el, target.text)
    }
  }

  function onMouseOut(e: MouseEvent): void {
    if (!currentTarget) return
    const related = e.relatedTarget as Node | null
    if (!related || !currentTarget.contains(related)) {
      hideTooltip()
    }
  }

  function onScrollOrResize(): void {
    if (state.visible) {
      hideTooltip()
    }
  }

  document.addEventListener('mouseover', onMouseOver, { passive: true })
  document.addEventListener('mouseout', onMouseOut, { passive: true })
  window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true })
  window.addEventListener('resize', onScrollOrResize, { passive: true })

  return () => {
    document.removeEventListener('mouseover', onMouseOver)
    document.removeEventListener('mouseout', onMouseOut)
    window.removeEventListener('scroll', onScrollOrResize, { capture: true })
    window.removeEventListener('resize', onScrollOrResize)
    clearTimer()
  }
}
</script>

<script setup lang="ts">
const tooltipEl = ref<HTMLElement | null>(null)

const lines = computed(() => state.content.split('\n'))

// 实时精确定位 tooltip 框体和指示小箭头
const tooltipStyle = computed(() => {
  if (!state.visible || !tooltipEl.value) {
    return {
      left: `${state.x}px`,
      top: `${state.y}px`,
      transform: 'translate(-50%, -100%)',
    }
  }

  const elWidth = tooltipEl.value.offsetWidth
  const halfW = elWidth / 2
  const vw = window.innerWidth
  const pad = 10

  let left = state.x

  if (left - halfW < pad) {
    left = pad + halfW
  } else if (left + halfW > vw - pad) {
    left = vw - pad - halfW
  }

  // 箭头相对于 Tooltip 中心的偏移量, 限制在气泡圆角安全区域内
  const rawOffset = state.x - left
  const arrowOffset = Math.max(-halfW + 12, Math.min(halfW - 12, rawOffset))

  const transform = state.placement === 'top'
    ? 'translate(-50%, -100%)'
    : 'translate(-50%, 0)'

  return {
    left: `${left}px`,
    top: `${state.y}px`,
    transform,
    '--arrow-offset': `${arrowOffset}px`,
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="g-tooltip-fade">
      <div
        v-if="state.visible && state.content"
        ref="tooltipEl"
        class="g-tooltip glass"
        :class="[`place-${state.placement}`]"
        :style="tooltipStyle"
        role="tooltip"
      >
        <div class="g-tooltip-inner">
          <div v-for="(line, idx) in lines" :key="idx" class="g-tooltip-line">
            {{ line }}
          </div>
        </div>
        <div class="g-tooltip-arrow" aria-hidden="true" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.g-tooltip {
  position: fixed;
  z-index: 99999;
  pointer-events: none;
  max-width: 360px;
  padding: 6px 11px;
  border-radius: var(--radius-sm);
  background: var(--bg-veil), var(--bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--accent-line);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), var(--glass-shadow);
  color: var(--text);
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
  user-select: none;
  transition: opacity 120ms var(--ease), transform 120ms var(--ease);
}

.g-tooltip-inner {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.g-tooltip-line {
  white-space: pre-wrap;
}

.g-tooltip-arrow {
  position: absolute;
  width: 8px;
  height: 8px;
  background: inherit;
  border: inherit;
  left: calc(50% + var(--arrow-offset, 0px));
  transform: translateX(-50%) rotate(45deg);
}

.place-top .g-tooltip-arrow {
  bottom: -5px;
  border-top: none;
  border-left: none;
}

.place-bottom .g-tooltip-arrow {
  top: -5px;
  border-bottom: none;
  border-right: none;
}

.g-tooltip-fade-enter-active,
.g-tooltip-fade-leave-active {
  transition: opacity 120ms var(--ease), transform 120ms var(--ease);
}

.g-tooltip-fade-enter-from,
.g-tooltip-fade-leave-to {
  opacity: 0;
  transform: translate(-50%, -95%) scale(0.96);
}

.place-bottom.g-tooltip-fade-enter-from,
.place-bottom.g-tooltip-fade-leave-to {
  transform: translate(-50%, -5%) scale(0.96);
}
</style>
