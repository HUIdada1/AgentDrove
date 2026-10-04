<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AgentView, AppConfig, UpdatePhase } from '@agent-drove/shared'
import { useAppStore } from '../stores/app'
import GlassModal from '../ui/GlassModal.vue'
import GlassButton from '../ui/GlassButton.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassSelect from '../ui/GlassSelect.vue'
import GlassToggle from '../ui/GlassToggle.vue'
import GlassMeter from '../ui/GlassMeter.vue'
import { MODE_OPTIONS } from '../labels'

const store = useAppStore()

// 挂载由父层 v-if 控制(打开设置才渲染),组件内 open 恒 true;关闭语义上抛,由 App 回落 panel
const emit = defineEmits<{ close: [] }>()

const draft = ref<AppConfig | null>(null)
const saved = ref(false)
const hotkeyConflict = ref('')
const rescanning = ref(false)

let savedTimer: ReturnType<typeof setTimeout> | undefined
let offConflict: (() => void) | null = null

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: '未检查',
  checking: '检查中…',
  available: '发现新版本',
  'not-available': '已是最新',
  downloading: '下载中…',
  downloaded: '已下载,待安装',
  error: '更新出错',
}

const phaseText = computed(() => PHASE_TEXT[store.updateStatus.value.phase])

const appVersion = __APP_VERSION__

function checkUpdate(): void {
  void run(() => window.api.updateCheck().then(() => undefined), '检查更新失败')
}

async function installUpdate(): Promise<void> {
  await run(() => window.api.updateInstall(), '启动安装失败')
}

const phaseClass = computed(() => {
  const phase = store.updateStatus.value.phase
  if (phase === 'error') return 'err'
  if (phase === 'available' || phase === 'downloaded') return 'accent'
  return ''
})

/** 统一收口 IPC 失败:更新链路出错时不静默,提示留在弹窗内;返回是否成功 */
async function run(action: () => Promise<void>, prefix: string): Promise<boolean> {
  try {
    await action()
    return true
  } catch (error) {
    window.alert(`${prefix}:${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

onMounted(async () => {
  // 先挂冲突监听:启动期主进程可能立刻推热键冲突,晚注册会丢这条提示
  offConflict = window.api.onHotkeyConflict((accelerator) => {
    hotkeyConflict.value = accelerator
  })
  try {
    await store.refreshSettings()
  } catch {
    // 单次刷新失败不判死:启动首拉多数已拿到配置,直接用缓存渲染
  }
  const config = store.settings.value
  // 结构化克隆成草稿:编辑/取消都不回写全局 settings,保存时才提交。
  // 不能用 structuredClone:settings.value 是 Vue 响应式代理(Proxy),克隆必抛 DataCloneError,
  // draft 恒为 null,设置页会永久停在"加载设置中…"——配置深拷贝统一走 JSON。
  if (config && !draft.value) draft.value = JSON.parse(JSON.stringify(config))
})

onUnmounted(() => {
  offConflict?.()
  clearTimeout(savedTimer)
})

async function save(): Promise<void> {
  const d = draft.value
  if (!d) return
  // settings:update 按顶层浅合并,嵌套组必须整对象提交,否则会丢组内未编辑字段。
  // 必须深拷贝成纯对象再过 IPC:draft 是 Vue 响应式代理,浅展开后嵌套组(failover 等)
  // 仍是 Proxy,结构化克隆必抛 "An object could not be cloned"
  const ok = await run(async () => {
    await window.api.settingsUpdate(
      JSON.parse(JSON.stringify({ throttle: d.throttle, task: d.task, danger: d.danger })),
    )
    await store.refreshSettings()
  }, '保存失败')
  if (!ok) return
  saved.value = true
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    saved.value = false
  }, 2000)
}

/**
 * GlassInput 的 modelValue 是 string:数字字段经此双向桥接(draft 数字 ↔ 表单字符串)。
 * 空串保持原值不动(用户清空输入时不把配置写坏),非数字串忽略,不做多余防御。
 */
function bindNum(read: () => number | undefined, write: (v: number) => void) {
  return computed<string>({
    get: () => {
      const v = read()
      return v === undefined ? '' : String(v)
    },
    set: (raw) => {
      const text = raw.trim()
      if (!text) return
      const n = Number(text)
      if (!Number.isNaN(n)) write(n)
    },
  })
}

const numConcurrency = bindNum(
  () => draft.value?.throttle.globalConcurrency,
  (v) => {
    if (draft.value) draft.value.throttle.globalConcurrency = v
  },
)

const numMinIntervalMs = bindNum(
  () => draft.value?.throttle.minIntervalMs,
  (v) => {
    if (draft.value) draft.value.throttle.minIntervalMs = v
  },
)

const numJitterMs = bindNum(
  () => draft.value?.throttle.jitterMs,
  (v) => {
    if (draft.value) draft.value.throttle.jitterMs = v
  },
)

const numMaxRetries = bindNum(
  () => draft.value?.task.failover.maxRetries,
  (v) => {
    if (draft.value) draft.value.task.failover.maxRetries = v
  },
)

const numTimeoutMs = bindNum(
  () => draft.value?.task.defaultTimeoutMs,
  (v) => {
    if (draft.value) draft.value.task.defaultTimeoutMs = v
  },
)

const numCleanupHours = bindNum(
  () => draft.value?.task.workspaceCleanupHours,
  (v) => {
    if (draft.value) draft.value.task.workspaceCleanupHours = v
  },
)

// GlassSelect 上抛 string,回写档位联合类型需一次收窄
function setMode(mode: string): void {
  if (draft.value) draft.value.task.defaultMode = mode as AppConfig['task']['defaultMode']
}

function toggleYolo(value: boolean): void {
  const d = draft.value
  if (!d) return
  if (!value) {
    d.danger.allowYolo = false
    return
  }
  if (!window.confirm('yolo 为全权限执行,仅限完全可信任务。确定开启?')) return
  if (!window.confirm('再次确认:开启后任务将绕过全部工具审批,继续吗?')) return
  d.danger.allowYolo = true
}

/** 客户端健康点配色,语义同 AgentRail 的 healthClass:无探活记录=灰 */
function dotClass(agent: AgentView): string {
  if (!agent.health) return 'unknown'
  return agent.health.ok ? 'ok' : 'bad'
}

async function toggleAgent(agent: AgentView, enabled: boolean): Promise<void> {
  await run(async () => {
    await window.api.agentsSetEnabled(agent.id, enabled)
    await store.refreshAgents()
  }, '切换客户端状态失败')
}

async function rescan(): Promise<void> {
  rescanning.value = true
  try {
    await run(async () => {
      await window.api.agentsRescan()
      await store.refreshAgents()
    }, '重新扫描失败')
  } finally {
    rescanning.value = false
  }
}

async function runExport(kind: 'data' | 'report'): Promise<void> {
  try {
    const result =
      kind === 'data' ? await window.api.exportData() : await window.api.exportWeeklyReport()
    window.alert(`已导出:${result.path}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== '已取消导出') window.alert(`导出失败:${message}`)
  }
}
</script>

