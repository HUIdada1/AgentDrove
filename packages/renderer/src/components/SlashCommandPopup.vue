<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

export interface SlashCommand {
  cmd: string
  label: string
  desc: string
  icon: string
  template: string
  recommendedMode?: 'build' | 'edit' | 'plan'
}

const COMMANDS: SlashCommand[] = [
  {
    cmd: '/fix',
    label: '修复缺陷',
    desc: '诊断异常报错，定位原因并生成热修复补丁',
    icon: '',
    template: '请帮我诊断并修复以下代码中的错误或报错信息：\n',
    recommendedMode: 'edit',
  },
  {
    cmd: '/test',
    label: '编写测试',
    desc: '为指定模块编写单元测试与覆盖边界情况',
    icon: '',
    template: '请为以下核心业务逻辑编写完备的自动化测试用例，覆盖正常与异常边界：\n',
    recommendedMode: 'build',
  },
  {
    cmd: '/refactor',
    label: '重构优化',
    desc: '遵循 KISS 原则优化代码结构与可维护性',
    icon: '',
    template: '请重构以下模块的代码，精简冗余状态，消除过度工程化：\n',
    recommendedMode: 'edit',
  },
  {
    cmd: '/explain',
    label: '代码解释',
    desc: '深度解析代码执行逻辑、数据流转与关键架构',
    icon: '',
    template: '请详细解释以下模块的架构设计与核心执行链路：\n',
    recommendedMode: 'plan',
  },
  {
    cmd: '/review',
    label: '代码审查',
    desc: '检查潜在竞态死锁、资源泄漏与性能隐患',
    icon: '',
    template: '请对以下代码进行全量代码审查，指出潜在风险与改进建议：\n',
    recommendedMode: 'plan',
  },
  {
    cmd: '/plan',
    label: '方案规划',
    desc: '按照“构思方案 → 分解为具体任务”输出实现步骤',
    icon: '',
    template: '请为以下需求设计落地实施方案，并分解为具体的任务清单：\n',
    recommendedMode: 'plan',
  },
]

const props = defineProps<{
  query: string
}>()

const emit = defineEmits<{
  (e: 'select', cmd: SlashCommand): void
  (e: 'close'): void
}>()

const selectedIndex = ref(0)

const filtered = computed(() => {
  const q = props.query.toLowerCase().replace(/^\//, '')
  if (!q) return COMMANDS
  return COMMANDS.filter(
    (c) =>
      c.cmd.toLowerCase().includes(q) ||
      c.label.toLowerCase().includes(q) ||
      c.desc.toLowerCase().includes(q),
  )
})

function onKeydown(event: KeyboardEvent): boolean {
  if (filtered.value.length === 0) return false
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    selectedIndex.value = (selectedIndex.value + 1) % filtered.value.length
    return true
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    selectedIndex.value =
      (selectedIndex.value - 1 + filtered.value.length) % filtered.value.length
    return true
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    const item = filtered.value[selectedIndex.value]
    if (item) emit('select', item)
    return true
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return true
  }
  return false
}

defineExpose({ onKeydown })
</script>

<template>
  <div v-if="filtered.length > 0" class="slash-popup glass">
    <div class="header">
      <span class="icon">/</span>
      <span class="title">快捷指令 (Enter 或点击选择)</span>
    </div>
    <div class="list">
      <div
        v-for="(item, idx) in filtered"
        :key="item.cmd"
        class="cmd-item"
        :class="{ active: idx === selectedIndex }"
        @click="emit('select', item)"
        @mouseenter="selectedIndex = idx"
      >
        <span class="cmd-tag num">{{ item.cmd }}</span>
        <span class="cmd-name">{{ item.label }}</span>
        <span class="cmd-desc">{{ item.desc }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.slash-popup {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  width: 100%;
  max-width: 480px;
  background: var(--glass-bg-strong);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-md);
  box-shadow: var(--glass-shadow);
  z-index: 100;
  overflow: hidden;
  backdrop-filter: var(--glass-blur);
}

.header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--field-bg);
  border-bottom: 1px solid var(--line);
  font-size: 11px;
  color: var(--faint);
}

.list {
  max-height: 220px;
  overflow-y: auto;
  padding: 4px;
}

.cmd-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--fast) var(--ease);
}

.cmd-item:hover,
.cmd-item.active {
  background: var(--accent-dim);
}

.cmd-icon {
  font-size: 13px;
  flex: none;
}

.cmd-tag {
  color: var(--accent-strong);
  font-weight: 600;
  font-size: 12px;
  font-family: var(--mono);
}

.cmd-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  flex: none;
}

.cmd-desc {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
</style>
