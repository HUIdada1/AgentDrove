<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChannelGroup } from '../labels'

const props = defineProps<{
  channelGroups: ChannelGroup[]
  currentChannelId: string
  currentModelId: string
  disabled?: boolean
  /** 锁定原因:触发器 disabled 时 title 明示(「该客户端不支持切换模型」/「无可用模型」) */
  disabledHint?: string
  /** 触发器 title 覆盖(会话底栏:S-07 未覆盖时沿用父任务：{模型} · {档位}) */
  triggerTitle?: string
  /**
   * 哨兵槽(B-03/S-03):存在时面板顶部渲染「↺ 跟随父任务（当前 X）」项——
   * 点击 emit select { channelId: 当前渠道, modelId: '' },会话侧据此清除本轮模型覆盖;
   * modelValue==='' 时该哨兵高亮,模型项一律不高亮,杜绝「点当前模型=制造伪覆盖」。
   */
  followSlot?: { label: string; hint?: string }
}>()

const emit = defineEmits<{
  (e: 'select', payload: { channelId: string; modelId: string }): void
}>()

/** 面板尺寸基准(S-08):翻转判定与右缘对齐换算的唯一来源 */
const PANEL_MAX_H = 380
const PANEL_W = 320

/** aria-activedescendant 需要文档内唯一 id:模块级计数器生成实例前缀 */
let selectorSeq = 0
const uid = `model-selector-${++selectorSeq}`
/** B14:listbox 的 id——combobox(开面板时=搜索框)用 aria-controls 指向它 */
const listboxId = `${uid}-listbox`

/** 键盘可达的扁平选项:哨兵项(若有)恒为 0 号,其余按渠道顺序摊平 */
interface FlatOption {
  channelId: string
  modelId: string
  label: string
  groupName: string
}

const isOpen = ref(false)
const keyword = ref('')
const selectorRef = ref<HTMLElement | null>(null)
/** Teleport 到 body 的弹层引用:outside-click/focusout 需同时把它算作「组件内」 */
const panelRef = ref<HTMLElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
/** 下方空间不足面板高度时向上弹出,与 GlassSelect 同款翻转 */
const openUp = ref(false)
/** 右缘溢出时靠右对齐 */
const alignRight = ref(false)
/** 面板高度 clamp 到视口内可用空间(A20:不设硬下限,矮窗/迷你窗不溢出) */
const panelMaxH = ref(PANEL_MAX_H)
/** A20:fixed 视口坐标——弹层不受会话列等 overflow 祖先裁切 */
const panelPos = ref({ top: 0, bottom: 0, left: 0, right: 0 })
/** 触发器宽度:弹层至少与触发器同宽 */
const triggerW = ref(120)
/** 键盘导航高亮项(仅移动高亮,Enter 才提交) */
const focusIndex = ref(-1)

const activeGroup = computed(() => {
  return props.channelGroups.find((g) => g.id === props.currentChannelId) || props.channelGroups[0]
})

/** 哨兵态(currentModelId==='')的触发器文案:显示场景化哨兵而非「选择模型」 */
const currentModelLabel = computed(() => {
  if (!props.currentModelId) {
    if (props.followSlot) return props.followSlot.label
    return props.channelGroups.length > 0 ? '选择模型' : '无可用模型'
  }
  const currentGroup = props.channelGroups.find((g) => g.id === props.currentChannelId)
  const item = currentGroup?.models.find((m) => m.value === props.currentModelId)
  if (item?.label) return item.label
  // 若当前渠道未找到，尝试全渠道搜索
  for (const g of props.channelGroups) {
    const found = g.models.find((m) => m.value === props.currentModelId)
    if (found?.label) return found.label
  }
  return props.currentModelId
})

/** 触发器 title:disabled 附原因;调用方未给时用模型全名 */
const triggerTitle = computed(() => {
  if (props.disabled) return props.disabledHint || '该客户端不支持切换模型'
  if (props.triggerTitle) return props.triggerTitle
  return `当前模型: ${currentModelLabel.value}${activeGroup.value ? ` (${activeGroup.value.name})` : ''}`
})

