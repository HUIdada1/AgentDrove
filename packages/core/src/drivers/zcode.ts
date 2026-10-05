import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AgentDriver,
  DetectedAgent,
  DriverRunOptions,
  DriverUsage,
  RunResult,
} from '../driver.js'
import { DEFAULT_RUN_TIMEOUT_MS } from '../driver.js'
import type { AgentProfile, ModelId, ModelPreset, ReasoningEffort, TaskInput } from '../types.js'
import { MODEL_CLIENT_FOLLOW } from '../types.js'
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
  /**
   * ZCode 内置 provider 配置文件路径(zcode-builtin.json)。
   * 若不指定,驱动将基于 cliPath 自动在周边目录定位并注入 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE。
   */
  builtinProviderConfigPath?: string
  /**
   * ZCode 用户 provider 配置文件路径(provider_config.json)。
   * 若不指定,将通过 resolveZcodePersonalConfigPath() 自动探查。
   */
  personalProviderConfigPath?: string
}

/**
 * 自动定位 ZCode 内置 provider 配置文件(zcode-builtin.json):
 * 官方 CLI 在无头 --prompt 执行时会强校验内置 provider 配置,若未通过环境变量指定,
 * 打包态因相对路径层级错位容易报 "无法定位 CLI ZCode Built-in Provider Config"。
 * 本函数自动在周边目录探查并返回有效文件路径。
 */
export function resolveZcodeBuiltinConfig(
  cliPath: string,
  fsx: Pick<FileSystem, 'exists'>,
  explicitPath?: string,
): string | undefined {
  if (explicitPath && fsx.exists(explicitPath)) return explicitPath

  const cliDir = dirname(cliPath)
  const candidates = [
    // 1. 打包态标准结构: <root>/resources/glm/zcode.cjs -> <root>/resources/config/provider/zcode-builtin.json
    join(cliDir, '..', 'config', 'provider', 'zcode-builtin.json'),
    // 2. cli 同级 provider 目录: <cliDir>/provider/zcode-builtin.json
    join(cliDir, 'provider', 'zcode-builtin.json'),
    // 3. 根目录下的 config: <root>/config/provider/zcode-builtin.json
    join(cliDir, '..', '..', 'config', 'provider', 'zcode-builtin.json'),
  ]

  for (const candidate of candidates) {
    if (fsx.exists(candidate)) return candidate
  }
  return undefined
}

/**
 * 跨 Windows 平台智能探查 ZCode CLI 路径:
 * 优先环境变量与传入值,随后检索当前用户 AppData、ProgramFiles 以及常见安装盘符。
 */
