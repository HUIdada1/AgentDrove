import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@agent-drove/shared'

export interface UpdaterDeps {
  /** 配置项:update.autoDownload */
  autoDownload: boolean
  /** 打包环境才自动检查;dev 下 GitHub provider 拉不到 release,自动检查只会刷错误状态 */
  enabled: boolean
  onStatus(status: UpdateStatus): void
}

export interface UpdateController {
  checkForUpdates(): void
  installUpdate(): void
}

/**
 * 轨道 A 整包更新(10.4):GitHub provider,打包环境启动 + 每 4h 检查 latest.yml,
 * blockmap 差分下载,退出时静默安装。updater 走 Electron net,自动继承系统代理;
 * 更新失败不阻断既有功能(保留旧版本)。
 */
export function initUpdater(deps: UpdaterDeps): UpdateController & { dispose(): void } {
  autoUpdater.autoDownload = deps.autoDownload
  autoUpdater.autoInstallOnAppQuit = true
  // 默认与 electron-builder.yml 的 publish 元数据一致;env 可覆盖以指向私有镜像
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: process.env.AGENTDROVE_UPDATE_OWNER ?? 'HUIdada1',
    repo: process.env.AGENTDROVE_UPDATE_REPO ?? 'AgentDrove',
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
  autoUpdater.on('error', (error) => {
    // 仓库尚无 release 资产时拉 latest.yml 得 404,对用户语义就是"已是最新",降级不报错
    if (isNotFound(error)) {
      deps.onStatus({ phase: 'not-available' })
      return
    }
    deps.onStatus({ phase: 'error', detail: error.message })
  })

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(() => {
      // 事件通道已推 error 状态,此处不再抛出
    })
  }
  // enabled=false(dev)不注册启动检查与定时器,手动"检查更新"仍可用;定时器不阻止进程退出
  let timer: NodeJS.Timeout | undefined
  if (deps.enabled) {
    check()
    timer = setInterval(check, 4 * 3600_000)
    timer.unref()
  }

  return {
    checkForUpdates: check,
    installUpdate: () => {
      void autoUpdater.quitAndInstall()
    },
    dispose: () => clearInterval(timer),
  } satisfies UpdateController & { dispose(): void }
}

/** electron-updater 的网络错误带 HTTP statusCode(GitHub 无 release 资产时为 404) */
export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  )
}
