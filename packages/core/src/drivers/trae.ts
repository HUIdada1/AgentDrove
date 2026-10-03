import { join } from 'node:path'
import type {
  AgentDriver,
  DetectedAgent,
  DriverRunOptions,
  RunResult,
} from '../driver.js'
import { DEFAULT_RUN_TIMEOUT_MS } from '../driver.js'
import type { AgentProfile, ModelId, TaskMode } from '../types.js'
import type { FileSystem, ProcessRunner } from '../ports.js'
import { LineDecoder, decodeBuffer } from '../text.js'
import { spawnForExit } from './spawnExit.js'

const PROBE_TIMEOUT_MS = 15_000

/** TaskMode 到 trae chat -m 档位的映射;trae 无 plan/yolo 概念,就近落 ask/agent */
const MODE_TO_TRAE: Record<TaskMode, string> = {
  build: 'agent',
  edit: 'edit',
  plan: 'ask',
  yolo: 'agent',
}

/**
 * TraeCode 半自动驱动(C8 实测:无无头通道,唯一 agent 入口是 `chat` 开 GUI 窗口)。
 * 派发=唤起 GUI 执行,stdout 仅回显启动信息,结果需人工在窗口确认——
 * 任务在命令退出码 0 时置 completed 并发 warning 说明半自动语义。
 */
export class TraeDriver implements AgentDriver {
  readonly id = 'trae'
  readonly supportedVersions?: string

  constructor(
    private readonly runner: ProcessRunner,
    private readonly fsx: FileSystem,
  ) {}

  async detect(entries: string[]): Promise<DetectedAgent | null> {
    for (const entry of entries) {
      // 候选是安装根(拼 bin/trae.cmd)或 trae.cmd 全路径
      const candidates = /trae\.cmd$/i.test(entry)
        ? [entry]
        : [join(entry, 'bin', 'trae.cmd')]
      for (const cli of candidates) {
        if (!this.fsx.exists(cli)) continue
        return {
          id: this.id,
          label: 'TraeCode',
          entry: cli,
          cliEntry: cli,
          version: await this.probeVersion(cli),
        }
      }
    }
    return null
  }

  async health(agent: AgentProfile): Promise<{ ok: boolean; reason?: string }> {
    // trae 无法经 CLI 判断登录态,--version 只能证明安装完好;登录引导交给 UI
    const code = await this.probeExit(agent.entry, ['--version'])
    return code === 0 ? { ok: true } : { ok: false, reason: `--version 退出码 ${code}` }
  }

  /** trae 无模型参数(C8),跟随客户端 */
  resolveModelArg(_modelId: ModelId, _agent: AgentProfile): string[] {
    return []
  }

  async run(options: DriverRunOptions): Promise<RunResult> {
    const { input, signal, emit, onSpawn, timeoutMs } = options
    if (!this.fsx.exists(input.cwd) || !this.fsx.isWritable(input.cwd)) {
      throw new Error(`工作区不可用(不存在或不可写):${input.cwd}`)
    }
    const args = [
      'chat',
      input.prompt,
      '-m',
      MODE_TO_TRAE[input.mode ?? 'build'],
      ...(input.attachments ?? []).flatMap((a) => ['-a', a.path]),
    ]
    if (input.toolPolicy?.denyList?.length) {
      emit({ kind: 'warning', text: 'trae 半自动通道无工具禁用参数,本次未透传 denyList' })
    }
    // 派发前再确认未被取消:取消语义下不应再拉起 GUI 窗口
    if (signal.aborted) throw new Error('任务已取消,未启动进程')
    const stdoutDecoder = new LineDecoder()
    const stderrDecoder = new LineDecoder()
    let timedOut = false

    const handle = this.runner.spawn({
      command: options.agent.entry,
      args,
      cwd: input.cwd,
      shell: this.needsShell(options.agent.entry),
      onStdout: (chunk) => {
        for (const line of stdoutDecoder.push(chunk)) {
          if (line) emit({ kind: 'message', channel: 'stdout', text: line })
        }
      },
      onStderr: (chunk) => {
        for (const line of stderrDecoder.push(chunk)) {
          if (line) emit({ kind: 'message', channel: 'stderr', text: line })
        }
      },
    })
    onSpawn?.(handle.pid)

    const watchdog = setTimeout(() => {
      timedOut = true
      void handle.killTree()
    }, timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
    const onAbort = () => void handle.killTree()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const code = await handle.exited
      for (const line of stdoutDecoder.flush()) {
        if (line) emit({ kind: 'message', channel: 'stdout', text: line })
      }
      for (const line of stderrDecoder.flush()) {
        if (line) emit({ kind: 'message', channel: 'stderr', text: line })
      }
      if (timedOut && !signal.aborted) {
        throw new Error('看门狗超时,已终止进程树')
      }
      // 半自动:窗口已拉起即认为派发成功,结果由人工确认
      if (code === 0) {
        emit({
          kind: 'warning',
          text: '半自动通道:任务已在 Trae 窗口执行,结果请人工确认',
        })
      }
      return { code }
    } finally {
      clearTimeout(watchdog)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private needsShell(entry: string): boolean {
    // .cmd/.bat shim 与 PATH 命令名在 Windows 上都需经 shell 解析
    return /\.(cmd|bat)$/i.test(entry) || (!entry.includes('\\') && !entry.includes('/'))
  }

  private async probeVersion(entry: string): Promise<string | undefined> {
    const chunks: Buffer[] = []
    try {
      const code = await this.probeExit(entry, ['--version'], (chunk) => chunks.push(chunk))
      if (code !== 0) return undefined
      return decodeBuffer(Buffer.concat(chunks)).trim() || undefined
    } catch {
      return undefined
    }
  }

  private probeExit(
    entry: string,
    args: string[],
    onStdout: (chunk: Buffer) => void = () => {},
  ): Promise<number> {
    return spawnForExit(
      this.runner,
      {
        command: entry,
        args,
        cwd: process.cwd(),
        shell: this.needsShell(entry),
        onStdout,
        onStderr: () => {},
      },
      PROBE_TIMEOUT_MS,
    )
  }
}
