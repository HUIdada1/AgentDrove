<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { readModelPref, useAppStore, writeModelPref } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import SkillSelector from './SkillSelector.vue'
import SlashCommandPopup, { type SlashCommand } from './SlashCommandPopup.vue'
import ModelSelector from './ModelSelector.vue'
import ReasoningEffortPicker from './ReasoningEffortPicker.vue'
import {
  CLIENT_FOLLOW_MODEL,
  MODE_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  parseChannelsAndModels,
  type ChannelGroup,
} from '../labels'
import { skillsToDenyList, type ReasoningEffort, type SubmitTaskDto } from '@agent-drove/shared'

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
/** G3-07:notice 分级(info=中性操作提示/warn=回落与不可用提示/err=失败),分色避免中性提示看起来像报错 */
const noticeLevel = ref<'info' | 'warn' | 'err'>('err')

function setNotice(msg: string, level: 'info' | 'warn' | 'err' = 'err'): void {
  notice.value = msg
  noticeLevel.value = level
}
const agentId = ref('')
const promptBox = ref<{ focus: () => void } | null>(null)
/** 思考档位(P0-4):''=默认(不传,跟随客户端);仅 capabilities.reasoningEffort 客户端可调 */
const reasoningEffort = ref<ReasoningEffort | ''>('')

const activeAgents = computed(() => store.agents.value.filter((a) => a.enabled && a.capabilities.headless))
const selectedAgent = computed(() => store.agents.value.find((a) => a.id === agentId.value))
const selectedProject = computed(() => store.selectedProject.value)
/** 无可用客户端(R17):发送禁用 + placeholder/notice 给明确原因,绝不静默吞输入 */
const noClients = computed(() => activeAgents.value.length === 0)
/** G3-10:探测完成标志——冷启动 5~15s 探活期间空态显示「正在探测客户端…」,不诱导误点重新扫描 */
const probing = computed(() => !store.agentsLoaded.value)
/** 该客户端是否支持思考档位(P0-4):false/缺省 = 不支持,控件降级为说明徽标 */
const supportsReasoning = computed(() => selectedAgent.value?.capabilities.reasoningEffort === true)
const modelId = ref('')
const selectedChannelId = ref('default')

// 思考档位不支持态的哨兵值(R18):disabled GlassSelect 只作展示,值恒为「不支持」
const REASONING_UNSUPPORTED = 'unsupported'
const REASONING_UNSUPPORTED_OPTIONS = [{ value: REASONING_UNSUPPORTED, label: '不支持' }]

/**
 * 思考档位选项(R18):value/label 集合取 labels.ts 的 REASONING_EFFORT_OPTIONS 单一来源(R06),
 * 仅对缺省项做展示层改写「跟随→跟随模型」;档位含义说明经触发器 title 呈现
 * (GlassSelect options 无 per-option title,说明统一挂容器 title,随选中值切换)。
 */
const reasoningOptions = computed(() =>
  REASONING_EFFORT_OPTIONS.map((o) => ({
    value: o.value,
    label: o.value === '' ? '跟随模型' : o.label,
  })),
)

// 思考控件 title(R18):不支持/跟随模型/具体档位三种语义,悬停即见诚实说明
const effortTitle = computed(() => {
  if (!supportsReasoning.value) return '该客户端不支持调节思考强度'
  if (!reasoningEffort.value) {
    return '跟随模型:zcode 等缺省取该模型支持的最高档,实际档位以运行反馈为准'
  }
  return '思考档位:按模型支持档位就近映射(实际生效档位以运行反馈为准)'
})

// 触发器 title 全名(R19):选择器收窄省略后,悬停触发器可读选中项完整名称
const agentTitle = computed(() => `客户端: ${selectedAgent.value?.label ?? '未选择'}`)
const channelTitle = computed(() => `渠道: ${currentChannelGroup.value?.name ?? '默认渠道'}`)
const modelTitle = computed(() => {
  const label = modelOptions.value.find((o) => o.value === modelId.value)?.label
  return `模型: ${label ?? '未选择'}`
})
const modeTitle = computed(() => `模式: ${mode.value}`)

