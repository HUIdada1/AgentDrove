<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAppStore, setTheme } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassMeter from '../ui/GlassMeter.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassModal from '../ui/GlassModal.vue'
import Logo from './Logo.vue'
import { formatQuotaNumber, formatTokens, formatAgentQuotaDisplay } from '../labels'
import type { AgentView, Project } from '@agent-drove/shared'

const store = useAppStore()

/** 内置日常工作区 id 由主进程(app.ts)定义,渲染层只做语义判断 */
const DAILY_PROJECT_ID = 'daily'

const notice = ref('')
const renameTarget = ref<Project | null>(null)
const renameText = ref('')
/** G1-08:移除工作区的应用内确认层目标;null=未打开 */
const removeTarget = ref<Project | null>(null)
/** 客户端空态「重新扫描」进行中标记(R05) */
const rescanning = ref(false)

/** 工作区顶部切换胶囊弹层状态 */
const showWsDropdown = ref(false)
const railRef = ref<HTMLElement | null>(null)

function onGlobalClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  if (!target.closest('.workspace-bar')) {
    showWsDropdown.value = false
  }
}

onMounted(() => window.addEventListener('click', onGlobalClick))
onBeforeUnmount(() => window.removeEventListener('click', onGlobalClick))

/** 任务卡拖到工作区项上的悬停高亮(P0-2) */
const dragOverProjectId = ref('')

/** 今日用量按 agent 建索引:模板里每个客户端要读两次,避免每次渲染全表扫描 */
const usageByAgent = computed(() => {
  const map = new Map<string, number>()
  for (const row of store.usage.value) map.set(row.agentId, row.taskCount)
  return map
})

function usageOf(agent: AgentView): number {
  return usageByAgent.value.get(agent.id) ?? agent.usedToday ?? 0
}

function quotaInfo(agent: AgentView) {
  return formatAgentQuotaDisplay({
    plan: agent.plan,
    remainingCredits: agent.remainingCredits,
    remainingTokens: agent.remainingTokens,
    remainingPercent: agent.remainingPercent,
    usedCreditsToday: agent.usedCreditsToday,
    usedTokensToday: agent.usedTokensToday,
    usedToday: usageOf(agent),
    isOverridden: agent.isOverridden,
  })
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
  if (!pickable(agent)) {
    store.showToast(agentPickTitle(agent))
    return
  }
  store.selectAgentContext(agent.id)
}

/** 「全部对话」:显式清除会话绑定(G1-01:任务列筛选与绑定解耦,不再连带清除) */
function clearAgentContext(): void {
  store.agentContext.value = ''
}

/** 可对话判定(R05):停用/非 headless 客户端置灰禁点 */
function pickable(agent: AgentView): boolean {
  return agent.enabled && agent.capabilities.headless !== false
}

/** 卡片 title(R05):不可对话时说明原因,可对话时展示额度详情 */
function agentPickTitle(agent: AgentView): string {
  if (!agent.enabled) return '已停用,启用后可对话'
  if (!agent.capabilities.headless) return '该客户端不支持对话'
  return agentDetailTitle(agent)
}

