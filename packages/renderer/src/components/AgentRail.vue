<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore, setTheme } from '../stores/app'
import GlassButton from '../ui/GlassButton.vue'
import GlassMeter from '../ui/GlassMeter.vue'
import GlassInput from '../ui/GlassInput.vue'
import GlassModal from '../ui/GlassModal.vue'
import Logo from './Logo.vue'
// A-06:日常工作区 id 与分组展示名一律走 labels 单一口径,组件内不再自带字面量
import { DAILY_PROJECT_ID, formatQuotaNumber, formatTokens, formatAgentQuotaDisplay } from '../labels'
import type { AgentView, Project } from '@agent-drove/shared'

const store = useAppStore()

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
/** P-07:折叠态浮层以胶囊实测位置为锚点(浮层走 body,不受侧栏滚动容器裁切) */
const capsuleRef = ref<HTMLElement | null>(null)
const popoverTop = ref(12)

const popoverStyle = computed(() => ({ left: '72px', top: `${popoverTop.value}px` }))

function onGlobalClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  // 折叠态浮层 Teleport 到 body,点它不算「点外部」
  if (!target.closest('.workspace-bar') && !target.closest('.ws-popover')) showWsDropdown.value = false
}

/** P-07:浮层(下拉/浮出面板)都可 Esc 关闭——一切浮层有退路 */
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && showWsDropdown.value) showWsDropdown.value = false
}

