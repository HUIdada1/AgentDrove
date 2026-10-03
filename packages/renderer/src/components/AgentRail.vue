<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppStore, setTheme } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassMeter from '../ui/GlassMeter.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassModal from '../ui/GlassModal.vue'
import Logo from './Logo.vue'
import type { AgentView, Project } from '@agent-drove/shared'

const store = useAppStore()

/** 内置日常工作区 id 由主进程(app.ts)定义,渲染层只做语义判断 */
const DAILY_PROJECT_ID = 'daily'

const notice = ref('')
const renameTarget = ref<Project | null>(null)
const renameText = ref('')

/** 今日用量按 agent 建索引:模板里每个客户端要读两次,避免每次渲染全表扫描 */
const usageByAgent = computed(() => {
  const map = new Map<string, number>()
  for (const row of store.usage.value) map.set(row.agentId, row.taskCount)
  return map
})

function usageOf(agent: AgentView): number {
  return usageByAgent.value.get(agent.id) ?? 0
}

/** 统一收口 IPC 失败:避免未处理的 rejection 静默丢失,失败原因就地提示 */
async function run<T>(action: () => Promise<T>, prefix: string): Promise<T | undefined> {
  try {
    notice.value = ''
    return await action()
  } catch (error) {
    notice.value = `${prefix}:${error instanceof Error ? error.message : String(error)}`
    return undefined
  }
}

function pick(agent: AgentView): void {
  // 切换语义:选中同一客户端再点一次回到全部
  store.filter.value.agentId = store.filter.value.agentId === agent.id ? '' : agent.id
}

/** 选中同一工作区再点一次回到全部(null) */
function pickProject(project: Project): void {
  store.selectedProjectId.value = store.selectedProjectId.value === project.id ? null : project.id
}

async function addProject(): Promise<void> {
  const project = await run(() => window.api.projectsPickAndAdd(), '添加工作区失败')
  if (!project) return
  await run(() => store.refreshProjects(), '刷新工作区失败')
  store.selectedProjectId.value = project.id
}

/** 日常工作区:未绑定 → 选目录绑定;已绑定 → 解绑回默认目录 */
async function toggleDailyBind(project: Project): Promise<void> {
  const done = await run(async () => {
    if (project.path) {
      await window.api.projectsBindDaily(null)
    } else {
      const dir = await window.api.pickDirectory()
      if (!dir) return false
      await window.api.projectsBindDaily(dir)
    }
    return true
  }, '更新日常工作区失败')
  if (done) await run(() => store.refreshProjects(), '刷新工作区失败')
}

function startRename(project: Project): void {
  renameTarget.value = project
  renameText.value = project.name
}

async function commitRename(): Promise<void> {
  const target = renameTarget.value
  const name = renameText.value.trim()
  if (!target || !name) return
  // Electron 不支持 window.prompt,改名走 GlassModal 内联输入
  await run(async () => {
    await window.api.projectsRename(target.id, name)
    await store.refreshProjects()
  }, '重命名工作区失败')
  renameTarget.value = null
}

async function removeProject(project: Project): Promise<void> {
  if (!window.confirm(`移除工作区「${project.name}」?目录与历史任务保留,仅解除分组。`)) return
  if (store.selectedProjectId.value === project.id) store.selectedProjectId.value = null
  await run(async () => {
    await window.api.projectsRemove(project.id)
    await store.refreshProjects()
  }, '移除工作区失败')
}

function pathTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('\\')
}

function wsGlyph(project: Project): string {
  const first = project.name.trim().slice(0, 1)
  return project.id === DAILY_PROJECT_ID ? '⌂' : first || '·'
}

function wsTitle(project: Project): string {
  const bound = project.path ? `绑定:${project.path}` : '未绑定目录,派发落默认工作区'
  return `${project.name}(${bound})`
}

async function toggleEnabled(agent: AgentView): Promise<void> {
  await run(async () => {
    await window.api.agentsSetEnabled(agent.id, !agent.enabled)
    await store.refreshAgents()
  }, '切换客户端状态失败')
}

async function recheck(agent: AgentView): Promise<void> {
  await run(async () => {
    await window.api.healthCheck(agent.id, { bypassCache: true })
    await store.refreshAgents()
  }, '探活失败')
}

async function launch(agent: AgentView): Promise<void> {
  await run(() => window.api.launchApp(agent.id), '唤起客户端失败')
}

async function openSettings(): Promise<void> {
  await run(() => store.refreshSettings(), '读取设置失败')
  store.view.value = 'settings'
}

