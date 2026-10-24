// PNG を左上から w×h に切り出す（RGB / RGBA 8bit、インターレース無し。Chrome の screenshot 用）
// node png-crop.mjs <src> <dst> <w> <h>
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'

const [src, dst, W, H] = process.argv.slice(2)
const b = readFileSync(src)
let p = 8
let ihdr
const idat = []
while (p < b.length) {
  const len = b.readUInt32BE(p)
  const type = b.toString('ascii', p + 4, p + 8)
  const data = b.subarray(p + 8, p + 8 + len)
  if (type === 'IHDR') ihdr = data
  if (type === 'IDAT') idat.push(data)
  p += 12 + len
}
const w = ihdr.readUInt32BE(0)
const h = ihdr.readUInt32BE(4)
const ct = ihdr[9]
const bpp = ct === 6 ? 4 : 3
if (ihdr[8] !== 8 || ihdr[12] !== 0 || (ct !== 2 && ct !== 6)) throw new Error('unsupported png')
// 行ごとのフィルタを戻す
const raw = inflateSync(Buffer.concat(idat))
const stride = w * bpp
const out = Buffer.alloc(h * stride)
for (let y = 0; y < h; y++) {
  const f = raw[y * (stride + 1)]
  const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? out[y * stride + x - bpp] : 0
    const u = y ? out[(y - 1) * stride + x] : 0
    const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0
    let v = line[x]
    if (f === 1) v += a
    else if (f === 2) v += u
    else if (f === 3) v += (a + u) >> 1
    else if (f === 4) {
      const q = a + u - c
      const pa = Math.abs(q - a)
      const pb = Math.abs(q - u)
      const pc = Math.abs(q - c)
      v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c
    }
    out[y * stride + x] = v & 255
  }
}
const cw = Math.min(Number(W), w)
const ch = Math.min(Number(H), h)
const rows = Buffer.alloc(ch * (cw * bpp + 1)) // フィルタ 0（なし）で詰め直す
for (let y = 0; y < ch; y++) out.copy(rows, y * (cw * bpp + 1) + 1, y * stride, y * stride + cw * bpp)
const chunk = (type, data) => {
  const l = Buffer.alloc(4)
  l.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = ~0
  for (const x of td) {
    crc ^= x
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  const c = Buffer.alloc(4)
  c.writeUInt32BE(~crc >>> 0)
  return Buffer.concat([l, td, c])
}
const hd = Buffer.from(ihdr)
hd.writeUInt32BE(cw, 0)
hd.writeUInt32BE(ch, 4)
writeFileSync(
  dst,
  Buffer.concat([
    b.subarray(0, 8),
    chunk('IHDR', hd),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
)
