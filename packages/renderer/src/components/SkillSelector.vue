<script setup lang="ts">
import { computed } from 'vue'
import { BUILTIN_SKILLS, type SkillDefinition } from '@agent-drove/shared'
import { useAppStore } from '../stores/app'

const props = withDefaults(
  defineProps<{
    compact?: boolean
  }>(),
  { compact: false },
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

function applyPreset(preset: Preset): void {
  store.setSkills(preset.skills)
}

function isSkillActive(skill: SkillDefinition): boolean {
  return activeSkillsSet.value.has(skill.id)
}
</script>

<template>
  <div class="skill-bar" :class="{ compact }">
    <div v-if="!compact" class="presets">
      <span class="label">技能预设:</span>
      <button
        v-for="p in PRESETS"
        :key="p.id"
        class="preset-btn"
        type="button"
        @click="applyPreset(p)"
      >
        <span class="name">{{ p.label }}</span>
      </button>
    </div>

    <div class="skills-list">
      <button
        v-for="skill in BUILTIN_SKILLS"
        :key="skill.id"
        class="skill-chip"
        :class="{ active: isSkillActive(skill) }"
        :title="`${skill.label} (${skill.description})${skill.disallowedTools?.length ? '\n关闭时注入禁用: ' + skill.disallowedTools.join(', ') : ''}`"
        type="button"
        @click="store.toggleSkill(skill.id)"
      >
        <span class="name">{{ skill.label }}</span>
        <span class="dot" />
      </button>
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

.presets {
  display: flex;
  align-items: center;
  gap: 5px;
}

.presets .label {
  font-size: 11px;
  color: var(--faint);
}

.preset-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: var(--radius-sm);
  background: var(--chip-bg);
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 11.5px;
  cursor: pointer;
  transition: all var(--fast) var(--ease);
}

.preset-btn:hover {
  background: var(--glass-bg-strong);
  color: var(--text);
  border-color: var(--line-strong);
}

.skills-list {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
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
</style>
