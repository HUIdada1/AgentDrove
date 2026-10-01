<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    multiline?: boolean
    rows?: number
    mono?: boolean
    disabled?: boolean
  }>(),
  { rows: 3 },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const el = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement | HTMLTextAreaElement).value)
}

function focus(): void {
  el.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <textarea
    v-if="props.multiline"
    ref="el"
    class="g-field"
    :class="{ mono: props.mono }"
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :rows="props.rows"
    :disabled="props.disabled"
    @input="onInput"
  />
  <input
    v-else
    ref="el"
    class="g-field"
    :class="{ mono: props.mono }"
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    spellcheck="false"
    @input="onInput"
  />
</template>

<style scoped>
/* 液态玻璃输入面:下凹感(内侧上暗下亮反转) */
.g-field {
  width: 100%;
  background: var(--field-bg);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 6px 11px;
  color: var(--text);
  transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.12), inset 0 -1px 0 var(--glass-specular);
}

.g-field::placeholder {
  color: var(--faint);
}

.g-field:hover {
  border-color: var(--line-strong);
}

.g-field:focus {
  border-color: var(--accent-line);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.12), 0 0 0 3px var(--accent-dim);
}

.g-field.mono {
  font-family: var(--mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

textarea.g-field {
  resize: none;
}
</style>
