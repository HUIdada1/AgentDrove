import type {
  AgentDriver,
  DetectedAgent,
  DriverRunOptions,
  DriverUsage,
  RunResult,
} from '../driver.js'
import { DEFAULT_RUN_TIMEOUT_MS } from '../driver.js'
import type { AgentProfile, ModelId, ModelPreset, TaskInput } from '../types.js'
import { MODEL_CLIENT_FOLLOW } from '../types.js'
import type { FileSystem, ProcessRunner } from '../ports.js'
import { LineDecoder, decodeBuffer, extractSessionId } from '../text.js'
import { spawnForExit } from './spawnExit.js'

const PROBE_TIMEOUT_MS = 15_000
const LOGIN_CHECK_TIMEOUT_MS = 20_000

/**
 * OpenAI Codex CLI 驱动(npm `@openai/codex`,实测口径 0.2x):
 * - 无头:`codex exec --json --skip-git-repo-check -C <cwd> --sandbox <档> [resume 子命令] <prompt>`;
 * - 沙箱映射 build/read-only、edit/workspace-write、plan/read-only、yolo/danger-full-access;
 * - 模型:`--model <id>`(0.2x 起才可省略);续聊:`exec resume <thread_id>` / `resume --last`;
 * - 会话锚点:--json 流 `thread.started` 事件的 thread_id,落库后供续聊链使用。
 */
export class CodexDriver implements AgentDriver {
  readonly id = 'codex'
  /** resume 子命令 0.2.0 引入,更早版本无法续聊 */
  readonly supportedVersions = '>=0.2'

  constructor(
    private readonly runner: ProcessRunner,
    private readonly fsx: FileSystem,
  ) {}

  async detect(entries: string[]): Promise<DetectedAgent | null> {
    for (const entry of entries) {
      // PATH 上的命令名(codex)或可执行文件全路径(codex.cmd/npm 全局目录)
      if (this.isCommandName(entry) || this.fsx.exists(entry)) {
        return {
          id: this.id,
          label: 'Codex',
          entry,
          cliEntry: entry,
          version: await this.probeVersion(entry),
        }
      }
    }
    return null
  }

  async health(agent: AgentProfile): Promise<{ ok: boolean; reason?: string }> {
    // login status 未登录时以非零码退出,正好作为健康判据
    const code = await this.probeExit(agent.entry, ['login', 'status'])
    return code === 0
      ? { ok: true }
      : { ok: false, reason: `未登录(login status 退出码 ${code})` }
  }

  resolveModelArg(modelId: ModelId, _agent: AgentProfile): string[] {
    if (modelId === MODEL_CLIENT_FOLLOW) return []
    return ['--model', modelId]
  }

  async fetchModels(agent: AgentProfile): Promise<ModelPreset[]> {
    return agent.models
  }

