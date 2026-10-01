import { join } from 'node:path'

export interface AppPaths {
  base: string
  data: string
  db: string
  config: string
  logs: string
  logos: string
  workspaces: string
  defaultWorkspace: string
  bundles: string
}

/**
 * 数据目录唯一出处(4.5),禁止散写路径。
 * dev/prod 同构:默认落 %APPDATA%\AgentDrove,AGENTDROVE_HOME 可整体重定向(测试/便携场景)。
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const base =
    env.AGENTDROVE_HOME ?? join(env.APPDATA ?? env.HOME ?? '.', 'AgentDrove')
  const data = join(base, 'data')
  return {
    base,
    data,
    db: join(data, 'console.db'),
    config: join(base, 'config'),
    logs: join(base, 'logs'),
    logos: join(base, 'assets', 'logos'),
    workspaces: join(base, 'workspaces'),
    defaultWorkspace: join(base, 'workspaces', 'default'),
    bundles: join(base, 'bundles'),
  }
}
