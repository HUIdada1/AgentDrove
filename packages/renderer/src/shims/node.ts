/**
 * 浏览器端的 node 内建模块垫片。
 * core 产物按 Node 编译,其模块级 import 具名绑定时会立即取属性,
 * vite 的外部化 stub 会在此抛错导致整个渲染层白屏;垫片只保证模块可加载——
 * 这些函数在浏览器里从不被调用(进程/文件能力只存在于 Electron 主进程)。
 *
 * 只导出 core 在渲染层链路里实际具名导入的符号(node:path 的 join/dirname/basename、
 * node:crypto 的 randomUUID、node:os 的 homedir/tmpdir);
 * core 新增其他内建依赖时需同步在此补导出,否则构建期会因缺失导出而报错(比运行期白屏更早暴露)。
 */
export function randomUUID(): string {
  return crypto.randomUUID()
}

export function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i > 0) return p.slice(0, i)
  return i === 0 ? '/' : '.'
}

export function homedir(): string {
  return ''
}

export function tmpdir(): string {
  return ''
}