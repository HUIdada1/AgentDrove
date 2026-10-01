import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import type { FileSystem } from '@agent-drove/core'

export class NodeFileSystem implements FileSystem {
  exists(path: string): boolean {
    return existsSync(path)
  }

  isWritable(path: string): boolean {
    try {
      accessSync(path, constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  ensureDir(path: string): void {
    mkdirSync(path, { recursive: true })
  }
}
