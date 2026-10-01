<script setup lang="ts">
withDefaults(defineProps<{
  title?: string
  /** strong=更实的玻璃面,用于一级面板 */
  strong?: boolean
  pad?: boolean
}>(), { pad: true })
</script>

<template>
  <section class="glass glass-panel" :class="{ strong, pad }">
    <header v-if="title" class="head">
      <h3>{{ title }}</h3>
      <slot name="extra" />
    </header>
    <slot />
  </section>
</template>

<style scoped>
.glass-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.glass-panel.pad {
  padding: 12px 14px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.head h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--muted);
}
</style>
