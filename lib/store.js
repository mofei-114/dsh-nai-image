/**
 * 图片落地：历史归档 + 附件登记。
 *
 * 两条落地路径各有用途，缺一不可：
 *  - 归档到磁盘：用户能直接找到文件，也是模型看不到图时的兜底凭据；
 *  - 登记为附件：让图片能作为 ImageBlock 进入工具结果，模型与界面都能看到。
 *
 * 用 node:fs 而不是 ctx.fs —— ctx.fs 是给 Agent 工具用的沙箱视图，
 * 插件自身的归档属于宿主侧行为，不受该沙箱约束。
 */

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 支持的图片类型（与 DSH 附件服务声明的 mediaTypes 对齐）。 */
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * 按魔数嗅探图片类型。
 *
 * @param {Buffer} data - 图片字节。
 * @returns {string|undefined} media type；无法识别时 undefined。
 */
export function sniffMediaType(data) {
  if (!Buffer.isBuffer(data) || data.length < 12) return undefined
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (data.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  return undefined
}

/** 按 media type 给扩展名，用于归档文件名。 */
function extensionFor(mediaType) {
  switch (mediaType) {
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return '.png'
  }
}

/**
 * 读 PNG/JPEG/WebP/GIF 的像素尺寸；失败返回 undefined。
 *
 * 只做头部解析，不引入图片库——插件目录没有 node_modules。
 * 每个分支都先验魔数：调用方可能在没有嗅探成功时传入兜底类型，
 * 不验魔数就会从垃圾字节里读出 4294967295 这种假尺寸。
 *
 * @param {Buffer} data - 图片字节。
 * @param {string} mediaType - 已嗅探的类型。
 * @returns {{width:number,height:number}|undefined} 尺寸。
 */
export function readDimensions(data, mediaType) {
  try {
    if (mediaType === 'image/png') {
      if (data.length < 24) return undefined
      if (!(data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)) return undefined
      // IHDR 紧随 8 字节签名 + 4 字节长度 + 4 字节类型
      const width = data.readUInt32BE(16)
      const height = data.readUInt32BE(20)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    if (mediaType === 'image/gif') {
      if (data.length < 10 || data.toString('ascii', 0, 4) !== 'GIF8') return undefined
      const width = data.readUInt16LE(6)
      const height = data.readUInt16LE(8)
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    if (mediaType === 'image/webp') {
      if (data.length < 30) return undefined
      if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return undefined
      const fourCC = data.toString('ascii', 12, 16)
      if (fourCC === 'VP8X') {
        return {
          width: 1 + (data[24] | (data[25] << 8) | (data[26] << 16)),
          height: 1 + (data[27] | (data[28] << 8) | (data[29] << 16)),
        }
      }
      if (fourCC === 'VP8 ') {
        return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
      }
      if (fourCC === 'VP8L' && data.length >= 25) {
        const bits = data.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      return undefined
    }
    if (mediaType === 'image/jpeg') {
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined
      let offset = 2
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) { offset += 1; continue }
        const marker = data[offset + 1]
        // SOF0-SOF3 / SOF5-SOF7 / SOF9-SOF11 / SOF13-SOF15 携带尺寸
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = data.readUInt16BE(offset + 5)
          const width = data.readUInt16BE(offset + 7)
          return width > 0 && height > 0 ? { width, height } : undefined
        }
        const length = data.readUInt16BE(offset + 2)
        if (length <= 0) return undefined
        offset += 2 + length
      }
    }
  } catch {
    // 头部不合预期：视为无法解析
  }
  return undefined
}

/**
 * 归档目录：配置优先，否则落在 $DSH_HOME/plugin-data 下。
 *
 * @param {string} configured - 配置的目录；空则用默认。
 * @returns {string} 绝对路径。
 */
export function resolveHistoryDir(configured) {
  if (configured && configured.length > 0) return configured
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'dsh-nai-image', 'image_history')
}

/**
 * 把一张图归档到磁盘，并按上限清理旧文件。
 *
 * @param {object} options - 归档参数。
 * @param {string} options.dir - 目标目录。
 * @param {Buffer} options.data - 图片字节。
 * @param {string} options.mediaType - 图片类型。
 * @param {number} options.limit - 最多保留张数；0 表示不清理。
 * @param {string} [options.stamp] - 文件名时间戳。
 * @returns {Promise<string|undefined>} 归档绝对路径；失败时 undefined。
 */
export async function archiveImage({ dir, data, mediaType, limit, stamp }) {
  try {
    await mkdir(dir, { recursive: true })
    const name = `nai_${stamp ?? formatStamp(new Date())}_${Math.random().toString(36).slice(2, 8)}${extensionFor(mediaType)}`
    const target = join(dir, name)
    await writeFile(target, data)
    if (limit > 0) await pruneHistory(dir, limit)
    return target
  } catch {
    // 归档失败不影响出图主流程：图片本身仍会作为附件返回
    return undefined
  }
}

/** 时间戳：本地时间的 yyyyMMdd_HHmmss。 */
function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 按修改时间删除超额的历史图片，只删本插件自己产生的文件。 */
async function pruneHistory(dir, limit) {
  try {
    const names = (await readdir(dir)).filter((n) => /^nai_.*\.(png|jpg|jpeg|webp|gif)$/i.test(n))
    if (names.length <= limit) return
    const entries = []
    for (const name of names) {
      const info = await stat(join(dir, name))
      entries.push({ name, mtime: info.mtimeMs })
    }
    entries.sort((a, b) => a.mtime - b.mtime)
    for (const entry of entries.slice(0, entries.length - limit)) {
      await unlink(join(dir, entry.name))
    }
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 把图片登记为 DSH 附件，供 ImageBlock 引用。
 *
 * @param {object|undefined} attachments - ctx.get('attachments')。
 * @param {Buffer} data - 图片字节。
 * @param {string} mediaType - 图片类型。
 * @param {string} name - 展示名。
 * @returns {Promise<object|undefined>} 附件引用；不可用时 undefined。
 */
export async function registerAttachment(attachments, data, mediaType, name) {
  if (!attachments || typeof attachments.saveImage !== 'function') return undefined
  if (!MEDIA_TYPES.includes(mediaType)) return undefined
  try {
    return await attachments.saveImage({ data, mediaType, name })
  } catch {
    // 超出部署字节/像素限制等：退回纯文本结果，不假装成功
    return undefined
  }
}

/** 供工具结果用的附件值（扁平化，满足 lossless JSON 约束）。 */
export function attachmentValue(ref) {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}