<template>
  <GlassModal open title="设置" @close="emit('close')">
    <div v-if="draft" class="body">
      <section class="card">
        <div class="card-head">
          <h2>客户端</h2>
          <GlassButton variant="ghost" size="sm" :disabled="rescanning" @click="rescan">
            {{ rescanning ? '扫描中…' : '重新扫描' }}
          </GlassButton>
        </div>
        <p v-if="!store.agents.value.length" class="muted">
          未发现客户端,点击「重新扫描」检索本机。
        </p>
        <div
          v-for="agent in store.agents.value"
          :key="agent.id"
          class="agent-row"
          :class="{ off: !agent.enabled }"
        >
          <span class="dot" :class="dotClass(agent)" :title="agent.health?.reason ?? '未探活'" />
          <span class="agent-meta">
            <span class="agent-name">
              {{ agent.label }}<template v-if="agent.version"> {{ agent.version }}</template>
            </span>
            <span class="agent-plan">{{ agent.plan.name }}</span>
          </span>
          <GlassToggle :model-value="agent.enabled" @change="toggleAgent(agent, $event)" />
        </div>
      </section>

      <section class="card">
        <h2>调度</h2>
        <div class="grid">
          <label>
            全局并发
            <GlassInput v-model="numConcurrency" />
          </label>
          <label>
            每客户端最小间隔(ms)
            <GlassInput v-model="numMinIntervalMs" />
          </label>
          <label>
            抖动(ms)
            <GlassInput v-model="numJitterMs" />
          </label>
        </div>
        <GlassToggle
          :model-value="draft.task.confirmRetry"
          label="重试前确认"
          hint="重试会再次消耗套餐额度"
          @change="draft.task.confirmRetry = $event"
        />
        <GlassToggle
          :model-value="draft.task.failover.enabled"
          label="失败自动降级"
          hint="失败时按健康度换客户端重试"
          @change="draft.task.failover.enabled = $event"
        />
        <label v-if="draft.task.failover.enabled" class="inline">
          降级重试上限
          <GlassInput v-model="numMaxRetries" />
        </label>
      </section>

      <section class="card">
        <h2>任务</h2>
        <div class="grid">
          <label>
            默认档位
            <GlassSelect
              :model-value="draft.task.defaultMode"
              :options="MODE_OPTIONS"
              @update:model-value="setMode"
            />
          </label>
          <label>
            任务超时(ms)
            <GlassInput v-model="numTimeoutMs" />
          </label>
          <label>
            派生工作区保留(小时)
            <GlassInput v-model="numCleanupHours" />
          </label>
        </div>
      </section>

      <section class="card">
        <h2>快捷键</h2>
        <div class="hotkey mono">{{ store.settings.value?.hotkey ?? '—' }}</div>
        <p class="muted">唤起迷你派发条。快捷键在设置文件(yaml)修改后重启生效。</p>
        <div v-if="hotkeyConflict" class="conflict">
          热键 {{ hotkeyConflict }} 注册失败,可能已被其他程序占用,请修改后重启。
        </div>
      </section>

      <section class="card">
        <h2>更新</h2>
        <div class="update-row">
          <span>状态:<span :class="phaseClass" class="phase">{{ phaseText }}</span></span>
          <span v-if="store.updateStatus.value.detail" class="muted mono detail">
            {{ store.updateStatus.value.detail }}
          </span>
          <span class="spacer" />
          <GlassButton v-if="store.updateStatus.value.phase !== 'downloaded'" variant="plain" @click="checkUpdate">
            检查更新
          </GlassButton>
          <GlassButton v-else variant="primary" @click="installUpdate">
            重启安装
          </GlassButton>
        </div>
        <div v-if="store.updateStatus.value.phase === 'downloading'" class="prog-meter-wrap">
          <GlassMeter
            :value="Math.round(store.updateStatus.value.progress ?? 0)"
            :max="100"
            :show-percent="true"
            :show-spinner="true"
            status-text="正在下载更新包…"
            size="md"
          />
        </div>
        <p class="muted">更新包从 GitHub Releases 下载,下载完成后重启安装。</p>
      </section>

      <section class="card">
        <h2>数据</h2>
        <div class="grid">
          <GlassButton variant="plain" @click="runExport('data')">导出数据(JSON)</GlassButton>
          <GlassButton variant="plain" @click="runExport('report')">
            导出周用量报告(CSV)
          </GlassButton>
        </div>
      </section>

      <section class="card">
        <h2>Danger</h2>
        <GlassToggle
          :model-value="draft.danger.allowYolo"
          label="--mode yolo 放行"
          hint="开启后派发可使用 yolo 档位"
          @change="toggleYolo($event)"
        />
        <div v-if="draft.danger.allowYolo" class="conflict">
          yolo 为全权限执行,仅限完全可信任务
        </div>
      </section>

      <section class="card">
        <h2>关于</h2>
        <div class="about">
          <span class="brand">AgentDrove</span>
          <span class="mono muted">v{{ appVersion }}</span>
          <span class="muted">作者:沐辉</span>
        </div>
        <p class="muted">更新状态:{{ phaseText }}</p>
      </section>
    </div>

    <div v-else class="empty">加载设置中…</div>

    <template #footer>
      <transition name="fade">
        <span v-if="saved" class="saved">已保存</span>
      </transition>
      <span class="spacer" />
      <GlassButton variant="primary" :disabled="!draft" @click="save">保存</GlassButton>
    </template>
  </GlassModal>
