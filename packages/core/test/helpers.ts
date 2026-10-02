import { normalize } from 'node:path'
import type {
  Clock,
  FileSystem,
  FileStat,
  ProcessHandle,
  ProcessRunner,
  SpawnRequest,
  TaskRecord,
} from '../src/index.js'
import { MemoryTaskRepository, PassthroughSink } from '../src/index.js'
import { MODEL_CLIENT_FOLLOW, type AgentProfile } from '../src/index.js'
import { Orchestrator } from '../src/orchestrator.js'
import { Registry } from '../src/registry.js'

export { MemoryTaskRepository, PassthroughSink }

/** 测试替身统一做路径规整,避免分隔符差异误判(真实文件系统对此不敏感) */
const norm = (p: string): string => normalize(p)

export const zcodeProfile: AgentProfile = {
  id: 'zcode',
  label: 'ZCode',
  driver: 'zcode',
  entry: 'E:/ZCode/ZCode.exe',
  cliEntry: 'E:/ZCode/resources/glm/zcode.cjs',
  version: '0.16.9',
  models: [],
  defaultModel: MODEL_CLIENT_FOLLOW,
  // 实测 zcode 无 --model 参数(R2/C9):模型跟随客户端,统一记哨兵
  capabilities: { headless: true, sessionResume: true, modelSwitch: 'none', attachments: true },
  plan: { name: 'GLM Coding Plan', quotaKind: 'daily', modelIds: [], dailyTaskCap: 20, maxConcurrency: 1 },
  enabled: true,
}

export const qoderProfile: AgentProfile = {
  id: 'qoder',
  label: 'Qoder CN',
  driver: 'qoder',
  entry: 'qoderclicn',
  models: [{ id: 'qwen3.7-max', label: 'Qwen 3.7 Max' }],
  defaultModel: 'qwen3.7-max',
  capabilities: { headless: true, sessionResume: true, modelSwitch: 'cli-arg', attachments: true },
  plan: { name: 'Credits', quotaKind: 'credits', modelIds: ['qwen3.7-max'], dailyTaskCap: 20, maxConcurrency: 1 },
  enabled: true,
}

export const codexProfile: AgentProfile = {
  id: 'codex',
  label: 'Codex',
  driver: 'codex',
  entry: 'codex',
  models: [{ id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' }],
  defaultModel: 'gpt-5.1-codex',
  capabilities: { headless: true, sessionResume: true, modelSwitch: 'cli-arg', attachments: false },
  plan: { name: 'ChatGPT 套餐', quotaKind: 'subscription', modelIds: ['gpt-5.1-codex'], dailyTaskCap: 20, maxConcurrency: 1 },
  enabled: true,
}

export interface Harness {
  orchestrator: Orchestrator
  registry: Registry
  repo: MemoryTaskRepository
  clock: FixedClock
}

export function buildHarness(defaultCwd = 'C:/tmp/ws'): Harness {
  const registry = new Registry()
  registry.register(zcodeProfile)
  registry.register(qoderProfile)
  const repo = new MemoryTaskRepository()
  const clock = new FixedClock()
  const orchestrator = new Orchestrator(registry, {
    repo,
    sink: new PassthroughSink(repo),
    clock,
    defaultCwd,
  })
  return { orchestrator, registry, repo, clock }
}

export async function waitFor(
  check: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export function states(task: TaskRecord | undefined, repo: MemoryTaskRepository): string[] {
  if (!task) return []
  return repo
    .eventsOf(task.id)
    .filter((e) => e.event.kind === 'state-changed')
    .map((e) => (e.event.kind === 'state-changed' ? e.event.to : ''))
}

export class FixedClock implements Clock {
  private wall: number
  private mono: number

  constructor(start = 1_700_000_000_000) {
    this.wall = start
    this.mono = 0
  }

  now(): number {
    return this.wall
  }

  monotonic(): number {
    return this.mono
  }

  advance(ms: number): void {
    this.wall += ms
    this.mono += ms
  }
}

export class FakeFileSystem implements FileSystem {
  private writable = new Set<string>()

  addWritable(path: string): void {
    this.writable.add(norm(path))
  }

  exists(path: string): boolean {
    return this.writable.has(norm(path))
  }

  isWritable(path: string): boolean {
    return this.writable.has(norm(path))
  }

  ensureDir(path: string): void {
    this.writable.add(norm(path))
  }

  readDir(path: string): string[] {
    const prefix = norm(path) + '\\'
    const names = new Set<string>()
    for (const p of this.writable) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length)
        names.add(rest.split('\\')[0])
      }
    }
    return [...names]
  }

  stat(): FileStat | null {
    return null
  }

  copy(src: string, dest: string): void {
    if (this.writable.has(norm(src))) this.writable.add(norm(dest))
  }

  remove(path: string): void {
    const target = norm(path)
    for (const p of [...this.writable]) {
      if (p === target || p.startsWith(target + '\\')) this.writable.delete(p)
    }
  }
}

export interface SpawnIo {
  stdout(chunk: Buffer | string): void
  stderr(chunk: Buffer | string): void
  exit(code: number): void
}

export type SpawnScript = (request: SpawnRequest, io: SpawnIo) => void

/** 脚本化进程替身:按入队顺序消费脚本,记录全部请求与杀树调用 */
export class ScriptedRunner implements ProcessRunner {
  readonly requests: SpawnRequest[] = []
  readonly killed: SpawnRequest[] = []
  private scripts: SpawnScript[] = []

  enqueue(script: SpawnScript): void {
    this.scripts.push(script)
  }

  spawn(request: SpawnRequest): ProcessHandle {
    this.requests.push(request)
    const script = this.scripts.shift()
    let exit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      exit = resolve
    })
    const io: SpawnIo = {
      stdout: (chunk) => request.onStdout(toBuffer(chunk)),
      stderr: (chunk) => request.onStderr(toBuffer(chunk)),
      exit,
    }
    const handle: ProcessHandle = {
      pid: 1000 + this.requests.length,
      exited,
      killTree: async () => {
        this.killed.push(request)
        exit(1)
      },
    }
    if (script) queueMicrotask(() => script(request, io))
    return handle
  }
}

function toBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
}
