import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface Logger {
  info(message: string, detail?: Record<string, unknown>): void
  warn(message: string, detail?: Record<string, unknown>): void
  error(message: string, detail?: Record<string, unknown>): void
}

const MAX_LOG_BYTES = 10 * 1024 * 1024
const MAX_LOG_FILES = 5

/**
 * 自诊日志(5.1 第 6 类):JSON 行落盘,10MB×5 滚动。
 * 只记动作与错误,不含 prompt 正文与任何凭据。
 */
export function createFileLogger(logsDir: string): Logger {
  const current = join(logsDir, 'agent.log')
  const rotate = (): void => {
    if (!existsSync(current) || statSync(current).size < MAX_LOG_BYTES) return
    const files = readdirSync(logsDir)
      .filter((name) => /^agent\.\d+\.log$/.test(name))
      .sort()
      .reverse()
    for (const file of files.slice(MAX_LOG_FILES - 1)) unlinkSync(join(logsDir, file))
    renameSafe(current, join(logsDir, `agent.${Date.now()}.log`))
  }
  const write = (level: string, message: string, detail?: Record<string, unknown>): void => {
    try {
      rotate()
      appendFileSync(
        current,
        JSON.stringify({ at: Date.now(), level, message, ...detail }) + '\n',
        'utf8',
      )
    } catch {
      // 日志失败不影响业务
    }
  }
  return {
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  }
}

function renameSafe(from: string, to: string): void {
  try {
    unlinkSync(to)
  } catch {
    // 目标不存在
  }
  renameSync(from, to)
}

/** logs:tail:读最新日志尾部 */
export function tailLogs(logsDir: string, limit = 200): string[] {
  const current = join(logsDir, 'agent.log')
  if (!existsSync(current)) return []
  const content = readFileSync(current, 'utf8').trim()
  if (!content) return []
  return content.split('\n').slice(-limit)
}
