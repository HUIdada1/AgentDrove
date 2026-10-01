<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import Timeline from './Timeline.vue'
import type { TaskRecord, WorkspaceRow } from '@agent-drove/shared'

const store = useAppStore()
const task = ref<TaskRecord | null>(null)
const continueText = ref('')
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

// 轮询兜底状态迁移推送丢失,切换面板时释放
const timer = setInterval(async () => {
  if (!store.selectedTaskId.value) return
  const fresh = await window.api.tasksGet(store.selectedTaskId.value)
  if (fresh && fresh.state !== task.value?.state) {
    task.value = fresh
    await store.refreshAgents()
  }
}, 800)
onUnmounted(() => clearInterval(timer))

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

async function continueConversation(): Promise<void> {
  if (!task.value || !continueText.value.trim()) return
  const next = await window.api.tasksContinue(task.value.id, continueText.value.trim())
  continueText.value = ''
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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
</script>

<template>
  <aside class="detail">
    <template v-if="task">
      <header class="head">
        <span class="title">任务详情</span>
        <span class="id" :title="task.id">{{ task.id.slice(0, 8) }}</span>
      </header>

      <dl class="meta">
        <div><dt>客户端</dt><dd>{{ agentLabel }}</dd></div>
        <div><dt>模型</dt><dd>{{ task.modelId === 'client-follow' ? '跟随客户端' : task.modelId }}</dd></div>
        <div><dt>档位</dt><dd>{{ task.mode }}</dd></div>
        <div><dt>状态</dt><dd>{{ task.state }}</dd></div>
        <div><dt>创建</dt><dd>{{ fmt(task.createdAt) }}</dd></div>
        <div><dt>结束</dt><dd>{{ fmt(task.finishedAt) }}</dd></div>
        <div class="wide"><dt>工作区</dt><dd class="mono" :title="task.cwd">{{ task.cwd }}</dd></div>
        <div v-if="task.sessionId" class="wide"><dt>会话</dt><dd class="mono">{{ task.sessionId }}</dd></div>
        <div v-if="task.error" class="wide"><dt>错误</dt><dd class="err">{{ task.error }}</dd></div>
      </dl>

      <div class="actions">
        <button v-if="task.state === 'running'" @click="cancel">取消</button>
        <button v-if="task.state !== 'running'" @click="retry">重试</button>
        <button v-if="otherAgents.length > 0 && task.state !== 'running'" @click="switching = !switching">
          换客户端
        </button>
        <button v-if="task.state === 'interrupted'" class="danger" @click="markFailed">标记为失败</button>
        <button @click="openClient">打开客户端</button>
        <button @click="openWorkspace">打开工作区</button>
        <button v-if="taskWorkspaces[0]" @click="mergeArtifacts">合并产物</button>
        <button v-if="taskWorkspaces[0]" @click="cleanWorkspace">立即清理</button>
      </div>

      <div v-if="switching" class="switch">
        <button v-for="a in otherAgents" :key="a.id" @click="resubmitOn(a.id)">
          派发给 {{ a.label }}({{ a.defaultModel === 'client-follow' ? '跟随客户端' : a.defaultModel }})
        </button>
      </div>

      <div v-if="mergeResult" class="merge">
        <div v-if="mergeResult.merged.length">已合并 {{ mergeResult.merged.length }} 个文件</div>
        <div v-if="mergeResult.conflicts.length" class="err">
          冲突跳过 {{ mergeResult.conflicts.length }}:{{ mergeResult.conflicts.slice(0, 5).join(', ') }}
        </div>
        <div v-if="!mergeResult.merged.length && !mergeResult.conflicts.length">没有可合并的变更</div>
      </div>

      <div class="continue">
        <textarea
          v-model="continueText"
          rows="2"
          placeholder="继续对话:追加提示词,派生新任务(会话失效时留空会按新会话派发)"
          @keydown.enter.exact.prevent="continueConversation"
        />
      </div>

      <Timeline :task-id="task.id" />
    </template>
    <div v-else class="placeholder">选中左侧任务查看详情与时间线</div>
  </aside>
</template>

<style scoped>
.detail {
  background: var(--bg1);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title {
  font-weight: 600;
}

.id {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.meta {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg2);
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
  border-radius: var(--radius);
}

.merge {
  font-size: 12px;
  color: var(--muted);
}

.continue textarea {
  width: 100%;
  background: var(--bg2);
}

.placeholder {
  color: var(--muted);
  margin-top: 40px;
  text-align: center;
}
</style>
