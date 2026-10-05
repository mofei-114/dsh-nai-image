// 单元测试：图片头解析、归档、附件降级路径（手写解析器最易出错）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

/** 本文件所在目录（test/）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件项目根。 */
const PROJECT = dirname(HERE)
/** fixture 与产物目录。 */
const PROBE = join(HERE, '.fixtures')
mkdirSync(PROBE, { recursive: true })

const store = await import(pathToFileURL(join(PROJECT, 'lib/store.js')).href)

const out = []
let failures = 0
const check = (label, cond, detail) => {
  if (cond) out.push(`PASS  ${label}${detail === undefined ? '' : '  -> ' + detail}`)
  else { failures += 1; out.push(`FAIL  ${label}${detail === undefined ? '' : '  -> ' + detail}`) }
}

// ---------------------------------------------------------------- 图片构造
const CRC_TABLE = (() => {
  const t = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 造一张真实可解码的 PNG。 */
function makePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((w * 3 + 1) * h))), chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 造一个 GIF 头（逻辑屏幕描述符带宽高）。 */
function makeGif(w, h) {
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]),
    Buffer.from([0x00, 0x00, 0x00, 0x3b]),
  ])
}

/** 造一个 VP8X WebP 头（画布尺寸 24 位小端减一）。 */
function makeWebpVp8x(w, h) {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(22, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8X', 12, 'ascii')
  b.writeUInt32LE(10, 16)
  b.writeUIntLE(w - 1, 24, 3)
  b.writeUIntLE(h - 1, 27, 3)
  return b
}

/** 造一个带 SOF0 的 JPEG。 */
function makeJpeg(w, h) {
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(h, 5)
  sof.writeUInt16BE(w, 7)
  sof[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])])
}

// ------------------------------------------------------------ sniffMediaType
out.push('=== sniffMediaType ===')
check('PNG', store.sniffMediaType(makePng(64, 96)) === 'image/png')
check('GIF', store.sniffMediaType(makeGif(64, 96)) === 'image/gif')
check('WebP', store.sniffMediaType(makeWebpVp8x(64, 96)) === 'image/webp')
check('JPEG', store.sniffMediaType(makeJpeg(64, 96)) === 'image/jpeg')
check('随机字节 → undefined', store.sniffMediaType(Buffer.from('hello world this is not an image')) === undefined)
check('空 buffer → undefined', store.sniffMediaType(Buffer.alloc(0)) === undefined)
check('太短 → undefined', store.sniffMediaType(Buffer.from([0x89, 0x50])) === undefined)
check('非 buffer → undefined', store.sniffMediaType('nope') === undefined)
out.push('')

