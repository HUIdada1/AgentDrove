<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
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
  <section class="composer" @dragover.prevent @drop.prevent="onDrop">
    <textarea
      v-model="prompt"
      rows="3"
      :placeholder="batchMode ? '每行一条任务,批量入队…(Enter 提交 / Shift+Enter 换行)' : '把任务派发给客户端…(Enter 提交 / Shift+Enter 换行)'"
      @keydown="onKeydown"
    />

    <div class="toolbar">
      <select v-model="agentId" title="客户端">
        <option v-for="a in activeAgents" :key="a.id" :value="a.id">
          {{ a.label }}
        </option>
      </select>
      <select v-model="mode" title="档位">
        <option value="build">build</option>
        <option value="edit">edit</option>
        <option value="plan">plan</option>
      </select>
      <input v-model="workspace" class="ws" placeholder="工作目录(留空=默认目录)" spellcheck="false" />
      <button class="ghost" @click="pickAttachment">附件 {{ attachments.length || '' }}</button>
      <button class="ghost" :class="{ on: batchMode }" @click="batchMode = !batchMode">批量</button>
      <button class="ghost" :class="{ on: advanced }" @click="advanced = !advanced">高级</button>
      <span class="spacer" />
      <button class="primary" :disabled="submitting || !prompt.trim()" @click="submit">派发</button>
    </div>

    <div v-if="advanced" class="advanced">
      <label>
        派生工作区源目录(git → worktree / 其他 → 整拷)
        <input v-model="workspaceSource" placeholder="留空=直接使用上面的工作目录" spellcheck="false" />
      </label>
      <label>
        禁用工具(逗号分隔,工具级)
        <input v-model="denyList" placeholder="如 Bash,Write" spellcheck="false" />
      </label>
      <label>
        max-turns
        <input v-model="maxTurns" type="number" min="1" placeholder="不限" />
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
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--bg1);
}

textarea {
  width: 100%;
  background: var(--bg2);
}

.toolbar {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar select {
  padding: 4px 8px;
}

.ws {
  flex: 1;
  min-width: 120px;
  font-family: var(--mono);
  font-size: 12px;
}

.ghost.on {
  color: var(--accent);
  border-color: rgba(77, 163, 255, 0.4);
}

.advanced {
  margin-top: 8px;
  display: grid;
  grid-template-columns: 1fr 1fr 120px;
  gap: 8px;
}

.advanced label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
}

.advanced input {
  font-size: 12px;
}

.hint {
  grid-column: 1 / -1;
  color: var(--warn);
  font-size: 11px;
}

.chips {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bg3);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
}

.chip .x {
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--muted);
}

.notice {
  margin-top: 8px;
  color: var(--err);
  font-size: 12px;
}
</style>
