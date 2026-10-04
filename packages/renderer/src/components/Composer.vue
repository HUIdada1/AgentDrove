<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import SkillSelector from './SkillSelector.vue'
import SlashCommandPopup, { type SlashCommand } from './SlashCommandPopup.vue'
import { CLIENT_FOLLOW_MODEL, MODE_OPTIONS } from '../labels'
import { skillsToDenyList, type SubmitTaskDto } from '@agent-drove/shared'

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
const promptBox = ref<{ focus: () => void } | null>(null)

const activeAgents = computed(() => store.agents.value.filter((a) => a.enabled && a.capabilities.headless))
const selectedAgent = computed(() => store.agents.value.find((a) => a.id === agentId.value))
const selectedProject = computed(() => store.selectedProject.value)
const modelId = ref('')

// modelSwitch=none 的客户端(如 zcode)没有可选模型,只展示哨兵项且锁定
const modelLocked = computed(() => selectedAgent.value?.capabilities.modelSwitch === 'none')

const modelOptions = computed(() => {
  const agent = selectedAgent.value
  if (!agent) return []
  if (modelLocked.value) return [{ value: CLIENT_FOLLOW_MODEL, label: '跟随客户端' }]
  // 套餐声明覆盖范围时取交集,避免发出会被 registry.resolveModel 拒绝的模型
  const covered = agent.plan.modelIds
  const list = covered.length > 0 ? agent.models.filter((m) => covered.includes(m.id)) : agent.models
  return list.map((m) => ({ value: m.id, label: m.label }))
})

// 仅在客户端支持切模型且已选中时随 DTO 透传;其余情况省略字段
const resolvedModelId = computed(() =>
  selectedAgent.value && !modelLocked.value && modelId.value ? modelId.value : undefined,
)

// 切客户端或模型列表异步到达时回填模型:优先档案默认模型,其次首个可选模型,避免空白
function syncPreferredModel() {
  const options = modelOptions.value
  if (options.length === 0) return
  if (!modelId.value || !options.some((o) => o.value === modelId.value)) {
    const preferred = selectedAgent.value?.defaultModel
    modelId.value =
      preferred && options.some((o) => o.value === preferred) ? preferred : (options[0]?.value ?? '')
  }
}

watch(agentId, () => {
  const options = modelOptions.value
  const preferred = selectedAgent.value?.defaultModel
  modelId.value =
    preferred && options.some((o) => o.value === preferred) ? preferred : (options[0]?.value ?? '')
})

watch(modelOptions, () => {
  syncPreferredModel()
})

// 默认档位来自设置(settings 异步到达后生效);yolo 不在发布框可选档位内,回落到 build
watch(
  () => store.settings.value?.task.defaultMode,
  (configured) => {
    if (configured === 'build' || configured === 'edit' || configured === 'plan') mode.value = configured
  },
  { immediate: true },
)

// 侧栏选中工作区 → 发布框目录跟随(显式改写仍可临时覆盖,项目归属不变);
// 只跟 path 而不是项目对象:项目列表刷新会换对象引用,按对象监听会误清用户手填的临时目录
watch(
  () => selectedProject.value?.path ?? '',
  (path) => {
    workspace.value = path
  },
)

onMounted(() => {
  window.addEventListener('focus-composer', focusPrompt)
})

// agents 异步到达后回填默认选中,否则下拉框显示为空
watch(
  activeAgents,
  (list) => {
    if (!agentId.value && list.length > 0) agentId.value = list[0]!.id
  },
  { immediate: true },
)

onBeforeUnmount(() => window.removeEventListener('focus-composer', focusPrompt))

