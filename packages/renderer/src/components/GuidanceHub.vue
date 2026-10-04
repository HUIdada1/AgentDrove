<script setup lang="ts">
import { computed } from 'vue'
import { SCENARIO_TEMPLATES, type ScenarioTemplate } from '@agent-drove/shared'
import { useAppStore } from '../stores/app'

const emit = defineEmits<{
  (e: 'selectScenario', scenario: ScenarioTemplate): void
}>()

const store = useAppStore()

const activeAgentsCount = computed(() => store.agents.value.filter((a) => a.enabled).length)
const currentProjectName = computed(() => store.selectedProject.value?.name ?? '日常工作区')
</script>

<template>
  <div class="guidance-hub">
    <div class="hero">
      <div class="hero-badge">
        <span class="dot live" />
        <span>多 Agent 协同调度已就绪 · {{ activeAgentsCount }} 款客户端在线</span>
      </div>
      <h2 class="hero-title">今天想让 Agent 协助完成什么？</h2>
      <p class="hero-sub">
        当前工作区：<span class="project-tag">{{ currentProjectName }}</span>。选择下方场景卡片快速启动，或直接在下方输入框下达指令。
      </p>
    </div>

    <div class="scenario-grid">
      <div
        v-for="item in SCENARIO_TEMPLATES"
        :key="item.id"
        class="scenario-card glass"
        @click="emit('selectScenario', item)"
      >
        <div class="card-top">
          <span class="icon">{{ item.icon }}</span>
          <span class="title">{{ item.title }}</span>
          <span class="mode-badge">{{ item.mode }}</span>
        </div>
        <p class="desc">{{ item.desc }}</p>
        <div class="card-footer">
          <span class="action">一键填入 ➔</span>
        </div>
      </div>
    </div>

    <div class="quick-tips">
      <div class="tip-item">
        <span class="tip-icon">💡</span>
        <span class="tip-text">输入框键入 <code>/</code> 可呼出 <code>/fix</code>、<code>/test</code>、<code>/refactor</code> 等常用指令</span>
      </div>
      <div class="tip-item">
        <span class="tip-icon">⏳</span>
        <span class="tip-text">Agent 正在执行时，仍可继续输入并点击<strong>“排队发送”</strong>，多轮任务自动接力</span>
      </div>
      <div class="tip-item">
        <span class="tip-icon">🛑</span>
        <span class="tip-text">任务执行中若需调整思路，随时点击右上角或输入框旁的<strong>“■ 终止”</strong>即可安全中断</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guidance-hub {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 30px 24px;
  max-width: 860px;
  margin: 0 auto;
  min-height: 0;
  overflow-y: auto;
}

.hero {
  text-align: center;
  margin-bottom: 24px;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 12px;
  border-radius: 999px;
  background: var(--chip-bg);
  border: 1px solid var(--line);
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 12px;
}

.hero-badge .dot.live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 8px var(--ok);
}

.hero-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 8px;
  letter-spacing: -0.3px;
}

.hero-sub {
  font-size: 13px;
  color: var(--muted);
  margin: 0;
}

.project-tag {
  color: var(--accent);
  font-weight: 600;
}

.scenario-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  width: 100%;
  margin-bottom: 24px;
}

@media (max-width: 760px) {
  .scenario-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.scenario-card {
  padding: 14px 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--glass-bg);
  cursor: pointer;
  transition: all var(--fast) var(--ease);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
}

.scenario-card:hover {
  transform: translateY(-2px);
  border-color: var(--accent-line);
  background: var(--glass-bg-strong);
  box-shadow: var(--card-shadow);
}

.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-top .icon {
  font-size: 16px;
}

.card-top .title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  flex: 1;
}

.mode-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--chip-bg);
  color: var(--faint);
  text-transform: uppercase;
}

.desc {
  font-size: 11px;
  color: var(--muted);
  margin: 0;
  line-height: 1.45;
}

.card-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

.action {
  font-size: 11px;
  color: var(--accent-strong);
  font-weight: 600;
  opacity: 0.85;
  transition: opacity var(--fast) var(--ease);
}

.scenario-card:hover .action {
  opacity: 1;
}

.quick-tips {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  border-radius: var(--radius-md);
  background: var(--field-bg);
  border: 1px solid var(--line);
}

.tip-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
}

.tip-icon {
  font-size: 13px;
  flex: none;
}

.tip-item code {
  background: var(--chip-bg);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--accent-strong);
  font-family: var(--mono);
}

.tip-item strong {
  color: var(--text);
}
</style>
