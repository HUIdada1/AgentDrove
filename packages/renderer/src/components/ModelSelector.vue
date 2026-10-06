<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ChannelGroup } from '../labels'

const props = defineProps<{
  channelGroups: ChannelGroup[]
  currentChannelId: string
  currentModelId: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', payload: { channelId: string; modelId: string }): void
}>()

const isOpen = ref(false)
const keyword = ref('')
const selectorRef = ref<HTMLElement | null>(null)

const activeGroup = computed(() => {
  return props.channelGroups.find((g) => g.id === props.currentChannelId) || props.channelGroups[0]
})

const currentModelLabel = computed(() => {
  const currentGroup = props.channelGroups.find((g) => g.id === props.currentChannelId)
  const item = currentGroup?.models.find((m) => m.value === props.currentModelId)
  if (item?.label) return item.label
  // 若当前渠道未找到，尝试全渠道搜索
  for (const g of props.channelGroups) {
    const found = g.models.find((m) => m.value === props.currentModelId)
    if (found?.label) return found.label
  }
  return props.currentModelId || '选择模型'
})

// 过滤模型列表：支持搜索关键字跨渠道过滤
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

function toggleDropdown(): void {
  if (props.disabled) return
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    keyword.value = ''
  }
}

function handleSelect(channelId: string, modelId: string): void {
  emit('select', { channelId, modelId })
  isOpen.value = false
}

function onClickOutside(event: MouseEvent): void {
  if (selectorRef.value && !selectorRef.value.contains(event.target as Node)) {
    isOpen.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isOpen.value) {
    isOpen.value = false
  }
}

onMounted(() => {
  window.addEventListener('click', onClickOutside)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', onClickOutside)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="selectorRef" class="model-selector-wrapper">
    <!-- 现代化一体胶囊触发器 -->
    <button
      type="button"
      class="model-trigger glass"
      :class="{ disabled, 'is-open': isOpen }"
      :disabled="disabled"
      :title="`当前模型: ${currentModelLabel}${activeGroup ? ` (${activeGroup.name})` : ''}`"
      @click="toggleDropdown"
    >
      <span class="model-ico">⚡</span>
      <span class="model-name">{{ currentModelLabel }}</span>
      <span v-if="channelGroups.length > 1 && activeGroup" class="provider-badge">
        {{ activeGroup.name }}
      </span>
      <span class="chevron" :class="{ rotated: isOpen }">▾</span>
    </button>

    <!-- 弹层面板 -->
    <Transition name="fade-slide">
      <div v-if="isOpen" class="model-popover glass" @click.stop>
        <div class="search-box">
          <input
            v-model="keyword"
            placeholder="搜索模型 (如 sonnet, deepseek, gpt)..."
            autofocus
            @keydown.enter.prevent
          />
          <button v-if="keyword" class="clear-btn" type="button" @click="keyword = ''">×</button>
        </div>

        <div class="groups-list custom-scroll">
          <div v-if="filteredGroups.length === 0" class="empty-hint">未找到匹配模型</div>
          <div v-for="grp in filteredGroups" :key="grp.id" class="group-section">
            <div class="group-header">
              <span>{{ grp.name }}</span>
              <span class="group-count">{{ grp.models.length }}</span>
            </div>
            <div class="model-items">
              <button
                v-for="m in grp.models"
                :key="m.value"
                type="button"
                class="model-item-btn"
                :class="{ active: m.value === currentModelId && grp.id === currentChannelId }"
                @click="handleSelect(grp.id, m.value)"
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
  </div>
</template>

<style scoped>
.model-selector-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
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

.model-trigger:hover:not(.disabled) {
  border-color: var(--accent-line);
  background: var(--surface);
}

.model-trigger.is-open {
  border-color: var(--accent-strong);
  box-shadow: 0 0 0 2px var(--accent-dim);
}

.model-trigger.disabled {
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
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 2500;
  width: 320px;
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
  max-height: 300px;
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.model-item-btn {
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
}

.model-item-btn:hover {
  background: var(--surface-dim);
  border-color: var(--line);
}

.model-item-btn.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
}

.model-item-btn .name {
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
