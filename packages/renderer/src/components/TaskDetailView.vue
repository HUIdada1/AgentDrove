<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import { CLIENT_FOLLOW_MODEL, STATE_TEXT } from '../labels'
import type { MergeResult, TaskRecord, WorkspaceRow } from '@agent-drove/shared'

const props = withDefaults(
  defineProps<{
    mode?: 'panel' | 'modal'
  }>(),
  { mode: 'panel' },
)

const store = useAppStore()
const task = ref<TaskRecord | null>(null)
const switching = ref(false)
const mergeResult = ref<MergeResult | null>(null)
const notice = ref('')
const copied = ref(false)

const agentLabel = computed(
  () => store.agents.value.find((a) => a.id === task.value?.agentId)?.label ?? task.value?.agentId ?? '',
)
const otherAgents = computed(() =>
  store.agents.value.filter((a) => a.id !== task.value?.agentId && a.enabled && a.capabilities.headless),
)
const taskWorkspaces = computed(() => {
  if (!task.value) return [] as WorkspaceRow[]
  return store.workspaces.value.filter((row) => row.taskId === task.value!.id)
})

const duration = computed(() => {
  if (!task.value?.startedAt) return ''
  const end = task.value.finishedAt ?? Date.now()
  const ms = Math.max(0, end - task.value.startedAt)
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3600_000)}h${Math.floor((ms % 3600_000) / 60_000)}m`
})

/** 选中任务切换的竞态守卫:慢响应回来时若已切走,丢弃结果 */
let loadId = 0
watch(
  () => store.selectedTaskId.value,
  async (id) => {
    const seq = ++loadId
    const record = id ? await window.api.tasksGet(id) : null
    if (seq !== loadId) return
    task.value = record
    mergeResult.value = null
    switching.value = false
    notice.value = ''
    await store.refreshWorkspaces()
  },
  { immediate: true },
)

// 详情元数据(会话 id/结束时间/错误)轻量轮询兜底
let pollId = 0
const poll = setInterval(async () => {
  const id = store.selectedTaskId.value
  if (!id) return
  const seq = ++pollId
  const fresh = await window.api.tasksGet(id)
  if (!fresh || store.selectedTaskId.value !== id || seq !== pollId) return
  if (fresh !== task.value) task.value = fresh
}, 2000)
onUnmounted(() => clearInterval(poll))

// 选中任务到达终态后刷一次用量
watch(
  () => task.value?.state,
  async (state, prev) => {
    if (state !== prev && state && state !== 'queued' && state !== 'running') {
      await store.refreshAgents()
    }
  },
)

async function run(action: () => Promise<void>, prefix: string): Promise<void> {
  try {
    notice.value = ''
    await action()
  } catch (error) {
    notice.value = `${prefix}:${error instanceof Error ? error.message : String(error)}`
  }
}

async function cancel(): Promise<void> {
  if (!task.value) return
  await run(async () => {
    await window.api.tasksCancel(task.value!.id)
    await store.refreshTasks()
    task.value = await window.api.tasksGet(task.value!.id)
  }, '取消失败')
}

async function retry(): Promise<void> {
  if (!task.value) return
  if (store.settings.value?.task.confirmRetry && !window.confirm('重试会再次消耗套餐额度,继续?')) return
  await run(async () => {
    const next = await window.api.tasksRetry(task.value!.id)
    await store.refreshTasks()
    store.selectedTaskId.value = next.id
  }, '重试失败')
}

async function resubmitOn(target: string): Promise<void> {
  if (!task.value) return
  await run(async () => {
    const next = await window.api.tasksResubmitOn(task.value!.id, target)
    switching.value = false
    await store.refreshTasks()
    store.selectedTaskId.value = next.id
  }, '换客户端失败')
}

async function markFailed(): Promise<void> {
  if (!task.value) return
  await run(async () => {
    await window.api.tasksMarkFailed(task.value!.id)
    await store.refreshTasks()
    task.value = await window.api.tasksGet(task.value!.id)
  }, '标记失败出错')
}

async function openClient(): Promise<void> {
  if (task.value)
    await run(async () => {
      await window.api.launchApp(task.value!.agentId)
    }, '唤起客户端失败')
}

async function openWorkspace(): Promise<void> {
  if (task.value) await run(() => window.api.openPath(task.value!.cwd), '打开工作区失败')
}

async function copyPath(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    // 降级使用 prompt
  }
}

async function mergeArtifacts(): Promise<void> {
  const row = taskWorkspaces.value[0]
  if (!row) return
  await run(async () => {
    mergeResult.value = await window.api.workspacesMerge(row.id)
  }, '合并产物失败')
}

async function cleanWorkspace(): Promise<void> {
  const row = taskWorkspaces.value[0]
  if (!row) return
  await run(async () => {
    await window.api.workspacesClean(row.id)
    await store.refreshWorkspaces()
  }, '清理工作区失败')
}

function fmt(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
</script>

<template>
  <div class="detail-content" :class="[`mode-${mode}`]">
    <template v-if="task">
      <div v-if="mode === 'modal'" class="modal-subhead">
        <span class="prompt-text" :title="task.prompt">{{ task.prompt }}</span>
      </div>

      <dl class="meta" :class="{ 'meta-modal': mode === 'modal' }">
        <div><dt>客户端</dt><dd>{{ agentLabel }}</dd></div>
        <div>
          <dt>状态</dt>
          <dd>
            <span class="badge" :class="`s-${task.state}`">{{ STATE_TEXT[task.state] }}</span>
          </dd>
        </div>
        <div><dt>模型</dt><dd>{{ task.modelId === CLIENT_FOLLOW_MODEL ? '跟随客户端' : task.modelId }}</dd></div>
        <div><dt>档位</dt><dd>{{ task.mode }}</dd></div>
        <div><dt>创建时间</dt><dd class="num">{{ fmt(task.createdAt) }}</dd></div>
        <div>
          <dt>结束/耗时</dt>
          <dd class="num">
            {{ fmt(task.finishedAt) }}
            <span v-if="duration" class="dur-tag">({{ duration }})</span>
          </dd>
        </div>
        <div class="wide">
          <dt>工作区目录</dt>
          <dd class="mono flex-between" :title="task.cwd">
            <span class="path-text">{{ task.cwd }}</span>
            <div class="path-ops">
              <GlassButton size="sm" variant="ghost" @click="copyPath(task.cwd)">
                {{ copied ? '已复制' : '复制' }}
              </GlassButton>
              <GlassButton size="sm" variant="ghost" @click="openWorkspace">打开</GlassButton>
            </div>
          </dd>
        </div>
        <div v-if="task.sessionId" class="wide"><dt>会话 ID</dt><dd class="mono">{{ task.sessionId }}</dd></div>
        <div v-if="task.error" class="wide"><dt>错误信息</dt><dd class="err">{{ task.error }}</dd></div>
      </dl>

      <div v-if="notice" class="notice" @click="notice = ''">{{ notice }}</div>

      <div class="actions">
        <GlassButton v-if="task.state === 'running'" variant="danger" @click="cancel">取消任务</GlassButton>
        <GlassButton v-if="task.state !== 'running'" variant="primary" @click="retry">重新运行</GlassButton>
        <GlassButton v-if="otherAgents.length > 0 && task.state !== 'running'" @click="switching = !switching">
          换客户端派发
        </GlassButton>
        <GlassButton v-if="task.state === 'interrupted'" variant="danger" @click="markFailed">
          标记失败
        </GlassButton>
        <GlassButton @click="openClient">唤起客户端</GlassButton>
        <GlassButton v-if="taskWorkspaces[0]" @click="mergeArtifacts">合并产物</GlassButton>
        <GlassButton v-if="taskWorkspaces[0]" @click="cleanWorkspace">清理工作区</GlassButton>
      </div>

      <div v-if="switching" class="switch">
        <span class="switch-title">派发至其他可用客户端:</span>
        <div class="switch-btns">
          <GlassButton v-for="a in otherAgents" :key="a.id" size="sm" @click="resubmitOn(a.id)">
            派发给 {{ a.label }}
          </GlassButton>
        </div>
      </div>

      <div v-if="mergeResult" class="merge">
        <div v-if="mergeResult.merged.length">已合并 {{ mergeResult.merged.length }} 个文件</div>
        <div v-if="mergeResult.conflicts.length" class="err">
          冲突跳过 {{ mergeResult.conflicts.length }}: {{ mergeResult.conflicts.slice(0, 5).join(', ') }}
        </div>
        <div v-if="!mergeResult.merged.length && !mergeResult.conflicts.length">没有可合并的变更</div>
      </div>

      <section class="ws">
        <h4>工作区登记</h4>
        <p v-if="taskWorkspaces.length === 0" class="muted">直接使用的工作目录,无派生工作区。</p>
        <div v-for="row in taskWorkspaces" :key="row.id" class="ws-row">
          <span class="kind">{{ row.kind }}</span>
          <span class="path mono" :title="row.path">{{ row.path }}</span>
          <span class="status" :class="row.status">{{ row.status }}</span>
        </div>
      </section>
    </template>

    <div v-else class="placeholder">
      <p class="big">详情</p>
      <p class="sub">选中任务后,这里展示元信息与可用操作。</p>
    </div>
  </div>
</template>

<style scoped>
.detail-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  height: 100%;
}

.modal-subhead {
  padding: 8px 12px;
  background: var(--glass-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  word-break: break-word;
}

.prompt-text {
  font-weight: 500;
}

.meta {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
  background: var(--field-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 10px 12px;
}

.meta-modal {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px 16px;
  padding: 14px 16px;
}

.meta .wide {
  grid-column: 1 / -1;
}

.meta dt {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 2px;
}

.meta dd {
  margin: 0;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flex-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.path-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.path-ops {
  display: inline-flex;
  gap: 4px;
  flex: none;
}

.mono {
  font-family: var(--mono);
  font-size: 11.5px;
}

.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--chip-bg);
  color: var(--muted);
  display: inline-block;
}

.badge.s-running {
  background: var(--accent-dim);
  color: var(--accent-strong);
}

.badge.s-completed {
  background: color-mix(in srgb, var(--ok) 16%, transparent);
  color: var(--ok);
}

.badge.s-failed {
  background: color-mix(in srgb, var(--err) 16%, transparent);
  color: var(--err);
}

.dur-tag {
  color: var(--accent-strong);
  margin-left: 4px;
}

.err {
  color: var(--err);
  word-break: break-word;
  white-space: normal;
}

.notice {
  font-size: 11.5px;
  color: var(--err);
  background: color-mix(in srgb, var(--err) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--err) 32%, transparent);
  border-radius: var(--radius-sm);
  padding: 6px 9px;
  cursor: pointer;
  word-break: break-word;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.switch {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-md);
  background: var(--glass-bg);
}

.switch-title {
  font-size: 11px;
  color: var(--muted);
}

.switch-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.merge {
  font-size: 12px;
  color: var(--muted);
}

.ws {
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--glass-bg);
  padding: 10px 12px;
}

.ws h4 {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.3px;
}

.ws-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  padding: 4px 0;
}

.ws-row .kind {
  flex: none;
  color: var(--accent-strong);
  border: 1px solid var(--accent-line);
  border-radius: 5px;
  padding: 0 6px;
  font-size: 10px;
}

.ws-row .path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}

.ws-row .status.done {
  color: var(--ok);
}

.ws-row .status.active {
  color: var(--accent-strong);
}

.muted {
  color: var(--faint);
  font-size: 11.5px;
  margin: 0;
}

.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  padding: 24px;
}

.big {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--muted);
}

.sub {
  margin: 0;
  font-size: 12px;
  color: var(--faint);
}
</style>
