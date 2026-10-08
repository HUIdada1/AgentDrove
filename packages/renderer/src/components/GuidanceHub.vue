<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppStore } from '../stores/app'

const store = useAppStore()

// 徽章按探活健康计数, 不再拿启用数冒充在线数;
// probing 消费 store.agentsLoaded, 区分「探测中」与「未发现」两种空态
const enabledCount = computed(() => store.agents.value.filter((a) => a.enabled).length)
const healthyCount = computed(
  () => store.agents.value.filter((a) => a.enabled && a.health?.ok).length,
)
const probing = computed(() => !store.agentsLoaded.value)
const badgeDotClass = computed(() =>
  probing.value ? 'probe' : healthyCount.value === 0 ? 'bad' : 'live',
)
const badgeText = computed(() =>
  probing.value
    ? '正在探测客户端…'
    : `${healthyCount.value}/${enabledCount.value} 款客户端可用`,
)
const currentProjectName = computed(() => store.selectedProject.value?.name ?? '日常工作区')

// 0 可用客户端时的引导态——重新扫描走 agentsRescan + refreshAgents
const rescanning = ref(false)

async function rescanAgents(): Promise<void> {
  if (rescanning.value) return
  rescanning.value = true
  try {
    await window.api.agentsRescan()
    await store.refreshAgents()
  } catch (error) {
    store.showToast(`重新扫描失败:${error instanceof Error ? error.message : String(error)}`)
  } finally {
    rescanning.value = false
  }
}
</script>

<template>
  <div class="guidance-hub">
    <div class="hero">
      <div class="hero-badge">
        <span class="dot" :class={badgeDotClass} />
        <span>{{ badgeText }}</span>
      </div>
      <h2 class="hero-title">今天想让 Agent 协助完成什么？</h2>
      <p class="hero-sub">
        当前工作区：<span class="project-tag">{{ currentProjectName }}</span>。直接在下方输入框下达指令，或键入 <code>/</code> 呼出快捷指令。
      </p>
    </div>

    <!-- 0 可用且非探测中时, 呈现扫描引导态 -->
    <div v-if="healthyCount === 0 && !probing" class="empty-guide glass">
      <p class="empty-title">未发现可用客户端</p>
      <p class="empty-desc">请确认本机客户端已安装并登录，然后重新扫描；也可在设置中手动启用。</p>
      <div class="empty-actions">
        <button class="empty-btn" :disabled="rescanning" @click="rescanAgents">
          {{ rescanning ? '扫描中…' : '重新扫描' }}
        </button>
        <button class="empty-link" @click="store.view.value = 'settings'">打开设置</button>
      </div>
    </div>

    <div class="quick-tips">
      <div class="tip-item">
        <span class="tip-dot" />
        <span class="tip-text">输入框键入 <code>/</code> 可呼出 <code>/fix</code>、<code>/test</code>、<code>/refactor</code> 等常用快捷指令</span>
      </div>
      <div class="tip-item">
        <span class="tip-dot" />
        <span class="tip-text">Agent 正在执行时，继续输入并点击<strong>“追加排队”</strong>，多轮任务自动接力</span>
      </div>
      <div class="tip-item">
        <span class="tip-dot" />
        <span class="tip-text">任务执行中若需调整思路，点击会话右上角的<strong>“终止”</strong>即可安全中断</span>
      </div>
      <div class="tip-item">
        <span class="tip-dot" />
        <span class="tip-text">选中任务后按 <code>Alt</code> + <code>↑</code> / <code>↓</code> 可在其所属工作区内微调顺序（也可右键卡片选「调整位置」）</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guidance-hub {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 30px 24px;
  max-width: 860px;
  margin: auto 0;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  container-type: inline-size;
}

.hero {
  text-align: center;
  margin-bottom: 28px;
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

.hero-badge .dot.probe {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
  box-shadow: 0 0 8px var(--warn);
}

.hero-badge .dot.bad {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--err);
  box-shadow: 0 0 8px var(--err);
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

.hero-sub code {
  color: var(--accent-strong);
  background: var(--accent-dim);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--mono);
}

.project-tag {
  color: var(--accent);
  font-weight: 600;
}

.empty-guide {
  width: 100%;
  margin-bottom: 24px;
  padding: 28px 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--glass-bg);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.empty-desc {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
  max-width: 380px;
}

.empty-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 6px;
}

.empty-btn {
  padding: 6px 16px;
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-sm);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: filter var(--fast) var(--ease);
}

.empty-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.empty-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.empty-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--accent-strong);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.empty-link:hover {
  filter: brightness(1.15);
}

.quick-tips {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 600px;
  background: var(--glass-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 16px 20px;
}

.tip-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}

.tip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  margin-top: 7px;
  flex: none;
}

.tip-text code {
  color: var(--accent-strong);
  background: var(--accent-dim);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 11px;
}

.tip-text strong {
  color: var(--text);
}
</style>
