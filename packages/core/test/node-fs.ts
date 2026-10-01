import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import type { FileStat, FileSystem } from '../src/index.js'

/** core 测试的真实文件系统适配器(行为与 main 的 NodeFileSystem 一致) */
export class TempFs implements FileSystem {
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

  readDir(path: string): string[] {
    return readdirSync(path)
  }

  stat(path: string): FileStat | null {
    try {
      const stat = statSync(path)
      return { size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() }
    } catch {
      return null
    }
  }

  copy(src: string, dest: string): void {
    cpSync(src, dest, { recursive: true })
  }

  remove(path: string): void {
    rmSync(path, { recursive: true, force: true })
  }
}

export { writeFileSync, mkdirSync, rmSync }