/** 过滤模型列表：支持搜索关键字跨渠道过滤;哨兵项一并参与关键字匹配 */
const filteredGroups = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return props.channelGroups
  return props.channelGroups
    .map((g) => ({
      ...g,
      models: g.models.filter(
        (m) => m.label.toLowerCase().includes(kw) || m.value.toLowerCase().includes(kw),
      ),
    }))
    .filter((g) => g.models.length > 0)
})

const followVisible = computed(() => {
  if (!props.followSlot) return false
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return true
  return props.followSlot.label.toLowerCase().includes(kw)
})

/** 键盘序列 = 可见哨兵项 + 可见模型项,与渲染顺序严格一致 */
const visibleOptions = computed<FlatOption[]>(() => {
  const list: FlatOption[] = []
  if (props.followSlot && followVisible.value) {
    list.push({ channelId: props.currentChannelId, modelId: '', label: props.followSlot.label, groupName: '' })
  }
  for (const g of filteredGroups.value) {
    for (const m of g.models) {
      list.push({ channelId: g.id, modelId: m.value, label: m.label, groupName: g.name })
    }
  }
  return list
})

function optionId(index: number): string {
  return `${uid}-opt-${index}`
}

/** 模型项在键盘序列中的下标(渲染分组与扁平序列对齐用;模型量级下 O(n) 查找足够) */
function optionIndex(channelId: string, modelId: string): number {
  return visibleOptions.value.findIndex((o) => o.channelId === channelId && o.modelId === modelId)
}

/** 打开时高亮的当前项:哨兵态落在哨兵项,模型态落在同渠道同模型项 */
function currentIndexOf(list: FlatOption[]): number {
  if (!props.currentModelId) return props.followSlot && list[0]?.modelId === '' ? 0 : -1
  const exact = list.findIndex(
    (o) => o.modelId === props.currentModelId && o.channelId === props.currentChannelId,
  )
  if (exact >= 0) return exact
  return list.findIndex((o) => o.modelId === props.currentModelId)
}

/** A20:按触发器视口坐标测量;弹层经 Teleport fixed 定位,不被任何 overflow 祖先裁切 */
function measurePanel(): void {
  const rect = selectorRef.value?.getBoundingClientRect()
  if (!rect) return
  const GAP = 6
  const MARGIN = 8
  const spaceBelow = window.innerHeight - rect.bottom - GAP
  const spaceAbove = rect.top - GAP
  openUp.value = spaceBelow < PANEL_MAX_H && spaceAbove > spaceBelow
  triggerW.value = rect.width
  // 面板上下边视口坐标,clamp 到视口内(触发器被滚动带出视口时面板仍贴边可见)
  const topY = Math.min(Math.max(rect.bottom + GAP, MARGIN), window.innerHeight - MARGIN)
  const bottomY = Math.min(Math.max(rect.top - GAP, MARGIN), window.innerHeight - MARGIN)
  const avail = openUp.value ? bottomY - MARGIN : window.innerHeight - topY - MARGIN
  panelMaxH.value = Math.min(PANEL_MAX_H, Math.max(avail, 40))
  alignRight.value = window.innerWidth - rect.left < PANEL_W
  panelPos.value = {
    top: topY,
    bottom: window.innerHeight - bottomY,
    left: rect.left,
    right: window.innerWidth - rect.right,
  }
}

/** 弹层内联样式:方向 + 视口坐标 + 高度/最小宽度 */
const panelStyle = computed(() => {
  const p = panelPos.value
  return {
    top: openUp.value ? 'auto' : `${p.top}px`,
    bottom: openUp.value ? `${p.bottom}px` : 'auto',
    left: alignRight.value ? 'auto' : `${p.left}px`,
    right: alignRight.value ? `${p.right}px` : 'auto',
    maxHeight: `${panelMaxH.value}px`,
    minWidth: `${triggerW.value}px`,
  }
})

