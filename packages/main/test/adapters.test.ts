import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeFileSystem } from '../src/adapters/node-fs.js'
import { NodeProcessRunner } from '../src/adapters/node-process.js'

describe('NodeProcessRunner', () => {
  it('捕获 stdout 与退出码', async () => {
    const runner = new NodeProcessRunner()
    const chunks: string[] = []
    const handle = runner.spawn({
      command: process.execPath,
      args: ['-e', "process.stdout.write('你好\\n'); process.exit(0)"],
      cwd: tmpdir(),
      onStdout: (c) => chunks.push(c.toString('utf8')),
      onStderr: () => {},
    })
    const code = await handle.exited
    expect(code).toBe(0)
    expect(chunks.join('')).toContain('你好')
    expect(handle.pid).toBeGreaterThan(0)
  })

  it('killTree 终止长驻进程树', async () => {
    const runner = new NodeProcessRunner()
    const handle = runner.spawn({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: tmpdir(),
      onStdout: () => {},
      onStderr: () => {},
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await handle.killTree()
    const code = await Promise.race([
      handle.exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('进程未被终止')), 3000),
      ),
    ])
    expect(code).not.toBe(0)
  })
})

describe('NodeFileSystem', () => {
  it('存在性与可写性判断', () => {
    const fsx = new NodeFileSystem()
    const dir = mkdtempSync(join(tmpdir(), 'ad-fs-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    expect(fsx.exists(file)).toBe(true)
    expect(fsx.isWritable(dir)).toBe(true)
    expect(fsx.exists(join(dir, 'nope.txt'))).toBe(false)
  })

  it('ensureDir 递归创建', () => {
    const fsx = new NodeFileSystem()
    const dir = join(mkdtempSync(join(tmpdir(), 'ad-fs-')), 'a', 'b')
    fsx.ensureDir(dir)
    expect(fsx.exists(dir)).toBe(true)
  })
})