// ------------------------------------------------------------ readDimensions
out.push('=== readDimensions ===')
for (const [w, h] of [[64, 96], [832, 1216], [1920, 1088], [1, 1], [4096, 4096], [1216, 832]]) {
  const d = store.readDimensions(makePng(w, h), 'image/png')
  check(`PNG ${w}x${h}`, d?.width === w && d?.height === h, JSON.stringify(d))
}
check('GIF 64x96', (() => { const d = store.readDimensions(makeGif(64, 96), 'image/gif'); return d?.width === 64 && d?.height === 96 })())
check('WebP(VP8X) 64x96', (() => { const d = store.readDimensions(makeWebpVp8x(64, 96), 'image/webp'); return d?.width === 64 && d?.height === 96 })())
check('JPEG 64x96', (() => { const d = store.readDimensions(makeJpeg(64, 96), 'image/jpeg'); return d?.width === 64 && d?.height === 96 })())
check('截断 PNG → undefined', store.readDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png') === undefined)
// 关键回归：类型与字节不符时不能从垃圾里读出假尺寸
check('垃圾字节 + 声明 png → undefined', store.readDimensions(Buffer.alloc(40, 0xff), 'image/png') === undefined)
check('垃圾字节 + 声明 jpeg → undefined', store.readDimensions(Buffer.alloc(40, 0xff), 'image/jpeg') === undefined)
check('垃圾字节 + 声明 gif → undefined', store.readDimensions(Buffer.alloc(40, 0xff), 'image/gif') === undefined)
check('垃圾字节 + 声明 webp → undefined', store.readDimensions(Buffer.alloc(40, 0xff), 'image/webp') === undefined)
check('PNG 字节被当成 gif 读 → undefined', store.readDimensions(makePng(64, 96), 'image/gif') === undefined)
out.push('')

// --------------------------------------------------------- resolveHistoryDir
out.push('=== resolveHistoryDir ===')
check('显式配置优先', store.resolveHistoryDir('C:/custom/dir') === 'C:/custom/dir')
{
  const def = store.resolveHistoryDir('')
  check('默认落在 plugin-data 下', def.includes('plugin-data') && def.includes('dsh-nai-image'), def)
}
out.push('')

// --------------------------------------------------------- attachmentValue
out.push('=== attachmentValue ===')
{
  const v = store.attachmentValue({
    attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 4, height: 5, name: 'x.png',
  })
  check('扁平且与 ImageAttachmentRef 同形',
    v.attachmentId === 'sha256:abc' && v.mediaType === 'image/png' && v.bytes === 10 && v.width === 4 && v.height === 5 && v.name === 'x.png',
    JSON.stringify(v))
  const noName = store.attachmentValue({ attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 })
  check('name 缺省时不带该字段', !('name' in noName), JSON.stringify(noName))
  check('是 lossless JSON', JSON.parse(JSON.stringify(v)).attachmentId === 'sha256:abc')
}
out.push('')

// ------------------------------------------------------- registerAttachment
out.push('=== registerAttachment（降级路径）===')
{
  const png = makePng(64, 96)
  check('无附件服务 → undefined', (await store.registerAttachment(undefined, png, 'image/png', 'a.png')) === undefined)
  check('服务缺 saveImage → undefined', (await store.registerAttachment({}, png, 'image/png', 'a.png')) === undefined)
  check('saveImage 抛错被吞成 undefined', (await store.registerAttachment({
    saveImage: async () => { throw new Error('boom') },
  }, png, 'image/png', 'a.png')) === undefined)
  check('不支持的类型不提交', (await store.registerAttachment({
    saveImage: async () => { throw new Error('不该被调用') },
  }, png, 'image/bmp', 'a.bmp')) === undefined)
  check('正常路径返回引用', (await store.registerAttachment({
    saveImage: async (i) => ({ attachmentId: 'id1', mediaType: i.mediaType, bytes: i.data.length, width: 64, height: 96 }),
  }, png, 'image/png', 'a.png'))?.attachmentId === 'id1')
}
out.push('')

// ------------------------------------------------------------- archiveImage
out.push('=== archiveImage ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'nai-store-'))
  const png = makePng(64, 96)

  const p1 = await store.archiveImage({ dir, data: png, mediaType: 'image/png', limit: 0, stamp: 'a' })
  check('归档成功且文件存在', typeof p1 === 'string' && existsSync(p1), p1)
  check('扩展名按类型 .png', p1?.endsWith('.png'))

  const p2 = await store.archiveImage({ dir, data: png, mediaType: 'image/jpeg', limit: 0, stamp: 'b' })
  check('jpeg 归档为 .jpg', p2?.endsWith('.jpg'))

  for (let i = 0; i < 4; i += 1) {
    await store.archiveImage({ dir, data: png, mediaType: 'image/png', limit: 2, stamp: `c${i}` })
    await new Promise((r) => setTimeout(r, 12))
  }
  const left = readdirSync(dir).filter((n) => n.startsWith('nai_'))
  check('超出上限被清理到 2 张', left.length === 2, left.join(','))

  const badResult = await store.archiveImage({ dir: 'Z:/definitely/not/here', data: png, mediaType: 'image/png', limit: 0, stamp: 'z' })
  check('写入失败返回 undefined 而非抛错', badResult === undefined)

  rmSync(dir, { recursive: true, force: true })
}
out.push('')

out.push(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'unit-store.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