async function rescanAgents(): Promise<void> {
  // R05:客户端区空态 CTA,与设置页同通道(agents:rescan + refreshAgents)
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

/** 选中同一工作区再点一次回到全部(null) */
function pickProject(project: Project): void {
  store.selectedProjectId.value = store.selectedProjectId.value === project.id ? null : project.id
}

// ---- 任务卡拖入工作区(P0-2) ----
function onWsDragOver(project: Project, event: DragEvent): void {
  if (!store.draggingTaskId.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverProjectId.value = project.id
}

function onWsDragLeave(project: Project, event: DragEvent): void {
  // 相关目标仍在本项内(子元素间移动)时保持高亮,避免闪烁
  const to = event.relatedTarget as Node | null
  if (to && (event.currentTarget as HTMLElement).contains(to)) return
  if (dragOverProjectId.value === project.id) dragOverProjectId.value = ''
}

async function onWsDrop(project: Project, event: DragEvent): Promise<void> {
  event.preventDefault()
  if (dragOverProjectId.value === project.id) dragOverProjectId.value = ''
  const taskId = store.draggingTaskId.value
  if (!taskId) return
  store.draggingTaskId.value = null
  const task = store.tasks.value.find((t) => t.id === taskId)
  if (!task || task.projectId === project.id) return
  await store.moveTask(taskId, project.id)
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

/** G1-08:移除工作区改走应用内 GlassModal 确认层,与重命名工作区同口径,不再弹原生 confirm */
function removeProject(project: Project): void {
  removeTarget.value = project
}

async function confirmRemoveProject(): Promise<void> {
  const target = removeTarget.value
  if (!target) return
  if (store.selectedProjectId.value === target.id) store.selectedProjectId.value = null
  await run(async () => {
    await window.api.projectsRemove(target.id)
    await store.refreshProjects()
  }, '移除工作区失败')
  removeTarget.value = null
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
  // G1-02:停用当前对话客户端时同步清空 agentContext 并 toast,消除
  // 侧栏高亮/空态横幅仍指向旧客户端、发布框却已回落的 三处矛盾;启用分支无需处理
  const wasContext = store.agentContext.value === agent.id
  const disabling = agent.enabled
  const done = await run(async () => {
    await window.api.agentsSetEnabled(agent.id, !agent.enabled)
    await store.refreshAgents()
    return true
  }, '切换客户端状态失败')
  if (!done || !disabling || !wasContext) return
  store.agentContext.value = ''
  store.showToast(`${agent.label} 已停用,发布框将回落到可用客户端`)
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

function hasRunningTask(agentId: string): boolean {
  return store.tasks.value.some((t) => t.agentId === agentId && t.state === 'running')
}


/**
 * R04:余量百分比,与余量文字同源同量纲。
 * 返回 undefined = 未知态(未配置总量且无每日上限),不再虚构满格。
 */
function quotaPct(agent: AgentView): number | undefined {
  if (agent.remainingPercent !== undefined && Number.isFinite(agent.remainingPercent)) {
    return Math.max(0, Math.min(100, Math.round(agent.remainingPercent)))
  }
  if (agent.plan.dailyTaskCap > 0) {
    return Math.max(0, Math.round(((agent.plan.dailyTaskCap - usageOf(agent)) / agent.plan.dailyTaskCap) * 100))
  }
  return undefined
}

/** R04:余量阈值配色——>50% 绿 / 20%~50% 橙 / ≤20% 深橙 / 0 红 */
function quotaColor(pct: number): string {
  if (pct <= 0) return 'var(--err)'
  if (pct <= 20) return '#ea580c'
  if (pct <= 50) return 'var(--warn)'
  return 'var(--ok)'
}

/** G1-06:客户端本地图标路径 → file:// URL(项目未注册自定义资源协议,生产以 file:// 加载、
 * CSP img-src 'self' 放行 file: 图片,dev 模式 CSP 被剥离;仅 logoPath 存在时调用,
 * 无 logo 客户端回落首字母,当前各驱动尚未上报 logoPath,默认渲染与现状一致) */
function logoUrl(agent: AgentView): string {
  const p = (agent.logoPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  return encodeURI(`file:///${p}`)
}

/** G1-06:轻量额度刷新——只走 usage:get,不触发探活;失败经 run 就地提示 */
async function refreshUsage(): Promise<void> {
  await run(() => store.refreshUsage(), '刷新额度失败')
}

/**
 * R04:余量文字与进度条同源同量纲——估算值前缀「约」,未配置额度显示「未设置额度」,
 * credits 取不到数据显示「—」(删除原 217 行的次数兜底,不再出现「余 0/0 次」假象)。
 */
function quotaRemainingText(agent: AgentView): string {
  const cap = agent.plan.dailyTaskCap
  const used = usageOf(agent)
  if (agent.plan.quotaKind === 'credits') {
    // totalCredits 为套餐总量估算口径,剩余值统一前缀「约」
    if (agent.remainingCredits !== undefined) {
      return `余约 ${formatQuotaNumber(agent.remainingCredits)} 点`
    }
    if (agent.usedCreditsToday !== undefined) {
      return `今日约 ${formatQuotaNumber(agent.usedCreditsToday)} 点`
    }
    return '—'
  }
  if (agent.plan.quotaKind === 'daily') {
    if (cap > 0) return `余 ${Math.max(0, cap - used)}/${cap} 次`
    return '未设置额度'
  }
  // subscription 订阅制:剩余/消耗 Token 均为本应用统计估算;全部缺位 = 未设置额度
  if (agent.remainingTokens !== undefined) {
    return `余约 ${formatTokens(agent.remainingTokens)} tok`
  }
  if (agent.usedTokensToday) {
    return `今日约 ${formatTokens(agent.usedTokensToday)} tok`
  }
  if (cap > 0) return `余 ${Math.max(0, cap - used)}/${cap} 次`
  return '未设置额度'
}

/** R04:余量行文案——余量为 0 时以「额度已用尽」警示替代数值 */
function quotaStatusText(agent: AgentView): string {
  if (quotaPct(agent) === 0) return '额度已用尽'
  return quotaRemainingText(agent)
}

/** R04:tooltip 与主行同口径;移除恒近总量的「剩余 Token」误导项,标注估算口径 */
function agentDetailTitle(agent: AgentView): string {
  const pct = quotaPct(agent)
  const cap = agent.plan.dailyTaskCap
  const parts = [
    `${agent.label}${agent.version ? ' ' + agent.version : ''}`,
    `状态: ${agent.health?.ok ? '运行正常' : agent.health?.reason ?? '未探活'}`,
    `模式: ${agent.plan.name || agent.plan.quotaKind}`,
    `今日已派任务: ${usageOf(agent)}${cap > 0 ? `/${cap}` : ''} 次`,
    `额度余量: ${pct !== undefined ? `${pct}%` : '未知(未设置额度)'}`,
  ]
  if (agent.plan.quotaKind === 'credits') {
    if (agent.remainingCredits !== undefined) {
      parts.push(`剩余点数: 约 ${formatQuotaNumber(agent.remainingCredits)} 点`)
    }
    if (agent.usedCreditsToday !== undefined) {
      parts.push(`今日消耗: 约 ${formatQuotaNumber(agent.usedCreditsToday)} 点`)
    }
  } else if (agent.usedTokensToday) {
    parts.push(`今日消耗: 约 ${formatTokens(agent.usedTokensToday)} tok`)
  }
  if (pct === 0) parts.push('额度已用尽')
  if (agent.cacheHitRateToday !== undefined && agent.cacheHitRateToday > 0) {
    parts.push(`缓存命中率: ${agent.cacheHitRateToday}%`)
  }
  parts.push('口径: 约 · 本应用统计(套餐总量为近似值,zcode 另含本地 CLI 用量)')
  return parts.join('\n')
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

    <!-- 醒目的新建对话大按钮 -->
    <div class="new-chat-section" :class="{ collapsed: store.railCollapsed.value }">
      <button
        class="new-chat-btn"
        :title="store.railCollapsed.value ? '新建对话' : '开启新的 Agent 对话'"
        type="button"
        @click="store.newChat()"
      >
        <span class="icon">＋</span>
        <span v-if="!store.railCollapsed.value" class="text">新建对话</span>
      </button>
    </div>

    <div class="scroll">
      <div v-if="notice" class="notice" @click="notice = ''">{{ notice }}</div>

      <!-- 顶部工作区环境胶囊:将工作区从平铺列表中剥离，侧栏空间全量让渡给智能体主航道 -->
      <div class="workspace-bar" :class="{ collapsed: store.railCollapsed.value }">
        <div
          class="ws-capsule glass"
          :class="{
            active: Boolean(store.selectedProjectId.value),
            'drop-target': dragOverProjectId === (store.selectedProjectId.value ?? DAILY_PROJECT_ID),
          }"
          :title="store.selectedProject.value ? `当前工作区: ${store.selectedProject.value.name} (点击切换)` : '全部工作区 (点击切换或投放卡片)'"
          @click="showWsDropdown = !showWsDropdown"
          @dragover="onWsDragOver(store.selectedProject.value ?? store.projects.value[0] ?? ({ id: DAILY_PROJECT_ID, name: '日常' } as any), $event)"
          @dragleave="onWsDragLeave(store.selectedProject.value ?? store.projects.value[0] ?? ({ id: DAILY_PROJECT_ID, name: '日常' } as any), $event)"
          @drop="onWsDrop(store.selectedProject.value ?? store.projects.value[0] ?? ({ id: DAILY_PROJECT_ID, name: '日常' } as any), $event)"
        >
          <span class="ws-ico" aria-hidden="true">📁</span>
          <span v-if="!store.railCollapsed.value" class="ws-label">
            {{ store.selectedProject.value ? store.selectedProject.value.name : '全部工作区' }}
          </span>
          <span v-if="!store.railCollapsed.value" class="ws-arrow" :class="{ rotated: showWsDropdown }">▾</span>
        </div>

        <!-- 工作区下拉管理菜单 -->
        <Transition name="fade-slide">
          <div v-if="showWsDropdown && !store.railCollapsed.value" class="ws-dropdown glass custom-scroll" @click.stop>
            <div class="ws-dropdown-header">
              <span>工作区切换</span>
              <button class="ws-add-link" type="button" @click="addProject">＋ 新增</button>
            </div>
            <div
              class="ws-drop-item"
              :class="{ active: store.selectedProjectId.value === null }"
              @click="store.selectedProjectId.value = null; showWsDropdown = false"
            >
              <span class="p-name">📁 全部工作区</span>
            </div>
            <div
              v-for="project in store.projects.value"
              :key="project.id"
              class="ws-drop-item"
              :class="{
                active: store.selectedProjectId.value === project.id,
                'drop-target': dragOverProjectId === project.id,
              }"
              @click="pickProject(project); showWsDropdown = false"
              @dragover="onWsDragOver(project, $event)"
              @dragleave="onWsDragLeave(project, $event)"
              @drop="onWsDrop(project, $event); showWsDropdown = false"
            >
              <div class="p-info">
                <span class="p-name">{{ project.name }}</span>
                <span class="p-path">{{ project.path ? pathTail(project.path) : '未绑定目录' }}</span>
              </div>
              <div class="p-ops" @click.stop>
                <button
                  v-if="project.id === DAILY_PROJECT_ID"
                  type="button"
                  class="op-mini"
                  @click="toggleDailyBind(project)"
                >
                  {{ project.path ? '解绑' : '绑定' }}
                </button>
                <template v-else>
                  <button type="button" class="op-mini" @click="startRename(project)">改名</button>
                  <button type="button" class="op-mini danger" @click="removeProject(project)">移除</button>
                </template>
              </div>
            </div>
          </div>
        </Transition>
      </div>

      <div class="section-title" v-if="!store.railCollapsed.value">
        <span>智能体列表</span>
        <GlassButton
          variant="plain"
          size="sm"
          title="取消当前对话绑定,回到全局对话"
          @click="clearAgentContext"
        >
          全部对话
        </GlassButton>
      </div>

      <!-- 客户端空态 -->
      <div v-if="store.agents.value.length === 0" class="agents-empty" :class="{ collapsed: store.railCollapsed.value }">
        <template v-if="!store.railCollapsed.value">
          <template v-if="!store.agentsLoaded.value">
            <span class="agents-empty-text"><i class="probe-dot" aria-hidden="true" />正在探测客户端…</span>
          </template>
          <template v-else>
            <span class="agents-empty-text">未发现客户端</span>
            <GlassButton variant="plain" size="sm" :disabled="rescanning" @click="rescanAgents">
              {{ rescanning ? '扫描中…' : '重新扫描' }}
            </GlassButton>
          </template>
        </template>
        <GlassButton
          v-else-if="store.agentsLoaded.value"
          variant="plain"
          size="sm"
          :disabled="rescanning"
          title="未发现客户端,点击重新扫描"
          @click="rescanAgents"
        >
          {{ rescanning ? '…' : '⟳' }}
        </GlassButton>
        <i v-else class="probe-dot" aria-hidden="true" title="正在探测客户端…" />
      </div>

      <!-- 智能体列表主航道 -->
      <div class="agents">
        <div
          v-for="agent in store.agents.value"
          :key="agent.id"
          class="agent spot"
          role="button"
          tabindex="0"
          :aria-disabled="!pickable(agent)"
          :class="{
            picked: store.agentContext.value === agent.id,
            'is-collapsed': store.railCollapsed.value,
            'pick-disabled': !pickable(agent),
          }"
          :title="agentPickTitle(agent)"
          @click="pick(agent)"
          @keydown.enter="pick(agent)"
          @keydown.space.prevent="pick(agent)"
        >
          <div class="glyph-wrap">
            <!-- 现代 SVG 环形进度光环:折叠/展开均清晰展示额度百分比 -->
            <svg class="avatar-ring" viewBox="0 0 44 44" aria-hidden="true">
              <circle class="ring-bg" cx="22" cy="22" r="18" />
              <circle
                v-if="quotaPct(agent) !== undefined"
                class="ring-progress"
                cx="22"
                cy="22"
                r="18"
                :stroke="quotaColor(quotaPct(agent) ?? 100)"
                :stroke-dasharray="113.1"
                :stroke-dashoffset="113.1 * (1 - (quotaPct(agent) ?? 100) / 100)"
              />
            </svg>
            <img v-if="agent.logoPath" :src="logoUrl(agent)" class="glyph logo" alt="" />
            <span v-else class="glyph" aria-hidden="true">{{ agent.label.slice(0, 1) }}</span>
            <span class="status-dot" :class="healthClass(agent)" :title="agent.health?.reason ?? '未探活'" />
            <span v-if="hasRunningTask(agent.id)" class="running-ring" aria-hidden="true" />
          </div>

          <span v-if="!store.railCollapsed.value" class="meta">
            <!-- 阶梯 1: 名称与标签 -->
            <span class="line1">
              <span class="name">{{ agent.label }}</span>
              <span v-if="agent.isOverridden" class="calibrated-tag" title="用户已校准额度">已校准</span>
              <span v-else-if="hasRunningTask(agent.id)" class="running-tag">运行中</span>
              <span v-else class="plan-tag">{{ agent.plan.name || agent.plan.quotaKind }}</span>
            </span>

            <!-- 阶梯 2: 独立极简进度槽 + 百分比 -->
            <div class="quota-progress-row">
              <div class="quota-track">
                <i
                  class="quota-fill"
                  :style="{
                    width: `${quotaPct(agent) ?? 0}%`,
                    background: quotaColor(quotaPct(agent) ?? 100),
                  }"
                />
              </div>
              <span
                v-if="quotaPct(agent) !== undefined"
                class="quota-pct-text num"
                :style="{ color: quotaColor(quotaPct(agent) ?? 100) }"
              >
                {{ quotaPct(agent) }}%
              </span>
              <span v-else class="quota-pct-text unknown">未配置</span>
            </div>

            <!-- 阶梯 3: 结构化余量 vs 今日消耗对比 与 刷新 -->
            <div class="quota-stats-row num">
              <span class="quota-primary-val" :title="quotaInfo(agent).primaryText">
                {{ quotaInfo(agent).primaryValue }} {{ quotaInfo(agent).primaryUnit }}
              </span>
              <span
                v-if="quotaInfo(agent).dailyValue"
                class="quota-daily-val"
                :title="`今日消耗: ${quotaInfo(agent).dailyValue} ${quotaInfo(agent).dailyUnit ?? ''}`"
              >
                今日 {{ quotaInfo(agent).dailyValue }}
              </span>
              <span v-else-if="agent.cacheHitRateToday" class="cache-badge" title="今日缓存命中率">
                缓存 {{ agent.cacheHitRateToday }}%
              </span>
              <span class="spacer" />
              <button
                type="button"
                class="refresh-icon-btn"
                title="刷新额度"
                @click.stop="refreshUsage"
              >
                ⟳
              </button>
            </div>

            <!-- 悬浮操作胶囊:悬停卡片右上角时浮出,不遮挡内容 -->
            <div class="action-capsule" @click.stop>
              <button type="button" class="act-btn" title="健康探活" @click="recheck(agent)">探活</button>
              <button type="button" class="act-btn" title="唤起客户端应用" @click="launch(agent)">唤起</button>
              <button type="button" class="act-btn" :class="{ warn: !agent.enabled }" @click="toggleEnabled(agent)">
                {{ agent.enabled ? '停用' : '启用' }}
              </button>
            </div>
          </span>
        </div>
      </div>
    </div>

    <div class="bottom">
      <GlassButton variant="ghost" size="sm" class="btm" :title="`主题:${themeLabel()}(点击切换)`" @click="cycleTheme">
        {{ store.railCollapsed.value ? themeLabel() : `主题:${themeLabel()}` }}
      </GlassButton>
      <!-- R04:折叠态调度暂停不再凭空消失——以设置钮警示描边 + 角标色点表达 -->
      <GlassButton
        variant="ghost"
        size="sm"
        class="btm"
        :class="{ 'paused-warn': store.settings.value?.schedulerPaused }"
        :title="store.settings.value?.schedulerPaused ? '调度已暂停 · 打开设置恢复' : '设置'"
        @click="openSettings"
      >
        设置
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

  <!-- G1-08:移除工作区的应用内确认层(Esc 取消,autofocus 落在确认钮上 Enter 直接确认) -->
  <GlassModal v-if="removeTarget" open title="移除工作区" width="420px" @close="removeTarget = null">
    <p class="remove-tip">将移除「{{ removeTarget.name }}」。目录与历史任务保留,仅解除分组。</p>
    <template #footer>
      <span class="spacer" />
      <GlassButton variant="ghost" @click="removeTarget = null">取消</GlassButton>
      <GlassButton variant="danger" autofocus @click="confirmRemoveProject">确认移除</GlassButton>
    </template>
  </GlassModal>
</template>

<style scoped>
.rail {
  /* P0-7:宽度受控于 App.vue 的 railW(--rail-w 下传);折叠态 specificity 更高仍走 64px */
  width: var(--rail-w, 236px);
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  transition: width 180ms var(--ease);
  /* R04:建立行内尺寸查询容器,@container 按侧栏实际宽度隐藏缓存徽章 */
  container-type: inline-size;
}

.rail.collapsed {
  width: 64px;
  padding: 10px 8px;
}

.brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px 6px;
  transition: all 180ms var(--ease);
}

.rail.collapsed .brand-row {
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  padding: 2px 0 6px;
}

/* 折叠钮在 64px 窄栏里比 GlassButton sm 默认更紧凑(加元素选择器压过 .g-btn.sm) */
.brand-row button.fold {
  font-size: 14px;
  padding: 2px 6px;
}

.new-chat-section {
  padding: 2px;
  margin-bottom: 4px;
}

.new-chat-section.collapsed {
  display: flex;
  justify-content: center;
}

.new-chat-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: #0c131d;
  font-weight: 700;
  font-size: 13px;
  border: none;
  cursor: pointer;
  transition: all var(--fast) var(--ease-spring);
  box-shadow: 0 4px 14px var(--accent-dim);
}