  async run(options: DriverRunOptions): Promise<RunResult> {
    const { input, signal, emit, onSpawn, timeoutMs } = options
    if (!this.fsx.exists(input.cwd) || !this.fsx.isWritable(input.cwd)) {
      throw new Error(`工作区不可用(不存在或不可写):${input.cwd}`)
    }
    if (signal.aborted) throw new Error('任务已取消,未启动进程')
    const agent = options.agent
    const args = this.buildArgs(input, options.modelId, agent, emit)
    const stdoutDecoder = new LineDecoder()
    const stderrDecoder = new LineDecoder()
    let timedOut = false
    let threadId: string | undefined
    let sessionId: string | undefined
    let usage: DriverUsage | undefined

    // 会话锚点随行提取,不保留全量 stdout(长任务输出可达数十 MB)
    const scanSession = (line: string): void => {
      if (!sessionId && /session/i.test(line)) sessionId = extractSessionId(line)
    }
    const handleLine = (line: string): void => {
      scanSession(line)
      this.emitLine(line, emit, (id) => {
        threadId ??= id
      }, (u) => {
        usage = u
      })
    }

    const handle = this.runner.spawn({
      command: agent.entry,
      args,
      cwd: input.cwd,
      shell: this.needsShell(agent.entry),
      onStdout: (chunk) => {
        for (const line of stdoutDecoder.push(chunk)) handleLine(line)
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
      for (const line of stdoutDecoder.flush()) handleLine(line)
      for (const line of stderrDecoder.flush()) {
        if (line) emit({ kind: 'message', channel: 'stderr', text: line })
      }
      if (timedOut && !signal.aborted) {
        throw new Error('看门狗超时,已终止进程树')
      }
      if (usage) emit({ kind: 'usage', ...usage })
      // thread_id 是续聊链锚点;兜底走通用提取(未来版本字段名变化时不断链)
      return { code, sessionId: threadId ?? sessionId, usage }
    } finally {
      clearTimeout(watchdog)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 参数装配纯函数,单测锁定形态:
   * exec 全局旗标在前,resume 子命令居中,prompt 恒为最后一个位置参数。
   */
  buildArgs(
    input: TaskInput,
    modelId: ModelId,
    agent: AgentProfile,
    emit?: DriverRunOptions['emit'],
  ): string[] {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      input.cwd,
      '--sandbox',
      this.sandboxFor(input.mode),
      ...this.resolveModelArg(modelId, agent),
    ]
    if (input.sessionId) {
      args.push('resume', input.sessionId)
    } else if (input.resumeLatest) {
      args.push('resume', '--last')
    }
    if (emit) {
      if (input.attachments && input.attachments.length > 0) {
        emit({ kind: 'warning', text: 'codex exec 暂无附件参数,本次未透传附件' })
      }
      const denyList = input.toolPolicy?.denyList ?? []
      if (denyList.length > 0) {
        emit({ kind: 'warning', text: 'codex 的工具禁用清单经沙箱/配置实现,本次未透传 denyList' })
      }
      if (input.toolPolicy?.maxTurns != null) {
        emit({ kind: 'warning', text: 'codex exec 无轮次上限参数,本次未透传 maxTurns' })
      }
    }
    args.push(input.prompt)
    return args
  }

  /** 任务档位 → codex 沙箱档(7.1 语义对齐:plan 只读,yolo 全权) */
  private sandboxFor(mode: TaskInput['mode']): string {
    switch (mode) {
      case 'edit':
        return 'workspace-write'
      case 'yolo':
        return 'danger-full-access'
      case 'plan':
      case 'build':
      default:
        return 'read-only'
    }
  }

  /**
   * --json 输出为 JSONL 事件流:
   * thread.started 取会话锚点;item.completed 按类型分流为消息/进度;
   * turn.completed 汇总 token 用量;解析失败原样透传。
   */
  private emitLine(
    line: string,
    emit: DriverRunOptions['emit'],
    onThread: (threadId: string) => void,
    onUsage: (usage: DriverUsage) => void,
  ): void {
    if (!line) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      emit({ kind: 'message', channel: 'stdout', text: line })
      return
    }
    const type = typeof parsed.type === 'string' ? parsed.type : ''
    if (type === 'thread.started' && typeof parsed.thread_id === 'string') {
      onThread(parsed.thread_id)
      return
    }
    if (type === 'turn.completed') {
      const usage = parsed.usage as Record<string, unknown> | undefined
      const inTok = numberOf(usage?.input_tokens ?? usage?.prompt_tokens)
      const outTok = numberOf(usage?.output_tokens ?? usage?.completion_tokens)
      const promptDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined
      const cachedTok = numberOf(promptDetails?.cached_tokens ?? usage?.cached_tokens ?? usage?.cached_input_tokens) ?? 0
      const total = (inTok ?? 0) + (outTok ?? 0) + cachedTok
      const credits = Number((total / 1000).toFixed(2))
      onUsage({
        inputTokens: inTok,
        outputTokens: outTok,
        cachedTokens: cachedTok,
        credits,
      })
      return
    }
    if (type === 'error' || type === 'turn.failed') {
      const message = typeof parsed.message === 'string' ? parsed.message : line
      emit({ kind: 'message', channel: 'stderr', text: message })
      return
    }
    if (type === 'item.completed') {
      const item = parsed.item as Record<string, unknown> | undefined
      const itemType = item && typeof item.type === 'string' ? item.type : ''
      const text = item && typeof item.text === 'string' ? item.text : ''
      if (itemType === 'agent_message' && text) {
        emit({ kind: 'message', channel: 'agent', text })
        return
      }
      if (itemType === 'command_execution' && typeof item?.command === 'string') {
        emit({ kind: 'progress', text: `▶ ${item.command}` })
        return
      }
      if (itemType === 'reasoning' && text) {
        emit({ kind: 'progress', text })
        return
      }
    }
    emit({ kind: 'message', channel: 'stdout', text: line })
  }

  private isCommandName(entry: string): boolean {
    return !entry.includes('\\') && !entry.includes('/')
  }

  private needsShell(entry: string): boolean {
    return /\.(cmd|bat)$/i.test(entry) || this.isCommandName(entry)
  }

  private async probeVersion(entry: string): Promise<string | undefined> {
    try {
      const chunks: Buffer[] = []
      const code = await this.spawnForExit([entry, '--version'], PROBE_TIMEOUT_MS, (chunk) =>
        chunks.push(chunk),
      )
      if (code !== 0) return undefined
      return decodeBuffer(Buffer.concat(chunks)).trim() || undefined
    } catch {
      return undefined
    }
  }

  private probeExit(entry: string, args: string[]): Promise<number> {
    return this.spawnForExit([entry, ...args], LOGIN_CHECK_TIMEOUT_MS)
  }

  private spawnForExit(
    args: string[],
    timeoutMs: number,
    onStdout: (chunk: Buffer) => void = () => {},
  ): Promise<number> {
    return spawnForExit(
      this.runner,
      {
        // 探测统一经 shell,PATH 命令名与 .cmd shim 都能解析
        command: args[0]!,
        args: args.slice(1),
        cwd: process.cwd(),
        shell: true,
        onStdout,
        onStderr: () => {},
      },
      timeoutMs,
    )
  }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
