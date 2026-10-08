<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import GlassButton from './GlassButton.vue'

const props = withDefaults(
  defineProps<{
    /** 开关;父层用 v-if 控制挂载时恒传 true 亦可 */
    open: boolean
    title?: string
    width?: string
  }>(),
  { width: '680px' },
)

const emit = defineEmits<{ close: [] }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

// open 期间才监听 Esc;immediate 覆盖"挂载即 open"的用法,卸载/关闭时移除
watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onKeydown)
    else window.removeEventListener('keydown', onKeydown)
  },
  { immediate: true },
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="g-modal">
      <div v-if="open" class="g-modal-mask" @click.self="emit('close')">
        <div class="g-modal" :style="{ width }" role="dialog" aria-modal="true" :aria-label="title ?? '对话框'">
          <header class="g-modal-head">
            <span class="g-modal-title">{{ title }}</span>
            <GlassButton variant="ghost" size="sm" @click="emit('close')">✕</GlassButton>
          </header>
          <div class="g-modal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="g-modal-foot">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 遮罩:深色压暗 + 轻模糊,让底下的四栏 shell 退成背景;层级走 K-05 令牌(drawer 1100 < modal 1200) */
.g-modal-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(4, 10, 16, 0.44);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

/* 玻璃面板:厚度三件套——内缘上高光 + 下缘折射暗边 + 深投影 */
.g-modal {
  position: relative;
  display: flex;
  flex-direction: column;
  max-height: min(84vh, 780px);
  max-width: calc(100vw - 48px);
  background: var(--glass-sheen), var(--glass-bg-strong);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-lg);
  box-shadow:
    0 24px 64px rgba(4, 10, 16, 0.45),
    inset 0 1px 0 var(--glass-specular),
    inset 0 -1px 0 var(--glass-under);
}

/* 斜向光泽:液态玻璃的高光带(配方同 styles.css 的 .glass::after) */
.g-modal::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.07), transparent 38%);
  opacity: 0.7;
}

.g-modal-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px 10px;
}

.g-modal-title {
  font-size: 14px;
  font-weight: 600;
}

.g-modal-body {
  min-height: 0;
  padding: 2px 18px 16px;
  overflow-y: auto;
  max-height: min(70vh, 620px);
}

.g-modal-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px 14px;
  border-top: 1px solid var(--line);
}

/* 淡入 + 面板轻微上浮缩放 */
.g-modal-enter-active,
.g-modal-leave-active {
  transition: opacity var(--fast) var(--ease);
}

.g-modal-enter-active .g-modal,
.g-modal-leave-active .g-modal {
  transition: transform var(--fast) var(--ease);
}

.g-modal-enter-from,
.g-modal-leave-to {
  opacity: 0;
}

.g-modal-enter-from .g-modal,
.g-modal-leave-to .g-modal {
  transform: translateY(8px) scale(0.98);
}
</style>