.new-chat-section.collapsed .new-chat-btn {
  width: 38px;
  height: 38px;
  padding: 0;
  border-radius: 50%;
}

.new-chat-btn:hover {
  transform: translateY(-1px);
  filter: brightness(1.08);
  box-shadow: 0 6px 18px var(--accent-line);
}

.new-chat-btn:active {
  transform: scale(0.97);
}

.new-chat-btn .icon {
  font-size: 15px;
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

/* G1-08:移除工作区确认层正文 */
.remove-tip {
  margin: 4px 0;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.6;
  word-break: break-word;
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
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
  transition: background var(--fast) var(--ease), border-color var(--fast) var(--ease), transform var(--fast) var(--ease);
}

.ws:focus-visible,
.agent:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: -2px;
}

.agent {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition: all var(--fast) var(--ease);
}

.agent:hover:not(.pick-disabled) {
  background: var(--surface-dim);
  border-color: var(--line);
}

/* 激活态高亮导轨与背板微光 */
.agent.picked {
  background: linear-gradient(90deg, var(--accent-dim) 0%, transparent 100%);
  border-color: var(--accent-line);
}

.agent.picked::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent-strong);
  box-shadow: 0 0 8px var(--accent);
}

/* R05:停用/非 headless 卡片置灰禁点 */
.agent.pick-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.agent.pick-disabled:hover {
  background: transparent;
  border-color: transparent;
}

