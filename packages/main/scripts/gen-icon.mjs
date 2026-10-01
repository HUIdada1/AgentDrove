#!/usr/bin/env node
/**
 * AgentDrove 图标生成脚本(零依赖)。
 *
 * 用 zlib 手写 PNG 编码(IHDR/IDAT/IEND + CRC32),生成:
 *   packages/main/build/icon.png  256x256 RGBA
 *   packages/main/build/icon.ico  同内容 PNG payload 的 ICO 容器
 *                                 (宽高字段写 0 表示 256,Vista+ 支持 PNG-in-ICO)
 *
 * 设计:深冷底 #10171e 圆角方块(四角留 8% 透明),中间冷蓝色 #4da3ff 向右三角
 * (派发/推进意象),三角右侧两条短横线(任务流)。带符号距离判断,不做抗锯齿。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.resolve(here, '..', 'build')

// ---------------- PNG 编码 ----------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  // compression/filter/interlace 均为 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---------------- ICO 容器 ----------------
function wrapICO(png) {
  const header = Buffer.alloc(6) // reserved(2) + type(2) + count(2)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // 1 张图
  const entry = Buffer.alloc(16)
  entry[0] = 0 // width 256 -> 0
  entry[1] = 0 // height 256 -> 0
  entry[2] = 0 // 调色板数
  entry[3] = 0 // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(6 + 16, 12) // 数据偏移
  return Buffer.concat([header, entry, png])
}

// ---------------- 绘制 ----------------
const S = 256
const C_BG = [0x10, 0x17, 0x1e] // #10171e 深冷底
const C_FG = [0x4d, 0xa3, 0xff] // #4da3ff 冷蓝

const M = 20 // 四角留 8%(256 * 0.08 ≈ 20)
const R = 36 // 圆角半径

function insideRoundedRect(x, y) {
  const x0 = M
  const y0 = M
  const x1 = S - 1 - M
  const y1 = S - 1 - M
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  // 圆角 SDF:点到内缩矩形的最近点距离不超过半径
  const cx = Math.min(Math.max(x, x0 + R), x1 - R)
  const cy = Math.min(Math.max(y, y0 + R), y1 - R)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= R * R
}

// 向右三角形(半平面同侧判定):A(100,76) B(100,180) C(180,128)
function edgeSign(px, py, ax, ay, bx, by) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

function insideTriangle(x, y) {
  const d1 = edgeSign(x, y, 100, 76, 100, 180)
  const d2 = edgeSign(x, y, 100, 180, 180, 128)
  const d3 = edgeSign(x, y, 180, 128, 100, 76)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

// 任务流:三角右侧两条短横线
function insideBar(x, y) {
  return x >= 190 && x <= 224 && ((y >= 106 && y <= 115) || (y >= 141 && y <= 150))
}

function render() {
  const px = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      if (!insideRoundedRect(x, y)) continue // 四角留透明
      let color = C_BG
      if (insideTriangle(x, y) || insideBar(x, y)) color = C_FG
      px[i] = color[0]
      px[i + 1] = color[1]
      px[i + 2] = color[2]
      px[i + 3] = 255
    }
  }
  return px
}

// ---------------- 校验 ----------------
function verifyPNG(buf, label) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error(`${label} PNG 签名不符`)
  }
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (w !== S || h !== S) throw new Error(`${label} IHDR 宽高异常: ${w}x${h}`)
  console.log(`[gen-icon] ${label} 校验通过: PNG 签名 OK, ${w}x${h}, ${(buf.length / 1024).toFixed(1)} KB`)
}

// ---------------- main ----------------
const png = encodePNG(S, S, render())
fs.mkdirSync(buildDir, { recursive: true })
const pngPath = path.join(buildDir, 'icon.png')
const icoPath = path.join(buildDir, 'icon.ico')
fs.writeFileSync(pngPath, png) // 同一张 PNG,托盘 resolveIconPath 找 build/icon.png
fs.writeFileSync(icoPath, wrapICO(png))
verifyPNG(fs.readFileSync(pngPath), 'build/icon.png')
verifyPNG(fs.readFileSync(icoPath).subarray(22), 'build/icon.ico(内嵌 PNG)')
console.log('[gen-icon] 已生成 packages/main/build/icon.png 与 build/icon.ico')
