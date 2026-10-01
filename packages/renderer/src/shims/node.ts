/**
 * 浏览器端的 node 内建模块垫片。
 * core 产物按 Node 编译,其模块级 import 具名绑定时会立即取属性,
 * vite 的外部化 stub 会在此抛错导致整个渲染层白屏;垫片只保证模块可加载——
 * 这些函数在浏览器里从不被调用(进程/文件能力只存在于 Electron 主进程)。
 */
export function randomUUID(): string {
  return crypto.randomUUID()
}

export function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

export function normalize(p: string): string {
  return p
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export function dirname(p: string): string {
  return p
}

export function pathToFileURL(p: string): { href: string } {
  return { href: p }
}

export const existsSync = (): boolean => false
export const mkdirSync = (): void => {}
export const readFileSync = (): string => ''
export const writeFileSync = (): void => {}
