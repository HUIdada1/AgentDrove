<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import Logo from './Logo.vue'
import { readModelPref, writeModelPref } from '../stores/app'
import {
  CLIENT_FOLLOW_MODEL,
  REASONING_EFFORT_OPTIONS,
  isModelLocked,
  parseChannelsAndModels,
} from '../labels'
import type { AgentView, ReasoningEffort } from '@agent-drove/shared'

// 迷你条是独立窗口生命周期,刻意不依赖面板 store,直连 api 保持轻量;
// readModelPref 为纯 localStorage 读取(无 store 依赖),仅作预填候选(G3-09 后模型/档位可显式改)
const agents = ref<AgentView[]>([])
const agentId = ref('')
const prompt = ref('')
const submitting = ref(false)
const error = ref('')
const area = ref<HTMLTextAreaElement | null>(null)

// —— G3-09:显示并允许修改将生效的模型与思考档位(此前记忆命中即静默透传,主面板记错迷你条只会用错) ——
const modelId = ref('')
const effort = ref<ReasoningEffort | ''>('')

const currentAgent = computed(() => agents.value.find((a) => a.id === agentId.value))
/** 锁定单一口径(B-11/S-10):与发布框/续聊栏共用 labels.isModelLocked(含无可用模型) */
const modelLocked = computed(() => isModelLocked(currentAgent.value))

/** 迷你窗不展开渠道层级:parseChannelsAndModels 各渠道模型直接展平为一列 */
const miniModelOptions = computed(() => {
  if (modelLocked.value) return [{ value: CLIENT_FOLLOW_MODEL, label: '跟随客户端' }]
  return parseChannelsAndModels(currentAgent.value?.models ?? []).flatMap((g) => g.models)
})

/** 模型 → 所属渠道(展平后回写记忆需要原始渠道 id;找不到按默认渠道) */
const channelOfModel = computed(() => {
  const map = new Map<string, string>()
  for (const g of parseChannelsAndModels(currentAgent.value?.models ?? [])) {
    for (const m of g.models) map.set(m.value, g.id)
  }
  return map
})

/**
 * S-15:派发成功后把当前模型/档位写回与主面板同一记忆键,
 * 避免迷你条的选择只对本次生效、主面板下次仍按旧记忆派发;
 * 未显式选择(哨兵/锁定)时保留既有记忆,绝不用空值把主面板的选择降级。
 */
function persistMiniPref(): void {
  if (!agentId.value) return
  const prev = readModelPref(agentId.value)
  const explicit = Boolean(
    !modelLocked.value && modelId.value && modelId.value !== CLIENT_FOLLOW_MODEL,
  )
  writeModelPref(agentId.value, {
    channelId: explicit
      ? (channelOfModel.value.get(modelId.value) ?? prev?.channelId ?? 'default')
      : (prev?.channelId ?? 'default'),
    modelId: explicit ? modelId.value : (prev?.modelId ?? ''),
    ...(effort.value
      ? { reasoningEffort: effort.value }
      : prev?.reasoningEffort
        ? { reasoningEffort: prev.reasoningEffort }
        : {}),
  })
}

/** 仅支持思考档位的客户端显示档位下拉(选项单一来源 labels.ts) */
const effortSupported = computed(() => currentAgent.value?.capabilities.reasoningEffort === true)
const miniEffortOptions = REASONING_EFFORT_OPTIONS

// 切客户端时从记忆恢复模型/档位:模型须在该客户端目录内,非法回落 ''(不透传=客户端默认)
watch(agentId, () => {
  const agent = currentAgent.value
  const pref = readModelPref(agentId.value)
  const validModel = pref && agent?.models?.some((m) => m.id === pref.modelId) && !modelLocked.value
  modelId.value = validModel ? pref!.modelId : ''
  effort.value = agent?.capabilities.reasoningEffort === true && pref?.reasoningEffort ? pref.reasoningEffort : ''
})

let offPrefill: (() => void) | null = null
let offAgentsChanged: (() => void) | null = null
let disposed = false

/** 拉取最新客户端列表:窗口 show/hide 复用同一实例,onMounted 仅跑一次会导致列表永久陈旧(R20) */
async function reloadAgents(): Promise<void> {
  try {
    const list = await window.api.agentsList()
    if (disposed) return
    agents.value = list
    // 当前选中项已停用/消失时回退到首个可用客户端,避免拿死 id 派发
    if (!list.some((a) => a.enabled && a.id === agentId.value)) {
      agentId.value = list.find((a) => a.enabled)?.id ?? ''
    }
  } catch {
    // 拉取失败保留旧列表:迷你条保持可用,不因一次失败整体瘫痪
  }
}

