#!/usr/bin/env node
/**
 * AgentDrove 图标生成脚本(零依赖)。
 *
 * 用 zlib 手写 PNG 编码(IHDR/IDAT/IEND + CRC32),生成:
 *   packages/main/build/icon.png  256x256 RGBA
 *   packages/main/build/icon.ico  同内容 PNG payload 的 ICO 容器
 *                                 (宽高字段写 0 表示 256,Vista+ 支持 PNG-in-ICO)
 *
 * 绘制:与 renderer 的 logo.svg 同一套几何(三条任务流汇入圆环执行节点,节点向右输出),
 * 坐标按 64 空间定义再 ×4 映射,两边改一处即同步。深冷圆角方块底 #10171e(与托盘深色融合),
 * 上下 ±6% 明度渐变给一点玻璃感;主色 #4d9ede 画节点,深一档 #2e6ea8 画输入流。
 * 距离场算覆盖度,边缘自带 1px 抗锯齿,托盘 16px 下不糊边。
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
const U = S / 64 // logo.svg 的 64 空间坐标 → 像素,保持两边几何同源

const C_BG = [0x10, 0x17, 0x1e] // #10171e 深冷底
const C_MAIN = [0x4d, 0x9e, 0xde] // #4d9ede 主色:执行节点/输出
const C_DEEP = [0x2e, 0x6e, 0xa8] // 深一档:输入任务流

const R = Math.round(S * 0.18) // 圆角半径约 18%(256px 下 ~46)

// 64 空间几何(与 logo.svg 一致):输入流折线、节点环、芯点、输出线
const STREAMS = [
  [9, 13, 22, 13, 34.1, 25.1], // 上:横进 + 45° 折入
  [9, 32, 31, 32], // 中:直线入环
  [9, 51, 22, 51, 34.1, 38.9], // 下:横进 + 45° 折入
]
const RING = { cx: 41, cy: 32, r: 10, w: 5 }
const DOT = { cx: 41, cy: 32, r: 3.2 }
const OUT = [52, 32, 57, 32]
const STROKE = 5 // 输入流/输出线线宽

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
// 覆盖度:像素中心在形状内 0.5px 记满覆盖,边界半覆盖,等效 1px 抗锯齿
const cover = (d) => clamp01(0.5 - d)
const mix = (a, b, t) => a + (b - a) * t

function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// 折线距离取各段最小;坐标从 64 空间放大到像素
function sdPolyline(px, py, pts) {
  let best = Infinity
  for (let i = 0; i + 3 < pts.length; i += 2) {
    best = Math.min(best, sdSegment(px, py, pts[i] * U, pts[i + 1] * U, pts[i + 2] * U, pts[i + 3] * U))
  }
  return best
}

// 圆角方块 SDF(负值在内),铺满画布、四角圆角外透明
function sdRoundedRect(px, py) {
  const b = (S - 1) / 2
  const qx = Math.abs(px - b) - (b - R)
  const qy = Math.abs(py - b) - (b - R)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R
}

function render() {
  const px = Buffer.alloc(S * S * 4)
  const halfStroke = (STROKE * U) / 2
  for (let y = 0; y < S; y++) {
    // 底色明度渐变:顶部 +6%、底部 -6%,液态玻璃的轻纵深感
    const lum = 1.06 - (0.12 * y) / (S - 1)
    const bg = [C_BG[0] * lum, C_BG[1] * lum, C_BG[2] * lum]
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      const aBg = cover(sdRoundedRect(x, y))
      if (aBg <= 0) continue // 圆角外保持透明
      // 输入流(深档)在下、节点(主色)在上:衔接处由主色收口,不出接缝
      let aDeep = 0
      for (const pts of STREAMS) aDeep = Math.max(aDeep, cover(sdPolyline(x, y, pts) - halfStroke))
      const dRing = Math.abs(Math.hypot(x - RING.cx * U, y - RING.cy * U) - RING.r * U) - (RING.w * U) / 2
      const dDot = Math.hypot(x - DOT.cx * U, y - DOT.cy * U) - DOT.r * U
      const dOut = sdSegment(x, y, OUT[0] * U, OUT[1] * U, OUT[2] * U, OUT[3] * U) - halfStroke
      const aMain = Math.max(cover(dRing), cover(dDot), cover(dOut))
      let r = bg[0]
      let g = bg[1]
      let b = bg[2]
      if (aDeep > 0) {
        r = mix(r, C_DEEP[0], aDeep)
        g = mix(g, C_DEEP[1], aDeep)
        b = mix(b, C_DEEP[2], aDeep)
      }
      if (aMain > 0) {
        r = mix(r, C_MAIN[0], aMain)
        g = mix(g, C_MAIN[1], aMain)
        b = mix(b, C_MAIN[2], aMain)
      }
      px[i] = Math.round(r)
      px[i + 1] = Math.round(g)
      px[i + 2] = Math.round(b)
      px[i + 3] = Math.round(aBg * 255)
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

function verifyICO(buf) {
  const reserved = buf.readUInt16LE(0)
  const type = buf.readUInt16LE(2)
  const count = buf.readUInt16LE(4)
  if (reserved !== 0 || type !== 1 || count !== 1) {
    throw new Error(`ICO 头异常: reserved=${reserved} type=${type} count=${count}`)
  }
  console.log('[gen-icon] ICO 头校验通过: reserved=0, type=1, count=1')
}

// ---------------- main ----------------
const png = encodePNG(S, S, render())
fs.mkdirSync(buildDir, { recursive: true })
const pngPath = path.join(buildDir, 'icon.png')
const icoPath = path.join(buildDir, 'icon.ico')
fs.writeFileSync(pngPath, png) // 同一张 PNG,托盘 resolveIconPath 找 build/icon.png
fs.writeFileSync(icoPath, wrapICO(png))
verifyPNG(fs.readFileSync(pngPath), 'build/icon.png')
const icoBuf = fs.readFileSync(icoPath)
verifyICO(icoBuf)
verifyPNG(icoBuf.subarray(22), 'build/icon.ico(内嵌 PNG)')
console.log('[gen-icon] 已生成 packages/main/build/icon.png 与 build/icon.ico')
