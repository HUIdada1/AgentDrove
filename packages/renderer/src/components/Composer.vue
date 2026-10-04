<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import SkillSelector from './SkillSelector.vue'
import SlashCommandPopup, { type SlashCommand } from './SlashCommandPopup.vue'
import { CLIENT_FOLLOW_MODEL, MODE_OPTIONS, parseChannelsAndModels, type ChannelGroup } from '../labels'
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
const selectedChannelId = ref('default')

// modelSwitch=none 的客户端(如 zcode)没有可选模型,只展示哨兵项且锁定
const modelLocked = computed(() => selectedAgent.value?.capabilities.modelSwitch === 'none')

// 客户端拥有的可用模型列表(取套餐覆盖交集)
const effectiveModels = computed(() => {
  const agent = selectedAgent.value
  if (!agent) return []
  if (modelLocked.value) return [{ id: CLIENT_FOLLOW_MODEL, label: '跟随客户端' }]
  const covered = agent.plan.modelIds
  return covered.length > 0 ? agent.models.filter((m) => covered.includes(m.id)) : agent.models
})

// 解析出渠道与模型级联结构(彻底杜绝跨渠道传错模型导致上游 502 漏洞)
const channelGroups = computed<ChannelGroup[]>(() => {
  return parseChannelsAndModels(effectiveModels.value)
})

const channelOptions = computed(() => {
  return channelGroups.value.map((g) => ({ value: g.id, label: g.name }))
})

const currentChannelGroup = computed(() => {
  return channelGroups.value.find((g) => g.id === selectedChannelId.value) ?? channelGroups.value[0]
})

// 级联模型选项:严格只展示当前渠道下的有效模型
const modelOptions = computed(() => {
  if (modelLocked.value) return [{ value: CLIENT_FOLLOW_MODEL, label: '跟随客户端' }]
  return currentChannelGroup.value?.models ?? []
})

// 仅在客户端支持切模型且已选中时随 DTO 透传;其余情况省略字段
const resolvedModelId = computed(() =>
  selectedAgent.value && !modelLocked.value && modelId.value ? modelId.value : undefined,
)

// 级联同步:保障渠道与模型严格合法
function syncCascadingModel() {
  const groups = channelGroups.value
  if (groups.length === 0) return

  // 1. 若当前 channelId 不在可选渠道列表内,自动回正
  if (!groups.some((g) => g.id === selectedChannelId.value)) {
    const matched = groups.find((g) => g.models.some((m) => m.value === modelId.value))
    selectedChannelId.value = matched?.id ?? groups[0]?.id ?? 'default'
  }

  // 2. 当前渠道下的可用模型 (直接检索目标 group, 杜绝 computed 时序未刷新问题)
  const currentGroup = groups.find((g) => g.id === selectedChannelId.value) ?? groups[0]
  const modelsInChannel = currentGroup?.models ?? []
  if (modelsInChannel.length === 0) {
    modelId.value = ''
    return
  }

  // 3. 若当前 modelId 不在该渠道内,自动落入该渠道首个有效模型或默认模型
  if (!modelId.value || !modelsInChannel.some((m) => m.value === modelId.value)) {
    const preferred = selectedAgent.value?.defaultModel
    const preferredMatch = preferred && modelsInChannel.find((m) => m.value === preferred)
    modelId.value = preferredMatch ? preferredMatch.value : (modelsInChannel[0]?.value ?? '')
  }
}

watch(agentId, () => {
  // 切客户端时重新选择匹配渠道
  selectedChannelId.value = channelGroups.value[0]?.id ?? 'default'
  syncCascadingModel()
})

watch(selectedChannelId, (newChannelId) => {
  // 渠道切换时,严格重选模型至该渠道内,避免上游由于 channel-model 错位触发 502/503 报错
  const targetGroup = channelGroups.value.find((g) => g.id === newChannelId) ?? channelGroups.value[0]
  const modelsInChannel = targetGroup?.models ?? []
  if (modelsInChannel.length > 0 && !modelsInChannel.some((m) => m.value === modelId.value)) {
    modelId.value = modelsInChannel[0]?.value ?? ''
  }
})

watch(channelGroups, () => {
  syncCascadingModel()
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

// agents 异步到达或变更后回填默认选中,避免失效或下拉框显示为空
watch(
  activeAgents,
  (list) => {
    if ((!agentId.value || !list.some((a) => a.id === agentId.value)) && list.length > 0) {
      agentId.value = list[0]!.id
    }
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
      skills: [...store.activeSkills.value],
      // 必须纯数据对象拷贝,避免 Vue 响应式代理引发 "An object could not be cloned"
      attachments:
        attachments.value.length > 0
          ? attachments.value.map((a) => ({ path: a.path, kind: a.kind }))
          : undefined,
      ...(toolPolicy ? { toolPolicy: { ...toolPolicy, denyList: [...toolPolicy.denyList] } } : {}),
    }))
    const cleanDtos = JSON.parse(JSON.stringify(dtos)) as SubmitTaskDto[]
    // 派生工作区:git 源建 worktree,非 git 整拷降级(主进程完成)
    const finalDtos = workspaceSource.value
      ? cleanDtos.map((dto) => ({ ...dto, workspaceSource: workspaceSource.value }))
      : cleanDtos
    const tasks = await window.api.tasksSubmitBatch(finalDtos)
    if (tasks.length > 0) store.selectedTaskId.value = tasks[0]?.id ?? null
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
      <div class="selectors-group">
        <GlassSelect
          v-model="agentId"
          class="who"
          title="执行客户端"
          :options="activeAgents.map((a) => ({ value: a.id, label: a.label }))"
        />
        <!-- 级联渠道选择器:多渠道时展示,选择特定渠道如官方/自定义中转 -->
        <GlassSelect
          v-if="channelOptions.length > 1"
          v-model="selectedChannelId"
          class="channel"
          title="模型渠道"
          :options="channelOptions"
          :disabled="modelLocked"
        />
        <!-- 联动模型选择器:只展示当前渠道下的合法模型 -->
        <GlassSelect
          v-model="modelId"
          class="model"
          title="模型"
          :options="modelOptions"
          :disabled="modelLocked"
        />
        <GlassSelect
          v-model="mode"
          class="mode"
          title="档位"
          :options="MODE_OPTIONS"
        />
      </div>
      <div class="actions-group">
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
        {{ selectedProject.name }}
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
        <span class="chip-kind">{{ a.kind === 'image' ? '[图]' : '[文]' }}</span> {{ a.path.split(/[\\/]/).pop() }}
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
  gap: 10px;
  padding: 14px 16px 12px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.selectors-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.actions-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.who {
  min-width: 95px;
  max-width: 130px;
}

.channel {
  min-width: 100px;
  max-width: 140px;
}

.model {
  min-width: 120px;
  max-width: 200px;
}

.mode {
  min-width: 75px;
  max-width: 95px;
}

/* 工作区行:目录输入占主导 */
.ws-row {
  display: flex;
  align-items: center;
  gap: 8px;
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