function focusPrompt(): void {
  promptBox.value?.focus()
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

/** 附件只引用原路径;重复路径跳过,避免同一文件多次入队 */
function addFiles(files: FileList | null): void {
  for (const file of files ?? []) {
    let path: string
    try {
      path = window.api.filePath(file)
    } catch {
      notice.value = `无法解析附件路径:${file.name}`
      continue
    }
    if (attachments.value.some((a) => a.path === path)) continue
    attachments.value.push({ path, kind: IMAGE_EXT.test(file.name) ? 'image' : 'file' })
  }
}

function pickAttachment(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.onchange = () => addFiles(input.files)
  input.click()
}

function onDrop(event: DragEvent): void {
  addFiles(event.dataTransfer?.files ?? null)
}

/** 附件路径去重后唯一,可作稳定 key;移除按路径而非数组下标 */
function removeAttachment(path: string): void {
  attachments.value = attachments.value.filter((a) => a.path !== path)
}

async function pickWorkspace(): Promise<void> {
  try {
    const dir = await window.api.pickDirectory()
    if (dir) workspace.value = dir
  } catch (error) {
    notice.value = `选择目录失败:${error instanceof Error ? error.message : String(error)}`
  }
}

const showSlashPopup = ref(false)
const slashQuery = ref('')
const slashPopupRef = ref<{ onKeydown: (e: KeyboardEvent) => boolean } | null>(null)

function handlePromptChange(val: string): void {
  prompt.value = val
  if (val.startsWith('/')) {
    slashQuery.value = val
    showSlashPopup.value = true
  } else {
    showSlashPopup.value = false
  }
}

function applySlashCommand(cmd: SlashCommand): void {
  prompt.value = cmd.template
  if (cmd.recommendedMode) {
    mode.value = cmd.recommendedMode
  }
  showSlashPopup.value = false
}

/** 高级选项转 toolPolicy:结合当前开启的技能计算 denyList */
function resolveToolPolicy(): SubmitTaskDto['toolPolicy'] {
  const deniedFromSkills = skillsToDenyList(store.activeSkills.value)
  const deniedFromInput = denyList.value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const denied = [...new Set([...deniedFromSkills, ...deniedFromInput])]
  const turns = Number(maxTurns.value)
  const cap = maxTurns.value && Number.isFinite(turns) && turns > 0 ? turns : null
  if (denied.length === 0 && cap === null) return undefined
  return { denyList: denied, maxTurns: cap }
}

async function submit(): Promise<void> {
  const text = prompt.value.trim()
  // Enter 与发送按钮可能几乎同时触发:这里兜住重复提交,避免同一批任务入队两次
  if (!text || !agentId.value || submitting.value) return
  submitting.value = true
  notice.value = ''
  try {
    const lines = batchMode.value ? text.split('\n').map((l) => l.trim()).filter(Boolean) : [text]
    const projectId = store.selectedProjectId.value ?? undefined
    const toolPolicy = resolveToolPolicy()
    const dtos: SubmitTaskDto[] = lines.map((line) => ({
      agentId: agentId.value,
      prompt: line,
      cwd: workspace.value || undefined,
      projectId,
      ...(resolvedModelId.value ? { modelId: resolvedModelId.value } : {}),
      mode: mode.value,
      skills: store.activeSkills.value,
      // 必须拷成纯对象数组:attachments.value 是响应式代理(Proxy),直接过 IPC
      // 结构化克隆必抛 "An object could not be cloned"(与设置页保存同源问题)
      attachments:
        attachments.value.length > 0
          ? attachments.value.map((a) => ({ ...a }))
          : undefined,
      ...(toolPolicy ? { toolPolicy } : {}),
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
  } catch (error) {
    // 批量入队可能部分成功,失败后仍要刷新列表,避免界面漏掉已入队的任务
    notice.value = error instanceof Error ? error.message : String(error)
  } finally {
    submitting.value = false
    await store.refreshTasks()
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (showSlashPopup.value && slashPopupRef.value?.onKeydown(event)) {
    return
  }
  // 中文输入法组词态的 Enter(isComposing/229)是选词确认,不是提交意图
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
}
</script>

<template>
  <section class="composer glass" @dragover.prevent @drop.prevent="onDrop">
    <!-- 技能快速选择栏 -->
    <div class="composer-skills">
      <SkillSelector compact />
    </div>

    <div class="input-pos">
      <SlashCommandPopup
        v-if="showSlashPopup"
        ref="slashPopupRef"
        :query="slashQuery"
        @select="applySlashCommand"
        @close="showSlashPopup = false"
      />

      <GlassInput
        ref="promptBox"
        :model-value="prompt"
        multiline
        :rows="3"
        send-label="派发"
        :send-disabled="submitting || !prompt.trim()"
        :placeholder="batchMode ? '每行一条任务,批量入队…(Enter 提交 / Shift+Enter 换行)' : '下达 Agent 任务,键入 / 呼出快捷技能…(Enter 提交 / Shift+Enter 换行)'"
        @update:model-value="handlePromptChange"
        @keydown="onKeydown"
        @send="submit"
      />
    </div>

    <div class="toolbar">
      <GlassSelect
        v-model="agentId"
        class="who"
        title="客户端"
        :options="activeAgents.map((a) => ({ value: a.id, label: a.label }))"
      />
      <GlassSelect
        v-model="modelId"
        class="model"
        title="模型"
        :options="modelOptions"
        :disabled="modelLocked"
      />
      <GlassSelect
        v-model="mode"
        title="档位"
        :options="MODE_OPTIONS"
      />
      <GlassButton variant="ghost" size="sm" @click="pickAttachment">
        附件{{ attachments.length ? ` ${attachments.length}` : '' }}
      </GlassButton>
      <GlassButton variant="ghost" size="sm" :class="{ on: batchMode }" @click="batchMode = !batchMode">
        批量
      </GlassButton>
      <GlassButton variant="ghost" size="sm" :class="{ on: advanced }" @click="advanced = !advanced">
        高级
      </GlassButton>
    </div>

    <div class="ws-row">
      <GlassInput v-model="workspace" class="ws" mono :placeholder="selectedProject ? `${selectedProject.name} · 可临时改写目录` : '工作目录(留空=默认目录)'" />
      <GlassButton variant="ghost" size="sm" title="选择目录填入工作区" @click="pickWorkspace">
        选目录
      </GlassButton>
      <span
        v-if="selectedProject"
        class="ws-chip"
        :title="selectedProject.path ?? '未绑定目录,派发落默认工作区'"
      >
        ⌂ {{ selectedProject.name }}
        <button class="x" title="取消选中工作区" @click="store.selectedProjectId.value = null">×</button>
      </span>
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
      <span v-for="a in attachments" :key="a.path" class="chip">
        {{ a.kind === 'image' ? '🖼' : '📄' }} {{ a.path.split(/[\\/]/).pop() }}
        <button class="x" @click="removeAttachment(a.path)">×</button>
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

.model {
  max-width: 160px;
}

/* 工作区行:目录输入占主导 */
.ws-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ws {
  flex: 1;
  min-width: 100px;
}

.ws-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  max-width: 140px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
  color: var(--accent-strong);
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  padding: 3px 8px;
}

.ws-chip .x {
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--muted);
  cursor: pointer;
}

/* 批量/高级开关的激活态:GlassButton ghost 默认 muted,这里给品牌色 */
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

.composer-skills {
  margin-bottom: 6px;
}

.input-pos {
  position: relative;
}
</style>
