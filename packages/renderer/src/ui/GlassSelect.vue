<script setup lang="ts">
defineProps<{
  modelValue: string
  options: Array<{ value: string; label: string }>
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

function onChange(event: Event): void {
  emit('update:modelValue', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <select class="g-select" :value="modelValue" :disabled="disabled" @change="onChange">
    <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
  </select>
</template>

<style scoped>
/* 原生 select 保可达性,玻璃化外观;箭头用主题色描边三角 */
.g-select {
  appearance: none;
  background: var(--field-bg);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 5px 28px 5px 11px;
  color: var(--text);
  cursor: pointer;
  transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 -1px 0 var(--glass-specular);
}

.g-select:hover {
  border-color: var(--line-strong);
}

.g-select:focus {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-dim);
}

.g-select option {
  background: var(--bg);
  color: var(--text);
}
</style>
