import type { EventSink, TaskRepository } from './ports.js'
import type { StoredEvent } from './types.js'

export interface EventBufferOptions {
  /** 批量窗口毫秒数,默认 500ms */
  flushMs?: number
  /** 队列达到该条数立即 flush,默认 200 */
  maxBatch?: number
}

/**
 * 事件缓冲 sink:小窗口攒批,一次性落库 + 批推渲染层(tasks:events-batch 通道)。
 * 攒批对上游透明:调度核心只管发,渲染层拿到的是合并推送,SQLite 写入次数被压平。
 */
export class EventBuffer implements EventSink {
  private queue: StoredEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly flushMs: number
  private readonly maxBatch: number
  private flushing = false

  constructor(
    private readonly repo: TaskRepository,
    private readonly push: (events: StoredEvent[]) => void,
    options: EventBufferOptions = {},
  ) {
    this.flushMs = options.flushMs ?? 500
    this.maxBatch = options.maxBatch ?? 200
  }

  append(events: StoredEvent[]): void {
    this.queue.push(...events)
    if (this.queue.length >= this.maxBatch) {
      this.flush()
      return
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.flushMs)
    }
  }

  /** 立即清空缓冲(落库+批推);退应用前调用防丢尾批 */
  flush(): void {
    if (this.flushing || this.queue.length === 0) {
      if (this.timer !== undefined) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
      return
    }
    const batch = this.queue
    this.queue = []
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flushing = true
    try {
      this.repo.appendEvents(batch)
      this.push(batch)
    } finally {
      this.flushing = false
    }
  }
}