function openDropdown(): void {
  if (props.disabled) return
  measurePanel()
  keyword.value = ''
  isOpen.value = true
  // 打开即高亮当前选中项(无选中停在 -1,首次 ↓ 落到第 0 项)
  focusIndex.value = currentIndexOf(visibleOptions.value)
  // S-08:搜索框挂载后聚焦,键盘可直接过滤
  void nextTick(() => searchRef.value?.focus())
}

function toggleDropdown(): void {
  if (props.disabled) return
  if (isOpen.value) isOpen.value = false
  else openDropdown()
}

function selectOption(opt: FlatOption): void {
  if (props.disabled) return
  emit('select', { channelId: opt.channelId, modelId: opt.modelId })
  isOpen.value = false
}

function onClickOutside(event: MouseEvent): void {
  const target = event.target as Node
  if (selectorRef.value?.contains(target)) return
  // 弹层 Teleport 到 body 后不在 selector 内,单独放行
  if (panelRef.value?.contains(target)) return
  isOpen.value = false
}

/** 失焦收起:Tab 把焦点移出组件后立即收起面板;搜索框在弹层内(Teleport),relatedTarget 落其中同样放行 */
function onFocusout(event: FocusEvent): void {
  const related = event.relatedTarget as Node | null
  if (!related) {
    isOpen.value = false
    return
  }
  if (selectorRef.value?.contains(related)) return
  if (panelRef.value?.contains(related)) return
  isOpen.value = false
}

/** A20:窗口尺寸变化/任意祖先滚动时面板跟随重定位(fixed 坐标基于视口,须同步刷新) */
function onViewportChange(): void {
  if (isOpen.value) measurePanel()
}

/** combobox 键盘惯例:↓↑ 只移动高亮,Enter 确认,Esc 关闭不改值,Home/End 跳首尾 */
function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (!isOpen.value) {
      openDropdown()
      return
    }
    const opt = visibleOptions.value[focusIndex.value]
    if (opt) selectOption(opt)
    else isOpen.value = false
  } else if (event.key === 'Escape') {
    isOpen.value = false
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!isOpen.value) {
      openDropdown()
      return
    }
    if (visibleOptions.value.length > 0 && focusIndex.value < visibleOptions.value.length - 1) {
      focusIndex.value++
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!isOpen.value) {
      openDropdown()
      return
    }
    if (focusIndex.value > 0) focusIndex.value--
  } else if (event.key === 'Home' && isOpen.value) {
    event.preventDefault()
    if (visibleOptions.value.length > 0) focusIndex.value = 0
  } else if (event.key === 'End' && isOpen.value) {
    event.preventDefault()
    if (visibleOptions.value.length > 0) focusIndex.value = visibleOptions.value.length - 1
  }
}

/** 搜索框内键盘:↓↑ 走高亮,Enter 确认当前高亮项,Esc 关闭;stop 阻断外层重复处理 */
function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (visibleOptions.value.length > 0 && focusIndex.value < visibleOptions.value.length - 1) {
      focusIndex.value++
    }
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (focusIndex.value > 0) focusIndex.value--
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const opt = visibleOptions.value[focusIndex.value]
    if (opt) selectOption(opt)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    isOpen.value = false
  }
}

// 高亮项跟随滚动:键盘移动时把该项滚入可视区(nearest 不产生多余滚动)
watch(focusIndex, async (idx) => {
  if (!isOpen.value || idx < 0) return
  await nextTick()
  selectorRef.value
    ?.querySelector(`#${CSS.escape(optionId(idx))}`)
    ?.scrollIntoView({ block: 'nearest' })
})

// 关键字变化后过滤集变化,高亮重置;flush:sync——openDropdown 清关键字时同步重置,
// 再由其后设置的选中高亮覆盖
watch(
  keyword,
  () => {
    focusIndex.value = -1
  },
  { flush: 'sync' },
)

