import { normalize } from 'node:path'
import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import {
  ZcodeDriver,
  resolveZcodeBuiltinConfig,
  type ZcodeLocator,
} from '../src/drivers/zcode.js'
import { extractSessionId, LineDecoder, satisfiesRange } from '../src/index.js'
import type { TaskInput } from '../src/index.js'
import { FakeFileSystem, ScriptedRunner, zcodeProfile } from './helpers.js'

const locator: ZcodeLocator = {
  nodeBin: 'node',
  cliPath: 'E:/ZCode/resources/glm/zcode.cjs',
}

function makeDriver(fsx = new FakeFileSystem(), runner = new ScriptedRunner()) {
  return { driver: new ZcodeDriver(runner, fsx, locator), fsx, runner }
}

function baseInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return { prompt: '写个快排', cwd: 'C:/tmp/ws', mode: 'build', ...overrides }
}

describe('ZcodeDriver 参数装配', () => {
  it('恒显式携带 --mode,无头缺省 yolo 绝不依赖默认值', () => {
    const { driver } = makeDriver()
    expect(driver.buildArgs(baseInput())).toContain('--mode')
    const args = driver.buildArgs(baseInput({ mode: 'plan' }))
    expect(args[args.indexOf('--mode') + 1]).toBe('plan')
  })

  it('附件逐个透传 --attach(可重复)', () => {
    const { driver } = makeDriver()
    const args = driver.buildArgs(
      baseInput({
        attachments: [
          { path: 'C:/a.png', kind: 'image' },
          { path: 'C:/b.md', kind: 'file' },
        ],
      }),
    )
    expect(args.filter((a) => a === '--attach')).toHaveLength(2)
    expect(args).toContain('C:/a.png')
    expect(args).toContain('C:/b.md')
  })

  it('工具限制按 --disallowed-tools 工具级透传', () => {
    const { driver } = makeDriver()
    const args = driver.buildArgs(
      baseInput({ toolPolicy: { denyList: ['Bash', 'Write'], maxTurns: null } }),
    )
    const idx = args.indexOf('--disallowed-tools')
    expect(args.slice(idx + 1, idx + 3)).toEqual(['Bash', 'Write'])
  })

  it('续聊:有 sessionId 走 --resume,否则 resumeLatest 走 -c', () => {
    const { driver } = makeDriver()
    const resume = driver.buildArgs(baseInput({ sessionId: 'abc-12345678' }))
    expect(resume.slice(resume.indexOf('--resume'))).toEqual(['--resume', 'abc-12345678'])
    const latest = driver.buildArgs(baseInput({ resumeLatest: true }))
    expect(latest).toContain('-c')
    const fresh = driver.buildArgs(baseInput())
    expect(fresh).not.toContain('--resume')
    expect(fresh).not.toContain('-c')
  })

  it('zcode 无模型参数:resolveModelArg 恒为空', () => {
    const { driver } = makeDriver()
    expect(driver.resolveModelArg('client-follow', zcodeProfile)).toEqual([])
  })
})

