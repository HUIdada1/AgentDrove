<script setup lang="ts">
defineProps<{ modelValue: boolean; label?: string; hint?: string }>()
const emit = defineEmits<{ change: [value: boolean] }>()
</script>

<template>
  <button
    class="g-toggle-row"
    type="button"
    role="switch"
    :aria-checked="modelValue"
    @click="emit('change', !modelValue)"
  >
    <span class="text">
      <span class="label">{{ label }}</span>
      <span v-if="hint" class="hint">{{ hint }}</span>
    </span>
    <span class="g-toggle" :class="{ on: modelValue }">
      <span class="thumb" />
    </span>
  </button>
</template>

<style scoped>
.g-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 4px 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}

.text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.label {
  color: var(--text);
}

.hint {
  font-size: 11px;
  color: var(--muted);
}

/* 液态玻璃开关:胶囊轨道 + 带高光的玻璃珠 */
.g-toggle {
  flex: none;
  width: 38px;
  height: 21px;
  border-radius: 999px;
  background: var(--field-bg);
  border: 1px solid var(--line);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.2);
  position: relative;
  transition: background var(--fast) var(--ease), border-color var(--fast) var(--ease);
}

.g-toggle .thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-edge);
  box-shadow: inset 0 1px 0 var(--glass-specular), 0 1px 3px rgba(4, 10, 16, 0.4);
  transition: transform var(--fast) var(--ease), background var(--fast) var(--ease);
}

.g-toggle.on {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}

.g-toggle.on .thumb {
  transform: translateX(17px);
  background: var(--accent);
  border-color: transparent;
}
</style>