onMounted(() => {
  document.addEventListener('click', onClickOutside)
  selectorRef.value?.addEventListener('focusout', onFocusout)
  window.addEventListener('resize', onViewportChange)
  // capture:true 捕获所有滚动容器(会话列/模态滚动区),面板不脱锚
  window.addEventListener('scroll', onViewportChange, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutside)
  selectorRef.value?.removeEventListener('focusout', onFocusout)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <!-- B14:combobox 语义只落在实际持焦元素上——收起态焦点在触发器容器(role=button 弹层入口),
       展开态焦点交给下方搜索框(role=combobox + aria-activedescendant),屏幕阅读器能读到高亮项 -->
  <div
    ref="selectorRef"
    class="model-selector-wrapper"
    :class="{ open: isOpen, disabled }"
    tabindex="0"
    role="button"
    aria-haspopup="listbox"
    :aria-expanded="isOpen"
    :aria-disabled="disabled"
    :title="triggerTitle"
    @keydown="onKeydown"
  >
    <!-- 现代化一体胶囊触发器(键盘入口在容器,触发器仅作点击面) -->
    <div class="model-trigger glass" :class="{ 'is-open': isOpen }" @click="toggleDropdown">
      <span class="model-ico">⚡</span>
      <span class="model-name">{{ currentModelLabel }}</span>
      <span v-if="channelGroups.length > 1 && activeGroup && currentModelId" class="provider-badge">
        {{ activeGroup.name }}
      </span>
      <span class="chevron" :class="{ rotated: isOpen }">▾</span>
    </div>

    <!-- 弹层面板(A20:Teleport 到 body + fixed 定位,不被会话列等 overflow 祖先裁切) -->
    <Teleport to="body">
      <Transition name="fade-slide">
        <div
          v-if="isOpen"
          ref="panelRef"
          class="model-popover glass"
          :style="panelStyle"
          @click.stop
        >
        <div class="search-box">
          <!-- B14:持焦的搜索框才是 combobox——aria-controls 指向下方 listbox,
               aria-activedescendant 指向当前高亮项(↓↑ 只移高亮不改 DOM 焦点) -->
          <input
            ref="searchRef"
            v-model="keyword"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-label="搜索模型"
            :aria-controls="listboxId"
            :aria-activedescendant="focusIndex >= 0 ? optionId(focusIndex) : undefined"
            placeholder="搜索模型 (如 sonnet, deepseek, gpt)..."
            @keydown.stop="onSearchKeydown"
          />
          <button v-if="keyword" class="clear-btn" type="button" @click="keyword = ''">×</button>
        </div>

        <div :id="listboxId" class="groups-list custom-scroll" role="listbox">
          <!-- B-03/S-03 哨兵项:恢复「跟随父任务」的首选入口,点击即清除本轮模型覆盖 -->
          <button
            v-if="followSlot && followVisible"
            :id="optionId(0)"
            type="button"
            class="follow-item"
            role="option"
            :aria-selected="!currentModelId"
            :class="{ active: !currentModelId, focused: focusIndex === 0 }"
            :title="followSlot.hint"
            @mousedown.prevent
            @click="selectOption(visibleOptions[0]!)"
            @mouseenter="focusIndex = 0"
          >
            <span class="name">↺ {{ followSlot.label }}</span>
          </button>

          <div v-if="visibleOptions.length === 0" class="empty-hint">未找到匹配模型</div>
          <div v-for="grp in filteredGroups" :key="grp.id" class="group-section">
            <div class="group-header">
              <span>{{ grp.name }}</span>
              <span class="group-count">{{ grp.models.length }}</span>
            </div>
            <div class="model-items">
              <button
                v-for="m in grp.models"
                :id="optionId(optionIndex(grp.id, m.value))"
                :key="m.value"
                type="button"
                class="model-item-btn"
                role="option"
                :aria-selected="m.value === currentModelId && grp.id === currentChannelId"
                :class="{
                  active: m.value === currentModelId && grp.id === currentChannelId,
                  focused: optionIndex(grp.id, m.value) === focusIndex,
                }"
                @mousedown.prevent
                @click="selectOption({ channelId: grp.id, modelId: m.value, label: m.label, groupName: grp.name })"
                @mouseenter="focusIndex = optionIndex(grp.id, m.value)"
              >
                <span class="name">{{ m.label }}</span>
                <span
                  v-if="
                    m.value.toLowerCase().includes('r1') ||
                    m.value.toLowerCase().includes('o1') ||
                    m.value.toLowerCase().includes('o3') ||
                    m.value.toLowerCase().includes('thinking')
                  "
                  class="feature-tag thinking"
                >
                  🧠 思考
                </span>
                <span
                  v-else-if="
                    m.value.toLowerCase().includes('flash') ||
                    m.value.toLowerCase().includes('mini') ||
                    m.value.toLowerCase().includes('turbo')
                  "
                  class="feature-tag fast"
                >
                  ⚡ 极速
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.model-selector-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  outline: none;
  user-select: none;
}

