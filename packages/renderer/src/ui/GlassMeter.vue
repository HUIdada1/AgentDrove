<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  value: number
  max: number
  color?: string
}>(), {})

const percent = computed(() => Math.min(100, (props.value / Math.max(1, props.max)) * 100))
</script>

<template>
  <div class="g-meter" role="progressbar" :aria-valuenow="value" :aria-valuemax="max">
    <span class="fill" :style="{ width: `${percent}%` }" />
  </div>
</template>

<style scoped>
/* 玻璃槽内的液面:高光在上缘,填充色可被调用方覆盖 */
.g-meter {
  height: 5px;
  border-radius: 999px;
  background: var(--field-bg);
  border: 1px solid var(--line);
  overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
}

.fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(180deg, var(--accent-strong), var(--accent));
  box-shadow: 0 0 6px var(--accent-dim);
  transition: width var(--fast) var(--ease);
}
</style>
