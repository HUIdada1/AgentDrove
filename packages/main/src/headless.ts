import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryTaskRepository,
  MODEL_CLIENT_FOLLOW,
  Orchestrator,
  Registry,
  ZcodeDriver,
  type AgentProfile,
  type EventSink,
  type StoredEvent,
  type TaskMode,
  type TaskRecord,
} from '@agent-drove/core'
import { NodeFileSystem } from './adapters/node-fs.js'
import { NodeProcessRunner } from './adapters/node-process.js'

/**
 * 无 GUI 的端到端入口(M1 DoD 验证用):
 * 探测 → 健康自检 → 派发单任务 → 事件流打到 stdout → 按终态给退出码。
 * GUI 壳就位后此文件保留作冒烟工具。
 */

const DEFAULT_ZCODE_CLI = 'E:\\ZCode\\resources\\glm\\zcode.cjs'

interface CliArgs {
  prompt?: string
  cwd?: string
  mode?: string
  model?: string
  zcodeCli?: string
  resume?: string
  deny?: string[]
  timeoutMs?: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const next = () => argv[++i]
    switch (key) {
      case '--prompt': args.prompt = next(); break
      case '--cwd': args.cwd = next(); break
      case '--mode': args.mode = next(); break
      case '--model': args.model = next(); break
      case '--zcode-cli': args.zcodeCli = next(); break
      case '--resume': args.resume = next(); break
      case '--deny': args.deny = (next() ?? '').split(',').filter(Boolean); break
      case '--timeout': {
        const ms = Number(next())
        if (Number.isFinite(ms) && ms > 0) args.timeoutMs = ms
        break
      }
    }
  }
  return args
}

class ConsoleSink implements EventSink {
  append(events: StoredEvent[]): void {
    for (const { seq, event } of events) {
      if (event.kind === 'message') {
        console.log(`#${seq} [${event.channel}] ${event.text}`)
      } else if (event.kind === 'state-changed') {
        console.log(`#${seq} [state] ${event.from} → ${event.to}`)
      } else if (event.kind === 'warning') {
        console.log(`#${seq} [warn] ${event.text}`)
      } else {
        console.log(`#${seq} [${event.kind}] ${JSON.stringify(event)}`)
      }
    }
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.prompt) {
    console.error('用法: tsx src/headless.ts --prompt "..." [--cwd dir] [--mode build] [--deny Bash,Write] [--resume id]')
    return 64
  }
  const cliPath = args.zcodeCli ?? process.env.AGENTDROVE_ZCODE_CLI ?? DEFAULT_ZCODE_CLI
  const fsx = new NodeFileSystem()
  const runner = new NodeProcessRunner()
  const driver = new ZcodeDriver(runner, fsx, {
    nodeBin: process.execPath,
    cliPath,
  })

  const installRoot = cliPath.replace(/[\\/]resources[\\/]glm[\\/]zcode\.cjs$/i, '')
  const detected = await driver.detect([installRoot, cliPath])
  if (!detected) {
    console.error(`未探测到 ZCode CLI:${cliPath}`)
    return 3
  }
  console.log(`探测到 ZCode:${detected.cliEntry}${detected.version ? ` (v${detected.version})` : ''}`)

  const profile: AgentProfile = {
    id: 'zcode',
    label: 'ZCode',
    driver: 'zcode',
    entry: detected.entry,
    cliEntry: detected.cliEntry,
    version: detected.version,
    models: [],
    defaultModel: MODEL_CLIENT_FOLLOW,
    capabilities: { headless: true, sessionResume: true, modelSwitch: 'none', attachments: true },
    plan: { name: 'GLM Coding Plan', quotaKind: 'daily', modelIds: [], dailyTaskCap: 20, maxConcurrency: 1 },
    enabled: true,
  }

  const health = await driver.health(profile)
  if (!health.ok) {
    console.error(`客户端不健康:${health.reason ?? '未知原因'}`)
    return 3
  }

  const registry = new Registry()
  registry.register(profile)
  const repo = new MemoryTaskRepository()
  const orchestrator = new Orchestrator(registry, {
    repo,
    sink: new ConsoleSink(),
    defaultCwd: mkdtempSync(join(tmpdir(), 'agent-drove-')),
    defaultTimeoutMs: args.timeoutMs,
  })
  orchestrator.registerDriver(driver)

  const task: TaskRecord = orchestrator.submit({
    agentId: 'zcode',
    prompt: args.prompt,
    cwd: args.cwd,
    mode: (args.mode as TaskMode | undefined) ?? 'build',
    sessionId: args.resume,
    toolPolicy: args.deny ? { denyList: args.deny } : undefined,
  })
  console.log(`任务 ${task.id} 已派发,等待终态...`)

  return await new Promise<number>((resolve) => {
    const timer = setInterval(() => {
      const current = orchestrator.get(task.id)
      if (!current) return
      if (current.state === 'completed') {
        clearInterval(timer)
        resolve(0)
      } else if (current.state === 'failed') {
        clearInterval(timer)
        console.error(`任务失败:${current.error}`)
        resolve(1)
      } else if (current.state === 'canceled' || current.state === 'interrupted') {
        clearInterval(timer)
        resolve(2)
      }
    }, 200)
    // 驱动失联(进程消失且无终态事件)时不能让冒烟脚本挂死,超时也按失败退出
    const watchdogMs = (args.timeoutMs ?? 600_000) + 30_000
    setTimeout(() => {
      clearInterval(timer)
      // 先取消任务以中止并回收 CLI 进程树,避免僵尸进程残留
      orchestrator.cancel(task.id)
      console.error(`等待终态超时(${Math.round(watchdogMs / 1000)}s),按失败退出`)
      resolve(1)
    }, watchdogMs).unref()
  })
}

process.exit(await main())
