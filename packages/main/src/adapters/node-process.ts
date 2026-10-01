import { exec } from 'node:child_process'
import { spawn as nodeSpawn } from 'node:child_process'
import type { ProcessHandle, ProcessRunner, SpawnRequest } from '@agent-drove/core'

export class NodeProcessRunner implements ProcessRunner {
  spawn(request: SpawnRequest): ProcessHandle {
    const child = nodeSpawn(request.command, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout?.on('data', (chunk: Buffer) => request.onStdout(chunk))
    child.stderr?.on('data', (chunk: Buffer) => request.onStderr(chunk))
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? -1))
    })
    return {
      pid: child.pid ?? -1,
      exited,
      killTree: () => killTree(child.pid ?? -1),
    }
  }
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (pid < 0) return resolve()
    // /T 杀整棵树防止 CLI 派生孙进程残留;/F 强制;进程已退出时 taskkill 非零属预期
    exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, () => resolve())
  })
}
