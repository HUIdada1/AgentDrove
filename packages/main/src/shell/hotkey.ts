import { globalShortcut, BrowserWindow, clipboard } from 'electron'
import { join } from 'node:path'

export interface HotkeyDeps {
  accelerator: string
  /** 热键触发:唤起/隐藏迷你条(预填剪贴板选中文本,先展示再派发可撤销) */
  onActivate(): void
  /** 注册失败回调(冲突检测+引导改键) */
  onRegisterFailed(accelerator: string): void
}

/**
 * 全局热键(7.4):唤起迷你条。
 * 选中文本发送的实现口径:Electron 无法全局注入按键,迷你条打开时预填当前剪贴板;
 * 用户"选中→Ctrl+C→热键"或直接热键后粘贴,先展示可编辑,防误发敏感文本。
 */
export function registerHotkey(deps: HotkeyDeps): () => void {
  const ok = globalShortcut.register(deps.accelerator, () => deps.onActivate())
  if (!ok) deps.onRegisterFailed(deps.accelerator)
  return () => globalShortcut.unregister(deps.accelerator)
}

/** 迷你条:小窗快速派发,Enter 派发 / Esc 关闭 */
export function createMiniBarWindow(entryUrl: string): BrowserWindow {
  const mini = new BrowserWindow({
    width: 520,
    height: 150,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#10161b',
    webPreferences: {
      // 与 app.cjs 同级:打包后所有主进程模块合并进 dist,preload 在 dist/preload
      preload: join(import.meta.dirname, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void mini.loadURL(entryUrl + (entryUrl.includes('#') ? '&' : '#') + 'mini')
  return mini
}

export function toggleMiniBar(mini: BrowserWindow): void {
  if (mini.isVisible()) {
    mini.hide()
    return
  }
  mini.show()
  mini.focus()
  mini.webContents.send('mini:prefill', clipboard.readText().trim().slice(0, 4000))
}