// 仅当客户端无可用模型或明确声明无切换能力且只有默认跟随项时才锁定
const modelLocked = computed(() => {
  const agent = selectedAgent.value
  if (!agent) return true
  if (agent.models.length === 0) return true
  if (agent.capabilities.modelSwitch === 'none' && agent.models.length <= 1) return true
  return false
})

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

// 思考档位(P0-4):仅支持的客户端随 DTO 透传;''=默认不传,实际生效档位以事件流为准
const resolvedReasoningEffort = computed(() =>
  supportsReasoning.value && reasoningEffort.value ? reasoningEffort.value : undefined,
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

/**
 * 恢复该客户端的记忆偏好(P0-5):渠道/模型/档位三元组,记忆值非法(渠道删除/模型下架)
 * 回落首渠道并给出轻提示;保留既有级联合法性校验,记忆只是优先候选。
 * 恢复属程序化赋值,期间抑制 watch(selectedChannelId) 的「已切换默认模型」提示,
 * 避免每次切客户端都弹无动作提示;记忆渠道失效的回落提示在此显式给出。
 */
let restoringPref = false

function restoreModelPrefForAgent(): void {
  // 复位注册必须晚于首次 ref 赋值(其时 Vue 已把 flushJobs 微任务入队),
  // 否则 reset 会先于 watch 回调执行,抑制标志失效
  restoringPref = true
  // G3-07:复位先于恢复——档位清空后再按目标客户端记忆覆盖,
  // 杜绝 A 客户端的档位残留到 B,再被 watch 即时写入 B 的记忆(用户从未为 B 选过)
  reasoningEffort.value = ''
  const groups = channelGroups.value
  const pref = readModelPref(agentId.value)
  if (pref) {
    const group = groups.find((g) => g.id === pref.channelId)
    if (group) {
      selectedChannelId.value = group.id
      if (!modelLocked.value && group.models.some((m) => m.value === pref.modelId)) {
        modelId.value = pref.modelId
      }
      if (pref.reasoningEffort) reasoningEffort.value = pref.reasoningEffort
      syncCascadingModel()
      queueMicrotask(() => {
        restoringPref = false
      })
      return
    }
    // 记忆的渠道已失效(被删除/下架):回落首渠道并明确告知(R19;G3-07 分级为 warn)
    const fallbackName = groups[0]?.name
    selectedChannelId.value = groups[0]?.id ?? 'default'
    syncCascadingModel()
    setNotice(
      fallbackName
        ? `上次记忆的渠道已不可用,已回落到渠道 ${fallbackName}`
        : '上次记忆的渠道已不可用,已回落默认渠道',
      'warn',
    )
    queueMicrotask(() => {
      restoringPref = false
    })
    return
  }
  selectedChannelId.value = groups[0]?.id ?? 'default'
  syncCascadingModel()
  queueMicrotask(() => {
    restoringPref = false
  })
}

// 启动期程序回填标记(P0-1 复审):activeAgents 首拉回填 agentId 时经由此标志跳过上下文反写,
// 否则侧栏第一个客户端未点击即呈选中态,且用户首点会被 toggle 语义解释为"取消绑定"
let programmaticAgentSet = false

watch(agentId, (id) => {
  // P0-1:发布框 → 侧栏单向同步,手动改写后侧栏选中态跟随高亮(程序回填不反写)
  if (!programmaticAgentSet && store.agentContext.value !== id) store.agentContext.value = id
  // P0-5:切客户端先恢复记忆渠道/模型/档位(与上下文联动同链执行,避免 watch 竞态)
  restoreModelPrefForAgent()
})

/** G3-07:切渠道前的渠道/模型组合,供「切回原选择」一键还原;还原成功后清空。
 *  用 ref 承载:模板按钮直接消费,普通变量不具备响应式(切渠道未重置模型时按钮不会出现) */
const lastChannelPref = ref<{ channelId: string; modelId: string } | null>(null)

watch(selectedChannelId, (newChannelId, oldChannelId) => {
  // G3-07:重置模型前记录切换前组合,原选择可一键还原(首次赋值/程序化恢复不记录)
  if (!restoringPref && oldChannelId && oldChannelId !== newChannelId) {
    lastChannelPref.value = { channelId: oldChannelId, modelId: modelId.value }
  }
  // 渠道切换时,严格重选模型至该渠道内,避免上游由于 channel-model 错位触发 502/503 报错
  const targetGroup = channelGroups.value.find((g) => g.id === newChannelId) ?? channelGroups.value[0]
  const modelsInChannel = targetGroup?.models ?? []
  if (modelsInChannel.length > 0 && !modelsInChannel.some((m) => m.value === modelId.value)) {
    modelId.value = modelsInChannel[0]?.value ?? ''
    // 程序化恢复(切客户端/记忆回落)不提示;用户主动切渠道导致模型被重置时给出轻提示(R19;G3-07 分级为 info)
    if (!restoringPref && targetGroup) {
      setNotice(`已切换到渠道 ${targetGroup.name} 的默认模型`, 'info')
    }
  }
})

/** G3-07:一键切回切渠道前的渠道/模型组合;程序化恢复期间抑制切换提示与再次记录,并撤下原提示 */
function restoreLastChannel(): void {
  const pref = lastChannelPref.value
  if (!pref) return
  restoringPref = true
  selectedChannelId.value = pref.channelId
  modelId.value = pref.modelId
  syncCascadingModel()
  lastChannelPref.value = null
  notice.value = ''
  queueMicrotask(() => {
    restoringPref = false
  })
}

// 选择即持久(R19):渠道/模型/档位任一变更立刻写记忆,不再等提交成功才 writeModelPref,
// 避免改好没发就切走被旧记忆静默覆盖;未选中客户端时无记忆主体,跳过
watch(
  [selectedChannelId, modelId, reasoningEffort],
  () => {
    if (!agentId.value) return
    writeModelPref(agentId.value, {
      channelId: selectedChannelId.value,
      modelId: modelId.value,
      ...(reasoningEffort.value ? { reasoningEffort: reasoningEffort.value } : {}),
    })
  },
  { immediate: true },
)

watch(channelGroups, () => {
  syncCascadingModel()
})

// P0-1:侧栏点击"进入上下文" → 发布框同步该客户端;取消绑定(空)时保持现值不清除
watch(
  () => store.agentContext.value,
  (ctx) => {
    if (ctx && ctx !== agentId.value && activeAgents.value.some((a) => a.id === ctx)) {
      agentId.value = ctx
    }
  },
)

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
  window.addEventListener('fill-composer', onFillComposer)
})

