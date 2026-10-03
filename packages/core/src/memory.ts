import type { EventSink, TaskRepository } from './ports.js'
import type { StoredEvent, TaskRecord } from './types.js'

/**
 * 内存任务仓库:TaskRepository 的最小实现。
 * 供单元测试与无持久化场景(headless 冒烟)使用;生产组合根注入 SQLite 适配器。
 */
export class MemoryTaskRepository implements TaskRepository {
  private tasks = new Map<string, TaskRecord>()
  private events = new Map<string, StoredEvent[]>()

  putTask(task: TaskRecord): void {
    this.tasks.set(task.id, { ...task })
  }

  getTask(id: string): TaskRecord | undefined {
    const task = this.tasks.get(id)
    return task ? { ...task } : undefined
  }

  allTasks(): TaskRecord[] {
    return [...this.tasks.values()].map((t) => ({ ...t }))
  }

  deleteTask(id: string): void {
    this.tasks.delete(id)
    // 事件随任务一并清理,否则删除后事件表残留(长跑内存泄漏)
    this.events.delete(id)
  }

  appendEvents(events: StoredEvent[]): void {
    for (const event of events) {
      const list = this.events.get(event.taskId) ?? []
      list.push(event)
      this.events.set(event.taskId, list)
    }
  }

  eventsOf(taskId: string): StoredEvent[] {
    return [...(this.events.get(taskId) ?? [])]
  }

  maxSeqOf(taskId: string): number {
    const list = this.events.get(taskId)
    return list && list.length > 0 ? list[list.length - 1].seq : 0
  }
}

/** 直通 sink:事件同步落仓库;带批量窗口的实现见 EventBuffer */
export class PassthroughSink implements EventSink {
  constructor(private readonly repo: TaskRepository) {}

  append(events: StoredEvent[]): void {
    this.repo.appendEvents(events)
  }
}
