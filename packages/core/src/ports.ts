import type { StoredEvent, TaskRecord } from './types.js'

/**
 * 端口层:核心领域不 import electron/child_process,
 * 进程与存储能力一律经这些接口由组合根(main)注入。
 */

export interface Clock {
  /** 墙钟,任务时间戳 */
  now(): number
  /** 单调钟,看门狗计时(系统睡眠不累计,防误判超时) */
  monotonic(): number
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
}

/** 任务与事件的唯一事实源;单测跑内存实现,生产换 SQLite 适配器 */
export interface TaskRepository {
  putTask(task: TaskRecord): void
  getTask(id: string): TaskRecord | undefined
  allTasks(): TaskRecord[]
  /** 仅供启动恢复;正常写入走 sink */
  deleteTask(id: string): void
  appendEvents(events: StoredEvent[]): void
  eventsOf(taskId: string): StoredEvent[]
  maxSeqOf(taskId: string): number
}

/**
 * 事件出口:调度核心只管发出,由 sink 决定批量落库与向渲染层批推,
 * 使核心不耦合渲染层,也把 500ms/200 条的批量策略隔离在核心之外。
 */
export interface EventSink {
  append(events: StoredEvent[]): void
}

export interface SpawnRequest {
  command: string
  args: string[]
  cwd: string
  /** 在继承系统环境基础上的覆盖项(如 LANG) */
  env?: Record<string, string>
  /** .cmd/.bat 入口在 Windows 上必须经 shell 解析,否则 ENOENT */
  shell?: boolean
  onStdout(chunk: Buffer): void
  onStderr(chunk: Buffer): void
}

export interface ProcessHandle {
  pid: number
  /** 退出码;进程树被强杀时也会 settle(Windows 下通常为 1) */
  exited: Promise<number>
  /** 终止整棵进程树,防止 CLI 派生孙进程残留 */
  killTree(): Promise<void>
}

export interface ProcessRunner {
  spawn(request: SpawnRequest): ProcessHandle
}

export interface FileStat {
  size: number
  mtimeMs: number
  isDirectory: boolean
}

/** 文件能力只暴露核心用得到的最小面,便于测试替身 */
export interface FileSystem {
  exists(path: string): boolean
  isWritable(path: string): boolean
  ensureDir(path: string): void
  /** 直接子项名(不含 . ..) */
  readDir(path: string): string[]
  stat(path: string): FileStat | null
  /** 递归复制目录或文件 */
  copy(src: string, dest: string): void
  /** 递归删除文件或目录 */
  remove(path: string): void
  /** 读取纯文本文件(UTF-8) */
  readTextFile(path: string): string
  /** 写入纯文本文件(UTF-8) */
  writeTextFile(path: string, content: string): void
}

