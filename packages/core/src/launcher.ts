import type { AgentProfile } from './types.js'

/**
 * deep link 注册表(6.9,均为注册表实测结论):
 * zcode/trae/trae-cn 有协议键;qoder 未安装无键(V5 后回填)。
 * 会话级跳转参数未实测(V7),未验证前统一"唤起后人工定位"。
 */
export const DEEP_LINKS: Record<string, string> = {
  zcode: 'zcode://',
  trae: 'trae://',
  'trae-cn': 'trae-cn://',
}

export interface SystemLauncher {
  openExternal(target: string): Promise<void>
  spawnDetached(entry: string, args?: string[]): void
}

export type LaunchChannel = 'deep-link' | 'spawn'

/** 唤起:优先 deep link,失败回退 spawn detached(仅查看接管用,不参与执行链) */
export class Launcher {
  constructor(private readonly system: SystemLauncher) {}

  async launchClient(agent: AgentProfile): Promise<LaunchChannel> {
    const deepLink = DEEP_LINKS[agent.id]
    if (deepLink) {
      try {
        await this.system.openExternal(deepLink)
        return 'deep-link'
      } catch {
        // deep link 失败(协议键被卸载残留等)回退可执行文件
      }
    }
    this.system.spawnDetached(agent.entry)
    return 'spawn'
  }
}
