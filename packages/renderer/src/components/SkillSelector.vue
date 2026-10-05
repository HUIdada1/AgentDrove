<script setup lang="ts">
import { computed, ref } from 'vue'
import { BUILTIN_SKILLS, type SkillDefinition } from '@agent-drove/shared'
import { useAppStore } from '../stores/app'
import GlassSelect from '../ui/GlassSelect.vue'

const props = withDefaults(
  defineProps<{
    compact?: boolean
    /** G1-03:当前客户端是否透传工具禁用清单(denyList);缺省 true。
     * codex/qoder/trae 不透传时技能芯片置灰并提示「仅作意图标记」,避免安全语义静默失效 */
    denySupported?: boolean
  }>(),
  { compact: false, denySupported: true },
)

const store = useAppStore()

const activeSkillsSet = computed(() => new Set(store.activeSkills.value))

interface Preset {
  id: string
  label: string
  skills: string[]
}

const PRESETS: Preset[] = [
  { id: 'full', label: '全能开发', skills: ['terminal', 'file_editor', 'code_search', 'web_search', 'test_runner'] },
  { id: 'code', label: '代码专注', skills: ['file_editor', 'code_search'] },
  { id: 'safe', label: '安全只读', skills: ['code_search', 'git_review'] },
  { id: 'test', label: '测试套件', skills: ['terminal', 'file_editor', 'test_runner'] },
]

// G1-03:预设一键切换在 compact 形态也可达——下拉由一次性动作驱动,选中后复位回 placeholder
const presetValue = ref('')
const presetOptions = PRESETS.map((p) => ({ value: p.id, label: p.label }))

function onPresetChange(value: string): void {
  const preset = PRESETS.find((p) => p.id === value)
  if (preset) applyPreset(preset)
  presetValue.value = ''
}

function applyPreset(preset: Preset): void {
  store.setSkills(preset.skills)
}

function isSkillActive(skill: SkillDefinition): boolean {
  return activeSkillsSet.value.has(skill.id)
}

/** G1-03:芯片 title——驱动不透传 denyList 时加前缀如实告知,安全语义不再静默失效 */
function chipTitle(skill: SkillDefinition): string {
  const detail = `${skill.label} (${skill.description})${skill.disallowedTools?.length ? '\n关闭时注入禁用: ' + skill.disallowedTools.join(', ') : ''}`
  return props.denySupported ? detail : `该客户端不透传工具禁用,开关仅作意图标记\n${detail}`
}
</script>

<template>
  <div class="skill-bar" :class="{ compact }">
    <div class="skills-list">
      <button
        v-for="skill in BUILTIN_SKILLS"
        :key="skill.id"
        class="skill-chip"
        :class="{ active: isSkillActive(skill), denied: !props.denySupported }"
        :title="chipTitle(skill)"
        type="button"
        @click="store.toggleSkill(skill.id)"
      >
        <span class="name">{{ skill.label }}</span>
        <span class="dot" />
      </button>
      <!-- G1-03:预设入口收敛为单个下拉,compact 与完整形态统一可达 -->
      <GlassSelect
        v-model="presetValue"
        class="preset-select"
        :options="presetOptions"
        placeholder="预设"
        title="技能预设:一键切换常用组合"
        @change="onPresetChange"
      />
    </div>
  </div>
</template>

<style scoped>
.skill-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.skill-bar.compact {
  gap: 5px;
}

.skills-list {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* G1-03:预设下拉与芯片同行,紧凑尺寸贴齐胶囊/发布框空间 */
.preset-select {
  min-width: 72px;
}

.preset-select :deep(.g-select-trigger) {
  height: 24px;
  padding: 0 8px;
  font-size: 11.5px;
}

.skill-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--chip-bg);
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 11.5px;
  cursor: pointer;
  transition: all var(--fast) var(--ease);
  user-select: none;
}

.skill-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--faint);
  transition: all var(--fast) var(--ease);
}

.skill-chip:hover {
  border-color: var(--line-strong);
  color: var(--text);
}

.skill-chip.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
}

.skill-chip.active .dot {
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
}

/* G1-03:驱动不透传 denyList 时芯片整体降级——仍可点(意图标记),但视觉明确不再是安全开关 */
.skill-chip.denied {
  opacity: 0.5;
  cursor: not-allowed;
}

.skill-chip.denied:hover {
  border-color: var(--line);
  color: var(--muted);
}
</style>
