<script setup lang="ts">
import type { ReasoningEffort } from '@agent-drove/shared'
import { EFFORT_HINT_TEXT } from '../labels'

defineProps<{
  modelValue: ReasoningEffort | ''
  supported: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: ReasoningEffort | ''): void
}>()

const options: Array<{ value: ReasoningEffort | ''; label: string; icon?: string }> = [
  { value: '', label: '自动' },
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

function select(val: ReasoningEffort | ''): void {
  emit('update:modelValue', val)
}
</script>

<template>
  <!-- 当不支持时完全隐藏，绝不留 disabled 破损占位框 -->
  <div v-if="supported" class="reasoning-picker glass" title="思考推理深度控制">
    <span class="picker-ico" aria-hidden="true">🧠</span>
    <div class="pills-track">
      <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        class="pill-btn"
        :class="{ active: modelValue === opt.value }"
        :title="EFFORT_HINT_TEXT[opt.value]"
        @click="select(opt.value)"
      >
        {{ opt.label }}
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
  color: #c084fc;
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
