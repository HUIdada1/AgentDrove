<script setup lang="ts">
defineProps<{
  /** primary=品牌色玻璃;ghost=透明;danger=危险语义 */
  variant?: 'primary' | 'ghost' | 'danger' | 'plain'
  size?: 'sm' | 'md'
  disabled?: boolean
}>()

const emit = defineEmits<{ click: [event: MouseEvent] }>()
</script>

<template>
  <button
    type="button"
    class="g-btn"
    :class="[variant ?? 'plain', size ?? 'md']"
    :disabled="disabled"
    @click="emit('click', $event)"
  >
    <slot />
  </button>
</template>

<style scoped>
.g-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
  font-weight: 500;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1),
    background 180ms cubic-bezier(0.16, 1, 0.3, 1),
    border-color 180ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1),
    filter 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

.g-btn.md {
  padding: 5px 14px;
  font-size: 13px;
}

.g-btn.sm {
  padding: 3px 10px;
  font-size: 12px;
}

/* 亮色调 + 玻璃质感基础规范 */
.g-btn.plain {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.05) 100%);
  border: 1px solid rgba(255, 255, 255, 0.24);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.35), 0 2px 8px rgba(0, 0, 0, 0.12);
  color: var(--text);
}

.g-btn.plain:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.24) 0%, rgba(255, 255, 255, 0.1) 100%);
  border-color: rgba(255, 255, 255, 0.42);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.5), 0 4px 14px rgba(0, 0, 0, 0.18);
  transform: translateY(-1.5px);
}

.g-btn.primary {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.46) 0%, rgba(37, 99, 235, 0.32) 100%);
  border: 1px solid rgba(147, 197, 253, 0.55);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.55), 0 2px 10px rgba(37, 99, 235, 0.3);
  color: #ffffff;
}

.g-btn.primary:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.6) 0%, rgba(37, 99, 235, 0.42) 100%);
  border-color: rgba(191, 219, 254, 0.75);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.7), 0 5px 18px rgba(37, 99, 235, 0.42);
  transform: translateY(-1.5px);
}

.g-btn.ghost {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.03) 100%);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.25), 0 1px 4px rgba(0, 0, 0, 0.08);
  color: var(--text);
}

.g-btn.ghost:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.2) 0%, rgba(255, 255, 255, 0.08) 100%);
  border-color: rgba(255, 255, 255, 0.35);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.45), 0 3px 12px rgba(0, 0, 0, 0.14);
  transform: translateY(-1.5px);
}

.g-btn.danger {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.32) 0%, rgba(220, 38, 38, 0.2) 100%);
  border: 1px solid rgba(252, 165, 165, 0.48);
  box-shadow: inset 0 1px 0.5px rgba(255, 255, 255, 0.4), 0 2px 10px rgba(239, 68, 68, 0.25);
  color: #ff7878;
}

.g-btn.danger:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.45) 0%, rgba(220, 38, 38, 0.3) 100%);
  border-color: rgba(254, 202, 202, 0.7);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.6), 0 4px 16px rgba(239, 68, 68, 0.38);
  transform: translateY(-1.5px);
  color: #ffffff;
}

/* 点击反馈(触感微弹) */
.g-btn:active:not(:disabled) {
  transform: translateY(0.5px) scale(0.98);
  filter: brightness(0.95);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25);
}

.g-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none !important;
  box-shadow: none !important;
}
</style>
