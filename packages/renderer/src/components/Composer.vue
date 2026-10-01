<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import type { SubmitTaskDto } from '@agent-drove/shared'

const store = useAppStore()
const prompt = ref('')
const mode = ref<'build' | 'edit' | 'plan'>('build')
const workspace = ref('')
const workspaceSource = ref('')
const attachments = ref<Array<{ path: string; kind: 'file' | 'image' }>>([])
const denyList = ref('')
const maxTurns = ref<string>('')
const advanced = ref(false)
const batchMode = ref(false)
const submitting = ref(false)
const notice = ref('')
const agentId = ref('')

const activeAgents = computed(() => store.agents.value.filter((a) => a.enabled && a.capabilities.headless))
const selectedAgent = computed(() => store.agents.value.find((a) => a.id === agentId.value))

onMounted(() => {
  window.addEventListener('focus-composer', focusPrompt)
})

// agents 异步到达后回填默认选中,否则下拉框显示为空
watch(activeAgents, (list) => {
  if (!agentId.value && list.length > 0) agentId.value = list[0]!.id
})

onBeforeUnmount(() => window.removeEventListener('focus-composer', focusPrompt))

function focusPrompt(): void {
  document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
}

async function pickAttachment(): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.onchange = async () => {
    for (const file of input.files ?? []) {
      attachments.value.push({
        path: await window.api.filePath(file),
        kind: /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name) ? 'image' : 'file',
      })
    }
  }
  input.click()
}

async function onDrop(event: DragEvent): Promise<void> {
  for (const file of event.dataTransfer?.files ?? []) {
    attachments.value.push({
      path: await window.api.filePath(file),
      kind: /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name) ? 'image' : 'file',
    })
  }
}

async function submit(): Promise<void> {
  const text = prompt.value.trim()
  if (!text || !agentId.value) return
  submitting.value = true
  notice.value = ''
  try {
    const lines = batchMode.value ? text.split('\n').map((l) => l.trim()).filter(Boolean) : [text]
    const dtos: SubmitTaskDto[] = lines.map((line) => ({
      agentId: agentId.value,
      prompt: line,
      cwd: workspace.value || undefined,
      mode: mode.value,
      attachments: attachments.value.length > 0 ? attachments.value : undefined,
      toolPolicy:
        denyList.value || maxTurns.value
          ? {
              denyList: denyList.value ? denyList.value.split(',').map((t) => t.trim()).filter(Boolean) : [],
              maxTurns: maxTurns.value ? Number(maxTurns.value) : null,
            }
          : undefined,
    }))
    // 派生工作区:git 源建 worktree,非 git 整拷降级(主进程完成)
    if (workspaceSource.value) {
      await window.api.tasksSubmitBatch(
        dtos.map((dto) => ({ ...dto, workspaceSource: workspaceSource.value })),
      )
    } else {
      const tasks = await window.api.tasksSubmitBatch(dtos)
      if (tasks.length > 0) store.selectedTaskId.value = tasks[0]?.id ?? null
    }
    prompt.value = ''
    attachments.value = []
    await store.refreshTasks()
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error)
  } finally {
    submitting.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
}
</script>

<template>
  <section class="composer glass" @dragover.prevent @drop.prevent="onDrop">
    <GlassInput
      v-model="prompt"
      multiline
      :rows="3"
      :placeholder="batchMode ? '每行一条任务,批量入队…(Enter 提交 / Shift+Enter 换行)' : '把任务派发给客户端…(Enter 提交 / Shift+Enter 换行)'"
      @keydown="onKeydown"
    />

    <div class="toolbar">
      <GlassSelect
        v-model="agentId"
        class="who"
        title="客户端"
        :options="activeAgents.map((a) => ({ value: a.id, label: a.label }))"
      />
      <GlassSelect
        v-model="mode"
        title="档位"
        :options="[
          { value: 'build', label: 'build' },
          { value: 'edit', label: 'edit' },
          { value: 'plan', label: 'plan' },
        ]"
      />
      <GlassInput v-model="workspace" class="ws" mono placeholder="工作目录(留空=默认目录)" />
      <GlassButton variant="ghost" size="sm" @click="pickAttachment">
        附件{{ attachments.length ? ` ${attachments.length}` : '' }}
      </GlassButton>
      <GlassButton variant="ghost" size="sm" :class="{ on: batchMode }" @click="batchMode = !batchMode">
        批量
      </GlassButton>
      <GlassButton variant="ghost" size="sm" :class="{ on: advanced }" @click="advanced = !advanced">
        高级
      </GlassButton>
      <span class="spacer" />
      <GlassButton variant="primary" :disabled="submitting || !prompt.trim()" @click="submit">
        派发
      </GlassButton>
    </div>

    <div v-if="advanced" class="advanced">
      <label>
        派生工作区源目录(git → worktree / 其他 → 整拷)
        <GlassInput v-model="workspaceSource" mono placeholder="留空=直接使用上面的工作目录" />
      </label>
      <label>
        禁用工具(逗号分隔,工具级)
        <GlassInput v-model="denyList" placeholder="如 Bash,Write" />
      </label>
      <label>
        max-turns
        <GlassInput v-model="maxTurns" placeholder="不限" />
      </label>
      <div v-if="selectedAgent && !selectedAgent.capabilities.attachments" class="hint">
        {{ selectedAgent.label }} 附件能力待核实,附件不会透传。
      </div>
    </div>

    <div v-if="attachments.length" class="chips">
      <span v-for="(a, i) in attachments" :key="a.path + i" class="chip">
        {{ a.kind === 'image' ? '🖼' : '📄' }} {{ a.path.split(/[\\/]/).pop() }}
        <button class="x" @click="attachments.splice(i, 1)">×</button>
      </span>
    </div>

    <div v-if="notice" class="notice">{{ notice }}</div>
  </section>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 10px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.who {
  max-width: 130px;
}

.ws {
  flex: 1;
  min-width: 100px;
}

.toolbar :deep(.on),
:deep(.on) {
  color: var(--accent-strong);
  border-color: var(--accent-line);
}

.advanced {
  display: grid;
  grid-template-columns: 1fr 1fr 110px;
  gap: 8px;
}

.advanced label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
}

.hint {
  grid-column: 1 / -1;
  color: var(--warn);
  font-size: 11px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--glass-bg-strong);
  border: 1px solid var(--glass-edge);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
}

.chip .x {
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--muted);
  cursor: pointer;
}

.notice {
  color: var(--err);
  font-size: 12px;
}
</style>
