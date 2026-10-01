<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import type { AgentView } from '@agent-drove/shared'

const store = useAppStore()
const probing = ref(new Set<string>())
void onMounted(() => void store.refreshAgents())

function usageOf(agent: AgentView): number {
  return store.usage.value.find((u) => u.agentId === agent.id)?.taskCount ?? 0
}

async function toggleEnabled(agent: AgentView): Promise<void> {
  await window.api.agentsSetEnabled(agent.id, !agent.enabled)
  await store.refreshAgents()
}

async function recheck(agent: AgentView): Promise<void> {
  probing.value.add(agent.id)
  try {
    await window.api.healthCheck(agent.id, { bypassCache: true })
    await store.refreshAgents()
  } finally {
    probing.value.delete(agent.id)
  }
}

async function launch(agent: AgentView): Promise<void> {
  await window.api.launchApp(agent.id)
}

async function openSettings(): Promise<void> {
  await store.refreshSettings()
  store.view.value = 'settings'
}

function healthClass(agent: AgentView): string {
  if (!agent.health) return 'unknown'
  return agent.health.ok ? 'ok' : 'bad'
}
</script>

<template>
  <aside class="agents">
    <header class="head">
      <span class="brand">AgentDrove</span>
      <button class="ghost" title="设置" @click="openSettings">⚙ 设置</button>
    </header>

    <div v-for="agent in store.agents.value" :key="agent.id" class="agent">
      <div class="row1">
        <span class="logo" aria-hidden="true">{{ agent.label.slice(0, 1) }}</span>
        <span class="name">{{ agent.label }}</span>
        <span v-if="agent.version" class="ver">{{ agent.version }}</span>
        <span class="dot" :class="healthClass(agent)" :title="agent.health?.reason ?? '未探活'" />
      </div>
      <div class="row2">
        <span class="plan">{{ agent.plan.name }}</span>
        <span class="muted">未运行自动降级</span>
      </div>
      <div class="usage" :title="`${usageOf(agent)} / ${agent.plan.dailyTaskCap} 今日任务`">
        <div
          class="bar"
          :style="{ width: `${Math.min(100, (usageOf(agent) / Math.max(1, agent.plan.dailyTaskCap)) * 100)}%` }"
        />
      </div>
      <div class="row3">
        <span class="count">{{ usageOf(agent) }}/{{ agent.plan.dailyTaskCap }}</span>
        <span class="spacer" />
        <button class="ghost" :disabled="probing.has(agent.id)" @click="recheck(agent)">
          {{ probing.has(agent.id) ? '探活中' : '重查' }}
        </button>
        <button class="ghost" @click="launch(agent)">唤起</button>
        <button class="ghost" :class="{ off: !agent.enabled }" @click="toggleEnabled(agent)">
          {{ agent.enabled ? '停用' : '启用' }}
        </button>
      </div>
    </div>

    <div v-if="store.agents.value.length === 0" class="empty">
      未探测到可用客户端。确认 ZCode 已安装后重启应用。
    </div>

    <footer class="foot">
      <span class="paused-tip" v-if="store.settings.value?.schedulerPaused">调度已暂停(托盘可恢复)</span>
    </footer>
  </aside>
</template>

<style scoped>
.agents {
  background: var(--bg1);
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.brand {
  font-weight: 600;
  letter-spacing: 0.4px;
}

.agent {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg2);
  padding: 10px 12px;
  transition: border-color var(--fast);
}

.agent:hover {
  border-color: var(--line-strong);
}

.row1 {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--accent-dim);
  color: var(--accent);
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 600;
}

.name {
  font-weight: 600;
}

.ver {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.dot {
  margin-left: auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}

.dot.ok {
  background: var(--ok);
}

.dot.bad {
  background: var(--err);
}

.row2 {
  margin-top: 4px;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted);
}

.usage {
  margin-top: 8px;
  height: 4px;
  border-radius: 2px;
  background: rgba(148, 174, 196, 0.12);
  overflow: hidden;
}

.bar {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width var(--fast) ease-out;
}

.row3 {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 2px;
}

.count {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.spacer {
  flex: 1;
}

.off {
  color: var(--warn);
}

.empty {
  color: var(--muted);
  font-size: 12px;
  padding: 20px 8px;
  text-align: center;
}

.foot {
  margin-top: auto;
  min-height: 18px;
  font-size: 11px;
  color: var(--warn);
}
</style>