describe('ZcodeDriver 执行路径', () => {
  it('cwd 不存在或不可写:直接失败不 spawn', async () => {
    const { driver, runner } = makeDriver()
    await expect(driver.run({
      agent: zcodeProfile,
      modelId: 'client-follow',
      input: baseInput(),
      emit: () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/工作区不可用/)
    expect(runner.requests).toHaveLength(0)
  })

  it('正常执行:按行产出 stdout 事件,退出码 0,提取会话 id', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => {
      io.stdout('分析中...\n')
      io.stdout('{"session_id":"sess-abcd1234"}\n')
      io.exit(0)
    })
    const driver = new ZcodeDriver(runner, fsx, locator)
    const events: string[] = []
    const result = await driver.run({
      agent: zcodeProfile,
      modelId: 'client-follow',
      input: baseInput(),
      emit: (e) => events.push(e.kind === 'message' ? `${e.channel}:${e.text}` : e.kind),
      signal: new AbortController().signal,
    })
    expect(result.code).toBe(0)
    expect(result.sessionId).toBe('sess-abcd1234')
    expect(events).toContain('stdout:分析中...')
    expect(events).toContain('stdout:{"session_id":"sess-abcd1234"}')
  })

  it('GBK 输出回退解码不乱码', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    const gbkLine = iconv.encode('目录不存在\n', 'gbk')
    runner.enqueue((_req, io) => {
      io.stdout(gbkLine)
      io.exit(1)
    })
    const driver = new ZcodeDriver(runner, fsx, locator)
    const texts: string[] = []
    await driver.run({
      agent: zcodeProfile,
      modelId: 'client-follow',
      input: baseInput(),
      emit: (e) => {
        if (e.kind === 'message') texts.push(e.text)
      },
      signal: new AbortController().signal,
    })
    expect(texts).toContain('目录不存在')
  })

  it('看门狗超时:杀进程树并抛错', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    // 脚本不主动退出,等 killTree 收尾
    runner.enqueue(() => {})
    const driver = new ZcodeDriver(runner, fsx, locator)
    await expect(driver.run({
      agent: zcodeProfile,
      modelId: 'client-follow',
      input: baseInput(),
      emit: () => {},
      signal: new AbortController().signal,
      timeoutMs: 40,
    })).rejects.toThrow(/看门狗超时/)
    expect(runner.killed).toHaveLength(1)
  })

  it('abort 信号:立即终止进程树', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue(() => {})
    const driver = new ZcodeDriver(runner, fsx, locator)
    const controller = new AbortController()
    const pending = driver.run({
      agent: zcodeProfile,
      modelId: 'client-follow',
      input: baseInput(),
      emit: () => {},
      signal: controller.signal,
    })
    controller.abort()
    const result = await pending
    expect(result.code).toBe(1)
    expect(runner.killed).toHaveLength(1)
  })

  it('onSpawn 上报进程号', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(0))
    const driver = new ZcodeDriver(runner, fsx, locator)
    let pid: number | undefined
    await driver.run({
      agent: zcodeProfile,
      modelId: 'client-follow',
      input: baseInput(),
      emit: () => {},
      signal: new AbortController().signal,
      onSpawn: (p) => {
        pid = p
      },
    })
    expect(pid).toBeGreaterThan(0)
  })

  it('maxTurns 无等价参数时告警,不静默丢弃', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(0))
    const driver = new ZcodeDriver(runner, fsx, locator)
    const warnings: string[] = []
    await driver.run({
      agent: zcodeProfile,
      modelId: 'client-follow',
      input: baseInput({ toolPolicy: { maxTurns: 3 } }),
      emit: (e) => {
        if (e.kind === 'warning') warnings.push(e.text)
      },
      signal: new AbortController().signal,
    })
    expect(warnings.some((t) => t.includes('maxTurns'))).toBe(true)
  })
})

describe('ZcodeDriver 探测与健康', () => {
  it('detect:候选路径命中 zcode.cjs 并读取版本', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('E:/ZCode/resources/glm/zcode.cjs')
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => {
      io.stdout('0.16.9\n')
      io.exit(0)
    })
    const driver = new ZcodeDriver(runner, fsx, locator)
    const detected = await driver.detect(['E:/ZCode'])
    // join 在 Windows 上产出原生分隔符,断言按规整后比较
    expect(normalize(detected?.cliEntry ?? '')).toBe(
      normalize('E:/ZCode/resources/glm/zcode.cjs'),
    )
    expect(detected?.version).toBe('0.16.9')
  })

  it('detect:全部未命中返回 null', async () => {
    const { driver } = makeDriver()
    expect(await driver.detect(['C:/Nope'])).toBeNull()
  })

  it('health:doctor 退出码 0 视为健康', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable(locator.cliPath)
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(0))
    const driver = new ZcodeDriver(runner, fsx, locator)
    expect(await driver.health(zcodeProfile)).toEqual({ ok: true })
  })

  it('health:doctor 非零退出码带原因', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable(locator.cliPath)
    const runner = new ScriptedRunner()
    runner.enqueue((_req, io) => io.exit(2))
    const driver = new ZcodeDriver(runner, fsx, locator)
    const health = await driver.health(zcodeProfile)
    expect(health.ok).toBe(false)
    expect(health.reason).toContain('2')
  })

  it('health:CLI 缺失直接不健康', async () => {
    const { driver } = makeDriver()
    const health = await driver.health(zcodeProfile)
    expect(health.ok).toBe(false)
    expect(health.reason).toContain('CLI 不存在')
  })
})

