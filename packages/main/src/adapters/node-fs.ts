import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import type { FileStat, FileSystem } from '@agent-drove/core'

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

  readTextFile(path: string): string {
    return readFileSync(path, 'utf8')
  }

  writeTextFile(path: string, content: string): void {
    writeFileSync(path, content, 'utf8')
  }
}

