<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    value: number
    max: number
    /** 覆盖填充配色(默认翡翠绿渐变) */
    color?: string
    /** 是否展示百分比文字 */
    showPercent?: boolean
    /** 是否展示转圈动画 */
    showSpinner?: boolean
    /** 是否展示不确定态扫描流动动画 */
    isBusy?: boolean
    /** 尺寸规格 */
    size?: 'sm' | 'md' | 'lg'
    /** 自定义状态提示文本 */
    statusText?: string
  }>(),
  {
    max: 100,
    showPercent: false,
    showSpinner: false,
    isBusy: false,
    size: 'md',
    statusText: '',
  },
)

// max 保护除零; value 可能为负或超限, 夹到 0~100
const percent = computed(() => {
  if (props.max <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((props.value / props.max) * 100)))
})
</script>

<template>
  <div class="g-meter-container" :class="[`size-${size}`, { busy: isBusy }]">
    <div v-if="showPercent || showSpinner || statusText" class="g-meter-header">
      <span v-if="showSpinner" class="g-spinner" aria-hidden="true" />
      <span v-if="statusText" class="g-status-text">{{ statusText }}</span>
      <span class="spacer" />
      <span v-if="showPercent" class="g-percent-text num">{{ percent }}%</span>
    </div>

    <div
      class="g-meter"
      role="progressbar"
      aria-valuemin="0"
      :aria-valuenow="value"
      :aria-valuemax="max"
      :class="{ 'is-busy': isBusy }"
    >
      <span
        class="fill"
        :style="{
          width: isBusy ? undefined : `${percent}%`,
          ...(color ? { background: color } : {}),
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.g-meter-container {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.g-meter-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
}

.spacer {
  flex: 1;
}

.g-percent-text {
  font-weight: 600;
  color: var(--accent-strong);
  font-family: var(--mono);
}

.g-status-text {
  color: var(--text);
}

/* 经典转圈指示器 (参考 AgentHub mpd-spin) */
.g-spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 2px solid var(--accent-line);
  border-top-color: var(--accent-strong);
  animation: gSpin 0.85s linear infinite;
}

@keyframes gSpin {
  to {
    transform: rotate(360deg);
  }
}

/* 玻璃底槽: 饱满高度与圆润胶囊形态 */
.g-meter {
  position: relative;
  width: 100%;
  border-radius: 999px;
  background: var(--field-bg);
  border: 1px solid var(--line);
  overflow: hidden;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.22);
}

.size-sm .g-meter {
  height: 6px;
}

.size-md .g-meter {
  height: 8px;
}

.size-lg .g-meter {
  height: 12px;
}

/* 填充条: 翡翠绿渐变光效 */
.fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent-strong), var(--accent));
  box-shadow: 0 0 8px var(--accent-dim);
  transition: width var(--fast) var(--ease);
}

/* 不确定扫描动画 (参考 AgentHub mpdScan) */
.g-meter.is-busy > .fill {
  width: 40% !important;
  transition: none;
  animation: gScan 1.4s var(--ease) infinite;
}

@keyframes gScan {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(280%);
  }
}
</style>
