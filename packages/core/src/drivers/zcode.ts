import { join } from 'node:path'
import type {
  AgentDriver,
  DetectedAgent,
  DriverRunOptions,
  RunResult,
} from '../driver.js'
import { DEFAULT_RUN_TIMEOUT_MS } from '../driver.js'
import type { AgentProfile, ModelId, TaskInput } from '../types.js'
import type { Clock, FileSystem, ProcessRunner } from '../ports.js'
import { systemClock } from '../ports.js'
import { LineDecoder, decodeBuffer, extractSessionId } from '../text.js'
import { spawnForExit } from './spawnExit.js'

export interface ZcodeLocator {
  nodeBin: string
  cliPath: string
  /**
   * spawn 时的附加环境变量。打包态 nodeBin 是 Electron exe,
   * 必须带 ELECTRON_RUN_AS_NODE=1 才按 node 执行,否则会拉起第二个 GUI 实例。
   */
  nodeEnv?: Record<string, string>
}

const PROBE_TIMEOUT_MS = 10_000
const DOCTOR_TIMEOUT_MS = 30_000

/**
 * ZCode 官方 CLI 驱动(zcode.cjs,实测 0.16.9):
 * - 无 --model 参数,模型跟随客户端(C9),resolveModelArg 恒空;
 * - 无头模式缺省 --mode yolo(C10),派发必须显式传 mode,绝不依赖客户端默认值;
 * - 附件 --attach 可重复;工具限制 --disallowed-tools 为工具级粒度(C4);
 * - 续聊优先 --resume <id>,无 id 时 -c 续接最近会话(C5)。
 */
export class ZcodeDriver implements AgentDriver {
  readonly id = 'zcode'
  readonly supportedVersions = '>=0.16 <0.17'

  constructor(
    private readonly runner: ProcessRunner,
    private readonly fsx: FileSystem,
    private readonly locator: ZcodeLocator,
    private readonly clock: Clock = systemClock,
  ) {}

  async detect(entries: string[]): Promise<DetectedAgent | null> {
    for (const entry of entries) {
      const candidates = entry.toLowerCase().endsWith('.cjs')
        ? [entry]
        : [join(entry, 'resources', 'glm', 'zcode.cjs')]
      for (const cliEntry of candidates) {
        if (!this.fsx.exists(cliEntry)) continue
        return {
          id: this.id,
          label: 'ZCode',
          entry,
          cliEntry,
          version: await this.probeVersion(cliEntry),
        }
      }
    }
    return null
  }

  async health(_agent: AgentProfile): Promise<{ ok: boolean; reason?: string }> {
    if (!this.fsx.exists(this.locator.cliPath)) {
      return { ok: false, reason: `CLI 不存在:${this.locator.cliPath}` }
    }
    let code: number
    try {
      code = await this.probeForExit(
        [this.locator.cliPath, 'doctor'],
        DOCTOR_TIMEOUT_MS,
        () => {},
      )
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    return code === 0
      ? { ok: true }
      : { ok: false, reason: `doctor 退出码 ${code}` }
  }

  /** zcode 无模型参数(R2/C9),模型档位跟随客户端当前会话 */
  resolveModelArg(_modelId: ModelId, _agent: AgentProfile): string[] {
    return []
  }

  async run(options: DriverRunOptions): Promise<RunResult> {
    const { input, signal, emit, onSpawn, timeoutMs } = options
    // cwd 校验在 spawn 前,失败直接抛,不产生子进程
    if (!this.fsx.exists(input.cwd) || !this.fsx.isWritable(input.cwd)) {
      throw new Error(`工作区不可用(不存在或不可写):${input.cwd}`)
    }
    const args = [this.locator.cliPath, ...this.buildArgs(input)]
    if (input.toolPolicy?.maxTurns != null) {
      emit({ kind: 'warning', text: 'zcode 无轮次上限参数,本次未透传 maxTurns' })
    }
    if (signal.aborted) throw new Error('任务已取消,未启动进程')
    const stdoutDecoder = new LineDecoder()
    const stderrDecoder = new LineDecoder()
    let timedOut = false
    let sessionId: string | undefined

    // 会话锚点随行提取,不保留全量 stdout
    const scanSession = (line: string): void => {
      if (!sessionId && /session/i.test(line)) sessionId = extractSessionId(line)
    }
    const handleLine = (line: string): void => {
      scanSession(line)
      if (line) emit({ kind: 'message', channel: 'stdout', text: line })
    }

    const handle = this.runner.spawn({
      command: this.locator.nodeBin,
      args,
      cwd: input.cwd,
      env: this.locator.nodeEnv,
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

    const startedMono = this.clock.monotonic()
    const limit = timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
    const watchdog = setTimeout(() => {
      timedOut = true
      void handle.killTree()
    }, limit)
    const onAbort = () => void handle.killTree()
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const code = await handle.exited
      for (const line of stdoutDecoder.flush()) handleLine(line)
      for (const line of stderrDecoder.flush()) {
        if (line) emit({ kind: 'message', channel: 'stderr', text: line })
      }
      if (timedOut && !signal.aborted) {
        const elapsed = Math.round(this.clock.monotonic() - startedMono)
        throw new Error(`看门狗超时(${elapsed}ms ≥ ${limit}ms),已终止进程树`)
      }
      return { code, sessionId }
    } finally {
      clearTimeout(watchdog)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 参数装配为纯函数抽出,便于单测锁定官方参数形态;
   * 返回的是 CLI 标志段,spawn 时前面拼 cliPath。
   */
  buildArgs(input: TaskInput): string[] {
    const args = [
      '-p',
      input.prompt,
      '--cwd',
      input.cwd,
      // 恒显式传 mode:无头缺省 yolo(C10),绝不依赖默认值
      '--mode',
      input.mode ?? 'build',
    ]
    for (const attachment of input.attachments ?? []) {
      args.push('--attach', attachment.path)
    }
    const denyList = input.toolPolicy?.denyList ?? []
    if (denyList.length > 0) {
      args.push('--disallowed-tools', ...denyList)
    }
    if (input.sessionId) {
      args.push('--resume', input.sessionId)
    } else if (input.resumeLatest) {
      args.push('-c')
    }
    return args
  }

  private async probeVersion(cliEntry: string): Promise<string | undefined> {
    const chunks: Buffer[] = []
    try {
      const code = await spawnForExit(
        this.runner,
        {
          command: this.locator.nodeBin,
          args: [cliEntry, '--version'],
          cwd: process.cwd(),
          env: this.locator.nodeEnv,
          onStdout: (chunk) => chunks.push(chunk),
          onStderr: () => {},
        },
        PROBE_TIMEOUT_MS,
      )
      if (code !== 0) return undefined
      return decodeBuffer(Buffer.concat(chunks)).trim() || undefined
    } catch {
      return undefined
    }
  }

  private probeForExit(args: string[], timeoutMs: number, onStdout: (chunk: Buffer) => void): Promise<number> {
    return spawnForExit(
      this.runner,
      {
        command: this.locator.nodeBin,
        args,
        cwd: process.cwd(),
        env: this.locator.nodeEnv,
        onStdout,
        onStderr: () => {},
      },
      timeoutMs,
    )
  }
}
