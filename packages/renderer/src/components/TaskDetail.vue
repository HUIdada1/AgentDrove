<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import type { TaskRecord, WorkspaceRow } from '@agent-drove/shared'

/** 右栏:元信息 + 操作区 + 工作区/产物管理;会话流已移至中栏 */
const store = useAppStore()
const task = ref<TaskRecord | null>(null)
const switching = ref(false)
const mergeResult = ref<{ merged: string[]; conflicts: string[] } | null>(null)

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

watch(
  () => store.selectedTaskId.value,
  async (id) => {
    task.value = id ? await window.api.tasksGet(id) : null
    mergeResult.value = null
    await store.refreshWorkspaces()
  },
  { immediate: true },
)

const poll = setInterval(async () => {
  if (!store.selectedTaskId.value) return
  const fresh = await window.api.tasksGet(store.selectedTaskId.value)
  if (fresh && fresh.state !== task.value?.state) {
    task.value = fresh
    await store.refreshAgents()
  }
}, 800)
onUnmounted(() => clearInterval(poll))

async function cancel(): Promise<void> {
  if (!task.value) return
  await window.api.tasksCancel(task.value.id)
  await store.refreshTasks()
  task.value = await window.api.tasksGet(task.value.id)
}

async function retry(): Promise<void> {
  if (!task.value) return
  if (store.settings.value?.task.confirmRetry && !window.confirm('重试会再次消耗套餐额度,继续?')) return
  const next = await window.api.tasksRetry(task.value.id)
  await store.refreshTasks()
  store.selectedTaskId.value = next.id
}

async function resubmitOn(target: string): Promise<void> {
  if (!task.value) return
  const next = await window.api.tasksResubmitOn(task.value.id, target)
  switching.value = false
  await store.refreshTasks()
  store.selectedTaskId.value = next.id
}

async function markFailed(): Promise<void> {
  if (!task.value) return
  await window.api.tasksMarkFailed(task.value.id)
  await store.refreshTasks()
  task.value = await window.api.tasksGet(task.value.id)
}

async function openClient(): Promise<void> {
  if (task.value) await window.api.launchApp(task.value.agentId)
}

async function openWorkspace(): Promise<void> {
  if (task.value) await window.api.openPath(task.value.cwd)
}

async function mergeArtifacts(): Promise<void> {
  const row = taskWorkspaces.value[0]
  if (!row) return
  mergeResult.value = await window.api.workspacesMerge(row.id)
}

async function cleanWorkspace(): Promise<void> {
  const row = taskWorkspaces.value[0]
  if (!row) return
  await window.api.workspacesClean(row.id)
  await store.refreshWorkspaces()
}

function fmt(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const STATE_TEXT: Record<string, string> = {
  queued: '排队',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  interrupted: '已中断',
}
</script>

<template>
  <aside class="detail glass">
    <template v-if="task">
      <header class="head">
        <span class="title">详情</span>
        <span class="id num" :title="task.id">{{ task.id.slice(0, 8) }}</span>
      </header>

      <dl class="meta">
        <div><dt>客户端</dt><dd>{{ agentLabel }}</dd></div>
        <div><dt>状态</dt><dd>{{ STATE_TEXT[task.state] }}</dd></div>
        <div><dt>模型</dt><dd>{{ task.modelId === 'client-follow' ? '跟随客户端' : task.modelId }}</dd></div>
        <div><dt>档位</dt><dd>{{ task.mode }}</dd></div>
        <div><dt>创建</dt><dd class="num">{{ fmt(task.createdAt) }}</dd></div>
        <div><dt>结束</dt><dd class="num">{{ fmt(task.finishedAt) }}</dd></div>
        <div class="wide"><dt>工作区</dt><dd class="mono" :title="task.cwd">{{ task.cwd }}</dd></div>
        <div v-if="task.sessionId" class="wide"><dt>会话</dt><dd class="mono">{{ task.sessionId }}</dd></div>
        <div v-if="task.error" class="wide"><dt>错误</dt><dd class="err">{{ task.error }}</dd></div>
      </dl>

      <div class="actions">
        <GlassButton v-if="task.state === 'running'" @click="cancel">取消</GlassButton>
        <GlassButton v-if="task.state !== 'running'" @click="retry">重试</GlassButton>
        <GlassButton v-if="otherAgents.length > 0 && task.state !== 'running'" @click="switching = !switching">
          换客户端
        </GlassButton>
        <GlassButton v-if="task.state === 'interrupted'" variant="danger" @click="markFailed">
          标记失败
        </GlassButton>
        <GlassButton @click="openClient">打开客户端</GlassButton>
        <GlassButton @click="openWorkspace">打开工作区</GlassButton>
        <GlassButton v-if="taskWorkspaces[0]" @click="mergeArtifacts">合并产物</GlassButton>
        <GlassButton v-if="taskWorkspaces[0]" @click="cleanWorkspace">立即清理</GlassButton>
      </div>

      <div v-if="switching" class="switch">
        <GlassButton v-for="a in otherAgents" :key="a.id" size="sm" @click="resubmitOn(a.id)">
          派发给 {{ a.label }}
        </GlassButton>
      </div>

      <div v-if="mergeResult" class="merge">
        <div v-if="mergeResult.merged.length">已合并 {{ mergeResult.merged.length }} 个文件</div>
        <div v-if="mergeResult.conflicts.length" class="err">
          冲突跳过 {{ mergeResult.conflicts.length }}:{{ mergeResult.conflicts.slice(0, 5).join(', ') }}
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
  </aside>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  height: 100%;
  padding: 12px 14px;
  overflow-y: auto;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title {
  font-weight: 600;
  letter-spacing: 0.5px;
}

.id {
  font-size: 11px;
  color: var(--faint);
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

.meta .wide {
  grid-column: 1 / -1;
}

.meta dt {
  font-size: 11px;
  color: var(--muted);
}

.meta dd {
  margin: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: var(--mono);
  font-size: 11.5px;
}

.err {
  color: var(--err);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.switch {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-md);
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
  margin-top: auto;
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
  padding: 3px 0;
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
  padding: 0 24px;
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
