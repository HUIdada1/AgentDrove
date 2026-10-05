<script setup lang="ts">
import { computed, ref } from 'vue'
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
          :class="{
            picked: store.selectedProjectId.value === project.id,
            'drop-target': dragOverProjectId === project.id,
          }"
          :title="wsTitle(project)"
          @click="pickProject(project)"
          @keydown.enter="pickProject(project)"
          @keydown.space.prevent="pickProject(project)"
          @dragover="onWsDragOver(project, $event)"
          @dragleave="onWsDragLeave(project, $event)"
          @drop="onWsDrop(project, $event)"
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
        <!-- R05/G1-01:显式「全部对话」入口——清除会话绑定(任务列筛选由列头下拉独立控制) -->
        <GlassButton
          variant="plain"
          size="sm"
          title="取消当前对话绑定,回到全部对话"
          @click="clearAgentContext"
        >
          全部对话
        </GlassButton>
      </div>
      <!-- R05/G1-06:客户端空态两态区分——探测中(agentsLoaded=false)显示脉冲点与「正在探测客户端…」,
           探测完成仍为空才显示「未发现客户端 + 重新扫描」,加载态不再伪装成异常态 -->
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
            <!-- G1-06:客户端上报本地图标时渲染 logo(折叠态亦可辨),否则回落首字母 -->
            <img v-if="agent.logoPath" :src="logoUrl(agent)" class="glyph logo" alt="" />
            <span v-else class="glyph" aria-hidden="true">{{ agent.label.slice(0, 1) }}</span>
            <span class="status-dot" :class="healthClass(agent)" :title="agent.health?.reason ?? '未探活'" />
            <!-- G1-06:额度余量色点——6px 定位左下,与右下 status-dot 错位叠放,折叠态额度不再完全不可见;
                 评审取色点而非色环,避免与 running-ring 虚线环视觉冲突 -->
            <i
              v-if="quotaPct(agent) !== undefined"
              class="quota-dot"
              :style="{ background: quotaColor(quotaPct(agent) ?? 100) }"
            />
            <span v-if="hasRunningTask(agent.id)" class="running-ring" aria-hidden="true" />
          </div>
          <span v-if="!store.railCollapsed.value" class="meta">
            <span class="line1">
              <span class="name">{{ agent.label }}</span>
              <span v-if="agent.isOverridden" class="calibrated-tag" title="用户已校准额度">已校准</span>
              <span v-else-if="hasRunningTask(agent.id)" class="running-tag">运行中</span>
              <span v-else class="plan-tag">{{ agent.plan.name || agent.plan.quotaKind }}</span>
            </span>
            <div class="quota-row">
              <template v-if="quotaPct(agent) !== undefined">
                <GlassMeter
                  :value="quotaPct(agent) ?? 0"
                  :max="100"
                  :show-percent="false"
                  size="sm"
                  :color="quotaColor(quotaPct(agent) ?? 0)"
                />
                <span class="quota-pct num">{{ quotaPct(agent) }}%</span>
              </template>
              <span v-else class="quota-unknown">未配置额度</span>
            </div>
            <div class="quota-meta num">
              <span class="quota-rem" :title="quotaInfo(agent).primaryText">
                {{ quotaInfo(agent).primaryText }}
              </span>
              <span v-if="quotaInfo(agent).subText" class="quota-sub" :title="quotaInfo(agent).subText">
                {{ quotaInfo(agent).subText }}
              </span>
              <span v-else-if="agent.cacheHitRateToday" class="cache-badge" title="今日平均缓存命中率">
                缓存 {{ agent.cacheHitRateToday }}%
              </span>
              <GlassButton
                variant="ghost"
                size="sm"
                class="quota-refresh"
                title="刷新额度"
                @click.stop="refreshUsage"
              >
                ⟳
              </GlassButton>
            </div>
            <span class="ops hover-ops">
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

/* R05:停用/非 headless 卡片置灰禁点,悬停不再给选中暗示 */
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

/* R05:客户端空态就地闭环 */
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

/* G1-06:探测中空态——脉冲圆点,与「未发现客户端」异常态视觉区分 */
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

/* 任务卡拖入时的放置高亮(P0-2) */
.ws.drop-target {
  background: var(--accent-dim);
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

.rail.collapsed .ws,
.rail.collapsed .agent {
  justify-content: center;
  padding: 10px 6px;
}

.glyph {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  font-weight: 600;
  font-size: 15px;
  color: var(--accent-strong);
  background: var(--accent-dim);
  border: 1px solid var(--accent-line);
  box-shadow: inset 0 1px 0 var(--glass-specular), 0 2px 8px rgba(0, 0, 0, 0.12);
}

.glyph-wrap {
  position: relative;
  flex: none;
}

.status-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--glass-bg);
  background: var(--faint);
}

.status-dot.ok {
  background: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
}

.status-dot.bad {
  background: var(--err);
}

/* G1-06:额度余量色点——6px 定位左下,与右下 status-dot 错位叠放;底色由内联 style 按阈值给 */
.quota-dot {
  position: absolute;
  left: -2px;
  bottom: -2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  border: 1px solid var(--glass-bg);
}

/* G1-06:客户端 logo 图标复用 .glyph 玻璃底座,图片内缩留边不顶格 */
.glyph.logo {
  object-fit: contain;
  padding: 3px;
}

.running-ring {
  position: absolute;
  inset: -3px;
  border-radius: 14px;
  border: 2px dashed var(--accent);
  animation: ringSpin 3s linear infinite;
  pointer-events: none;
}

@keyframes ringSpin {
  100% {
    transform: rotate(360deg);
  }
}

.plan-tag {
  font-size: 10px;
  color: var(--muted);
  background: var(--accent-dim);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--accent-line);
}

.quota-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.quota-row :deep(.g-meter) {
  flex: 1;
}

.quota-pct {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  min-width: 28px;
  text-align: right;
}

/* R04:额度未知态文字(不渲染满格进度条) */
.quota-unknown {
  flex: 1;
  font-size: 10.5px;
  color: var(--faint);
  border: 1px dashed var(--line);
  border-radius: 4px;
  padding: 0 6px;
  line-height: 1.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
