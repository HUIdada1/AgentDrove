<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

/**
 * 轻量安全 Markdown 渲染(S-18/C-09/C-13,零新增依赖):
 * 先对整个片段做 HTML 转义,再按行识别块级语法(标题/列表/围栏代码块),
 * 行内语法(行内代码/粗体/斜体/链接)只在已转义文本上做替换——
 * 因此任何原始 HTML 都不会成为标签,链接仅接受 http/https,其余按纯文本原样呈现。
 */
const props = defineProps<{
  text: string
  /** 折叠阈值(字符数):超过则默认折叠并提供「展开全文/收起」 */
  collapseThreshold?: number
}>()

/** 块渲染单元:html 为已转义文本生成的片段;code 非空 = 围栏代码块(走插值渲染,不解析) */
interface MdBlock {
  html: string
  code?: string
  lang?: string
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** 第一步永远是转义:此后任何用户文本都不具备标签能力 */
function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]!)
}

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

/** 行内语法:行内代码优先(代码内不再解析其它语法),随后链接、粗体、斜体 */
function renderInline(escaped: string): string {
  const parts = escaped.split('`')
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i] ?? ''
    if (i % 2 === 1) {
      out += `<code class="md-code">${seg}</code>`
      continue
    }
    out += seg
      .replace(LINK_RE, '<a class="md-link" href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/_([^_\n]+)_/g, '<em>$1</em>')
  }
  return out
}

const FENCE_RE = /^\s*```(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const UL_RE = /^\s*[-*+]\s+(.*)$/
const OL_RE = /^\s*\d+[.)]\s+(.*)$/

function parseBlocks(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  /** 段落缓冲:连续普通行合并为一段,段内换行交给 pre-wrap 保留(纯文本保真) */
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushPara = (): void => {
    if (para.length === 0) return
    blocks.push({ html: `<p class="md-p">${renderInline(escapeHtml(para.join('\n')))}</p>` })
    para = []
  }
  const flushList = (): void => {
    if (!list) return
    const tag = list.ordered ? 'ol' : 'ul'
    const items = list.items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join('')
    blocks.push({ html: `<${tag} class="md-list">${items}</${tag}>` })
    list = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    const fence = line.match(FENCE_RE)
    if (fence) {
      flushPara()
      flushList()
      const lang = (fence[1] ?? '').trim()
      const code: string[] = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        code.push(lines[i]!)
        i++
      }
      blocks.push({ html: '', code: code.join('\n'), lang })
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      flushPara()
      flushList()
      const level = heading[1]!.length
      blocks.push({ html: `<h${level} class="md-h">${renderInline(escapeHtml(heading[2]!))}</h${level}>` })
      continue
    }

    const ul = line.match(UL_RE)
    if (ul) {
      flushPara()
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(ul[1]!)
      continue
    }

    const ol = line.match(OL_RE)
    if (ol) {
      flushPara()
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(ol[1]!)
      continue
    }

    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }

    flushList()
    para.push(line)
  }

  flushPara()
  flushList()
  return blocks
}

const blocks = computed(() => parseBlocks(props.text))

const COLLAPSE_LIMIT = 8000
const collapsible = computed(() => props.text.length > (props.collapseThreshold ?? COLLAPSE_LIMIT))
const expanded = ref(false)

const copiedKey = ref(-1)
let copyTimer: ReturnType<typeof setTimeout> | null = null

/** 复制回退:剪贴板 API 不可用(非安全上下文/权限拒绝)时退回临时 textarea */
function legacyCopy(code: string): boolean {
  try {
    const area = document.createElement('textarea')
    area.value = code
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

async function copyCode(code: string | undefined, key: number): Promise<void> {
  if (code === undefined) return
  let ok = false
  try {
    await navigator.clipboard.writeText(code)
    ok = true
  } catch {
    ok = legacyCopy(code)
  }
  if (!ok) return
  copiedKey.value = key
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copiedKey.value = -1
  }, 1600)
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <div class="md-bubble" :class="{ clamped: collapsible && !expanded }">
    <div class="md-body">
      <template v-for="(b, bi) in blocks" :key="bi">
        <!-- 围栏代码块:语言标签 + 一键复制;代码走插值渲染(天然免注入) -->
        <div v-if="b.code !== undefined" class="md-code-block">
          <div class="md-code-head">
            <span class="md-lang">{{ b.lang || 'text' }}</span>
            <button type="button" class="md-copy" @click="copyCode(b.code, bi)">
              {{ copiedKey === bi ? '已复制' : '复制' }}
            </button>
          </div>
          <pre class="md-pre"><code>{{ b.code }}</code></pre>
        </div>
        <div v-else class="md-html" v-html="b.html" />
      </template>
    </div>
    <button v-if="collapsible" type="button" class="md-toggle" @click="expanded = !expanded">
      {{ expanded ? '收起' : `展开全文（共 ${text.length} 字符）` }}
    </button>
  </div>
</template>

<style scoped>
.md-bubble {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.md-body {
  position: relative;
  min-width: 0;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

/* >8000 字符默认折叠:限高 + 底部渐隐,展开按钮常驻可逆 */
.md-bubble.clamped .md-body {
  max-height: 320px;
  overflow: hidden;
}

.md-bubble.clamped .md-body::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 42px;
  background: linear-gradient(transparent, var(--glass-bg-strong));
  pointer-events: none;
}

.md-html {
  display: block;
  min-width: 0;
}

.md-html :deep(.md-p) {
  margin: 0 0 6px;
  white-space: pre-wrap;
}

.md-html :deep(.md-p:last-child) {
  margin-bottom: 0;
}

.md-html :deep(.md-h) {
  margin: 4px 0 6px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.35;
}

.md-html :deep(h1.md-h) { font-size: 16px; }
.md-html :deep(h2.md-h) { font-size: 15px; }
.md-html :deep(h3.md-h) { font-size: 14px; }
.md-html :deep(h4.md-h),
.md-html :deep(h5.md-h),
.md-html :deep(h6.md-h) { font-size: 13px; }

.md-html :deep(.md-list) {
  margin: 0 0 6px;
  padding-left: 20px;
}

.md-html :deep(.md-list li) {
  margin: 1px 0;
}

.md-html :deep(.md-code) {
  font-family: var(--mono);
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--chip-bg);
  border: 1px solid var(--line);
  color: var(--accent-strong);
}

.md-html :deep(.md-link) {
  color: var(--accent-strong);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.md-code-block {
  margin: 2px 0 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--field-bg);
  overflow: hidden;
}

.md-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--glass-bg);
}

.md-lang {
  font-size: 10.5px;
  color: var(--faint);
  font-family: var(--mono);
  text-transform: lowercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.md-copy {
  flex: none;
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--fast) var(--ease);
}

.md-copy:hover {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

.md-pre {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
}

.md-toggle {
  align-self: flex-start;
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--accent-line);
  background: var(--accent-dim);
  color: var(--accent-strong);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--fast) var(--ease);
}

.md-toggle:hover {
  background: var(--glass-bg-strong);
}
</style>
