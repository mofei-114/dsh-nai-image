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
import { isAbsolute, join } from 'node:path'

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
 * 路径里常见的不可见排版控制字符。
 *
 * 来源是复制粘贴：从浏览器、聊天窗口或文档里粘路径时，双向文本控制符
 * 会跟着进来。它们肉眼不可见，却会让 `path.isAbsolute()` 返回 false
 * —— Windows 于是把 `\u202AE:\dir` 当成相对路径，归档落到意料之外的位置
 * 或直接失败。
 *
 * 覆盖：LRM/RLM、LRE/RLE/PDF/LRO/RLO、LRI/RLI/FSI/PDI、零宽空格、
 * 零宽非连接符/连接符、BOM/零宽不换行空格。
 */
const INVISIBLE_PATH_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/

/**
 * 清洗配置里来的路径。
 *
 * 剔除首尾空白与上述不可见控制字符。只处理**首尾**：路径中间的控制字符
 * 同样非法，但那种情况交给 `isAbsolute` 判定后报错，比悄悄改动用户写的
 * 路径更安全。
 *
 * @param {unknown} raw - 配置值。
 * @returns {string} 清洗后的路径（可能是空串）。
 */
export function sanitizeDir(raw) {
  if (typeof raw !== 'string') return ''
  let value = raw.trim()
  // 反复剥离：可能连着好几个（例如 LRE + LRM）
  for (;;) {
    const next = value.replace(/^[\s\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/, '')
      .replace(/[\s\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+$/, '')
    if (next === value) break
    value = next
  }
  return value
}

/**
 * 归档目录：配置优先，否则落在 $DSH_HOME/plugin-data 下。
 *
 * 配置值会先清洗（见 {@link sanitizeDir}）——粘贴路径带进隐形字符是常见事故，
 * 而它的后果是静默不落盘。
 *
 * @param {string} configured - 配置的目录；空则用默认。
 * @returns {string} 绝对路径。
 */
export function resolveHistoryDir(configured) {
  const value = sanitizeDir(configured)
  if (value.length > 0) return value
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'dsh-nai-image', 'image_history')
}

/**
 * 判断路径是否可以安全地作为归档目录。
 *
 * `isAbsolute` 是关键闸门：带前导 U+202A 的路径会让它返回 false，
 * 说明这个字符串不是干净的绝对路径，绝不能交给 fs 去解释。
 *
 * @param {string} dir - 待检查的目录。
 * @returns {string|null} 问题描述；可用时 null。
 */
export function historyDirProblem(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return '目录为空'
  if (INVISIBLE_PATH_CHARS.test(dir)) {
    return '路径里含不可见的排版控制字符（常见于复制粘贴），请清空后手工重新输入'
  }
  if (!isAbsolute(dir)) return `不是绝对路径：${dir}`
  return null
}

/**
 * 把一张图归档到磁盘，并按上限清理旧文件。
 *
 * 失败时返回 `{ error }` 而不是静默 undefined：归档失败意味着用户找不到
 * 文件，必须让人知道原因（历史实现吞掉异常，导致「图能看但磁盘上没有」
 * 这种几乎无法自查的状态）。
 *
 * @param {object} options - 归档参数。
 * @param {string} options.dir - 目标目录。
 * @param {Buffer} options.data - 图片字节。
 * @param {string} options.mediaType - 图片类型。
 * @param {number} options.limit - 最多保留张数；0 表示不清理。
 * @param {string} [options.stamp] - 文件名时间戳。
 * @returns {Promise<{path: string}|{error: string}>} 归档结果。
 */
export async function archiveImage({ dir, data, mediaType, limit, stamp }) {
  // 路径合法性先于一切：不合法就不要碰 fs，也不要建出诡异目录
  const problem = historyDirProblem(dir)
  if (problem !== null) return { error: problem }

  let target
  try {
    await mkdir(dir, { recursive: true })
    const name = `nai_${stamp ?? formatStamp(new Date())}_${Math.random().toString(36).slice(2, 8)}${extensionFor(mediaType)}`
    target = join(dir, name)
    await writeFile(target, data)
  } catch (error) {
    const code = error?.code === undefined ? '' : ` (${error.code})`
    return { error: `写入失败${code}：${error?.message ?? String(error)}` }
  }

  // 清理失败不影响这次归档本身：文件已经写进去了，只是旧的没删掉
  if (limit > 0) await pruneHistory(dir, limit)
  return { path: target }
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
