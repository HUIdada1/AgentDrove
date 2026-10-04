import { describe, expect, it } from 'vitest'
import { CodexDriver } from '../src/drivers/codex.js'
import type { TaskInput } from '../src/index.js'
import { codexProfile, FakeFileSystem, ScriptedRunner } from './helpers.js'

function makeDriver(fsx = new FakeFileSystem(), runner = new ScriptedRunner()) {
  return { driver: new CodexDriver(runner, fsx), fsx, runner }
}

function baseInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return { prompt: '写个快排', cwd: 'C:/tmp/ws', mode: 'build', ...overrides }
}

describe('CodexDriver 参数装配', () => {
  it('基础形态:exec --json -C cwd --sandbox read-only + prompt 收尾', () => {
    const { driver } = makeDriver()
    const args = driver.buildArgs(baseInput(), 'gpt-5.1-codex', codexProfile)
    expect(args[0]).toBe('exec')
    expect(args).toContain('--json')
    expect(args).toContain('--skip-git-repo-check')
    const c = args.indexOf('-C')
    expect(args[c + 1]).toBe('C:/tmp/ws')
    const sb = args.indexOf('--sandbox')
    expect(args[sb + 1]).toBe('read-only')
    expect(args[args.length - 1]).toBe('写个快排')
  })

  it('档位映射:edit→workspace-write,yolo→danger-full-access,plan→read-only', () => {
    const { driver } = makeDriver()
    const sandboxOf = (mode: TaskInput['mode']): string => {
      const args = driver.buildArgs(baseInput({ mode }), 'gpt-5.1-codex', codexProfile)
      return args[args.indexOf('--sandbox') + 1]!
    }
    expect(sandboxOf('edit')).toBe('workspace-write')
    expect(sandboxOf('yolo')).toBe('danger-full-access')
    expect(sandboxOf('plan')).toBe('read-only')
  })

  it('模型:client-follow 省略 --model,其余档位透传', () => {
    const { driver } = makeDriver()
    expect(driver.buildArgs(baseInput(), 'client-follow', codexProfile)).not.toContain('--model')
    const args = driver.buildArgs(baseInput(), 'gpt-5.1-codex-max', codexProfile)
    const idx = args.indexOf('--model')
    expect(args[idx + 1]).toBe('gpt-5.1-codex-max')
  })

  it('续聊:sessionId 走 resume <id>,resumeLatest 走 resume --last,新任务不带 resume', () => {
    const { driver } = makeDriver()
    const resume = driver.buildArgs(baseInput({ sessionId: '0aae5f21' }), 'client-follow', codexProfile)
    expect(resume).toContain('resume')
    expect(resume[resume.indexOf('resume') + 1]).toBe('0aae5f21')
    const latest = driver.buildArgs(baseInput({ resumeLatest: true }), 'client-follow', codexProfile)
    expect(latest.slice(latest.indexOf('resume'), latest.indexOf('resume') + 2)).toEqual([
      'resume',
      '--last',
    ])
    const fresh = driver.buildArgs(baseInput(), 'client-follow', codexProfile)
    expect(fresh).not.toContain('resume')
  })

  it('附件/denyList 不透传仅告警(codex exec 无等价参数)', () => {
    const { driver } = makeDriver()
    const warnings: string[] = []
    driver.buildArgs(
      baseInput({
        attachments: [{ path: 'C:/a.png', kind: 'image' }],
        toolPolicy: { denyList: ['Bash'], maxTurns: null },
      }),
      'client-follow',
      codexProfile,
      (e) => {
        if (e.kind === 'warning') warnings.push(e.text)
      },
    )
    expect(warnings).toHaveLength(2)
  })

  it('maxTurns 无等价参数时同样告警,不静默丢弃', () => {
    const { driver } = makeDriver()
    const warnings: string[] = []
    driver.buildArgs(
      baseInput({ toolPolicy: { maxTurns: 5 } }),
      'client-follow',
      codexProfile,
      (e) => {
        if (e.kind === 'warning') warnings.push(e.text)
      },
    )
    expect(warnings.some((t) => t.includes('maxTurns'))).toBe(true)
  })

  it('思考档位(P0-4):reasoningEffort 直通映射 --config model_reasoning_effort=<effort>,缺省不带', () => {
    const { driver } = makeDriver()
    const effortOf = (effort?: 'minimal' | 'low' | 'medium' | 'high'): string[] | undefined => {
      const args = driver.buildArgs(baseInput(), 'gpt-5.1-codex', codexProfile, undefined, effort)
      if (!args.includes('--config')) return undefined
      return args.slice(args.indexOf('--config'), args.indexOf('--config') + 2)
    }
    expect(effortOf()).toBeUndefined()
    expect(effortOf('low')).toEqual(['--config', 'model_reasoning_effort=low'])
    expect(effortOf('high')).toEqual(['--config', 'model_reasoning_effort=high'])
    expect(effortOf('minimal')).toEqual(['--config', 'model_reasoning_effort=minimal'])
    // prompt 恒为最后一个位置参数,--config 不改变收尾形态
    const withEffort = driver.buildArgs(
      baseInput(),
      'gpt-5.1-codex',
      codexProfile,
      undefined,
      'medium',
    )
    expect(withEffort[withEffort.length - 1]).toBe('写个快排')
  })
})

