<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import Logo from './Logo.vue'
import type { AgentView } from '@agent-drove/shared'

// 迷你条是独立窗口生命周期,刻意不依赖面板 store,直连 api 保持轻量
const agents = ref<AgentView[]>([])
const agentId = ref('')
const prompt = ref('')
const submitting = ref(false)
const area = ref<HTMLTextAreaElement | null>(null)

let offPrefill: (() => void) | null = null
let disposed = false

onMounted(async () => {
  // 先挂预填监听:不依赖 agents 拉取,也避免注册前到达的推送被丢掉
  offPrefill = window.api.onMiniPrefill((text) => {
    if (text) prompt.value = text
    area.value?.focus()
  })
  area.value?.focus()
  try {
    agents.value = await window.api.agentsList()
    if (disposed) return
    if (!agentId.value) agentId.value = agents.value.find((a) => a.enabled)?.id ?? ''
  } catch {
    // 拉取失败保留空态:窗口不关,用户可 Esc 关闭或用推送预填直接派发
  }
})

onUnmounted(() => {
  disposed = true
  offPrefill?.()
})

function close(): void {
  void window.api.hideMini()
}

async function submit(): Promise<void> {
  const text = prompt.value.trim()
  if (!text || !agentId.value || submitting.value) return
  submitting.value = true
  try {
    await window.api.tasksSubmit({ agentId: agentId.value, prompt: text, origin: 'hotkey' })
    prompt.value = ''
    void window.api.hideMini()
  } catch {
    // 失败留在输入框,窗口不关,用户可直接改后重发
  } finally {
    submitting.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    close()
    return
  }
  // 组词态 Enter 是输入法选词确认,不派发
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
}
</script>

<template>
  <div class="mini">
    <div class="panel glass">
      <Logo :size="20" class="mark" />
      <GlassSelect
        v-model="agentId"
        class="who"
        title="客户端"
        :options="agents.filter((a) => a.enabled).map((a) => ({ value: a.id, label: a.label }))"
      />
      <div class="field">
        <GlassInput
          ref="area"
          v-model="prompt"
          class="fill"
          multiline
          :rows="2"
          send-label="派发"
          :send-disabled="submitting || !prompt.trim() || !agentId"
          placeholder="把任务派发给客户端…(Enter 派发 / Esc 关闭)"
          @keydown="onKeydown"
          @send="submit"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.mini {
  height: 100vh;
  padding: 10px;
  background: var(--bg-veil), var(--bg);
}

.panel {
  height: 100%;
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 10px 12px;
}

.mark {
  align-self: center;
  flex: none;
}

.who {
  align-self: center;
  max-width: 128px;
}

.field {
  flex: 1;
  min-width: 0;
  display: flex;
}

/* GlassInput 根是定位 wrapper,行方向 flex 里需显式撑满 */
.field .fill {
  flex: 1;
  min-width: 0;
}

.field :deep(.g-field) {
  height: 100%;
  resize: none;
}
</style>
