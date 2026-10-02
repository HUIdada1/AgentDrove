<script setup lang="ts">
import { onMounted } from 'vue'
import { useAppStore, setTheme } from '../stores/app'
import GlassMeter from '../ui/GlassMeter.vue'
import Logo from './Logo.vue'
import type { AgentView, Project } from '@agent-drove/shared'

const store = useAppStore()
void onMounted(() => void store.refreshAgents())

function usageOf(agent: AgentView): number {
  return store.usage.value.find((u) => u.agentId === agent.id)?.taskCount ?? 0
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
  const project = await window.api.projectsPickAndAdd()
  if (!project) return
  await store.refreshProjects()
  store.selectedProjectId.value = project.id
}

/** 日常工作区:未绑定 → 选目录绑定;已绑定 → 解绑回默认目录 */
async function toggleDailyBind(project: Project): Promise<void> {
  if (project.path) {
    await window.api.projectsBindDaily(null)
  } else {
    const dir = await window.api.pickDirectory()
    if (!dir) return
    await window.api.projectsBindDaily(dir)
  }
  await store.refreshProjects()
}

async function renameProject(project: Project): Promise<void> {
  const name = window.prompt('重命名工作区', project.name)?.trim()
  if (!name) return
  await window.api.projectsRename(project.id, name)
  await store.refreshProjects()
}

async function removeProject(project: Project): Promise<void> {
  if (!window.confirm(`移除工作区「${project.name}」?目录与历史任务保留,仅解除分组。`)) return
  if (store.selectedProjectId.value === project.id) store.selectedProjectId.value = null
  await window.api.projectsRemove(project.id)
  await store.refreshProjects()
}

function pathTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('\\')
}

function wsGlyph(project: Project): string {
  return project.id === 'daily' ? '⌂' : project.name.slice(0, 1)
}

function wsTitle(project: Project): string {
  const bound = project.path ? `绑定:${project.path}` : '未绑定目录,派发落默认工作区'
  return `${project.name}(${bound})`
}

async function toggleEnabled(agent: AgentView): Promise<void> {
  await window.api.agentsSetEnabled(agent.id, !agent.enabled)
  await store.refreshAgents()
}

async function recheck(agent: AgentView): Promise<void> {
  await window.api.healthCheck(agent.id, { bypassCache: true })
  await store.refreshAgents()
}

async function launch(agent: AgentView): Promise<void> {
  await window.api.launchApp(agent.id)
}

async function openSettings(): Promise<void> {
  await store.refreshSettings()
  store.view.value = 'settings'
}

function cycleTheme(): void {
  const current = store.settings.value?.ui.theme ?? 'auto'
  void setTheme(current === 'dark' ? 'light' : current === 'light' ? 'auto' : 'dark')
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
      <button class="fold ghost" :title="store.railCollapsed.value ? '展开侧栏' : '收起侧栏'" @click="store.railCollapsed.value = !store.railCollapsed.value">
        {{ store.railCollapsed.value ? '»' : '«' }}
      </button>
    </div>

    <div class="scroll">
      <div class="section-title" v-if="!store.railCollapsed.value">
        <span>工作区</span>
        <button class="mini" title="选择文件夹登记为项目工作区" @click="addProject">＋ 添加</button>
      </div>
      <div class="workspaces" :class="{ 'has-title': !store.railCollapsed.value }">
        <button
          v-for="project in store.projects.value"
          :key="project.id"
          class="ws spot"
          :class="{ picked: store.selectedProjectId.value === project.id }"
          :title="wsTitle(project)"
          @click="pickProject(project)"
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
              <button
                v-if="project.id === 'daily'"
                class="mini"
                :title="project.path ? '解绑目录,回到默认工作区' : '选择文件夹绑定'"
                @click.stop="toggleDailyBind(project)"
              >
                {{ project.path ? '解绑' : '选目录' }}
              </button>
              <template v-if="project.id !== 'daily'">
                <button class="mini" title="重命名" @click.stop="renameProject(project)">改名</button>
                <button class="mini" title="移除分组(保留目录)" @click.stop="removeProject(project)">移除</button>
              </template>
            </span>
          </span>
        </button>
        <button
          v-if="store.railCollapsed.value"
          class="ws add-collapsed"
          title="添加项目工作区"
          @click="addProject"
        >
          ＋
        </button>
      </div>

      <div class="section-title" v-if="!store.railCollapsed.value">
        <span>客户端</span>
      </div>
      <div class="agents">
        <button
          v-for="agent in store.agents.value"
          :key="agent.id"
          class="agent spot"
          :class="{ picked: store.filter.value.agentId === agent.id }"
          :title="`${agent.label}${agent.version ? ' ' + agent.version : ''}`"
          @click="pick(agent)"
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
              <button class="mini" title="探活(绕过缓存)" @click.stop="recheck(agent)">重查</button>
              <button class="mini" title="唤起客户端" @click.stop="launch(agent)">唤起</button>
              <button class="mini" :class="{ warn: !agent.enabled }" @click.stop="toggleEnabled(agent)">
                {{ agent.enabled ? '停用' : '启用' }}
              </button>
            </span>
          </span>
        </button>
      </div>
    </div>

    <div class="bottom">
      <button class="mini" :title="`主题:${themeLabel()}(点击切换)`" @click="cycleTheme">
        {{ store.railCollapsed.value ? themeLabel() : `主题:${themeLabel()}` }}
      </button>
      <button class="mini" title="设置" @click="openSettings">
        {{ store.railCollapsed.value ? '⚙' : '⚙ 设置' }}
      </button>
      <span v-if="store.settings.value?.schedulerPaused && !store.railCollapsed.value" class="paused">
        调度已暂停
      </span>
    </div>
  </aside>
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

.fold {
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}

.fold:hover {
  color: var(--text);
  background: var(--glass-bg);
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
  cursor: pointer;
  text-align: left;
  transition: background var(--fast) var(--ease), border-color var(--fast) var(--ease);
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

.add-collapsed {
  border: 1px dashed var(--line);
  border-radius: var(--radius-md);
  color: var(--muted);
  font-size: 14px;
  padding: 7px 0;
  background: transparent;
  cursor: pointer;
}

.add-collapsed:hover {
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

.mini {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--glass-bg);
  color: var(--muted);
  cursor: pointer;
  transition: color var(--fast) var(--ease), border-color var(--fast) var(--ease);
}

.mini:hover {
  color: var(--text);
  border-color: var(--line-strong);
}

.mini.warn {
  color: var(--warn);
}

.bottom {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}

.rail.collapsed .bottom .mini {
  width: 100%;
  text-align: center;
}

.paused {
  font-size: 11px;
  color: var(--warn);
  text-align: center;
}
</style>
