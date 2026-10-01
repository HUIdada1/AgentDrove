import type { Clock } from './ports.js'

export interface JournalEntry {
  at: number
  action: string
  origin: string
  agentId?: string
  taskId?: string
  detail?: string
}

export interface JournalStore {
  append(entry: JournalEntry): void
}

/** 审计日志:只记动作与来源,不含 prompt 正文 */
export class Journal {
  constructor(
    private readonly store: JournalStore | undefined,
    private readonly clock: Clock,
  ) {}

  record(
    action: string,
    origin: string,
    refs: { agentId?: string; taskId?: string; detail?: string } = {},
  ): void {
    this.store?.append({ at: this.clock.now(), action, origin, ...refs })
  }
}
