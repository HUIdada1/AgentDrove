import { describe, expect, it } from 'vitest'
import { QoderDriver } from '../src/drivers/qoder.js'
import { TraeDriver } from '../src/drivers/trae.js'
import type { TaskInput } from '../src/index.js'
import { qoderProfile, FakeFileSystem, ScriptedRunner, zcodeProfile } from './helpers.js'

describe('QoderDriver', () => {
  it('buildArgs 纯函数:模型档位与续聊形态可单测锁定', () => {
    const driver = new QoderDriver(new ScriptedRunner(), new FakeFileSystem())
    const input: TaskInput = { prompt: 'hi', cwd: 'C:/ws', resumeLatest: true }
    expect(driver.buildArgs(input, 'client-follow', qoderProfile)).toEqual([
      '-p',
      'hi',
      '--output-format',
      'stream-json',
      '-c',
    ])
    expect(driver.buildArgs(input, 'qwen3.7-max', qoderProfile)).toContain('--model')
  })

  it('参数装配:-p/stream-json/模型/续聊/-r', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(0))
    const driver = new QoderDriver(runner, fsx)
    await driver.run({
      agent: qoderProfile,
      modelId: 'qwen3.7-max',
      input: {
        prompt: 'hi',
        cwd: 'C:/tmp/ws',
        sessionId: 'sess-1',
        toolPolicy: { denyList: ['Bash'], maxTurns: 8 },
      },
      emit: () => {},
      signal: new AbortController().signal,
    })
    const args = runner.requests[0].args
    expect(args).toEqual([
      '-p',
      'hi',
      '--output-format',
      'stream-json',
      '--model',
      'qwen3.7-max',
      '-r',
      'sess-1',
      '--max-turns',
      '8',
    ])
    expect(runner.requests[0].command).toBe(qoderProfile.entry)
  })

  it('denyList/附件未透传时发 warning,不静默丢弃', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(0))
    const driver = new QoderDriver(runner, fsx)
    const warnings: string[] = []
    await driver.run({
      agent: qoderProfile,
      modelId: 'qwen3.7-max',
      input: {
        prompt: 'hi',
        cwd: 'C:/tmp/ws',
        attachments: [{ path: 'C:/a.png', kind: 'image' }],
        toolPolicy: { denyList: ['Bash'] },
      },
      emit: (e) => {
        if (e.kind === 'warning') warnings.push(e.text)
      },
      signal: new AbortController().signal,
    })
    expect(warnings.some((t) => t.includes('工具禁用清单'))).toBe(true)
    expect(warnings.some((t) => t.includes('附件'))).toBe(true)
  })

  it('health:--version 退出码 0 视为健康', async () => {
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(0))
    const driver = new QoderDriver(runner, new FakeFileSystem())
    expect(await driver.health(qoderProfile)).toEqual({ ok: true })
  })

  it('abort 已置位时拒绝派发,不 spawn', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    const driver = new QoderDriver(runner, fsx)
    const controller = new AbortController()
    controller.abort()
    await expect(driver.run({
      agent: qoderProfile,
      modelId: 'qwen3.7-max',
      input: { prompt: 'hi', cwd: 'C:/tmp/ws' },
      emit: () => {},
      signal: controller.signal,
    })).rejects.toThrow(/已取消/)
    expect(runner.requests).toHaveLength(0)
  })

  it('PATH 命令名入口经 shell 解析(Windows .cmd shim 否则 ENOENT)', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(0))
    const driver = new QoderDriver(runner, fsx)
    await driver.run({
      agent: qoderProfile,
      modelId: 'qwen3.7-max',
      input: { prompt: 'hi', cwd: 'C:/tmp/ws' },
      emit: () => {},
      signal: new AbortController().signal,
    })
    expect(runner.requests[0].command).toBe('qoderclicn')
    expect(runner.requests[0].shell).toBe(true)
  })

  it('detect:命令名入口可直接命中(未安装场景由 health 拦截)', async () => {
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => {
      io.stdout('0.5.0\n')
      io.exit(0)
    })
    const driver = new QoderDriver(runner, new FakeFileSystem())
    const detected = await driver.detect(['qoderclicn'])
    expect(detected?.cliEntry).toBe('qoderclicn')
  })
})

describe('TraeDriver', () => {
  const traeProfile = {
    ...zcodeProfile,
    id: 'trae',
    label: 'TraeCode',
    driver: 'trae',
    entry: 'E:/Trae/bin/trae.cmd',
    capabilities: { headless: false, sessionResume: false, modelSwitch: 'none' as const, attachments: true },
  }

  it('半自动派发:chat + 模式映射 + 附件 -a', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(0))
    const driver = new TraeDriver(runner, fsx)
    const warnings: string[] = []
    await driver.run({
      agent: traeProfile as never,
      modelId: 'client-follow',
      input: {
        prompt: '改代码',
        cwd: 'C:/tmp/ws',
        mode: 'build',
        attachments: [{ path: 'C:/a.ts', kind: 'file' }],
      },
      emit: (e) => {
        if (e.kind === 'warning') warnings.push(e.text)
      },
      signal: new AbortController().signal,
    })
    const request = runner.requests[0]
    expect(request.command).toBe('E:/Trae/bin/trae.cmd')
    expect(request.shell).toBe(true) // .cmd 必须经 shell
    expect(request.args).toEqual(['chat', '改代码', '-m', 'agent', '-a', 'C:/a.ts'])
    expect(warnings.some((t) => t.includes('半自动'))).toBe(true)
  })

  it('plan 模式映射为 ask', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(0))
    const driver = new TraeDriver(runner, fsx)
    await driver.run({
      agent: traeProfile as never,
      modelId: 'client-follow',
      input: { prompt: '评审', cwd: 'C:/tmp/ws', mode: 'plan' },
      emit: () => {},
      signal: new AbortController().signal,
    })
    expect(runner.requests[0].args).toContain('ask')
  })

  it('denyList 无等价参数时告警,且 abort 已置位不 spawn', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    const driver = new TraeDriver(runner, fsx)
    const controller = new AbortController()
    controller.abort()
    const warnings: string[] = []
    await expect(driver.run({
      agent: traeProfile as never,
      modelId: 'client-follow',
      input: { prompt: '改代码', cwd: 'C:/tmp/ws', toolPolicy: { denyList: ['Bash'] } },
      emit: (e) => {
        if (e.kind === 'warning') warnings.push(e.text)
      },
      signal: controller.signal,
    })).rejects.toThrow(/已取消/)
    expect(warnings.some((t) => t.includes('denyList'))).toBe(true)
    expect(runner.requests).toHaveLength(0)
  })

  it('health 探活:--version', async () => {
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => {
      io.stdout('1.107.1\n')
      io.exit(0)
    })
    const driver = new TraeDriver(runner, new FakeFileSystem())
    expect(await driver.health(traeProfile as never)).toEqual({ ok: true })
  })

  it('detect:安装根拼接 bin/trae.cmd', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('E:/Trae/bin/trae.cmd')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => {
      io.stdout('1.107.1\n')
      io.exit(0)
    })
    const driver = new TraeDriver(runner, fsx)
    const detected = await driver.detect(['E:/Trae'])
    expect(detected?.version).toBe('1.107.1')
  })
})
