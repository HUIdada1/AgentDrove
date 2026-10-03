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
  transition: transform var(--fast) var(--ease), background var(--fast) var(--ease),
    border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
}

.g-btn.md {
  padding: 5px 14px;
}

.g-btn.sm {
  padding: 2px 10px;
  font-size: 12px;
}

/* 玻璃实体:内侧上高光制造厚度 */
.g-btn.plain,
.g-btn.primary {
  background: var(--glass-bg-strong);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-edge);
  box-shadow: inset 0 1px 0 var(--glass-specular), 0 2px 8px rgba(4, 10, 16, 0.18);
}

.g-btn.primary {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

.g-btn.ghost {
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
}

.g-btn.ghost:hover {
  color: var(--text);
  background: var(--glass-bg);
  border-color: var(--glass-edge);
}

.g-btn.danger {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--err) 40%, transparent);
  color: var(--err);
}

.g-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.g-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.98);
}

.g-btn:disabled {
  opacity: 0.42;
  cursor: default;
}
</style>
