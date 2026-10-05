<script setup lang="ts">
/**
 * 栏间拖拽分隔条:按住水平拖动,拖拽中 emit('resize', clientX 增量),
 * 松手 emit('end')(父层借此把列宽落盘一次,拖拽中不写存储)。
 * pointer capture 保证拖出元素/窗口边缘不丢事件;拖拽期禁用全文选中。
 * 宽度控制、min/max 与持久化由父层(grid 布局)负责,这里只产出增量。
 * G4-05:可聚焦(Tab),←/→ 步进(Shift ×4 加速),keyup 触发落盘;
 * aria 值由父层经 valueNow/min/max 下传,读屏可读出当前列宽。
 */
defineProps<{
  /** 当前分隔条所调列宽(aria-valuenow,读屏播报用) */
  valueNow?: number
  min?: number
  max?: number
}>()

const emit = defineEmits<{ resize: [deltaX: number]; end: []; reset: [] }>()

let lastX = 0
let dragging = false

function cleanup(): void {
  dragging = false
  document.body.classList.remove('resizing')
}

function onDown(event: PointerEvent): void {
  dragging = true
  lastX = event.clientX
  // 捕获后后续 move/up 都派发到本元素,拖出窗口也能收到
  ;(event.currentTarget as Element | null)?.setPointerCapture(event.pointerId)
  document.body.classList.add('resizing')
  // 拖拽中窗口失焦会丢 pointerup,blur 时兜底复位,避免禁选中态卡死
  window.addEventListener('blur', cleanup, { once: true })
}

function onMove(event: PointerEvent): void {
  if (!dragging) return
  emit('resize', event.clientX - lastX)
  lastX = event.clientX
}

function onUp(event: PointerEvent): void {
  if (!dragging) return
  ;(event.currentTarget as Element | null)?.releasePointerCapture(event.pointerId)
  cleanup()
  emit('end')
}

// G4-05:键盘步进——←/→ 每 16px,Shift 加速 ×4;keyup 才 emit('end') 让父层落盘一次。
// 增量经父层 applyColumnResize 的 clamp 与会话流守卫,自然受限不会拖爆布局。
function onKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 64 : 16
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    emit('resize', -step)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    emit('resize', step)
  }
}

function onKeyup(event: KeyboardEvent): void {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') emit('end')
}
</script>

<template>
  <div
    class="resizer"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-valuenow="valueNow"
    :aria-valuemin="min"
    :aria-valuemax="max"
    title="按住拖拽调整列宽，双击恢复推荐宽度"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @keydown="onKeydown"
    @keyup="onKeyup"
    @dblclick="emit('reset')"
  />
</template>

<style scoped>
.resizer {
  /* 命中区即栏间距本身(父级 grid 已去掉 gap),中间 2px 视觉线条 */
  width: 10px;
  cursor: col-resize;
  display: flex;
  align-items: stretch;
  justify-content: center;
  border-radius: 2px;
  transition: background var(--fast);
}

.resizer::after {
  content: '';
  width: 2px;
  border-radius: 1px;
  background: var(--glass-edge);
  transition: background var(--fast);
}

.resizer:hover::after,
.resizer:active::after {
  background: var(--accent);
}

.resizer:active {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

/* G4-05:键盘聚焦描边——Tab 可聚焦后焦点态必须可见,光标保持 col-resize 语义 */
.resizer:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  cursor: col-resize;
}
</style>

<style>
/* 拖拽期全局禁选中(挂 body,非 scoped) */
body.resizing {
  cursor: col-resize;
  user-select: none;
}
</style>
