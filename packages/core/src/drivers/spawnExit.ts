import type { ProcessRunner, SpawnRequest } from '../ports.js'

/**
 * 探测/doctor 类短进程统一包装:跑完拿退出码,超时杀整棵进程树。
 * 长任务 run 不走这里(它们有自己的看门狗与事件流)。
 */
export function spawnForExit(
  runner: ProcessRunner,
  request: SpawnRequest,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const handle = runner.spawn(request)
    const timer = setTimeout(() => {
      void handle.killTree()
      reject(new Error(`探测超时(${timeoutMs}ms)`))
    }, timeoutMs)
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