function cycleTheme(): void {
  const current = store.settings.value?.ui.theme ?? 'auto'
  void run(
    () => setTheme(current === 'dark' ? 'light' : current === 'light' ? 'auto' : 'dark'),
    '切换主题失败',
  )
}

function themeLabel(): string {
  const current = store.settings.value?.ui.theme ?? 'auto'
  return current === 'dark' ? '暗' : current === 'light' ? '亮' : '随'
}

function healthClass(agent: AgentView): string {
  if (!agent.health) return 'unknown'
  return agent.health.ok ? 'ok' : 'bad'
}
</script>

<template>
  <aside class="rail glass" :class="{ collapsed: store.railCollapsed.value }">
    <div class="brand-row">
      <Logo :size="24" />
      <GlassButton
        variant="ghost"
        size="sm"
        class="fold"
        :title="store.railCollapsed.value ? '展开侧栏' : '收起侧栏'"
        @click="store.railCollapsed.value = !store.railCollapsed.value"
      >
        {{ store.railCollapsed.value ? '»' : '«' }}
      </GlassButton>
    </div>

    <div class="scroll">
      <div v-if="notice" class="notice" @click="notice = ''">{{ notice }}</div>
      <div class="section-title" v-if="!store.railCollapsed.value">
        <span>工作区</span>
        <GlassButton variant="plain" size="sm" title="选择文件夹登记为项目工作区" @click="addProject">
          ＋ 添加
        </GlassButton>
      </div>
      <div class="workspaces" :class="{ 'has-title': !store.railCollapsed.value }">
        <div
          v-for="project in store.projects.value"
          :key="project.id"
          class="ws spot"
          role="button"
          tabindex="0"
          :class="{ picked: store.selectedProjectId.value === project.id }"
          :title="wsTitle(project)"
          @click="pickProject(project)"
          @keydown.enter="pickProject(project)"
          @keydown.space.prevent="pickProject(project)"
        >
          <span class="glyph ws" aria-hidden="true">{{ wsGlyph(project) }}</span>
          <span v-if="!store.railCollapsed.value" class="meta">
            <span class="line1">
              <span class="name">{{ project.name }}</span>
            </span>
            <span class="plan" :class="{ unbound: !project.path }">
              {{ project.path ? pathTail(project.path) : '未绑定 · 默认目录' }}
            </span>
            <span class="ops">
              <GlassButton
                v-if="project.id === DAILY_PROJECT_ID"
                variant="ghost"
                size="sm"
                :title="project.path ? '解绑目录,回到默认工作区' : '选择文件夹绑定'"
                @click.stop="toggleDailyBind(project)"
              >
                {{ project.path ? '解绑' : '选目录' }}
              </GlassButton>
              <template v-if="project.id !== DAILY_PROJECT_ID">
                <GlassButton variant="ghost" size="sm" title="重命名" @click.stop="startRename(project)">改名</GlassButton>
                <GlassButton variant="ghost" size="sm" title="移除分组(保留目录)" @click.stop="removeProject(project)">移除</GlassButton>
              </template>
            </span>
          </span>
        </div>
        <GlassButton
          v-if="store.railCollapsed.value"
          variant="plain"
          size="sm"
          class="add-collapsed"
          title="添加项目工作区"
          @click="addProject"
        >
          ＋
        </GlassButton>
      </div>

      <div class="section-title" v-if="!store.railCollapsed.value">
        <span>客户端</span>
      </div>
      <div class="agents">
        <div
          v-for="agent in store.agents.value"
          :key="agent.id"
          class="agent spot"
          role="button"
          tabindex="0"
          :class="{ picked: store.filter.value.agentId === agent.id }"
          :title="`${agent.label}${agent.version ? ' ' + agent.version : ''}`"
          @click="pick(agent)"
          @keydown.enter="pick(agent)"
          @keydown.space.prevent="pick(agent)"
        >
          <span class="glyph" aria-hidden="true">{{ agent.label.slice(0, 1) }}</span>
          <span v-if="!store.railCollapsed.value" class="meta">
            <span class="line1">
              <span class="name">{{ agent.label }}</span>
              <span class="dot" :class="healthClass(agent)" :title="agent.health?.reason ?? '未探活'" />
            </span>
            <span class="plan">{{ agent.plan.name }}</span>
            <GlassMeter :value="usageOf(agent)" :max="agent.plan.dailyTaskCap" />
            <span class="count num">{{ usageOf(agent) }}/{{ agent.plan.dailyTaskCap }}</span>
            <span class="ops">
              <GlassButton variant="ghost" size="sm" title="探活(绕过缓存)" @click.stop="recheck(agent)">重查</GlassButton>
              <GlassButton variant="ghost" size="sm" title="唤起客户端" @click.stop="launch(agent)">唤起</GlassButton>
              <GlassButton variant="ghost" size="sm" :class="{ warn: !agent.enabled }" @click.stop="toggleEnabled(agent)">
                {{ agent.enabled ? '停用' : '启用' }}
              </GlassButton>
            </span>
          </span>
        </div>
      </div>
    </div>

    <div class="bottom">
      <GlassButton variant="ghost" size="sm" class="btm" :title="`主题:${themeLabel()}(点击切换)`" @click="cycleTheme">
        {{ store.railCollapsed.value ? themeLabel() : `主题:${themeLabel()}` }}
      </GlassButton>
      <GlassButton variant="ghost" size="sm" class="btm" title="设置" @click="openSettings">
        {{ store.railCollapsed.value ? '⚙' : '⚙ 设置' }}
      </GlassButton>
      <span v-if="store.settings.value?.schedulerPaused && !store.railCollapsed.value" class="paused">
        调度已暂停
      </span>
    </div>
  </aside>

  <GlassModal v-if="renameTarget" open title="重命名工作区" width="420px" @close="renameTarget = null">
    <label class="rename">
      <span>名称</span>
      <GlassInput
        v-model="renameText"
        placeholder="工作区名称"
        @keydown.enter.exact.prevent="commitRename"
      />
    </label>
    <template #footer>
      <span class="spacer" />
      <GlassButton variant="ghost" @click="renameTarget = null">取消</GlassButton>
      <GlassButton variant="primary" :disabled="!renameText.trim()" @click="commitRename">保存</GlassButton>
    </template>
  </GlassModal>