.model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--surface-dim);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 160ms var(--ease);
  max-width: 260px;
  min-width: 110px;
  box-sizing: border-box;
}

.model-selector-wrapper:hover:not(.disabled) .model-trigger {
  border-color: var(--accent-line);
  background: var(--surface-bright);
}

.model-selector-wrapper:focus-visible .model-trigger,
.model-trigger.is-open {
  border-color: var(--accent-strong);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

.model-selector-wrapper.disabled .model-trigger {
  opacity: 0.55;
  cursor: not-allowed;
}

.model-ico {
  font-size: 12px;
  color: var(--accent-strong);
  flex-shrink: 0;
}

.model-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-align: left;
}

.provider-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-bright);
  color: var(--muted);
  border: 1px solid var(--line);
  flex-shrink: 0;
  max-width: 65px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chevron {
  font-size: 9px;
  color: var(--muted);
  transition: transform 160ms var(--ease);
  flex-shrink: 0;
}

.chevron.rotated {
  transform: rotate(180deg);
}

.model-popover {
  /* A20:fixed 视口定位(经 Teleport 落在 body 下),宽高均 clamp 到视口内 */
  position: fixed;
  z-index: var(--z-popover);
  width: min(320px, calc(100vw - 20px));
  max-height: 380px;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  border: 1px solid var(--accent-line);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), var(--glass-shadow);
  padding: 8px;
  box-sizing: border-box;
  background: var(--surface);
  backdrop-filter: blur(20px);
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 6px;
}

.search-box input {
  width: 100%;
  height: 28px;
  padding: 0 24px 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface-dim);
  color: var(--text);
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 140ms;
}

.search-box input:focus {
  border-color: var(--accent-strong);
}

.clear-btn {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-70%);
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

.groups-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.empty-hint {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}

.group-section {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 6px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.group-count {
  font-size: 10px;
  color: var(--faint);
  background: var(--surface-dim);
  padding: 0 4px;
  border-radius: 999px;
}

.model-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-item-btn,
.follow-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: all 120ms;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}

.model-item-btn:hover,
.follow-item:hover,
.model-item-btn.focused,
.follow-item.focused {
  background: var(--surface-dim);
  border-color: var(--line);
}

.model-item-btn.active,
.follow-item.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
}

/* 哨兵项:与模型项同构,顶部分隔线提示「清除覆盖」语义 */
.follow-item {
  color: var(--accent-strong);
  border-bottom: 1px solid var(--line);
  border-radius: var(--radius-sm);
  margin-bottom: 4px;
}

.model-item-btn .name,
.follow-item .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feature-tag {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  margin-left: 6px;
  flex-shrink: 0;
}

.feature-tag.thinking {
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
  border: 1px solid rgba(168, 85, 247, 0.3);
}

.feature-tag.fast {
  background: rgba(59, 130, 246, 0.15);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.3);
}

.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