</template>

<style scoped>
/* 弹窗内容区:单列卡片流,滚动交给 GlassModal 的 body */
.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card {
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-md);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  box-shadow: inset 0 1px 0 var(--glass-specular);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.card h2 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--muted);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 0;
}

/* 未启用客户端整行弱化,关闭状态一眼可辨 */
.agent-row.off {
  opacity: 0.55;
}

/* GlassToggle 是整行布局,这里只取右侧开关,宽度收回 auto 靠右 */
.agent-row :deep(.g-toggle-row) {
  width: auto;
  flex: none;
}

.agent-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.agent-name {
  font-size: 12.5px;
  font-weight: 600;
}

.agent-plan {
  font-size: 11px;
  color: var(--muted);
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--faint);
}

.dot.ok {
  background: var(--ok);
}

.dot.bad {
  background: var(--err);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.grid label,
.inline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

.inline {
  margin-top: 2px;
}

.hotkey {
  align-self: flex-start;
  font-family: var(--mono);
  background: var(--field-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
}

.update-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  flex-wrap: wrap;
}

.phase {
  font-weight: 600;
}

.phase.accent {
  color: var(--accent);
}

.phase.err {
  color: var(--err);
}

.detail {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prog {
  height: 4px;
  border-radius: 2px;
  background: var(--chip-bg);
  overflow: hidden;
}

.prog > div {
  height: 100%;
  background: var(--accent);
  transition: width var(--fast);
}

.conflict {
  border: 1px solid color-mix(in srgb, var(--err) 40%, transparent);
  background: color-mix(in srgb, var(--err) 9%, transparent);
  color: var(--err);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 12px;
}

.about {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.brand {
  font-weight: 600;
}

.mono {
  font-family: var(--mono);
}

.muted {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
}

.saved {
  color: var(--ok);
  font-size: 12px;
}

.spacer {
  flex: 1;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--fast);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.empty {
  color: var(--muted);
  text-align: center;
  padding: 40px 0;
}
</style>