.agent.pick-disabled .glyph {
  filter: grayscale(0.6);
}

/* 客户端空态就地闭环 */
.agents-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-md);
  font-size: 11.5px;
  color: var(--muted);
}

.agents-empty.collapsed {
  justify-content: center;
  padding: 8px 6px;
}

.agents-empty-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.probe-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: probePulse 1.2s ease-in-out infinite;
}

@keyframes probePulse {
  0%, 100% { opacity: 0.35; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.1); }
}

.rail.collapsed .agent {
  justify-content: center;
  padding: 10px 6px;
}

.glyph-wrap {
  position: relative;
  flex: none;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
}

/* 现代 SVG 环形进度光环 */
.avatar-ring {
  position: absolute;
  inset: -3px;
  width: 44px;
  height: 44px;
  transform: rotate(-90deg);
  pointer-events: none;
}

.ring-bg {
  fill: none;
  stroke: var(--line);
  stroke-width: 2;
  opacity: 0.35;
}

.ring-progress {
  fill: none;
  stroke-width: 2.2;
  stroke-linecap: round;
  transition: stroke-dashoffset 300ms ease, stroke 300ms ease;
}

.glyph {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-weight: 600;
  font-size: 14px;
  color: var(--accent-strong);
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
  box-shadow: inset 0 1px 0 var(--glass-specular);
}

