<script setup lang="ts">
import { ref } from 'vue'
import GlassButton from './GlassButton.vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    multiline?: boolean
    rows?: number
    mono?: boolean
    disabled?: boolean
    /** 传入时在输入面右下角内嵌发送按钮,触发 send 事件 */
    sendLabel?: string
    /** true 时发送按钮置灰且不触发 send */
    sendDisabled?: boolean
  }>(),
  { rows: 3 },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
}>()

const el = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement | HTMLTextAreaElement).value)
}

function onSend(): void {
  if (props.disabled || props.sendDisabled) return
  emit('send')
}

function focus(): void {
  el.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div class="wrap">
    <textarea
      v-if="props.multiline"
      ref="el"
      class="g-field"
      :class="{ mono: props.mono, 'with-send': !!props.sendLabel }"
      :value="props.modelValue"
      :placeholder="props.placeholder"
      :rows="props.rows"
      :disabled="props.disabled"
      spellcheck="false"
      @input="onInput"
    />
    <input
      v-else
      ref="el"
      class="g-field"
      :class="{ mono: props.mono, 'with-send': !!props.sendLabel }"
      :value="props.modelValue"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      spellcheck="false"
      @input="onInput"
    />
    <GlassButton
      v-if="props.sendLabel"
      variant="primary"
      size="sm"
      class="g-send"
      :disabled="props.disabled || props.sendDisabled"
      @click="onSend"
    >
      {{ props.sendLabel }}
    </GlassButton>
  </div>
</template>

<style scoped>
/* 定位上下文:内嵌发送按钮以此为锚 */
.wrap {
  position: relative;
}

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

/* 内嵌按钮的避让空间:多行留底部,单行留右侧 */
textarea.g-field.with-send {
  padding-bottom: 34px;
}

input.g-field.with-send {
  padding-right: 64px;
}

/* 内嵌发送按钮:只需定位,玻璃质感完全复用 GlassButton primary。
   选择器带 .wrap 以压过 GlassButton 自身的 position:relative */
.wrap .g-send {
  position: absolute;
  right: 6px;
  bottom: 6px;
}
</style>