// ---- P0-10:引导中心空态点场景卡 → 草稿填入常驻发布框,聚焦并短暂高亮 ----
const prefilled = ref(false)
let prefilledTimer: ReturnType<typeof setTimeout> | null = null

function onFillComposer(event: Event): void {
  const text = (event as CustomEvent<string>).detail
  if (typeof text !== 'string' || !text) return
  prompt.value = text
  showSlashPopup.value = false
  focusPrompt()
  prefilled.value = true
  if (prefilledTimer) clearTimeout(prefilledTimer)
  prefilledTimer = setTimeout(() => {
    prefilled.value = false
  }, 1200)
}

// agents 异步到达或变更后回填:P0-1 优先当前对话上下文,上下文无效才回落首项
watch(
  activeAgents,
  (list) => {
    if (list.length === 0) return
    const ctx = store.agentContext.value
    if (ctx && list.some((a) => a.id === ctx)) {
      if (agentId.value !== ctx) agentId.value = ctx
      return
    }
    // G3-07:stale 前置——冷启动首填(agentId 为空)不算回落、不提示;
    // 仅原选中客户端已停用/消失时才回落首项并 toast 告知去向
    const stale = Boolean(agentId.value) && !list.some((a) => a.id === agentId.value)
    if (!agentId.value || stale) {
      // 程序回填(静默赋值):走 watch(agentId) 时跳过上下文反写,P0-1 点击语义不受污染;
      // Vue 的 watcher 经微任务 flush,恢复标记在其后注册,回调内读到的是 true
      programmaticAgentSet = true
      agentId.value = list[0]!.id
      if (stale) store.showToast(`原客户端不可用，发布框已切到 ${list[0]!.label}`)
      queueMicrotask(() => {
        programmaticAgentSet = false
      })
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('focus-composer', focusPrompt)
  window.removeEventListener('fill-composer', onFillComposer)
})

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
      setNotice(`无法解析附件路径:${file.name}`)
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
    setNotice(`选择目录失败:${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 重新扫描客户端(R17):无可用客户端的空态里,给用户一条自愈路径而非死胡同 */
const rescanning = ref(false)

async function rescanAgents(): Promise<void> {
  if (rescanning.value) return
  rescanning.value = true
  try {
    await window.api.agentsRescan()
    await store.refreshAgents()
  } catch (error) {
    setNotice(`重新扫描失败:${error instanceof Error ? error.message : String(error)}`)
  } finally {
    rescanning.value = false
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
  if (!text || submitting.value) return
  // 无目标时给出原因并保留草稿,绝不静默吞掉输入(R17)
  if (!agentId.value) {
    setNotice(
      noClients.value
        ? '未检出可用客户端,请先在左侧启用客户端或重新扫描后再派发'
        : '尚未选择执行客户端,请先在上方选择派发目标',
    )
    return
  }
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
      ...(resolvedReasoningEffort.value ? { reasoningEffort: resolvedReasoningEffort.value } : {}),
      mode: mode.value,
      skills: [...store.activeSkills.value],
      // 必须纯数据对象拷贝,避免 Vue 响应式代理引发 "An object could not be cloned"
      attachments:
        attachments.value.length > 0
          ? attachments.value.map((a) => ({ path: a.path, kind: a.kind }))
          : undefined,
      ...(toolPolicy
        ? { toolPolicy: { ...toolPolicy, denyList: [...(toolPolicy.denyList ?? [])] } }
        : {}),
    }))
    const cleanDtos = JSON.parse(JSON.stringify(dtos)) as SubmitTaskDto[]
    // 派生工作区:git 源建 worktree,非 git 整拷降级(主进程完成)
    const finalDtos = workspaceSource.value
      ? cleanDtos.map((dto) => ({ ...dto, workspaceSource: workspaceSource.value }))
      : cleanDtos
    const result = await window.api.tasksSubmitBatch(finalDtos)
    const tasks = result.created
    if (tasks.length > 0) store.selectedTaskId.value = tasks[0]?.id ?? null
    // G3-02:批量派发汇总提示——只自动选中第一条,其余条目去向由 toast 明示
    // G5-07:per-item 容错——单行失败不再整体抛错,汇总"已入队 N 条,失败 M 条"
    if (result.errors.length > 0) {
      store.showToast(`已入队 ${tasks.length} 条任务，失败 ${result.errors.length} 条`)
    } else if (tasks.length > 1) {
      store.showToast(`已入队 ${tasks.length} 条任务，已选中第一条`)
    }
    // G3-02:筛选自愈——带着列头客户端筛选派发异客户端任务时,新任务会被主进程筛选排除,
    // 会话区将退回空态;此处主动清除残留筛选并说明,保证新任务立即可见
    if (store.filter.value.agentId && store.filter.value.agentId !== agentId.value) {
      store.filter.value.agentId = ''
      store.showToast('已清除客户端筛选以显示新任务')
    }
    // 渠道/模型/档位记忆已由 watch 即时写入(R19),提交成功仅清理草稿与附件
    prompt.value = ''
    attachments.value = []
  } catch (error) {
    // 批量入队可能部分成功,失败后仍要刷新列表,避免界面漏掉已入队的任务
    setNotice(error instanceof Error ? error.message : String(error))
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
    <!-- 技能快速选择栏(G3-07⑤:承接 G1-03——驱动不支持 deny 能力时芯片置灰) -->
    <div class="composer-skills">
      <SkillSelector
        compact
        :deny-supported="selectedAgent ? !['codex', 'qoder', 'trae'].includes(selectedAgent.id) : true"
      />
    </div>

    <!-- R17+G3-10:无可用客户端空态两态区分——探测中给旋转提示(无 CTA),
         探测完成仍为空才显示「未检出可用客户端 + 重新扫描」自愈入口 -->
    <div v-if="noClients && probing" class="no-clients probing">
      <span class="probe-spin" aria-hidden="true"></span>
      <span>正在探测客户端…</span>
    </div>
    <div v-else-if="noClients" class="no-clients">
      <span>未检出可用客户端</span>
      <GlassButton variant="ghost" size="sm" :disabled="rescanning" @click="rescanAgents">
        {{ rescanning ? '扫描中…' : '重新扫描' }}
      </GlassButton>
    </div>

    <div class="input-pos" :class="{ prefilled }">
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
        auto-grow
        send-label="派发"
        :send-disabled="submitting || !prompt.trim() || noClients"
        :placeholder="noClients
          ? '暂无可用客户端,先在左侧启用或重新扫描'
          : batchMode
            ? '每行一条任务,批量入队…(Enter 提交 / Shift+Enter 换行)'
            : '下达 Agent 任务,键入 / 呼出快捷技能…(Enter 提交 / Shift+Enter 换行)'"
        @update:model-value="handlePromptChange"
        @keydown="onKeydown"
        @send="submit"
      />
    </div>

    <div class="ws-row">
      <span
        v-if="selectedProject"
        class="ws-chip"
        :title="selectedProject.path ?? '未绑定目录,派发落默认工作区'"
      >
        ⌂ {{ selectedProject.name }}
        <button class="x" title="取消选中工作区" @click="store.selectedProjectId.value = null">×</button>
      </span>
      <GlassInput v-model="workspace" class="ws" mono :placeholder="selectedProject ? `${selectedProject.name} · 可临时改写目录` : '工作目录(留空=默认目录)'" />
      <GlassButton variant="ghost" size="sm" title="选择目录填入工作区" @click="pickWorkspace">
        选目录
      </GlassButton>
    </div>

    <div class="toolbar">
      <div class="selectors-group">
        <!-- R19:触发器带名称前缀(样式 ::before),title 悬停见选中项全名 -->
        <GlassSelect
          v-model="agentId"
          class="who"
          :title="agentTitle"
          :options="activeAgents.map((a) => ({ value: a.id, label: `🤖 ${a.label}` }))"
        />
        <!-- 现代化一体式模型选择器:单胶囊即可呼出带搜索与分类面板，告别渠道模型割裂 -->
        <ModelSelector
          :channel-groups="channelGroups"
          :current-channel-id="selectedChannelId"
          :current-model-id="modelId"
          :disabled="modelLocked"
          @select="({ channelId, modelId: mId }) => {
            selectedChannelId = channelId
            modelId = mId
          }"
        />
        <GlassSelect
          v-model="mode"
          class="mode"
          :title="modeTitle"
          :options="MODE_OPTIONS"
        />
        <!-- 现代化思考强度分段胶囊:支持时展示微调器，不支持时自然隐藏，零残缺破损占位 -->
        <ReasoningEffortPicker
          v-model="reasoningEffort"
          :supported="supportsReasoning"
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
        最大轮数 (max-turns)
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

    <!-- G3-07:notice 按 info/warn/err 分色;切渠道重置过原选择时提供「切回原选择」一键还原 -->
    <div v-if="notice" class="notice" :class="noticeLevel">
      <span class="notice-text">{{ notice }}</span>
      <GlassButton
        v-if="lastChannelPref && notice"
        variant="ghost"
        size="sm"
        title="恢复切渠道前的渠道与模型"
        @click="restoreLastChannel"
      >
        切回原选择
      </GlassButton>
    </div>
  </section>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 12px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
  box-sizing: border-box;
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
  /* R19:放宽上限,容纳「客户端: 」前缀与较长客户端名,溢出仍可悬停 title 看全名 */
  max-width: 210px;
}

.channel {
  min-width: 100px;
  max-width: 140px;
}

.model {
  min-width: 120px;
  /* R19:放宽上限,容纳「模型: 」前缀与较长模型名 */
  max-width: 280px;
}

.mode {
  min-width: 85px;
  max-width: 140px;
}

.effort {
  min-width: 75px;
  max-width: 95px;
}

/* R19:触发器名称前缀(仅入口显示,下拉选项保持纯选项);省略时悬停 title 见全名 */
.who :deep(.g-select-text)::before,
.channel :deep(.g-select-text)::before,
.model :deep(.g-select-text)::before,
.mode :deep(.g-select-text)::before,
.effort :deep(.g-select-text)::before {
  color: var(--muted);
  white-space: nowrap;
}

.who :deep(.g-select-text)::before {
  content: '客户端: ';
}

.channel :deep(.g-select-text)::before {
  content: '渠道: ';
}

.model :deep(.g-select-text)::before {
  content: '模型: ';
}

.mode :deep(.g-select-text)::before {
  content: '模式: ';
}

.effort :deep(.g-select-text)::before {
  content: '思考: ';
}

/* R17:无可用客户端空态,内联于输入区上方 */
.no-clients {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--warn);
  font-size: 12px;
}

/* G3-10:探测中空态——中性色 + 旋转点,不呈异常态、不诱导误点重新扫描 */
.no-clients.probing {
  color: var(--muted);
}

.probe-spin {
  width: 12px;
  height: 12px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--line);
  border-top-color: var(--accent-strong);
  animation: probeSpin 0.85s linear infinite;
}

@keyframes probeSpin {
  to { transform: rotate(360deg); }
}

/* R18:思考档位不支持说明徽标——disabled GlassSelect 承载「不支持」值,
   外层徽标提供虚线外观与可悬停的 title(GlassSelect disabled 态 pointer-events:none 无法悬停) */
.effort-off {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  color: var(--faint);
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  white-space: nowrap;
  cursor: help;
}

.effort-off :deep(.g-select-wrap) {
  min-width: 0;
}

/* disabled 的 0.55 透明度与徽标本就偏淡的 --faint 叠加会难以阅读,恢复不透明 */
.effort-off :deep(.g-select-wrap.disabled) {
  opacity: 1;
}

.effort-off :deep(.g-select-trigger) {
  height: auto;
  padding: 0;
  border: none;
  background: none;
  box-shadow: none;
  cursor: help;
}

.effort-off :deep(.g-arrow) {
  display: none;
}

/* P0-10:场景卡预填高亮,品牌色边框 1.2s 内自行消退 */
.input-pos.prefilled :deep(.g-field) {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-dim);
  transition: border-color 400ms var(--ease), box-shadow 900ms var(--ease);
}

/* 工作区行:目录输入占主导 */
.ws-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

.ws {
  flex: 1 1 140px;
  min-width: 0;
  max-width: 100%;
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
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
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

/* G3-15:单渠道只读渠道徽标,仿 effort-off 说明徽标(虚线边框、--faint 色、悬停说明) */
.channel-badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  color: var(--faint);
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  white-space: nowrap;
  cursor: help;
}

/* G3-07:notice 分级(info=中性操作提示/warn=回落提示/err=失败),不再全部呈错误红 */
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.notice .notice-text {
  min-width: 0;
}

.notice.info {
  color: var(--muted);
}

.notice.warn {
  color: var(--warn);
}

.notice.err {
  color: var(--err);
}

.composer-skills {
  margin-bottom: 6px;
}

.input-pos {
  position: relative;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
</style>