.glyph.logo {
  object-fit: contain;
  padding: 3px;
}

.status-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--glass-bg);
  background: var(--faint);
  z-index: 2;
}

.status-dot.ok {
  background: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
}

.status-dot.bad {
  background: var(--err);
}

.running-ring {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 2px dashed var(--accent);
  animation: ringSpin 3s linear infinite;
  pointer-events: none;
}

@keyframes ringSpin {
  100% { transform: rotate(360deg); }
}

.plan-tag {
  font-size: 10px;
  color: var(--muted);
  background: var(--accent-dim);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--accent-line);
}

/* 阶梯 2: 独立极简进度槽 */
.quota-progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 1px 0;
}

.quota-track {
  flex: 1;
  height: 4px;
  background: var(--line);
  border-radius: 2px;
  overflow: hidden;
}

.quota-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  transition: width 300ms ease;
}

.quota-pct-text {
  font-size: 11px;
  font-weight: 700;
  min-width: 28px;
  text-align: right;
  line-height: 1;
}

.quota-pct-text.unknown {
  color: var(--faint);
  font-size: 10px;
}

/* 阶梯 3: 结构化余量 vs 今日消耗对比 */
.quota-stats-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.2;
}

.quota-primary-val {
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota-daily-val {
  color: var(--faint);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.refresh-icon-btn {
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  transition: color 140ms;
}

.refresh-icon-btn:hover {
  color: var(--accent-strong);
}

/* 悬浮操作微胶囊 */
.action-capsule {
  position: absolute;
  right: 6px;
  top: 6px;
  display: none;
  align-items: center;
  gap: 3px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  z-index: 10;
}

.agent:hover .action-capsule {
  display: flex;
}

.act-btn {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  transition: all 120ms;
}

.act-btn:hover {
  background: var(--surface-dim);
  color: var(--text);
}

.act-btn.warn {
  color: var(--warn);
}

/* 顶部工作区环境胶囊样式 */
.workspace-bar {
  position: relative;
  margin-bottom: 4px;
}

.ws-capsule {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--surface-dim);
  cursor: pointer;
  user-select: none;
  transition: all 140ms ease;
}

.ws-capsule:hover {
  border-color: var(--accent-line);
  background: var(--surface);
}

.ws-capsule.active {
  border-color: var(--accent);
  background: var(--accent-dim);
}

.ws-capsule.drop-target {
  box-shadow: 0 0 0 2px var(--accent);
}

.ws-ico {
  font-size: 13px;
  flex-shrink: 0;
}

.ws-label {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-arrow {
  font-size: 9px;
  color: var(--muted);
  transition: transform 140ms ease;
}

.ws-arrow.rotated {
  transform: rotate(180deg);
}

.workspace-bar.collapsed .ws-capsule {
  justify-content: center;
  padding: 0;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  margin: 0 auto;
}

.ws-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 2200;
  background: var(--surface);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-md);
  padding: 6px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ws-dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  margin-bottom: 4px;
}