onMounted(async () => {
  // 先挂预填监听:不依赖 agents 拉取,也避免注册前到达的推送被丢掉
  offPrefill = window.api.onMiniPrefill((text) => {
    if (text) prompt.value = text
    area.value?.focus()
    // 每次唤起都重拉一次,保证停用/启用客户端后列表即最新(R20)
    void reloadAgents()
  })
  // 客户端增删/启停推送:面板侧变更后迷你条无需重启即跟随(R20)
  offAgentsChanged = window.api.onAgentsChanged(() => {
    void reloadAgents()
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
  offAgentsChanged?.()
})

function close(): void {
  void window.api.hideMini()
}

async function submit(): Promise<void> {
  const text = prompt.value.trim()
  if (!text || !agentId.value || submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    // G3-09:改用显式选择的模型/档位随 DTO 透传(不再静默沿记忆);未选择/哨兵值/锁定客户端
    // 一律省略字段回落客户端默认,避免 registry.resolveModel 抛错
    const explicitModelId =
      modelId.value && modelId.value !== CLIENT_FOLLOW_MODEL && !modelLocked.value
        ? modelId.value
        : undefined
    await window.api.tasksSubmit({
      agentId: agentId.value,
      prompt: text,
      origin: 'hotkey',
      ...(explicitModelId ? { modelId: explicitModelId } : {}),
      ...(effort.value && currentAgent.value?.capabilities.reasoningEffort === true
        ? { reasoningEffort: effort.value }
        : {}),
    })
    prompt.value = ''
    persistMiniPref()
    void window.api.hideMini()
  } catch (e) {
    // 失败原位显示原因,草稿保留、窗口不关,用户可直接改后重发(R20)
    error.value = `派发失败:${e instanceof Error ? e.message : String(e)}`
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
      <!-- R20:frameless 小窗不可拖动,顶部空白条专司拖拽;控件区显式 no-drag -->
      <div class="drag-strip" aria-hidden="true"></div>
      <div class="main-row">
        <Logo :size="20" class="mark" />
        <GlassSelect
          v-model="agentId"
          class="who"
          title="客户端"
          :options="agents.filter((a) => a.enabled).map((a) => ({ value: a.id, label: a.label }))"
        />
        <!-- G3-09:将生效的模型可见可改;未选择(哨兵)时按客户端默认派发 -->
        <GlassSelect
          v-model="modelId"
          class="mb-model"
          title="模型:未选择时按客户端默认"
          :options="miniModelOptions"
        />
        <!-- G3-09:支持思考档位的客户端附档位下拉,''=跟随(不透传) -->
        <GlassSelect
          v-if="effortSupported"
          v-model="effort"
          class="mb-effort"
          title="思考档位:跟随=不随任务下发"
          :options="miniEffortOptions"
        />
        <div class="field">
          <GlassInput
            ref="area"
            v-model="prompt"
            class="fill"
            multiline
            :rows="2"
            auto-grow
            :max-grow-height="86"
            send-label="派发"
            :send-disabled="submitting || !prompt.trim() || !agentId"
            placeholder="把任务派发给客户端…(Enter 派发 / Esc 关闭)"
            @keydown="onKeydown"
            @send="submit"
          />
        </div>
      </div>
      <!-- R20:派发失败原位显示原因,不弹窗不吞错 -->
      <div v-if="error" class="mini-error">{{ error }}</div>
    </div>
  </div>
</template>

<style scoped>
.mini {
  height: 100vh;
  padding: 10px;
  background: var(--bg-veil), var(--bg);
}

/* R20:纵向布局,主行 + 可选错误行;位置相对,承载顶部拖拽条 */
.panel {
  height: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
}

.main-row {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 8px;
  /* G3-09:150px 迷你窗放不下全部下拉时折行,模型/档位落到 error 行上方 */
  flex-wrap: wrap;
}

/* R20:顶部空白拖拽条,高度贴合 panel 上内边距,不遮挡下方控件命中 */
.drag-strip {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 10px;
  -webkit-app-region: drag;
}

/* R20:控件区显式声明 no-drag,确保可点可输入不被拖拽语义截胡 */
.main-row > * {
  -webkit-app-region: no-drag;
}

.mark {
  align-self: center;
  flex: none;
}

.who {
  align-self: center;
  min-width: 100px;
  max-width: 150px;
}

/* G3-09:模型/档位下拉压缩宽度适配迷你窗;超宽时经 .main-row 的 wrap 折行 */
.mb-model {
  align-self: center;
  flex: none;
  min-width: 88px;
  max-width: 130px;
}

.mb-effort {
  align-self: center;
  flex: none;
  min-width: 72px;
  max-width: 100px;
}

.field {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

/* GlassInput 根是定位 wrapper,行方向 flex 里需显式撑满 */
.field .fill {
  flex: 1;
  min-width: 0;
}

/* 高度交由 autoGrow 管理(150px 迷你窗 40vh 无意义,传固定上限 86px),不再强制撑满 */
.field :deep(.g-field) {
  resize: none;
}

/* R20:派发失败行内原因,压缩布局不给迷你窗添滚动 */
.mini-error {
  flex: none;
  color: var(--err);
  font-size: 11px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