onMounted(() => {
  window.addEventListener('click', onGlobalClick)
  window.addEventListener('keydown', onGlobalKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('click', onGlobalClick)
  window.removeEventListener('keydown', onGlobalKeydown)
})

/** 展开发下拉、折叠开浮层;开合前记录胶囊位置,浮层与胶囊对齐 */
function toggleWsDropdown(): void {
  if (showWsDropdown.value) {
    showWsDropdown.value = false
    return
  }
  const rect = capsuleRef.value?.getBoundingClientRect()
  if (rect) popoverTop.value = Math.max(8, Math.round(rect.top))
  showWsDropdown.value = true
}

/** 收起/展开侧栏时关掉浮层,避免残留错位的面板 */
watch(
  () => store.railCollapsed.value,
  () => {
    showWsDropdown.value = false
  },
)

/** 任务卡拖到工作区项上的悬停高亮(P0-2) */
const dragOverProjectId = ref('')

/**
 * A-08:胶囊 drop 落点——选中某工作区时即该项目;「全部工作区」态固定为日常工作区
 * (不再拿 projects[0] 当替身,胶囊语义与投放落点一致)。
 */
const capsuleDropProject = computed<Project>(
  () => store.selectedProject.value ?? { id: DAILY_PROJECT_ID, name: '日常', path: null, createdAt: 0 },
)

/** A-08:胶囊 title——拖拽悬停时直接说明投放目标(折叠态亦以此表达落点) */
const capsuleTitle = computed(() => {
  const target = capsuleDropProject.value
  if (store.draggingTaskId.value && dragOverProjectId.value === target.id) {
    return `松手投放到「${target.name}」`
  }
  const base = store.selectedProject.value
    ? `当前工作区: ${store.selectedProject.value.name} (点击切换)`
    : '全部工作区 (点击切换或投放卡片)'
  return store.draggingTaskId.value ? `${base} · 投放目标:「${target.name}」` : base
})

/** G2-02/A-06:今日用量按 agent 建索引:模板里每个客户端要读两次,避免每次渲染全表扫描 */
const usageByAgent = computed(() => {
  const map = new Map<string, number>()
  for (const row of store.usage.value) map.set(row.agentId, row.taskCount)
  return map
})

function usageOf(agent: AgentView): number {
  return usageByAgent.value.get(agent.id) ?? agent.usedToday ?? 0
}

/**
 * C-06/C-08:余量口径单一事实源——优先 quotaOf 的现算快照,
 * 快照缺失(尚未拉到)时回落 agents 旧内嵌字段,避免侧栏与设置页两处漂移。
 */
function quotaFields(agent: AgentView) {
  const snapshot = store.quotaOf(agent.id)
  return {
    remainingCredits: snapshot?.remainingCredits ?? agent.remainingCredits,
    remainingTokens: snapshot?.remainingTokens ?? agent.remainingTokens,
    remainingPercent: snapshot?.remainingPercent ?? agent.remainingPercent,
    totalCredits: snapshot?.totalCredits ?? agent.totalCredits,
    totalTokens: snapshot?.totalTokens ?? agent.totalTokens,
  }
}

function quotaInfo(agent: AgentView) {
  return formatAgentQuotaDisplay({
    plan: agent.plan,
    ...quotaFields(agent),
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
  // A-03:选择 Agent = 进入其上下文(默认联动任务列筛选),统一走 setAgentContext
  store.setAgentContext(agent.id)
}

/** 「全部对话」:绑定与筛选同时清除(统一语义入口) */
function clearAgentContext(): void {
  store.setAgentContext('')
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

/** 下拉/浮层选项统一收口:选中并关闭面板(null=全部工作区) */
function chooseProject(project: Project | null): void {
  if (project) pickProject(project)
  else store.selectedProjectId.value = null
  showWsDropdown.value = false
}

/** 浮层里的「全部对话」:清除客户端绑定(与展开态同一入口) */
function clearAgentBinding(): void {
  store.setAgentContext('')
  showWsDropdown.value = false
}

/** P-17:工作区项键盘可达——Enter/Space 与点击同语义 */
function onWsItemKeydown(project: Project | null, event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  chooseProject(project)
}

function onBindingKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  clearAgentBinding()
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

/** A-10/A-14:整批走 moveTasks;零变更时轻提示,不静默也不报错 */
async function onWsDrop(project: Project, event: DragEvent): Promise<void> {
  event.preventDefault()
  if (dragOverProjectId.value === project.id) dragOverProjectId.value = ''
  // 展开态下拉接收投放后收起,折叠态浮层不挡后续操作
  if (!store.railCollapsed.value) showWsDropdown.value = false
  const taskId = store.draggingTaskId.value
  if (!taskId) return
  store.draggingTaskId.value = null
  const ids =
    store.selection.value.has(taskId) && store.selection.value.size > 1
      ? [...store.selection.value]
      : [taskId]
  const moved = await store.moveTasks(ids, project.id)
  if (moved === 0) store.showToast('卡片已在该工作区')
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
  // B9:统一走 setAgentContext('')——直赋 agentContext 会漏清 filter.agentId,
  // 留下「筛选仍按已停用客户端」的隐形空列表
  store.setAgentContext('')
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
 * R04/C-06:余量百分比,与余量文字同源同量纲(quotaOf 优先)。
 * 返回 undefined = 未知态(未配置总量且无每日上限),不再虚构满格。
 */
function quotaPct(agent: AgentView): number | undefined {
  const percent = quotaFields(agent).remainingPercent
  if (percent !== undefined && Number.isFinite(percent)) {
    return Math.max(0, Math.min(100, Math.round(percent)))
  }
  if (agent.plan.dailyTaskCap > 0) {
    return Math.max(0, Math.round(((agent.plan.dailyTaskCap - usageOf(agent)) / agent.plan.dailyTaskCap) * 100))
  }
  return undefined
}

/** R04:余量阈值配色——>50% 绿 / 20%~50% 橙 / ≤20% 深橙 / 0 红 */
function quotaColor(pct: number): string {
  if (pct <= 0) return 'var(--err)'
  if (pct <= 20) return 'var(--warn-strong)'
  if (pct <= 50) return 'var(--warn)'
  return 'var(--ok)'
}

/** C-05:余量告急(≤20%)——就地给校准入口 */
function quotaLow(agent: AgentView): boolean {
  const pct = quotaPct(agent)
  return pct !== undefined && pct <= 20
}

/**
 * G1-06:客户端本地图标路径 → file:// URL(项目未注册自定义资源协议,生产以 file:// 加载;
 * B11:生产 CSP 实为 `img-src 'self' data:`,不含 file:,故 file:// 图标会被拦下、
 * 不生效——当前各驱动尚未上报 logoPath,该分支默认不触发,现状渲染与首字母一致)
 */
function logoUrl(agent: AgentView): string {
  const p = (agent.logoPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  return encodeURI(`file:///${p}`)
}

/** C-01/C-06:手动刷新按钮状态——防重入 + 旋转态 */
const refreshing = ref(false)

/** G1-06/C-01:轻量额度刷新——只走 usage:get,不触发探活;force 现算绕过按日缓存 */
async function refreshUsage(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await run(() => store.refreshUsage(true), '刷新额度失败')
  } finally {
    refreshing.value = false
  }
}

/**
 * C-05:跳设置页用量区——设置页按需挂载,用量卡片出现后再滚到位
 * (有限重试,超时静默放弃,不阻塞用户手动查找)。
 */
async function openUsageSection(): Promise<void> {
  await run(() => store.refreshSettings(), '读取设置失败')
  store.view.value = 'settings'
  let tries = 0
  const seek = (): void => {
    const card = Array.from(document.querySelectorAll('section.card')).find(
      (el) => el.querySelector('h2')?.textContent?.trim() === '用量',
    )
    if (card) {
      card.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    if (++tries < 20) window.setTimeout(seek, 50)
  }
  void nextTick(() => seek())
}

/**
 * K-03/C-08:周期口径行——有 cycleDays 校准的客户端显示周期窗口(本地日 YYYY-MM-DD),
 * 否则如实标注「自首次任务累计（近似）」。
 */
function cycleLine(agent: AgentView): string {
  const snapshot = store.quotaOf(agent.id)
  const start = snapshot?.cycleStartAt ?? agent.cycleStartAt
  const reset = snapshot?.cycleResetAt ?? agent.cycleResetAt
  if (start && reset) return `周期 ${start} ~ ${reset}（${reset} 重置）`
  return '自首次任务累计（近似）'
}

/** R04:tooltip 与主行同口径;移除恒近总量的「剩余 Token」误导项,标注估算口径与周期口径 */
function agentDetailTitle(agent: AgentView): string {
  const pct = quotaPct(agent)
  const fields = quotaFields(agent)
  const cap = agent.plan.dailyTaskCap
  const parts = [
    `${agent.label}${agent.version ? ' ' + agent.version : ''}`,
    `状态: ${agent.health?.ok ? '运行正常' : agent.health?.reason ?? '未探活'}`,
    `模式: ${agent.plan.name || agent.plan.quotaKind}`,
    `今日已派任务: ${usageOf(agent)}${cap > 0 ? `/${cap}` : ''} 次`,
    `额度余量: ${pct !== undefined ? `${pct}%` : '未知(未设置额度)'}`,
    `额度周期: ${cycleLine(agent)}`,
  ]
  if (agent.isOverridden) parts.push('额度来源: 用户手动校准')
  if (agent.plan.quotaKind === 'credits') {
    if (fields.remainingCredits !== undefined) {
      parts.push(`剩余点数: 约 ${formatQuotaNumber(fields.remainingCredits)} 点`)
    }
    if (agent.usedCreditsToday !== undefined) {
      parts.push(`今日消耗: 约 ${formatQuotaNumber(agent.usedCreditsToday)} 点`)
    }
  } else if (agent.usedTokensToday) {
    parts.push(`今日消耗: 约 ${formatTokens(agent.usedTokensToday)} tok`)
  }
  if (pct === 0) parts.push('额度已用尽')
  // B10:折叠态没有「校准」按钮,文案不承诺不存在的入口
  if (quotaLow(agent)) {
    parts.push(
      store.railCollapsed.value
        ? '额度告急: 展开侧栏后可校准'
        : '额度告急: 点卡片上的「校准」直达设置页用量区',
    )
  }
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
        @click="store.setRailCollapsed(!store.railCollapsed.value, { userInitiated: true })"
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
          ref="capsuleRef"
          class="ws-capsule glass"
          :class="{
            active: Boolean(store.selectedProjectId.value),
            'drop-target': dragOverProjectId === capsuleDropProject.id,
          }"
          :title="capsuleTitle"
          @click="toggleWsDropdown"
          @dragover="onWsDragOver(capsuleDropProject, $event)"
          @dragleave="onWsDragLeave(capsuleDropProject, $event)"
          @drop="onWsDrop(capsuleDropProject, $event)"
        >
          <span class="ws-ico" aria-hidden="true">📁</span>
          <span v-if="!store.railCollapsed.value" class="ws-label">
            {{ store.selectedProject.value ? store.selectedProject.value.name : '全部工作区' }}
          </span>
          <!-- A-08:悬停投放时明示落点(「全部工作区」态固定投放到日常) -->
          <span
            v-if="!store.railCollapsed.value && dragOverProjectId === capsuleDropProject.id"
            class="ws-drop-hint"
          >
            投放到 {{ capsuleDropProject.name }}
          </span>
          <span v-if="!store.railCollapsed.value" class="ws-arrow" :class="{ rotated: showWsDropdown }">▾</span>
        </div>

        <!-- 工作区下拉管理菜单(展开态) -->
        <Transition name="fade-slide">
          <div
            v-if="showWsDropdown && !store.railCollapsed.value"
            class="ws-dropdown glass custom-scroll"
            role="menu"
            @click.stop
          >
            <div class="ws-dropdown-header">
              <span>工作区切换</span>
              <button class="ws-add-link" type="button" @click="addProject">＋ 新增</button>
            </div>
            <div
              class="ws-drop-item"
              role="menuitem"
              tabindex="0"
              :class="{ active: store.selectedProjectId.value === null }"
              @click="chooseProject(null)"
              @keydown="onWsItemKeydown(null, $event)"
            >
              <span class="p-name">📁 全部工作区</span>
            </div>
            <div
              v-for="project in store.projects.value"
              :key="project.id"
              class="ws-drop-item"
              role="menuitem"
              tabindex="0"
              :class="{
                active: store.selectedProjectId.value === project.id,
                'drop-target': dragOverProjectId === project.id,
              }"
              @click="chooseProject(project)"
              @keydown="onWsItemKeydown(project, $event)"
              @dragover="onWsDragOver(project, $event)"
              @dragleave="onWsDragLeave(project, $event)"
              @drop="onWsDrop(project, $event)"
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

      <!-- A-07:折叠态浮层——fixed 浮出到 rail 右侧,含工作区切换/新增/清除客户端绑定;
           走 Teleport 到 body,既不受 .scroll 横向裁切,也不受 rail 玻璃层 containing block 影响 -->
      <Teleport to="body">
        <Transition name="fade-slide">
          <div
            v-if="showWsDropdown && store.railCollapsed.value"
            class="ws-popover glass"
            :style="popoverStyle"
            role="menu"
            @click.stop
          >
            <div class="ws-dropdown-header">
              <span>工作区</span>
              <button class="ws-add-link" type="button" @click="addProject">＋ 新增</button>
            </div>
            <button
              type="button"
              role="menuitem"
              class="ws-popover-item"
              :class="{ active: store.selectedProjectId.value === null }"
              @click="chooseProject(null)"
            >
              📁 全部工作区
            </button>
            <button
              v-for="project in store.projects.value"
              :key="project.id"
              type="button"
              role="menuitem"
              class="ws-popover-item"
              :class="{ active: store.selectedProjectId.value === project.id }"
              @click="chooseProject(project)"
            >
              <span class="p-name">{{ project.name }}</span>
              <span class="p-path">{{ project.path ? pathTail(project.path) : '未绑定目录' }}</span>
            </button>
            <div class="ws-popover-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              class="ws-popover-item"
              @click="clearAgentBinding"
              @keydown="onBindingKeydown"
            >
              ✕ 全部对话(清除客户端绑定)
            </button>
          </div>
        </Transition>
      </Teleport>

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
            <!-- C-08:折叠态在 glyph 下补 9px 百分比微字,余量不再依赖悬停 tooltip;无数据渲染灰点 -->
            <span
              v-if="store.railCollapsed.value"
              class="glyph-pct num"
              :class="{ 'is-dot': quotaPct(agent) === undefined }"
              :style="quotaPct(agent) !== undefined ? { color: quotaColor(quotaPct(agent) ?? 100) } : undefined"
              :title="quotaPct(agent) !== undefined ? `额度余量 ${quotaPct(agent)}%` : '额度未配置'"
            >
              {{ quotaPct(agent) !== undefined ? `${quotaPct(agent)}%` : '•' }}
            </span>
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
              <!-- C-05:余量告急(≤20%)就地给校准入口,直达设置页用量区 -->
              <button
                v-if="quotaLow(agent)"
                type="button"
                class="calibrate-btn"
                title="额度告急,前往设置页用量区校准"
                @click.stop="openUsageSection"
              >
                校准
              </button>
              <button
                type="button"
                class="refresh-icon-btn"
                :class="{ spin: refreshing }"
                :disabled="refreshing"
                :title="refreshing ? '正在刷新额度…' : '刷新额度(现算)'"
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
  /* C-08:底部留出余量微字的位置 */
  padding: 10px 6px 16px;
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
  background: var(--ok);
  box-shadow: 0 0 6px color-mix(in srgb, var(--ok) 40%, transparent);
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

/* A-19:悬停时状态标签让位给右上角操作胶囊,消除对「运行中/已校准」的遮挡
   (布局不动,仅淡出;信息在同卡 tooltip 内仍可查) */
.agent:hover .calibrated-tag,
.agent:hover .running-tag,
.agent:hover .plan-tag {
  opacity: 0;
}

.plan-tag {
  font-size: 10px;
  color: var(--muted);
  background: var(--accent-dim);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--accent-line);
  transition: opacity 140ms var(--ease);
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

.refresh-icon-btn:hover:not(:disabled) {
  color: var(--accent-strong);
}

.refresh-icon-btn:disabled {
  cursor: progress;
  color: var(--accent-strong);
}

/* C-01:刷新进行中旋转,并挡住重入(同一时刻只刷一轮) */
.refresh-icon-btn.spin {
  display: inline-block;
  animation: refreshSpin 0.9s linear infinite;
}

@keyframes refreshSpin {
  to {
    transform: rotate(360deg);
  }
}

/* C-05:额度告急时的校准入口(余量 ≤20% 才出现) */
.calibrate-btn {
  flex: none;
  border: 1px solid color-mix(in srgb, var(--warn-strong) 45%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--warn-strong) 14%, transparent);
  color: var(--warn-strong);
  font-size: 10px;
  line-height: 1.5;
  padding: 0 5px;
  cursor: pointer;
  transition: filter 140ms var(--ease);
}

.calibrate-btn:hover {
  filter: brightness(1.12);
}

/* C-08:折叠态余量微字——贴在 glyph 下缘,不展开侧栏也能看到百分比 */
.rail.collapsed .glyph-pct {
  position: absolute;
  left: 50%;
  bottom: -7px;
  transform: translateX(-50%);
  font-size: 9px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-weight: 700;
  z-index: 3;
  pointer-events: none;
}

.rail.collapsed .glyph-pct.is-dot {
  color: var(--faint);
  font-weight: 400;
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

/* A-08:拖拽悬停时明示投放目标 */
.ws-drop-hint {
  flex: none;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  border-radius: 999px;
  padding: 1px 7px;
  white-space: nowrap;
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
  z-index: var(--z-popover);
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

/* A-07:折叠态浮出面板——fixed 到 rail 右侧(Teleport 到 body),横向不被 .scroll 裁切 */
.ws-popover {
  position: fixed;
  z-index: var(--z-popover);
  width: 220px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--surface);
  border: 1px solid var(--accent-line);
  border-radius: var(--radius-md);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
}

.ws-popover-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  text-align: left;
  font: inherit;
  font-size: 12px;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  cursor: pointer;
  transition: background 120ms var(--ease), color 120ms var(--ease);
}

.ws-popover-item:hover,
.ws-popover-item:focus-visible {
  background: var(--surface-dim);
  outline: none;
}

.ws-popover-item.active {
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
}

.ws-popover-item .p-path {
  font-size: 10px;
  color: var(--faint);
}

.ws-popover-sep {
  height: 1px;
  margin: 3px 4px;
  background: var(--line);
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

/* P-17:下拉项键盘可达——Tab 落到该项时给出可见焦点 */
.ws-drop-item:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: -2px;
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
  transition: opacity 140ms var(--ease);
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
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 28%, transparent);
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
  transition: opacity 140ms var(--ease);
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