.ws-add-link {
  background: none;
  border: none;
  color: var(--accent-strong);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  font-weight: 600;
}

.ws-drop-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 120ms;
}

.ws-drop-item:hover {
  background: var(--surface-dim);
}

.ws-drop-item.active {
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
}

.ws-drop-item .p-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ws-drop-item .p-name {
  font-size: 12px;
}

.ws-drop-item .p-path {
  font-size: 10px;
  color: var(--faint);
}

.ws-drop-item .p-ops {
  display: flex;
  gap: 4px;
}

.op-mini {
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--muted);
  font-size: 10px;
  padding: 1px 5px;
  cursor: pointer;
}

.op-mini:hover {
  background: var(--surface);
  color: var(--text);
}

.op-mini.danger:hover {
  color: var(--err);
  border-color: var(--err);
}


.running-tag {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-strong);
  background: var(--accent-dim);
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--accent-line);
  animation: runPulse 1.8s ease-in-out infinite;
}

@keyframes runPulse {
  0%, 100% { opacity: 0.85; }
  50% { opacity: 1; box-shadow: 0 0 6px var(--accent-dim); }
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

.quota-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* R04:余量行单行不折行,窄栏靠省略号收缩,不再错位换行 */
  flex-wrap: nowrap;
  font-size: 11px;
  gap: 4px;
  min-width: 0;
}

