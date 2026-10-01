import iconv from 'iconv-lite'

/**
 * 完整输出解码:UTF-8 严格校验,失败回退 GBK。
 * Windows 中文环境下原生 CLI 的 stderr 可能是 GBK,zcode(node 程序)恒为 UTF-8。
 */
export function decodeBuffer(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return iconv.decode(buf, 'gbk')
  }
}

/**
 * 按行增量解码。以 \n 为界缓存字节,整行再解码:
 * UTF-8/GBK 的多字节序列都不可能含 0x0A,行边界切分不会撕裂字符。
 */
export class LineDecoder {
  private pending: Buffer[] = []
  private pendingLength = 0

  /** 返回本次推送后凑齐的完整行(已去 \r) */
  push(chunk: Buffer): string[] {
    const lines: string[] = []
    let start = 0
    while (true) {
      const nl = chunk.indexOf(0x0a, start)
      if (nl < 0) break
      this.pending.push(chunk.subarray(start, nl))
      lines.push(decodeLine(Buffer.concat(this.pending)))
      this.pending = []
      this.pendingLength = 0
      start = nl + 1
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      this.pending.push(rest)
      this.pendingLength += rest.length
    }
    return lines
  }

  /** 收尾:残留内容(无换行)也作为一行交出 */
  flush(): string[] {
    if (this.pendingLength === 0) return []
    const line = decodeLine(Buffer.concat(this.pending))
    this.pending = []
    this.pendingLength = 0
    return [line]
  }
}

function decodeLine(buf: Buffer): string {
  return decodeBuffer(buf).replace(/\r$/, '')
}

/** 会话 id 提取(V2 定论前的保守实现):优先 JSON 输出字段,其次键值对文本 */
export function extractSessionId(output: string): string | undefined {
  const trimmed = output.trim()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of ['session_id', 'sessionId', 'sessionID']) {
        const value = record[key]
        if (typeof value === 'string' && value.length >= 8) return value
      }
    }
  } catch {
    // 非 JSON 输出,走文本匹配
  }
  const match = trimmed.match(
    /\bsession[_ -]?id\b["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9_-]{7,})/i,
  )
  return match?.[1]
}