describe('文本与版本工具', () => {
  it('LineDecoder:多字节字符跨块不撕裂', () => {
    const decoder = new LineDecoder()
    const full = Buffer.from('你好\n世界', 'utf8')
    const first = decoder.push(full.subarray(0, 4)) // 好 字被切成 1+2 字节
    const second = decoder.push(full.subarray(4))
    expect([...first, ...second, ...decoder.flush()]).toEqual(['你好', '世界'])
  })

  it('LineDecoder:末尾无换行的残留行由 flush 交出', () => {
    const decoder = new LineDecoder()
    expect(decoder.push(Buffer.from('a\nb'))).toEqual(['a'])
    expect(decoder.flush()).toEqual(['b'])
  })

  it('extractSessionId:JSON 与键值对两种形态', () => {
    expect(extractSessionId('{"session_id":"abc12-3456"}')).toBe('abc12-3456')
    expect(extractSessionId('session_id: xyz98765432')).toBe('xyz98765432')
    expect(extractSessionId('普通输出无会话')).toBeUndefined()
  })

  it('satisfiesRange:双子句范围判断', () => {
    expect(satisfiesRange('0.16.9', '>=0.16 <0.17')).toBe(true)
    expect(satisfiesRange('0.17.0', '>=0.16 <0.17')).toBe(false)
    expect(satisfiesRange('0.15.2', '>=0.16 <0.17')).toBe(false)
    expect(satisfiesRange('1.2.3', '=1.2.3')).toBe(true)
  })
})

describe('ZCode Built-in Provider Config 自动定位与环境变量注入', () => {
  const cliPath = 'E:/ZCode/resources/glm/zcode.cjs'

  it('显式路径存在时优先采用', () => {
    const fsx = new FakeFileSystem()
    const custom = 'D:/custom/zcode-builtin.json'
    fsx.addWritable(custom)
    expect(resolveZcodeBuiltinConfig(cliPath, fsx, custom)).toBe(custom)
  })

  it('打包态标准路径:优先匹配 resources/config/provider/zcode-builtin.json', () => {
    const fsx = new FakeFileSystem()
    const bundled = 'E:/ZCode/resources/config/provider/zcode-builtin.json'
    fsx.addWritable(bundled)
    const resolved = resolveZcodeBuiltinConfig(cliPath, fsx)
    expect(resolved && normalize(resolved)).toBe(normalize(bundled))
  })

  it('命中同级 provider/zcode-builtin.json', () => {
    const fsx = new FakeFileSystem()
    const sameDir = 'E:/ZCode/resources/glm/provider/zcode-builtin.json'
    fsx.addWritable(sameDir)
    const resolved = resolveZcodeBuiltinConfig(cliPath, fsx)
    expect(resolved && normalize(resolved)).toBe(normalize(sameDir))
  })

  it('所有路径都不存在时返回 undefined', () => {
    const fsx = new FakeFileSystem()
    expect(resolveZcodeBuiltinConfig(cliPath, fsx)).toBeUndefined()
  })

  it('驱动自动将定位到的配置注入到 spawn 环境变量 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    fsx.addWritable(locator.cliPath)
    const bundledConfig = 'E:/ZCode/resources/config/provider/zcode-builtin.json'
    fsx.addWritable(bundledConfig)

    const runner = new ScriptedRunner()
    runner.enqueue((req, io) => {
      expect(req.env?.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && normalize(req.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE)).toBe(normalize(bundledConfig))
      expect(req.env?.ELECTRON_RUN_AS_NODE).toBe('1')
      io.stdout('ok\n')
      io.exit(0)
    })

    const driver = new ZcodeDriver(runner, fsx, {
      nodeBin: 'node',
      cliPath: locator.cliPath,
      nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    })

    await driver.run({
      agent: zcodeProfile,
      modelId: 'client-follow',
      input: baseInput(),
      emit: () => {},
      signal: new AbortController().signal,
    })

    expect(runner.requests).toHaveLength(1)
  })

  it('若外部已显式指定环境变量则不覆盖', async () => {
    const fsx = new FakeFileSystem()
    fsx.addWritable('C:/tmp/ws')
    fsx.addWritable(locator.cliPath)
    const existing = 'X:/my-custom/zcode-builtin.json'

    const runner = new ScriptedRunner()
    runner.enqueue((req, io) => {
      expect(req.env?.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe(existing)
      io.exit(0)
    })

    const driver = new ZcodeDriver(runner, fsx, {
      nodeBin: 'node',
      cliPath: locator.cliPath,
      nodeEnv: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: existing },
    })

    await driver.run({
      agent: zcodeProfile,
      modelId: 'client-follow',
      input: baseInput(),
      emit: () => {},
      signal: new AbortController().signal,
    })

    expect(runner.requests).toHaveLength(1)
  })
})

