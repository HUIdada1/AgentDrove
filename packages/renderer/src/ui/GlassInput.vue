<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
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
    /** 多行时随内容自动增高(P0-9/F3);未传 maxGrowHeight 时上限走 CSS min(40vh, 280px) */
    autoGrow?: boolean
    /** 自动增高的像素上限:固定小窗(如迷你条 150px)40vh 无意义,传固定值 */
    maxGrowHeight?: number
  }>(),
  { rows: 3 },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: []
  /** 剪贴板携带文件时转发(调用方入附件),文本粘贴不受影响 */
  paste: [files: FileList]
}>()

const el = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement | HTMLTextAreaElement).value)
  // 输入路径同步增高,避免经 watch 的一帧迟滞
  syncGrow()
}

/**
 * S-06:粘贴文件(截图/复制的文件)入附件——clipboardData.files 非空时阻止默认粘贴,
 * 由调用方按自身附件规则收纳;纯文本粘贴(无 files)不拦截,原样落输入框。
 */
function onPaste(event: ClipboardEvent): void {
  const files = event.clipboardData?.files
  if (!files || files.length === 0) return
  event.preventDefault()
  emit('paste', files)
}

/** 自动增高:先置 auto 取内容实际高度,再夹到显式上限(若有);CSS max-height 始终兜底 */
function syncGrow(): void {
  const node = el.value
  if (!props.autoGrow || !props.multiline || !(node instanceof HTMLTextAreaElement)) return
  node.style.height = 'auto'
  node.style.height = `${Math.min(node.scrollHeight, props.maxGrowHeight ?? node.scrollHeight)}px`
}

// 外部赋值(清空/回填)路径经 watch 同步复位高度
watch(
  () => props.modelValue,
  () => {
    void nextTick(syncGrow)
  },
)
onMounted(syncGrow)

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
      :class="{ mono: props.mono, 'with-send': !!props.sendLabel, grow: props.autoGrow }"
      :style="props.maxGrowHeight != null ? { maxHeight: `${props.maxGrowHeight}px` } : undefined"
      :value="props.modelValue"
      :placeholder="props.placeholder"
      :rows="props.rows"
      :disabled="props.disabled"
      spellcheck="false"
      @input="onInput"
      @paste="onPaste"
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
      @paste="onPaste"
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
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

/* 液态玻璃输入面:下凹感(内侧上暗下亮反转) */
.g-field {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  display: block;
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

/* 自动增高模式:超限后内部滚动;未传 maxGrowHeight 时上限为视口 40%(至少 280px) */
textarea.g-field.grow {
  max-height: min(40vh, 280px);
  overflow-y: auto;
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
