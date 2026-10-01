<script setup lang="ts">
import { onMounted } from 'vue'
import { useAppStore, setTheme } from '../stores/app'
import GlassMeter from '../ui/GlassMeter.vue'
import Logo from './Logo.vue'
import type { AgentView } from '@agent-drove/shared'

const store = useAppStore()
void onMounted(() => void store.refreshAgents())

function usageOf(agent: AgentView): number {
  return store.usage.value.find((u) => u.agentId === agent.id)?.taskCount ?? 0
}

function pick(agent: AgentView): void {
  // 切换语义:选中同一客户端再点一次回到全部
  store.filter.value.agentId = store.filter.value.agentId === agent.id ? '' : agent.id
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

    <div class="agents">
      <button
        v-for="agent in store.agents.value"
        :key="agent.id"
        class="agent"
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

.agents {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}

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

.agent:hover {
  background: var(--glass-bg);
  border-color: var(--glass-edge);
}

.agent.picked {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}

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
