import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@agent-drove/shared'

export interface UpdaterDeps {
  /** 配置项:update.autoDownload */
  autoDownload: boolean
  onStatus(status: UpdateStatus): void
}

export interface UpdateController {
  checkForUpdates(): void
  installUpdate(): void
}

/**
 * 轨道 A 整包更新(10.4):GitHub provider,启动 + 每 4h 检查 latest.yml,
 * blockmap 差分下载,退出时静默安装。updater 走 Electron net,自动继承系统代理;
 * 更新失败不阻断既有功能(保留旧版本)。
 */
export function initUpdater(deps: UpdaterDeps): UpdateController & { dispose(): void } {
  autoUpdater.autoDownload = deps.autoDownload
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'HUIdada1',
    repo: 'AgentDrove',
  })

  autoUpdater.on('checking-for-update', () => deps.onStatus({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    deps.onStatus({ phase: 'available', detail: String(info.version) }),
  )
  autoUpdater.on('update-not-available', () => deps.onStatus({ phase: 'not-available' }))
  autoUpdater.on('download-progress', (progress) =>
    deps.onStatus({ phase: 'downloading', progress: Math.round(progress.percent) }),
  )
  autoUpdater.on('update-downloaded', (info) =>
    deps.onStatus({ phase: 'downloaded', detail: String(info.version) }),
  )
  autoUpdater.on('error', (error) =>
    deps.onStatus({ phase: 'error', detail: error.message }),
  )

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(() => {
      // 事件通道已推 error 状态,此处不再抛出
    })
  }
  // 启动即查一次,之后每 4h;定时器不阻止进程退出
  check()
  const timer = setInterval(check, 4 * 3600_000)
  timer.unref()

  return {
    checkForUpdates: check,
    installUpdate: () => {
      void autoUpdater.quitAndInstall()
    },
    dispose: () => clearInterval(timer),
  } satisfies UpdateController & { dispose(): void }
}
