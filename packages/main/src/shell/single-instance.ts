import { app } from 'electron'

/**
 * 单实例锁(R16):失败即退出,由已运行实例响应 second-instance 唤起窗口。
 */
export function acquireSingleInstance(onSecondInstance: () => void): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (gotLock) {
    app.on('second-instance', onSecondInstance)
  }
  return gotLock
}
