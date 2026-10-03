<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import Logo from './Logo.vue'

// 自绘标题栏:整条为系统拖拽区,双击最大化/还原交给系统处理,事件回流走 onWindowMaximized
const maximized = ref(false)
let offMaximized: (() => void) | null = null

onMounted(() => {
  offMaximized = window.api.onWindowMaximized((value) => (maximized.value = value))
})

onUnmounted(() => offMaximized?.())

const minimize = (): void => void window.api.windowMinimize()
const toggleMaximize = (): void => void window.api.windowToggleMaximize()
const close = (): void => void window.api.windowClose()
</script>

<template>
  <header class="titlebar">
    <div class="brand">
      <Logo :size="20" />
      <span class="name">AgentDrove</span>
    </div>
    <div class="controls">
      <button type="button" class="ctl" title="最小化" @click="minimize">
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
          <path d="M1.5 5.5h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
      <button type="button" class="ctl" :title="maximized ? '向下还原' : '最大化'" @click="toggleMaximize">
        <svg
          v-if="!maximized"
          width="11"
          height="11"
          viewBox="0 0 11 11"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1.5" y="1.5" width="8" height="8" rx="1.6" stroke="currentColor" stroke-width="1.2" />
        </svg>
        <svg v-else width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
          <rect x="1.5" y="3.5" width="6" height="6" rx="1.4" stroke="currentColor" stroke-width="1.2" />
          <path d="M3.6 3.3V2.6a1.1 1.1 0 0 1 1.1-1.1h3.7a1.1 1.1 0 0 1 1.1 1.1v3.7a1.1 1.1 0 0 1-1.1 1.1h-.7" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <button type="button" class="ctl close" title="关闭" @click="close">
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
          <path d="M1.8 1.8l7.4 7.4M9.2 1.8l-7.4 7.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 14px;
  -webkit-app-region: drag;
  user-select: none;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.controls {
  display: flex;
  align-items: stretch;
  height: 100%;
}

/* 靠边通栏不留缝:按钮矩形直抵窗口角,与系统窗口钮同占位 */
.ctl {
  -webkit-app-region: no-drag;
  width: 46px;
  border: 0;
  background: transparent;
  color: var(--muted);
  display: grid;
  place-items: center;
  transition: background var(--fast) var(--ease), color var(--fast) var(--ease);
}

.ctl:hover {
  background: var(--chip-bg);
  color: var(--text);
}

/* 关闭钮遵循 Windows 惯例:悬停转红,一眼可辨危险操作 */
.ctl.close:hover {
  background: #d83b34;
  color: #fff;
}
</style>
