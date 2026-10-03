import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// core 产物按 Node 编译,浏览器端内建模块走垫片(函数体在渲染层从不执行)
const nodeShim = fileURLToPath(new URL('./src/shims/node.ts', import.meta.url))

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'strip-csp-in-dev',
      // 产物 CSP 会拦掉 dev server 的 HMR websocket 与内联诊断脚本,仅在构建产物保留
      apply: 'serve',
      transformIndexHtml(html) {
        return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
      },
    },
  ],
  base: './',
  resolve: {
    alias: [
      { find: /^node:crypto$/, replacement: nodeShim },
      { find: /^node:path$/, replacement: nodeShim },
    ],
  },
  // 版本号进运行时常量,关于卡直接读,免一次 IPC 往返
  define: {
    __APP_VERSION__: JSON.stringify(
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version,
    ),
  },
  build: {
    outDir: 'dist',
    target: 'chrome128',
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    strictPort: true,
  },
})
