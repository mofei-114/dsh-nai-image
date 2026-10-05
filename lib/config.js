/**
 * 配置归一化。
 *
 * 插件 export 了 `Config`（见 lib/schema.js），所以正常路径下 Cordis 已经
 * 按 schema 校验并解析过配置；这里的职责是：
 *   - 把 schema 覆盖不到的东西定型（画师串查表、尺寸别名、默认反向词）；
 *   - 让「手改 cordis.patch.yml 绕过表单」写出的坏值变成可读报错。
 *
 * ## secret 字段为什么不在 schema 里取
 *
 * `token` / `openaiApiKey` 声明为 `.role('secret')` 且由 GUI 写入
 * **凭据域**（credentials），不是 settings 命名空间 —— 官方 web-search
 * 页面同此做法，好处是密钥不落进 cordis.patch.yml 明文。因此它们的值
 * 由调用方从 `ctx.credentials.resolve()` 取，再传进来覆盖（见 lib/index.js）。
 */

import {
  CALL_MODES,
  CONFIG_SAMPLERS,
  DEFAULT_ARTISTS,
  DEFAULT_BASE_URL,
  DEFAULT_NEGATIVE,
  DIRECT_MODELS,
  IMAGE_SIZES,
  IMAGE_STYLES,
  NOISE_SCHEDULES,
  SIZE_ALIASES,
  STYLE_ALIASES,
} from './constants.js'

/** 与 lib/client.js 的 SECRET_REFS 必须一致：GUI 按这些名字写凭据域。 */
export const CREDENTIAL_REFS = {
  token: 'NAI_IMAGE_TOKEN',
  openaiApiKey: 'NAI_IMAGE_OPENAI_KEY',
}

/** 非法配置：带着字段名抛错，不静默兜底。 */
export class ConfigError extends Error {
  constructor(field, message) {
    super(`配置项 ${field} ${message}`)
    this.name = 'ConfigError'
    this.field = field
  }
}

/** 取字符串配置，空白视为未设置。 */
function str(value, fallback = '') {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/** 取数字配置并夹到区间；非法值用兜底。 */
function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 取布尔配置。 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 值是否「没写」：undefined / null / 空白字符串。 */
function absent(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)
}

/**
 * 取「闭合词表」配置。
 *
 * 词表是闭的，写错就必然被静默替换成默认值——用户以为设置生效了，实际没有。
 * 因此这里对「写了但不合法」直接报错；只有真的没写才用默认值。
 *
 * @param {unknown} value - 配置值。
 * @param {string} field - 字段名，用于报错。
 * @param {readonly string[]} allowed - 合法取值。
 * @param {string} fallback - 未配置时的默认值。
 * @returns {string} 生效值。
 */
function closedEnum(value, field, allowed, fallback) {
  if (absent(value)) return fallback
  const text = typeof value === 'string' ? value.trim() : String(value)
  if (allowed.includes(text)) return text
  throw new ConfigError(field, `只能是 ${allowed.join(' / ')} 之一，收到 "${text}"`)
}

/**
 * 取必为字符串的配置（URL、token 这类自由文本）。
 *
 * @param {unknown} value - 配置值。
 * @param {string} field - 字段名。
 * @param {string} fallback - 未配置时的默认值。
 * @returns {string} 生效值。
 */
function text(value, field, fallback = '') {
  if (absent(value)) return fallback
  if (typeof value !== 'string') throw new ConfigError(field, `必须是字符串，收到 ${typeof value}`)
  return value.trim()
}

/**
 * 把尺寸写法归一化。
 *
 * 像素串（含 ×/* 变体）原样保留——OpenAI 通道要用它，直连通道后面再回退；
 * 分档名与别名映射到中文分档名。
 *
 * @param {unknown} raw - 分档名、别名或像素串。
 * @returns {string} 中文分档名或像素串。
 */
export function normalizeSize(raw) {
  const value = str(raw, '竖图')
  if (/^\s*\d{1,5}\s*[x×*]\s*\d{1,5}\s*$/i.test(value)) return value.replace(/\s+/g, '')
  if (Object.hasOwn(IMAGE_SIZES, value)) return value
  return SIZE_ALIASES[value.toLowerCase()] ?? '竖图'
}

/**
 * 校验风格：写了但不在词表内就报错，而不是悄悄换成默认画风。
 *
 * @param {unknown} raw - 配置值。
 * @returns {string} 归一化后的风格键。
 */
export function resolveStyleField(raw) {
  if (absent(raw)) return 'vertical'
  const value = typeof raw === 'string' ? raw.trim() : String(raw)
  if (Object.hasOwn(IMAGE_STYLES, value)) return value
  const aliased = STYLE_ALIASES[value.toLowerCase()]
  if (aliased !== undefined) return aliased
  throw new ConfigError('imageStyle', `只能是 ${Object.keys(IMAGE_STYLES).join(' / ')} 或对应的中文显示名，收到 "${value}"`)
}