.quota-rem {
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
  min-width: 0;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cache-badge {
  font-size: 10px;
  font-weight: 700;
  color: #10b981;
  background: color-mix(in srgb, #10b981 12%, transparent);
  border: 1px solid color-mix(in srgb, #10b981 28%, transparent);
  padding: 0 4px;
  border-radius: 4px;
  line-height: 1.4;
  flex: none;
}

/* G1-06:额度行尾轻量刷新钮,压缩到与缓存徽章同量级,不挤占余量文字 */
.quota-meta :deep(button.quota-refresh) {
  flex: none;
  padding: 0 5px;
  font-size: 11px;
  line-height: 1.5;
}

/* R04:窄侧栏(约 200px 档)缓存徽章隐藏,把宽度让给余量文字;折叠态 meta 本就不渲染 */
@container (max-width: 219px) {
  .cache-badge {
    display: none;
  }
}

.today-usage {
  font-size: 10px;
  color: var(--muted);
  line-height: 1.2;
}

.count {
  font-size: 11px;
  color: var(--muted);
}

.calibrated-tag {
  font-size: 9.5px;
  color: var(--accent);
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 1.4;
}

.quota-sub {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}

/* 现代化悬停操作栏:卡片悬停时平滑浮现,常态半隐不侵占高度 */
.ops.hover-ops {
  display: flex;
  gap: 4px;
  margin-top: 2px;
  opacity: 0.25;
  transform: translateY(1px);
  transition: opacity 160ms ease, transform 160ms ease;
}

.agent:hover .ops.hover-ops,
.agent:focus-within .ops.hover-ops {
  opacity: 1;
  transform: translateY(0);
}

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

/* R04:折叠态「调度已暂停」警示——底部状态钮描边 + 右上角色点,不再凭空消失 */
.btm.paused-warn {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 55%, transparent);
  position: relative;
}

.btm.paused-warn::after {
  content: '';
  position: absolute;
  top: -3px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warn);
  box-shadow: 0 0 6px color-mix(in srgb, var(--warn) 60%, transparent);
}
</style>

<style>
/* 拖动任一分隔条时(Resizer 挂 body.resizing)关闭侧栏宽度过渡,消除拖拽跟随迟滞 */
body.resizing .rail {
  transition: none;
}
</style>