export function resolveZcodeCliPaths(explicit?: string): string[] {
  const list: string[] = []
  if (explicit) list.push(explicit)
  if (process.env.AGENTDROVE_ZCODE_CLI) list.push(process.env.AGENTDROVE_ZCODE_CLI)

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    list.push(join(localAppData, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'))
  }
  const progFiles = process.env.ProgramFiles
  if (progFiles) {
    list.push(join(progFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs'))
  }
  const progFilesX86 = process.env['ProgramFiles(x86)']
  if (progFilesX86) {
    list.push(join(progFilesX86, 'ZCode', 'resources', 'glm', 'zcode.cjs'))
  }

  list.push('D:\\ZCode\\resources\\glm\\zcode.cjs')
  list.push('E:\\ZCode\\resources\\glm\\zcode.cjs')
  list.push('C:\\ZCode\\resources\\glm\\zcode.cjs')

  return [...new Set(list)]
}

/**
 * 获取用户 personal provider_config.json 路径:
 * 优先显式指定与 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 环境变量,缺省落 ~/.zcode/v2/provider_config.json。
 */
export function resolveZcodePersonalConfigPath(explicit?: string): string {
  if (explicit) return explicit
  const fromEnv = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.zcode', 'v2', 'provider_config.json')
}

export interface ParsedZcodeModel extends ModelPreset {
  providerId: string
  modelId: string
  providerName: string
  reasoningLevels?: string[]
}

/**
 * 解析用户 provider_config.json 提取模型目录:
 * 1. 按 providerOrder 确定服务商优先级;
 * 2. 依次提取服务商下的 modelOrder 与 personalModelIds 并去重;
 * 3. 过滤显式 disabled (enabled === false) 的模型规则;
 * 4. 生成规范的 id ("<providerId>/<modelId>") 与 label ("<providerName> · <modelId>")。
 */
export function parseZcodePersonalModels(configJson: string): ParsedZcodeModel[] {
  let data: any
  try {
    data = JSON.parse(configJson)
  } catch {
    return []
  }
  const config = data?.config
  if (!config) return []

  const providerRules: any[] = config.providerConfigRules?.providerRules ?? []
  const providerOrder: string[] = config.providerOrder ?? []
  const modelRules: any[] = config.modelConfigRules?.providerModelRules ?? []

  const providerMap = new Map<string, any>()
  for (const p of providerRules) {
    if (p?.providerId) providerMap.set(p.providerId, p)
  }

  const orderedProviders: any[] = []
  for (const pid of providerOrder) {
    const p = providerMap.get(pid)
    if (p) {
      orderedProviders.push(p)
      providerMap.delete(pid)
    }
  }
  for (const p of providerMap.values()) {
    orderedProviders.push(p)
  }

  const modelRuleMap = new Map<string, Map<string, any>>()
  for (const r of modelRules) {
    if (!r?.providerId || !r?.modelId) continue
    if (!modelRuleMap.has(r.providerId)) {
      modelRuleMap.set(r.providerId, new Map())
    }
    modelRuleMap.get(r.providerId)!.set(r.modelId, r)
  }

  const results: ParsedZcodeModel[] = []
  const seenIds = new Set<string>()

  for (const provider of orderedProviders) {
    const pid = provider.providerId
    const pName = provider.providerName || pid
    const pConfig = provider.config ?? {}
    const rawList: string[] = [
      ...(pConfig.modelOrder ?? []),
      ...(pConfig.personalModelIds ?? []),
    ]
    const uniqueModels = [...new Set(rawList.filter(Boolean))]

    for (const mId of uniqueModels) {
      const rule = modelRuleMap.get(pid)?.get(mId)
      if (rule?.config?.enabled === false) continue

      const fullId = `${pid}/${mId}`
      if (seenIds.has(fullId)) continue
      seenIds.add(fullId)

      const reasoningLevels = rule?.config?.optionSpecs?.reasoningLevel?.values
      results.push({
        id: fullId,
        label: `${pName} · ${mId}`,
        providerId: pid,
        modelId: mId,
        providerName: pName,
        reasoningLevels: Array.isArray(reasoningLevels) ? reasoningLevels : undefined,
      })
    }
  }
  return results
}

/**
 * 从 personal 与内置配置中解析目标模型的合法 reasoningLevel 可选值(P0-4):
 * 1. personal modelConfigRules 中该模型的显式 optionSpecs 优先;
 * 2. 否则按内置规则的 modelMatch 正则匹配(CLI 运行时对 personal 模型同样按此合并 optionSpecs)。
 * 取不到返回 undefined —— 调用侧不应猜测档位,应不带 options 回落客户端实际模型。
 */
export function resolveZcodeReasoningLevels(
  baseConfigJson: string,
  targetCompoundModelId: string,
  builtinConfigJson?: string,
): string[] | undefined {
  const slashIdx = targetCompoundModelId.indexOf('/')
  if (slashIdx === -1) return undefined
  const providerId = targetCompoundModelId.slice(0, slashIdx)
  const modelId = targetCompoundModelId.slice(slashIdx + 1)

  try {
    const data = JSON.parse(baseConfigJson)
    const rules: any[] = data?.config?.modelConfigRules?.providerModelRules ?? []
    const direct = rules.find((r) => r.providerId === providerId && r.modelId === modelId)
    const values = direct?.config?.optionSpecs?.reasoningLevel?.values
    if (Array.isArray(values) && values.length > 0) return values
  } catch {
    // personal 配置非法时继续尝试内置规则
  }

  if (builtinConfigJson) {
    try {
      const builtinData = JSON.parse(builtinConfigJson)
      const builtinRules: any[] = builtinData?.config?.modelConfigRules?.modelRules ?? []
      for (const br of builtinRules) {
        if (br.modelMatch && new RegExp(`^${br.modelMatch}$`, 'i').test(modelId)) {
          const brLevels = br.config?.optionSpecs?.reasoningLevel?.values
          if (Array.isArray(brLevels) && brLevels.length > 0) return brLevels
        }
      }
    } catch {
      // 忽略内置配置解析异常
    }
  }
  return undefined
}

/**
 * 档位取位(P0-4):ReasoningEffort 通用四档映射到 CLI 合法 values 的首/中/末;
 * effort 缺省取最高档(values.at(-1),与 CLI registry-fallback 语义一致)。
 * values 为空返回 undefined,由调用侧回落"不带 options"并告警。
 */
export function pickReasoningLevel(
  values: string[] | undefined,
  effort?: ReasoningEffort,
): string | undefined {
  if (!values || values.length === 0) return undefined
  if (effort === undefined) return values.at(-1)
  if (effort === 'off') {
    const noneOpt = values.find((v) => /^(off|none|false|disabled)$/i.test(v))
    return noneOpt ?? undefined
  }
  const position: Record<Exclude<ReasoningEffort, 'off'>, number> = {
    minimal: 0,
    low: 1 / 3,
    medium: 2 / 3,
    high: 1,
  }
  const idx = Math.round(position[effort] * (values.length - 1))
  return values[idx]
}

/**
 * 构造任务级临时 provider 配置(双保险注入):
 * 1. 注入 config.defaultModelSelection: { providerId, modelId, options?: { reasoningLevel } };
 *    reasoningLevel 由调用侧经 resolveZcodeReasoningLevels + pickReasoningLevel 解析后传入,
 *    取不到合法值时不带 options(CLI 校验不过会回落实际模型),绝不猜写非法档位;
 * 2. 双保险 fallback:将指定 providerId 置顶到 providerOrder;
 * 3. 双保险 fallback:将指定 modelId 置顶到该 provider 的 modelOrder 与 personalModelIds。
 */
export function buildTaskZcodeProviderConfig(
  baseConfigJson: string,
  targetCompoundModelId: string,
  reasoningLevel?: string,
): string {
  const slashIdx = targetCompoundModelId.indexOf('/')
  if (slashIdx === -1) return baseConfigJson
  const targetProviderId = targetCompoundModelId.slice(0, slashIdx)
  const targetModel = targetCompoundModelId.slice(slashIdx + 1)

  let data: any
  try {
    data = JSON.parse(baseConfigJson)
  } catch {
    return baseConfigJson
  }
  if (!data.config) data.config = {}

  data.config.defaultModelSelection = {
    providerId: targetProviderId,
    modelId: targetModel,
    ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}),
  }

  if (Array.isArray(data.config.providerOrder)) {
    data.config.providerOrder = [
      targetProviderId,
      ...data.config.providerOrder.filter((id: string) => id !== targetProviderId),
    ]
  }

  const providerRules: any[] = data.config.providerConfigRules?.providerRules ?? []
  const targetProvider = providerRules.find((p) => p.providerId === targetProviderId)
  if (targetProvider?.config) {
    if (Array.isArray(targetProvider.config.modelOrder)) {
      targetProvider.config.modelOrder = [
        targetModel,
        ...targetProvider.config.modelOrder.filter((m: string) => m !== targetModel),
      ]
    }
    if (Array.isArray(targetProvider.config.personalModelIds)) {
      targetProvider.config.personalModelIds = [
        targetModel,
        ...targetProvider.config.personalModelIds.filter((m: string) => m !== targetModel),
      ]
    }
  }

  return JSON.stringify(data, null, 2)
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

    let tempConfigFile: string | undefined
    let effectiveEnv = this.getEffectiveEnv()
    if (options.modelId && options.modelId !== MODEL_CLIENT_FOLLOW && options.modelId.includes('/')) {
      try {
        const personalConfigPath = resolveZcodePersonalConfigPath(
          this.locator.personalProviderConfigPath ?? effectiveEnv?.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
        )
        if (this.fsx.exists(personalConfigPath)) {
          const rawPersonal = this.fsx.readTextFile(personalConfigPath)
          let rawBuiltin: string | undefined
          const builtinPath = effectiveEnv?.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
          if (builtinPath && this.fsx.exists(builtinPath)) {
            try {
              rawBuiltin = this.fsx.readTextFile(builtinPath)
            } catch {
              // 忽略内置配置读取异常
            }
          }
          // 档位解析(P0-4):按请求 effort 从合法 values 取位,取不到不带 options 回落客户端默认
          const reasoningLevels = resolveZcodeReasoningLevels(
            rawPersonal,
            options.modelId,
            rawBuiltin,
          )
          const reasoningLevel = pickReasoningLevel(reasoningLevels, options.reasoningEffort)
          if (!reasoningLevel) {
            emit({
              kind: 'warning',
              text: `未解析到 ${options.modelId} 的合法 reasoningLevel${options.reasoningEffort ? `(请求档位 ${options.reasoningEffort})` : ''},本次不带档位参数,思考强度跟随客户端默认`,
            })
          } else {
            // 实际档位入流(P0-4 复审):取位映射后实际下发值可能与请求四档不同
            // (如三档 values ["low","high","max"] 请求 low 实际下发 high),详情侧取此值为准
            emit({
              kind: 'info',
              text:
                reasoningLevel === options.reasoningEffort
                  ? `思考档位下发:${reasoningLevel}`
                  : `思考档位下发:${reasoningLevel}(请求 ${options.reasoningEffort ?? '默认'})`,
              reasoningLevel,
            })
          }
          const modifiedConfig = buildTaskZcodeProviderConfig(
            rawPersonal,
            options.modelId,
            reasoningLevel,
          )
          const tmpName = `zcode-provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
          const tmpPath = join(tmpdir(), tmpName)
          this.fsx.writeTextFile(tmpPath, modifiedConfig)
          tempConfigFile = tmpPath
          effectiveEnv = {
            ...effectiveEnv,
            ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: tmpPath,
          }
        } else {
          emit({
            kind: 'warning',
            text: `ZCode personal 配置未找到(${personalConfigPath}),按客户端当前默认运行`,
          })
        }
      } catch (error) {
        emit({
          kind: 'warning',
          text: `创建任务级模型配置副本失败,按客户端当前默认运行: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    let outputChars = 0
    const startedTimestamp = Date.now()

    // 会话锚点随行提取,不保留全量 stdout
    const scanSession = (line: string): void => {
      if (!sessionId && /session/i.test(line)) sessionId = extractSessionId(line)
    }
    const handleLine = (line: string): void => {
      scanSession(line)
      outputChars += line.length
      if (line) emit({ kind: 'message', channel: 'stdout', text: line })
    }

    const handle = this.runner.spawn({
      command: this.locator.nodeBin,
      args,
      cwd: input.cwd,
      env: effectiveEnv,
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

      let usage = tryReadZcodeSqliteUsage(sessionId, startedTimestamp)
      if (!usage) {
        const inTok = Math.ceil(input.prompt.length / 3)
        const outTok = Math.ceil(outputChars / 3)
        const cachedTok = input.sessionId ? Math.ceil(inTok * 0.75) : 0
        const credits = Number(((inTok + outTok + cachedTok) / 1000).toFixed(2))
        usage = {
          inputTokens: inTok,
          outputTokens: outTok,
          cachedTokens: cachedTok,
          credits,
        }
      }
      if (usage) emit({ kind: 'usage', ...usage })
      return { code, sessionId, usage }
    } finally {
      clearTimeout(watchdog)
      signal.removeEventListener('abort', onAbort)
      if (tempConfigFile) {
        try {
          this.fsx.remove(tempConfigFile)
        } catch {
          // 忽略临时文件清理异常
        }
      }
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
          env: this.getEffectiveEnv(),
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
        env: this.getEffectiveEnv(),
        onStdout,
        onStderr: () => {},
      },
      timeoutMs,
    )
  }

  /**
   * 构造 spawn 使用的环境变量:
   * 1. 保留 locator.nodeEnv (含 ELECTRON_RUN_AS_NODE=1 等);
   * 2. 若未显式传入 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,自动探查并注入内置 provider 配置路径,
   *    彻底解决官方 CLI 在脱离 Electron 主进程独立执行时报 "无法定位 CLI ZCode Built-in Provider Config" 的问题。
   */
  private getEffectiveEnv(): Record<string, string> | undefined {
    const builtinConfig = resolveZcodeBuiltinConfig(
      this.locator.cliPath,
      this.fsx,
      this.locator.builtinProviderConfigPath ?? this.locator.nodeEnv?.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    )
    if (!builtinConfig && !this.locator.nodeEnv) return undefined

    const env: Record<string, string> = { ...this.locator.nodeEnv }
    if (builtinConfig && !env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinConfig
    }
    return env
  }
}

/**
 * 尝试从 ZCode 本地 SQLite 权威库提取模型调用的实际用量
 */
export function tryReadZcodeSqliteUsage(
  sessionId?: string,
  startedAfterMs?: number,
): DriverUsage | undefined {
  try {
    const dbPath = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = (globalThis as any).require
    if (!req) return undefined
    const { DatabaseSync } = req('node:sqlite') ?? {}
    if (!DatabaseSync) return undefined
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let row: any
      if (sessionId) {
        row = db
          .prepare(
            `SELECT input_tokens, output_tokens, cache_read_input_tokens
             FROM model_usage
             WHERE session_id = ?
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get(sessionId)
      }
      if (!row && startedAfterMs) {
        row = db
          .prepare(
            `SELECT input_tokens, output_tokens, cache_read_input_tokens
             FROM model_usage
             WHERE started_at >= ?
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get(startedAfterMs)
      }
      if (row) {
        const inTok = Number(row.input_tokens) || 0
        const outTok = Number(row.output_tokens) || 0
        const cachedTok = Number(row.cache_read_input_tokens) || 0
        const total = inTok + outTok + cachedTok
        const credits = Number((total / 1000).toFixed(2))
        return {
          inputTokens: inTok,
          outputTokens: outTok,
          cachedTokens: cachedTok,
          credits,
        }
      }
    } finally {
      db.close()
    }
  } catch {
    // 忽略并降级
  }
  return undefined
}
