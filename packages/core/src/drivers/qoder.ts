import type {
  AgentDriver,
  DetectedAgent,
  DriverRunOptions,
  RunResult,
} from '../driver.js'
import type { AgentProfile, ModelId, ModelPreset, TaskInput } from '../types.js'
import type { FileSystem, ProcessRunner } from '../ports.js'
import { LineDecoder, decodeBuffer, extractSessionId } from '../text.js'

const PROBE_TIMEOUT_MS = 15_000

/**
 * Qoder CN 驱动(qoderclicn)。
 * 接入矩阵按"cli-arg 全自动"执行,但本机未安装,以下参数形态以官方文档为准,
 * 全部待 V5(安装复测)/V6(探活)回填后核实——不实之处以实测为准再改:
 * - headless:`-p <prompt>`;
 * - 模型:`--model <id>`(R2 原标准);
 * - 轮次限制:`--max-turns <n>`;输出:`--output-format stream-json`;
 * - 续聊:`-c` / `-r <id>`;附件与 denyList 的等价参数未确认,先不透传并给 warning。
 */
export class QoderDriver implements AgentDriver {
  readonly id = 'qoder'
  readonly supportedVersions?: string

  constructor(
    private readonly runner: ProcessRunner,
    private readonly fsx: FileSystem,
  ) {}

  async detect(entries: string[]): Promise<DetectedAgent | null> {
    for (const entry of entries) {
      // qoderclicn 可能是 PATH 上的命令名,也可能给出可执行文件全路径
      if (this.isCommandName(entry) || this.fsx.exists(entry)) {
        return {
          id: this.id,
          label: 'Qoder CN',
          entry,
          cliEntry: entry,
          version: await this.probeVersion(entry),
        }
      }
    }
    return null
  }

  async health(agent: AgentProfile): Promise<{ ok: boolean; reason?: string }> {
    const code = await this.probeExit(agent.entry, ['--version'])
    return code === 0
      ? { ok: true }
      : { ok: false, reason: `--version 退出码 ${code}(未安装或未登录)` }
  }

  resolveModelArg(modelId: ModelId, _agent: AgentProfile): string[] {
    if (modelId === 'client-follow') return []
    return ['--model', modelId]
  }

  async fetchModels(agent: AgentProfile): Promise<ModelPreset[]> {
    // V5 未回填前直接返回档案目录;确认有模型列表子命令后再实现拉取
    return agent.models
  }

  async run(options: DriverRunOptions): Promise<RunResult> {
    const { input, signal, emit, onSpawn, timeoutMs } = options
    if (!this.fsx.exists(input.cwd) || !this.fsx.isWritable(input.cwd)) {
      throw new Error(`工作区不可用(不存在或不可写):${input.cwd}`)
    }
    const agent = options.agent
    const args = [
      '-p',
      input.prompt,
      '--output-format',
      'stream-json',
      ...this.resolveModelArg(options.modelId, agent),
      ...this.buildResumeArgs(input),
      ...this.buildPolicyArgs(input, emit),
    ]
    const stdoutChunks: Buffer[] = []
    const stdoutDecoder = new LineDecoder()
    const stderrDecoder = new LineDecoder()
    let timedOut = false

    const handle = this.runner.spawn({
      command: agent.entry,
      args,
      cwd: input.cwd,
      shell: this.needsShell(agent.entry),
      onStdout: (chunk) => {
        stdoutChunks.push(chunk)
        for (const line of stdoutDecoder.push(chunk)) this.emitLine(line, emit)
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
    }, timeoutMs ?? 600_000)
    const onAbort = () => void handle.killTree()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const code = await handle.exited
      for (const line of stdoutDecoder.flush()) this.emitLine(line, emit)
      for (const line of stderrDecoder.flush()) {
        if (line) emit({ kind: 'message', channel: 'stderr', text: line })
      }
      if (timedOut && !signal.aborted) {
        throw new Error(`看门狗超时,已终止进程树`)
      }
      return {
        code,
        sessionId: extractSessionId(decodeBuffer(Buffer.concat(stdoutChunks))),
      }
    } finally {
      clearTimeout(watchdog)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** stream-json 行尽量结构化,解析不出就原样透传(6.2 规范 3) */
  private emitLine(line: string, emit: DriverRunOptions['emit']): void {
    if (!line) return
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const text = typeof parsed.text === 'string' ? parsed.text : undefined
      if (text) {
        emit({ kind: 'message', channel: 'agent', text })
        return
      }
      emit({ kind: 'message', channel: 'stdout', text: line })
    } catch {
      emit({ kind: 'message', channel: 'stdout', text: line })
    }
  }

  /** -r <id> / -c 的形态待 V5 核实,先按文档惯例实现 */
  private buildResumeArgs(input: TaskInput): string[] {
    if (input.sessionId) return ['-r', input.sessionId]
    if (input.resumeLatest) return ['-c']
    return []
  }

  private buildPolicyArgs(
    input: TaskInput,
    emit: DriverRunOptions['emit'],
  ): string[] {
    const args: string[] = []
    const policy = input.toolPolicy
    if (policy?.maxTurns != null) {
      args.push('--max-turns', String(policy.maxTurns))
    }
    if (policy?.denyList && policy.denyList.length > 0) {
      emit({
        kind: 'warning',
        text: 'qoder 的工具禁用清单等价参数未确认,本次未透传',
      })
    }
    if (input.attachments && input.attachments.length > 0) {
      emit({
        kind: 'warning',
        text: 'qoder 的附件参数待 V5 核实,本次未透传附件',
      })
    }
    return args
  }

  private isCommandName(entry: string): boolean {
    return !entry.includes('\\') && !entry.includes('/')
  }

  private needsShell(entry: string): boolean {
    return /\.(cmd|bat)$/i.test(entry)
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
    return new Promise<number>((resolve, reject) => {
      const handle = this.runner.spawn({
        command: entry,
        args,
        cwd: process.cwd(),
        shell: this.needsShell(entry),
        onStdout,
        onStderr: () => {},
      })
      const timer = setTimeout(() => {
        void handle.killTree()
        reject(new Error(`探测超时(${PROBE_TIMEOUT_MS}ms)`))
      }, PROBE_TIMEOUT_MS)
      void handle.exited.then(
        (code) => {
          clearTimeout(timer)
          resolve(code)
        },
        (error) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }
}
