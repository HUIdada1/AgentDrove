<script setup lang="ts">
import type { ReasoningEffort } from '@agent-drove/shared'
import { EFFORT_HINT_TEXT, REASONING_EFFORT_OPTIONS } from '../labels'

const props = defineProps<{
  modelValue: ReasoningEffort | ''
  supported: boolean
  /** 哨兵项('')的场景化文案:发布框「跟随客户端」/ 续聊「跟随父任务（当前X档）」 */
  sentinelLabel?: string
  /** 哨兵项的场景化说明;缺省用 labels.EFFORT_HINT_TEXT[''] */
  sentinelHint?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: ReasoningEffort | ''): void
}>()

/** 选项与说明单一来源 labels.ts(R06/S-01):六档含极简,禁止本地再维护一份 */
const options = REASONING_EFFORT_OPTIONS

/** 哨兵项文案:场景化覆盖,缺省回落 labels 的「跟随」 */
function labelOf(value: ReasoningEffort | ''): string {
  if (value === '') return props.sentinelLabel || options.find((o) => o.value === '')?.label || '跟随'
  return options.find((o) => o.value === value)?.label ?? value
}

/** 悬停说明:哨兵用场景化 hint(缺省 EFFORT_HINT_TEXT['']),其余档位取 labels 常量 */
function hintOf(value: ReasoningEffort | ''): string {
  if (value === '') return props.sentinelHint || EFFORT_HINT_TEXT['']
  return EFFORT_HINT_TEXT[value]
}

function select(val: ReasoningEffort | ''): void {
  emit('update:modelValue', val)
}
</script>

<template>
  <!-- 当不支持时完全隐藏，绝不留 disabled 破损占位框 -->
  <div
    v-if="supported"
    class="reasoning-picker glass"
    :title="hintOf(modelValue)"
  >
    <span class="picker-ico" aria-hidden="true">🧠</span>
    <div class="pills-track">
      <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        class="pill-btn"
        :class="{ active: modelValue === opt.value }"
        :title="hintOf(opt.value)"
        @click="select(opt.value)"
      >
        {{ labelOf(opt.value) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.reasoning-picker {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 6px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--surface-dim);
  box-sizing: border-box;
}

.picker-ico {
  font-size: 11px;
  color: var(--accent-strong);
}

.pills-track {
  display: flex;
  align-items: center;
  gap: 2px;
}

.pill-btn {
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: all 140ms var(--ease);
  line-height: 20px;
  white-space: nowrap;
}

.pill-btn:hover {
  color: var(--text);
  background: var(--surface);
}

.pill-btn.active {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}
</style>
