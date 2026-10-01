<script setup lang="ts">
// 两档同色系:输入流用深一档、执行节点用主色,层级即"任务流汇入执行核心"的语义;
// mono 时全部交给 currentColor,由外层文字色决定显隐,避免图标色与玻璃面板底色打架。
withDefaults(defineProps<{ size?: number; mono?: boolean }>(), {
  size: 22,
  mono: false,
})

const FLOW = '#2e6ea8' // 深一档:待汇聚的任务流
const NODE = '#4d9ede' // 主色:执行节点与输出
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <!-- 输入流先画,末端收进节点环内,衔接处由主色盖上,不出接缝 -->
    <g
      :stroke="mono ? 'currentColor' : FLOW"
      stroke-width="5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M9 13 H22 L34.1 25.1" />
      <path d="M9 32 H31" />
      <path d="M9 51 H22 L34.1 38.9" />
    </g>
    <g :stroke="mono ? 'currentColor' : NODE" stroke-width="5" stroke-linecap="round">
      <circle cx="41" cy="32" r="10" />
      <path d="M52 32 H57" />
    </g>
    <circle cx="41" cy="32" r="3.2" :fill="mono ? 'currentColor' : NODE" />
  </svg>
</template>
