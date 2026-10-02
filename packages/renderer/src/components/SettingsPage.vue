<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AppConfig, UpdatePhase } from '@agent-drove/shared'
import { useAppStore } from '../stores/app'

const store = useAppStore()

const draft = ref<AppConfig | null>(null)
const saved = ref(false)
const hotkeyConflict = ref('')

let savedTimer: ReturnType<typeof setTimeout> | undefined
let offConflict: (() => void) | null = null

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: '未检查',
  checking: '检查中…',
  available: '发现新版本',
  'not-available': '已是最新',
  downloading: '下载中…',
  downloaded: '已下载,待安装',
  error: '更新出错',
}

const phaseText = computed(() => PHASE_TEXT[store.updateStatus.value.phase])
const phaseClass = computed(() => {
  const phase = store.updateStatus.value.phase
  if (phase === 'error') return 'err'
  if (phase === 'available' || phase === 'downloaded') return 'accent'
  return ''
})

onMounted(async () => {
  await store.refreshSettings()
  if (store.settings.value && !draft.value) {
    draft.value = JSON.parse(JSON.stringify(store.settings.value))
  }
  offConflict = window.api.onHotkeyConflict((accelerator) => {
    hotkeyConflict.value = accelerator
  })
})

onUnmounted(() => {
  offConflict?.()
  clearTimeout(savedTimer)
})

async function save(): Promise<void> {
  const d = draft.value
  if (!d) return
  // settings:update 按顶层浅合并,嵌套组必须整对象提交,否则会丢组内未编辑字段
  await window.api.settingsUpdate({
    throttle: { ...d.throttle },
    task: { ...d.task },
    danger: { ...d.danger },
  })
  await store.refreshSettings()
  saved.value = true
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    saved.value = false
  }, 2000)
}

function toggleYolo(): void {
  const d = draft.value
  if (!d) return
  if (d.danger.allowYolo) {
    d.danger.allowYolo = false
    return
  }
  if (!window.confirm('yolo 为全权限执行,仅限完全可信任务。确定开启?')) return
  if (!window.confirm('再次确认:开启后任务将绕过全部工具审批,继续吗?')) return
  d.danger.allowYolo = true
}