describe('CodexDriver 执行路径', () => {
  it('cwd 不可用直接失败,不 spawn', async () => {
    const { driver, runner } = makeDriver()
    await expect(driver.run({
      agent: codexProfile,
      modelId: 'gpt-5.1-codex',
      input: baseInput(),
      emit: () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/工作区不可用/)
    expect(runner.requests).toHaveLength(0)
  })

  it('abort 已置位时拒绝派发,不 spawn', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    const driver = new CodexDriver(runner, fsx)
    const controller = new AbortController()
    controller.abort()
    await expect(driver.run({
      agent: codexProfile,
      modelId: 'gpt-5.1-codex',
      input: baseInput(),
      emit: () => {},
      signal: controller.signal,
    })).rejects.toThrow(/已取消/)
    expect(runner.requests).toHaveLength(0)
  })

  it('运行中 abort:终止进程树并返回退出码', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue(() => {})
    const driver = new CodexDriver(runner, fsx)
    const controller = new AbortController()
    const pending = driver.run({
      agent: codexProfile,
      modelId: 'gpt-5.1-codex',
      input: baseInput(),
      emit: () => {},
      signal: controller.signal,
    })
    controller.abort()
    const result = await pending
    expect(result.code).toBe(1)
    expect(runner.killed).toHaveLength(1)
  })

  it('JSONL 事件流:thread_id 为会话锚点,agent_message/进度分流,usage 汇总', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => {
      io.stdout('{"type":"thread.started","thread_id":"0aae5f21-abcd"}\n')
      io.stdout('{"type":"item.completed","item":{"type":"agent_message","text":"完成"}}\n')
      io.stdout('{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}\n')
      io.stdout('{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":40}}\n')
      io.exit(0)
    })
    const driver = new CodexDriver(runner, fsx)
    const events: string[] = []
    const result = await driver.run({
      agent: codexProfile,
      modelId: 'gpt-5.1-codex',
      input: baseInput(),
      emit: (e) => events.push(e.kind === 'progress' ? `progress:${e.text}` : e.kind === 'message' ? `${e.channel}:${e.text}` : e.kind),
      signal: new AbortController().signal,
    })
    expect(result.code).toBe(0)
    expect(result.sessionId).toBe('0aae5f21-abcd')
    expect(events).toContain('agent:完成')
    expect(events).toContain('progress:▶ npm test')
    expect(events).toContain('usage')
  })

  it('error 事件走 stderr 通道;非 JSON 行原样透传', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => {
      io.stdout('普通文本行\n')
      io.stdout('{"type":"error","message":"quota exceeded"}\n')
      io.exit(1)
    })
    const driver = new CodexDriver(runner, fsx)
    const events: string[] = []
    await driver.run({
      agent: codexProfile,
      modelId: 'gpt-5.1-codex',
      input: baseInput(),
      emit: (e) => events.push(e.kind === 'message' ? `${e.channel}:${e.text}` : e.kind),
      signal: new AbortController().signal,
    })
    expect(events).toContain('stdout:普通文本行')
    expect(events).toContain('stderr:quota exceeded')
  })
})

describe('CodexDriver 探测与健康', () => {
  it('detect:命令名直接命中并探测版本', async () => {
    const { driver, runner } = makeDriver()
    runner.enqueue((_req, io) => {
      io.stdout('codex-cli 0.42.0\n')
      io.exit(0)
    })
    const detected = await driver.detect(['codex'])
    expect(detected?.id).toBe('codex')
    expect(detected?.version).toBe('codex-cli 0.42.0')
    expect(detected?.cliEntry).toBe('codex')
  })

  it('detect:文件路径存在才命中,否则 null', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/npm/codex.cmd')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => {
      io.stdout('codex-cli 0.42.0\n')
      io.exit(0)
    })
    const driver = new CodexDriver(runner, fsx)
    expect((await driver.detect(['C:/npm/codex.cmd']))?.entry).toBe('C:/npm/codex.cmd')
    const missing = makeDriver()
    expect(await missing.driver.detect(['C:/Nope/codex.cmd'])).toBeNull()
  })

  it('health:login status 退出码判登录态', async () => {
    const { driver, runner } = makeDriver()
    runner.enqueue((_req, io) => io.exit(0))
    expect(await driver.health(codexProfile)).toEqual({ ok: true })
    runner.enqueue((_req, io) => io.exit(1))
    const bad = await driver.health(codexProfile)
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('未登录')
  })
})