</template>

<style scoped>
.rail {
  width: 236px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  transition: width 180ms var(--ease);
}

.rail.collapsed {
  width: 64px;
}

.brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px 6px;
}

/* 折叠钮在 64px 窄栏里比 GlassButton sm 默认更紧凑(加元素选择器压过 .g-btn.sm) */
.brand-row button.fold {
  font-size: 14px;
  padding: 2px 6px;
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--faint);
  letter-spacing: 0.08em;
  padding: 2px 2px 0;
}

/* 操作失败就地提示:点击可关闭,不阻塞其它操作 */
.notice {
  font-size: 11px;
  color: var(--err);
  background: color-mix(in srgb, var(--err) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--err) 32%, transparent);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  cursor: pointer;
  word-break: break-word;
}

.rename {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}

.rename .spacer {
  flex: 1;
}

.workspaces,
.agents {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.workspaces {
  flex: none;
}

.agents {
  flex: 1;
  min-height: 60px;
}

.ws,
.agent {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition: background var(--fast) var(--ease), border-color var(--fast) var(--ease);
}

.ws:focus-visible,
.agent:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: -2px;
}

.ws:hover,
.agent:hover {
  background: var(--glass-bg);
  border-color: var(--glass-edge);
}

.ws.picked,
.agent.picked {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}

.rail.collapsed .ws,
.rail.collapsed .agent {
  justify-content: center;
  padding: 9px 6px;
}

.glyph {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-weight: 600;
  font-size: 13px;
  color: var(--accent-strong);
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
  box-shadow: inset 0 1px 0 var(--glass-specular);
}

/* 折叠态加号:虚线边保留"添加"语义,其余质感来自 GlassButton plain */
.workspaces button.add-collapsed {
  width: 100%;
  border-style: dashed;
  color: var(--muted);
}

.workspaces button.add-collapsed:hover {
  color: var(--accent-strong);
  border-color: var(--accent-line);
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.line1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.name {
  font-weight: 600;
  font-size: 12.5px;
}

.dot {
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

.plan {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plan.unbound {
  color: var(--faint);
}

.count {
  font-size: 11px;
  color: var(--muted);
}

.ops {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

/* 停用/启用按钮:客户端停用时文字给警示色(覆盖 GlassButton ghost 的 muted) */
.ops :deep(button.warn) {
  color: var(--warn);
}

.bottom {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}

.rail.collapsed .bottom .btm {
  width: 100%;
}

.paused {
  font-size: 11px;
  color: var(--warn);
  text-align: center;
}
</style>