async function runExport(kind: 'data' | 'report'): Promise<void> {
  try {
    const result =
      kind === 'data' ? await window.api.exportData() : await window.api.exportWeeklyReport()
    window.alert(`已导出:${result.path}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== '已取消导出') window.alert(`导出失败:${message}`)
  }
}
</script>

<template>
  <div class="page view">
    <header class="head">
      <button class="ghost" @click="store.view.value = 'panel'">← 返回面板</button>
      <span class="title">设置</span>
      <span class="spacer" />
      <transition name="fade">
        <span v-if="saved" class="saved">已保存</span>
      </transition>
      <button class="primary" :disabled="!draft" @click="save">保存</button>
    </header>

    <div v-if="draft" class="body">
      <section class="card">
        <h2>调度</h2>
        <div class="grid">
          <label>
            全局并发
            <input v-model.number="draft.throttle.globalConcurrency" type="number" min="1" />
          </label>
          <label>
            每客户端最小间隔(ms)
            <input v-model.number="draft.throttle.minIntervalMs" type="number" min="0" step="500" />
          </label>
          <label>
            抖动(ms)
            <input v-model.number="draft.throttle.jitterMs" type="number" min="0" step="500" />
          </label>
        </div>
        <div class="switch-row">
          <span>重试前确认<small>重试会再次消耗套餐额度</small></span>
          <button
            class="toggle"
            role="switch"
            :aria-checked="draft.task.confirmRetry"
            :class="{ on: draft.task.confirmRetry }"
            @click="draft.task.confirmRetry = !draft.task.confirmRetry"
          ><i /></button>
        </div>
        <div class="switch-row">
          <span>失败自动降级<small>失败时按健康度换客户端重试</small></span>
          <button
            class="toggle"
            role="switch"
            :aria-checked="draft.task.failover.enabled"
            :class="{ on: draft.task.failover.enabled }"
            @click="draft.task.failover.enabled = !draft.task.failover.enabled"
          ><i /></button>
        </div>
        <label v-if="draft.task.failover.enabled" class="inline">
          降级重试上限
          <input v-model.number="draft.task.failover.maxRetries" type="number" min="0" />
        </label>
      </section>

      <section class="card">
        <h2>任务</h2>
        <div class="grid">
          <label>
            默认档位
            <select v-model="draft.task.defaultMode">
              <option value="build">build</option>
              <option value="edit">edit</option>
              <option value="plan">plan</option>
            </select>
          </label>
          <label>
            任务超时(ms)
            <input
              v-model.number="draft.task.defaultTimeoutMs"
              type="number"
              min="60000"
              step="60000"
            />
          </label>
          <label>
            派生工作区保留(小时)
            <input v-model.number="draft.task.workspaceCleanupHours" type="number" min="1" />
          </label>
        </div>
      </section>

      <section class="card">
        <h2>快捷键</h2>
        <div class="hotkey mono">{{ store.settings.value?.hotkey ?? '—' }}</div>
        <p class="muted">唤起迷你派发条。快捷键在设置文件(yaml)修改后重启生效。</p>
        <div v-if="hotkeyConflict" class="conflict">
          热键 {{ hotkeyConflict }} 注册失败,可能已被其他程序占用,请修改后重启。
        </div>
      </section>

      <section class="card">
        <h2>更新</h2>
        <div class="update-row">
          <span>状态:<span :class="phaseClass" class="phase">{{ phaseText }}</span></span>
          <span v-if="store.updateStatus.value.detail" class="muted mono detail">
            {{ store.updateStatus.value.detail }}
          </span>
          <span class="spacer" />
          <button
            v-if="store.updateStatus.value.phase !== 'downloaded'"
            @click="void window.api.updateCheck()"
          >
            检查更新
          </button>
          <button v-else class="primary" @click="window.api.updateInstall()">重启安装</button>
        </div>
        <div v-if="store.updateStatus.value.phase === 'downloading'" class="prog">
          <div :style="{ width: `${Math.round((store.updateStatus.value.progress ?? 0) * 100)}%` }" />
        </div>
        <p class="muted">更新包从 GitHub Releases 下载,下载完成后重启安装。</p>
      </section>

      <section class="card">
        <h2>数据</h2>
        <div class="grid">
          <button @click="runExport('data')">导出数据(JSON)</button>
          <button @click="runExport('report')">导出周用量报告(CSV)</button>
        </div>
      </section>

      <section class="card">
        <h2>Danger</h2>
        <div class="switch-row">
          <span>--mode yolo 放行<small>开启后派发可使用 yolo 档位</small></span>
          <button
            class="toggle"
            role="switch"
            :aria-checked="draft.danger.allowYolo"
            :class="{ on: draft.danger.allowYolo }"
            @click="toggleYolo"
          ><i /></button>
        </div>
        <div v-if="draft.danger.allowYolo" class="conflict">
          yolo 为全权限执行,仅限完全可信任务
        </div>
      </section>

      <section class="card">
        <h2>关于</h2>
        <div class="about">
          <span class="brand">AgentDrove</span>
          <span class="mono muted">v{{ __APP_VERSION__ }}</span>
          <span class="muted">作者:沐辉</span>
        </div>
        <p class="muted">更新状态:{{ phaseText }}</p>
      </section>
    </div>

    <div v-else class="empty">加载设置中…</div>
  </div>
</template>

<style scoped>
.page {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--glass-bg);
}

.title {
  font-weight: 600;
}

.spacer {
  flex: 1;
}

.saved {
  color: var(--ok);
  font-size: 12px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--fast);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 12px;
  align-content: start;
}

.card {
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-md);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  box-shadow: inset 0 1px 0 var(--glass-specular);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.card h2 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--muted);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.grid label,
.inline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

.inline {
  margin-top: 2px;
}

.grid input,
.grid select,
.inline input {
  font-size: 12px;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}

.switch-row small {
  display: block;
  color: var(--muted);
  font-size: 11px;
}

.toggle {
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: var(--field-bg);
  border: 1px solid var(--line);
  position: relative;
  padding: 0;
  flex-shrink: 0;
}

.toggle i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--muted);
  transition: left var(--fast), background var(--fast);
}

.toggle.on {
  background: var(--accent-dim);
  border-color: var(--accent-line);
}

.toggle.on i {
  left: 16px;
  background: var(--accent);
}

.hotkey {
  align-self: flex-start;
  font-family: var(--mono);
  background: var(--field-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
}

.update-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  flex-wrap: wrap;
}

.update-row .spacer {
  flex: 1;
}

.phase {
  font-weight: 600;
}

.phase.accent {
  color: var(--accent);
}

.phase.err {
  color: var(--err);
}

.detail {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prog {
  height: 4px;
  border-radius: 2px;
  background: var(--chip-bg);
  overflow: hidden;
}

.prog > div {
  height: 100%;
  background: var(--accent);
  transition: width var(--fast);
}

.conflict {
  border: 1px solid color-mix(in srgb, var(--err) 40%, transparent);
  background: color-mix(in srgb, var(--err) 9%, transparent);
  color: var(--err);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  font-size: 12px;
}

.about {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.brand {
  font-weight: 600;
}

.mono {
  font-family: var(--mono);
}

.muted {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
}

.empty {
  color: var(--muted);
  text-align: center;
  margin-top: 60px;
}
</style>
