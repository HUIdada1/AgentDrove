import { app, Menu, Tray, nativeImage, dialog, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { Orchestrator, Registry } from '@agent-drove/core'

export interface TrayDeps {
  orchestrator: Orchestrator
  registry: Registry
  iconPath: string
  isPaused(): boolean
  setPaused(paused: boolean): void
  checkUpdates(): void
  launchClient(agentId: string): void
  onQuitRequested(): Promise<'wait' | 'cancel-and-exit' | 'force'>
}

/**
 * 托盘(7.1):打开面板/快速派发/打开客户端(动态)/暂停调度(持久化)/检查更新/退出三选。
 * 返回 rebuild 供客户端探测完成后重建菜单(启动时探测后台跑,菜单先以空客户端列表就位)。
 */
export function createTray(deps: TrayDeps): { tray: Tray; rebuild(): void } {
  // 空 icon 会让托盘不可见,必须落在实体图标上
  let icon = nativeImage.createFromPath(deps.iconPath)
  if (icon.isEmpty() && process.resourcesPath) {
    icon = nativeImage.createFromPath(join(process.resourcesPath, 'icon.png'))
  }
  const tray = new Tray(icon)
  tray.setToolTip('AgentDrove')

  const buildMenu = () =>
    Menu.buildFromTemplate([
      { label: '打开面板', click: () => showPanel() },
      { label: '快速派发', click: () => showPanel({ quick: true }) },
      { type: 'separator' },
      ...deps.registry.list().map((profile) => ({
        label: `打开 ${profile.label}`,
        click: () => deps.launchClient(profile.id),
      })),
      { type: 'separator' },
      {
        label: '暂停调度',
        type: 'checkbox',
        checked: deps.isPaused(),
        click: (item) => deps.setPaused(item.checked),
      },
      { label: '检查更新', click: () => deps.checkUpdates() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          void deps.onQuitRequested().then((choice) => {
            // 走 app.quit 而非 app.exit:后者不触发 before-quit,会跳过事件落盘与关库清理
            if (choice !== 'wait') app.quit()
          })
        },
      },
    ])

  tray.setContextMenu(buildMenu())
  // 暂停状态可能由渲染层改写,仅在变化时重建菜单
  let lastPaused = deps.isPaused()
  const refreshTimer = setInterval(() => {
    const paused = deps.isPaused()
    if (paused !== lastPaused) {
      lastPaused = paused
      tray.setContextMenu(buildMenu())
    }
  }, 1000)
  app.on('quit', () => clearInterval(refreshTimer))
  return { tray, rebuild: () => tray.setContextMenu(buildMenu()) }
}

export function showPanel(options: { quick?: boolean } = {}): void {
  // 迷你条与主窗共用窗口列表,按 hash 区分,避免托盘"打开面板"聚焦到迷你条
  // 先剔除已销毁窗口:向销毁的 webContents 读 URL/send 会抛错
  const windows = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && !w.webContents.isDestroyed(),
  )
  const win =
    windows.find((w) => !w.webContents.getURL().includes('#mini')) ?? windows[0]
  if (!win) {
    // 窗口被销毁的极端场景:重启应用
    app.relaunch()
    app.quit()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (options.quick) {
    win.webContents.send('panel:focus-composer')
  }
}

export async function confirmExitWithRunning(
  activeCount: number,
): Promise<'wait' | 'cancel-and-exit' | 'force'> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: '存在未完成任务',
    message: `还有 ${activeCount} 个任务未完成(运行中或排队),如何处理?`,
    // 中断语义:进程退出后由下次启动恢复为 interrupted;取消语义才是立即 canceled
    buttons: ['等待完成(隐藏到托盘)', '取消任务并退出', '退出(任务标记为 interrupted)'],
    defaultId: 0,
    cancelId: 0,
  })
  return (['wait', 'cancel-and-exit', 'force'] as const)[response] ?? 'wait'
}