/**
 * 校验尺寸：接受分档名、别名或像素串；无法识别就报错。
 *
 * @param {unknown} raw - 配置值。
 * @returns {string} 分档名或像素串。
 */
export function resolveSizeField(raw) {
  if (absent(raw)) return '竖图'
  const value = typeof raw === 'string' ? raw.trim() : String(raw)
  if (/^\s*\d{1,5}\s*[x×*]\s*\d{1,5}\s*$/i.test(value)) return value.replace(/\s+/g, '')
  if (Object.hasOwn(IMAGE_SIZES, value)) return value
  const aliased = SIZE_ALIASES[value.toLowerCase()]
  if (aliased !== undefined) return aliased
  throw new ConfigError(
    'imageSize',
    `只能是 ${Object.keys(IMAGE_SIZES).join(' / ')} 之一，或像素写法（如 832x1216），收到 "${value}"`,
  )
}

/**
 * 按风格取画师串；custom 用配置值且允许为空。
 *
 * @param {string} style - 归一化后的风格键。
 * @param {string} customArtists - 自定义画师串。
 * @returns {string} 画师串。
 */
export function artistsFor(style, customArtists) {
  if (style === 'custom') return customArtists ?? ''
  return DEFAULT_ARTISTS[style] ?? DEFAULT_ARTISTS.vertical
}

/**
 * 归一化插件配置。
 *
 * @param {object} raw - Loader 传入的 config。
 * @returns {object} 各字段已定型的配置。
 */
export function resolveConfig(raw = {}) {
  // 闭合词表：写错就报错，不静默换成默认值
  const callMode = closedEnum(raw.callMode, 'callMode', CALL_MODES, 'direct')
  const style = resolveStyleField(raw.imageStyle)
  const imageSize = resolveSizeField(raw.imageSize)
  const sampler = closedEnum(raw.sampler, 'sampler', CONFIG_SAMPLERS, 'k_dpmpp_2m_sde')
  const noiseSchedule = closedEnum(raw.noiseSchedule, 'noiseSchedule', NOISE_SCHEDULES, 'karras')

  // 自由文本：类型不对就报错，避免 "12345" 这种被当成地址
  const baseUrl = text(raw.baseUrl, 'baseUrl', DEFAULT_BASE_URL)
  const openaiBaseUrl = text(raw.openaiBaseUrl, 'openaiBaseUrl')
  const token = text(raw.token, 'token')
  const openaiApiKey = text(raw.openaiApiKey, 'openaiApiKey')
  const model = text(raw.model, 'model', 'nai-diffusion-4-5-full')
  const openaiModel = text(raw.openaiModel, 'openaiModel', 'nai-diffusion-5-full')
  const negative = text(raw.negative, 'negative')

  return {
    callMode,

    // 直连
    baseUrl,
    token,
    // 直连面板只给两个模型；配置写了别的也放行（上游可能自建），但不改默认
    model,
    directModels: DIRECT_MODELS,

    // OpenAI 兼容
    openaiBaseUrl,
    openaiApiKey,
    openaiModel,

    // 生成参数
    imageStyle: style,
    customArtists: text(raw.customArtists, 'customArtists'),
    imageSize,
    steps: Math.trunc(num(raw.steps, 24, 1, 50)),
    scale: num(raw.scale, 6, 0, 20),
    cfg: num(raw.cfg, 1, 0, 1),
    sampler,
    noiseSchedule,
    negative: negative.length > 0 ? negative : DEFAULT_NEGATIVE,
    seed: Math.trunc(num(raw.seed, -1, -1, 2147483647)),
    defaultCount: Math.trunc(num(raw.defaultCount, 1, 1, 6)),

    // 网络
    requestTimeout: num(raw.requestTimeout, 180, 30, 600),
    maxRetries: Math.trunc(num(raw.maxRetries, 2, 0, 3)),

    // 归档
    saveImageHistory: bool(raw.saveImageHistory, true),
    imageHistoryDir: text(raw.imageHistoryDir, 'imageHistoryDir'),
    imageHistoryLimit: Math.trunc(num(raw.imageHistoryLimit, 200, 0, 100000)),

    // 开关
    enableTool: bool(raw.enableTool, true),
    enableQuotaTool: bool(raw.enableQuotaTool, true),
    verbose: bool(raw.verbose, true),
  }
}

/** 当前配置下生效的模型名。 */
export function activeModel(config) {
  return config.callMode === 'openai' ? config.openaiModel : config.model
}

/** 当前配置下生效的画师串。 */
export function activeArtists(config) {
  return artistsFor(config.imageStyle, config.customArtists)
}
