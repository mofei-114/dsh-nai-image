/**
 * dsh-nai-image —— NovelAI 中转生图插件（DSH 版）。
 *
 * 参考 astrbot_plugin_nai_image 的功能面，按 DSH 的插件模型重新实现：
 * 上游契约（端点、字段名、枚举、阈值、重试策略）照搬，交互方式按 DSH 重做
 * ——AstrBot 的 `/image` 斜杠指令在 DSH 里对应一个工具（模型可调用）。
 *
 * 两条通道：
 *  - direct：NAI 直连。任务接口 POST /api/web/jobs 优先，404 时回退 GET /generate。
 *  - openai：OpenAI 兼容，POST /v1/images/generations，带退避重试。
 *
 * 图片如何回到用户面前（DSH 特有）：
 *  工具结果里放 { type: 'image', attachment } 块，模型与界面都能看到；
 *  同时把原图归档到磁盘，供用户直接取用。
 *
 * ## 配置的两条来源
 *
 *  `Config` schema（见 lib/schema.js）声明了全部 26 个字段为 `.volatile()`，
 *  于是 GUI 的配置表单能编辑它们，且字段变成「实时句柄」而不是启动快照。
 *  因此本文件不在 apply 时把配置读死，而是每次生图重新读一遍 —— GUI 上
 *  点保存后立刻生效，不需要重启。
 *
 *  `enableTool` / `enableQuotaTool` 是例外：它们决定注册哪些工具，而工具
 *  注册只在 apply 时发生一次，所以改这两项仍需重启（描述里已写明）。
 *
 * 本文件只 import Node 内置模块与同目录文件 —— 插件目录没有 node_modules。
 * 唯一需要第三方包（schemastery）的地方在 lib/schema.js，且它从宿主安装
 * 目录自适应取用，取不到就降级（业务功能不依赖它，只有 GUI 表单依赖）。
 */

import { NaiClient } from './nai-client.js'
import {
  activeArtists,
  activeModel,
  ConfigError,
  CREDENTIAL_REFS,
  normalizeSize,
  resolveConfig,
} from './config.js'
import { buildConfig, readAll } from './schema.js'
import {
  archiveImage,
  attachmentValue,
  readDimensions,
  registerAttachment,
  resolveHistoryDir,
  sniffMediaType,
} from './store.js'
import { MAX_PROMPT_LENGTH } from './constants.js'

/** 稳定 Loader 标识。 */
export const name = 'dsh-nai-image'

/** 需要工具注册表；缺少提供方时插件保持 PENDING。 */
export const inject = ['tools']

/**
 * 插件 Config schema。
 *
 * 导出它，DSH 才会把本插件列入「可配置插件」，并把这些字段投影成
 * GUI 配置表单。schemastery 取不到时这里是 undefined —— 插件照常工作，
 * 只是没有 GUI 表单（退回手改 cordis.patch.yml）。
 */
export const Config = buildConfig()

/**
 * 图片值 schema。
 *
 * 形态刻意与 ImageAttachmentRef 一致（扁平），这样 render 可以直接把它当作
 * attachment 交给 ImageBlock，无需再做一次转换。
 *
 * 注意：ctx.tools.register 直接校验【raw JSON Schema 子集】，不做 author spec
 * 编译，所以 required 必须是标准的字符串数组，而不是属性上的 required: true。
 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
}

/** 生成工具的输出 schema。 */
const GENERATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    images: { type: 'array', items: IMAGE_VALUE_SCHEMA },
    saved: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    // 计费行（仅 NAI 直连通道可得）。界面只能读到结果的 ContentBlock、
    // 读不到结构化输出值，所以这里带着固定前缀把它文本化，供工具调用行解析；
    // 缺省（OpenAI 通道）时整个字段不出现。
    billing: { type: 'string' },
  },
  required: ['images', 'saved', 'summary'],
}

/** 额度工具的输出 schema。 */
const QUOTA_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    value: { type: 'integer' },
    balance: { type: 'integer' },
    enabled: { type: 'boolean' },
  },
  required: ['summary'],
}

/** 单条文本块。 */
function textBlock(text) {
  return { type: 'text', text }
}

/**
 * 计费行的机器可读前缀。
 *
 * 界面（`lib/client.js` 的工具调用行）只能读到工具结果的 ContentBlock，
 * 读不到结构化的输出值，所以计费信息要跟着文本块一起出来。用固定前缀
 * 便于客户端稳定解析，同时这行本身对人类也是可读的。
 */
const BILLING_PREFIX = '计费: '

/**
 * 把计费信息拼成一行文本。
 *
 * 直连通道才有数据：`cost` 来自任务提交响应的 `cost` 字段（契约里可选），
 * `balance` 来自生图后额外查一次的额度接口。OpenAI 通道两者皆无，
 * 返回 null —— 界面据此整行不渲染。
 *
 * @param {object} info - `{ channel, cost, balance }`。
 * @returns {string|null} 一行文本，或 null 表示无从展示。
 */
function billingLine(info) {
  if (info.channel !== 'direct') return null
  const parts = []
  parts.push(info.cost === undefined ? '本次消耗: 上游未返回' : `本次消耗: ${info.cost}`)
  if (info.balance !== undefined) parts.push(`剩余点数: ${info.balance}`)
  return BILLING_PREFIX + parts.join(' / ')
}

/**
 * 注册插件。
 *
 * @param {object} ctx - 插件上下文（需 tools 服务）。
 * @param {object} rawConfig - cordis.patch.yml 里该条目的 config。
 *   当插件 export 了 `Config` 时，Cordis 已按 schema 校验并解析过它，
 *   其中 `.volatile()` 字段是实时句柄；否则是原样传入的普通对象。
 */
export function apply(ctx, rawConfig = {}) {
  /**
   * 读凭据服务。
   *
   * **必须在每次操作时重新取，不能在 apply 时抓一次存起来。**
   * Cordis 的 `ctx.get` 反映的是「此刻」的服务可见性：credentials 由
   * `dsh-credentials-local` 提供，它在 Loader 树里的位置与本插件无关，
   * 完全可能在 apply 之后才就绪。apply 时抓成局部变量的话，那一刻的
   * undefined 会被闭包永久记住 —— 表现就是「凭据明明配了，插件一直说没配」。
   *
   * 这个坑实测复现过（见 test/verify-cred-timing.mjs 的场景 B）。
   *
   * @returns {object|undefined} 可用的凭据服务。
   */
  const credentialsService = () => {
    try {
      const service = ctx.get?.('credentials')
      return service !== undefined && typeof service.resolve === 'function' ? service : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 解析一个 secret：优先凭据域，其次 schema/patch 里的值。
   *
   * 官方契约要求「每次操作重新解析，不得跨操作缓存」—— 这正是
   * 「在界面上换了 token，下一次生图就用新的」得以成立的原因。
   *
   * @param {string} field - 字段名（CREDENTIAL_REFS 的键）。
   * @param {string} fallback - 凭据域没配时的兜底值。
   * @returns {Promise<string>} 生效的明文。
   */
  const resolveSecret = async (field, fallback) => {
    const ref = CREDENTIAL_REFS[field]
    const service = credentialsService()
    if (service === undefined || ref === undefined) return fallback
    try {
      const resolved = await service.resolve(ref)
      const value = resolved?.value
      // 空值视为未配置：一张空白的凭据不该盖掉 patch 里写的值
      return typeof value === 'string' && value.length > 0 ? value : fallback
    } catch {
      return fallback
    }
  }

  /**
   * 读一份【当前】配置。
   *
   * GUI 表单写入的是 volatile 句柄背后的值，所以每次调用都重新解一遍，
   * 而不是复用 apply 时的快照 —— 这样界面上点保存后立刻生效。
   * secret 字段再从凭据域覆盖一次。
   *
   * @returns {Promise<object>} 归一化后的配置。
   */
  const currentConfig = async () => {
    const snapshot = readAll(rawConfig)
    const config = resolveConfig(snapshot)
    const [token, openaiApiKey] = await Promise.all([
      resolveSecret('token', snapshot.token ?? ''),
      resolveSecret('openaiApiKey', snapshot.openaiApiKey ?? ''),
    ])
    return { ...config, token, openaiApiKey }
  }

  // 启动时先解一份快照：用于日志与「注册哪些工具」。
  // 必须容忍坏配置 —— schema 已挡过一次，但手改 cordis.patch.yml 仍可能写出坏值。
  let boot
  try {
    boot = resolveConfig(readAll(rawConfig))
  } catch (error) {
    if (error instanceof ConfigError) {
      ctx.logger?.error?.(`[dsh-nai-image] ${error.message}；插件未启用`)
      return
    }
    throw error
  }

  const log = (message, force = false) => {
    if (force || boot.verbose) ctx.logger?.info?.(`[dsh-nai-image] ${message}`)
  }

  if (boot.enableTool) {
    ctx.tools.register(buildGenerateTool(ctx, currentConfig, log))
    log(`已注册 nai_generate_image（模式 ${boot.callMode}，模型 ${activeModel(boot)}）`)
  }
  if (boot.enableQuotaTool) {
    ctx.tools.register(buildQuotaTool(currentConfig, log))
    log('已注册 nai_quota')
  }

  // 凭据服务是否可用只在生图时才检查（见 readinessProblem）。
  // 这里不做启动期判断 —— 它可能只是「还没就绪」，而不是「不存在」，
  // 当时打一条警告反而会误导。
}

/**
 * 生成工具定义。
 *
 * @param {object} ctx - 插件上下文。
 * @param {() => Promise<object>} currentConfig - 读当前配置（含凭据域的 secret）。
 * @param {(m: string, force?: boolean) => void} log - 日志。
 * @returns {object} 工具定义。
 */
function buildGenerateTool(ctx, currentConfig, log) {
  // 工具描述在注册时定稿（模型看到的 schema 不会随表单变化），
  // 因此这里用注册那一刻的配置来决定「尺寸」参数该怎么描述。
  // 用 Config 的 schema 默认值即可：调用时不给 prompt 之外的参数，描述只是说明。
  const sizeDescription = '输出画幅或尺寸。直连用中文分档名（竖图 / 横图 / 方图 / 2K竖图 / 2K横图 / 2K方图 / 4K竖图 / 4K横图 / 4K方图）；OpenAI 通道可写像素（如 832x1216）。留空使用插件当前配置。'

  return {
    name: 'nai_generate_image',
    description: [
      '用 NovelAI（经中转站）根据提示词生成图片，并把图片直接返回给用户。',
      '提示词用逗号分隔的英文 tag 效果最好，也接受自然语言描述。',
      '生成通常需要数十秒，一次调用就会真实消耗账号点数；不要为了同一需求重复调用。',
      '返回结果里已经包含图片本身，无需再调用其他工具去读取。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '画面描述（主体提示词）。' },
        size: { type: 'string', description: sizeDescription },
        negative: { type: 'string', description: '反向提示词（不想出现的内容）。留空使用插件默认反向词。' },
        steps: { type: 'integer', description: '采样步数 1-50。步数越高越慢、越贵。留空使用插件默认值。' },
        scale: { type: 'number', description: '提示词引导强度 0-20。留空使用插件默认值。' },
        seed: { type: 'integer', description: '随机种子；固定同一个种子可复现同一张图。留空或 -1 表示随机。' },
        count: { type: 'integer', description: '生成张数 1-6。默认 1。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: GENERATE_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const head = [value.summary, ...value.saved.map((p) => `已归档: ${p}`)]
        // 计费行紧跟摘要，界面按前缀识别并渲染进工具调用行
        if (typeof value.billing === 'string' && value.billing.length > 0) head.push(value.billing)
        const blocks = [textBlock(head.join('\n'))]
        for (const image of value.images) blocks.push({ type: 'image', attachment: image })
        return blocks
      },
    },
    // 生图真实扣费且耗时，禁止同轮并发
    isConcurrencySafe: () => false,
    // 硬上限按「最多 6 张 × 单张超时」预留，避免长任务被中途掐断。
    // 这个值在注册时定稿（timeoutMs 是静态字段），用 schema 最大超时算上界。
    timeoutMs: (600 * 6 + 120) * 1000,
    async execute(args, exec) {
      // 每次执行都读当前配置：GUI 上刚保存的值立刻生效
      const config = await currentConfig()
      const prompt = requirePrompt(args)
      const request = buildRequest(config, args, prompt)
      const client = new NaiClient(config)

      const problem = client.readinessProblem()
      if (problem) throw new Error(problem)

      log(`生图：${request.n} 张，${request.size}，${request.steps} 步，风格 ${request.style}`)
      const result = await client.generate(request, exec.signal)
      const historyDir = resolveHistoryDir(config.imageHistoryDir)
      return await collectImages(ctx, config, result, { request, historyDir, log, client })
    },
  }
}

/**
 * 额度查询工具定义。
 *
 * @param {() => object} currentConfig - 读当前配置的函数。
 * @param {(m: string, force?: boolean) => void} log - 日志。
 * @returns {object} 工具定义。
 */
function buildQuotaTool(currentConfig, log) {
  return {
    name: 'nai_quota',
    description: '查询 NovelAI 生图中转站账号的剩余点数与启用状态。不生图，不消耗点数。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: QUOTA_OUTPUT_SCHEMA,
      render: (_args, value) => [textBlock(value.summary)],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(_args, exec) {
      const config = await currentConfig()
      if (config.callMode !== 'direct') {
        throw new Error('额度查询只支持直连模式（需要「生图服务地址」与「生图 Token」）')
      }
      const client = new NaiClient(config)
      const problem = client.readinessProblem()
      if (problem) throw new Error(problem)

      const data = await client.fetchQuota(exec.signal)
      const value = toInt(data?.value)
      const balance = toInt(data?.balance)
      const enabled = typeof data?.enabled === 'boolean' ? data.enabled : undefined

      const parts = [enabled === false ? '账号状态：已停用' : '账号状态：正常']
      if (value !== undefined) parts.push(`剩余额度：${value}`)
      if (balance !== undefined) parts.push(`余额：${balance}`)
      if (value === undefined && balance === undefined) parts.push('上游未返回额度字段')
      log(`额度：${parts.join('，')}`)

      return {
        summary: parts.join('\n'),
        ...(value === undefined ? {} : { value }),
        ...(balance === undefined ? {} : { balance }),
        ...(enabled === undefined ? {} : { enabled }),
      }
    },
  }
}

/** 取整数；非有限数返回 undefined。 */
function toInt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** 校验并取出提示词。 */
function requirePrompt(args) {
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('prompt 不能为空')
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt 过长（${prompt.length} 字符，上限 ${MAX_PROMPT_LENGTH}）`)
  }
  return prompt
}

/**
 * 合并单次参数与插件默认值，得到完整的生图请求。
 * 单次参数只影响本次调用，不写回配置。
 */
function buildRequest(config, args, prompt) {
  const blank = (v) => v === undefined || v === null || String(v).trim() === ''
  // 画风不接受单次覆盖：只认配置里的 imageStyle。
  // 即使调用方硬塞 args.style 也会被忽略（工具 schema 里已无此项）。
  const style = config.imageStyle
  const size = blank(args?.size) ? config.imageSize : normalizeSize(args.size)

  return {
    prompt,
    style,
    artist: activeArtists({ imageStyle: style, customArtists: config.customArtists }),
    negative: blank(args?.negative) ? config.negative : String(args.negative),
    model: activeModel(config),
    size,
    steps: clampInt(args?.steps, config.steps, 1, 50),
    scale: clampNum(args?.scale, config.scale, 0, 20),
    cfg: config.cfg,
    sampler: config.sampler,
    noiseSchedule: config.noiseSchedule,
    seed: blank(args?.seed) ? config.seed : clampInt(args.seed, config.seed, -1, 2147483647),
    n: clampInt(args?.count, config.defaultCount, 1, 6),
  }
}

/** 整数参数收敛；非数字用兜底。 */
function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

/** 小数参数收敛；非数字用兜底。 */
function clampNum(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * 汇总本次调用的计费信息。
 *
 * 只在直连通道有意义：`cost` 取任务提交响应里的实际扣费点数（多张则求和，
 * 全部缺失时为 undefined），`balance` 额外查一次额度接口。
 *
 * 额度查询是**尽力而为**：失败（网络抖动、上游不认这个端点）不影响生图结果，
 * 只是不显示剩余点数 —— 绝不能因为查额度失败就让一次已扣费的生图报错。
 *
 * @param {object} client - NaiClient 实例。
 * @param {object} result - 生图结果。
 * @param {AbortSignal} [signal] - 取消。
 * @returns {Promise<{cost: number|undefined, balance: number|undefined}>} 计费信息。
 */
async function collectBilling(client, result, signal) {
  const costs = Array.isArray(result.meta?.costs) ? result.meta.costs : []
  const known = costs.filter((c) => typeof c === 'number' && Number.isFinite(c))
  const cost = known.length > 0 ? known.reduce((a, b) => a + b, 0) : undefined

  let balance
  try {
    const data = await client.fetchQuota(signal)
    balance = toInt(data?.balance) ?? toInt(data?.value)
  } catch {
    // 查不到就不显示，不影响生图本身
    balance = undefined
  }
  return { cost, balance }
}

/**
 * 把上游返回的图片落地成工具结果。
 *
 * 逐张尝试登记附件；登记失败的仍然归档并如实说明，不假装模型看到了图。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} config - 运行配置。
 * @param {{images: Buffer[], meta: object}} result - 客户端结果。
 * @param {object} extra - 请求、归档目录与客户端。
 * @returns {Promise<object>} 工具输出值。
 */
async function collectImages(ctx, config, result, extra) {
  const attachments = ctx.get('attachments')
  const images = []
  const saved = []
  const failed = []
  const stamp = Date.now()

  for (let index = 0; index < result.images.length; index += 1) {
    const data = result.images[index]
    const mediaType = sniffMediaType(data)

    // 嗅探失败说明上游给的不是受支持的图片：不猜类型、不登记附件，
    // 但仍然归档原始字节，让用户至少能拿到文件自己看。
    if (mediaType === undefined) {
      let path
      if (config.saveImageHistory) {
        path = await archiveImage({
          dir: extra.historyDir, data, mediaType: 'image/png', limit: config.imageHistoryLimit, stamp: `${stamp}_${index}`,
        })
        if (path) saved.push(path)
      }
      failed.push(`无法识别的图片格式 / ${data.length} 字节`
        + (path ? `，原始文件在 ${path}` : '，且未能归档'))
      continue
    }

    let path
    if (config.saveImageHistory) {
      path = await archiveImage({
        dir: extra.historyDir,
        data,
        mediaType,
        limit: config.imageHistoryLimit,
        stamp: `${stamp}_${index}`,
      })
      if (path) saved.push(path)
    }

    const ref = await registerAttachment(
      attachments, data, mediaType, path ? basename(path) : `nai_${stamp}_${index}`,
    )
    if (ref) {
      images.push(attachmentValue(ref))
    } else {
      const size = readDimensions(data, mediaType)
      failed.push(`${mediaType} ${size ? `${size.width}x${size.height}` : '尺寸未知'} / ${data.length} 字节`
        + (path ? `，文件在 ${path}` : '，且未能归档'))
    }
  }

  const via = [].concat(result.meta?.via ?? []).join('、')
  const summary = [
    `已生成 ${result.images.length} 张图片。`,
    `参数：${extra.request.size} / ${extra.request.steps} 步 / scale ${extra.request.scale} / ${extra.request.sampler}`,
    `通道：${result.meta?.channel === 'openai' ? 'OpenAI 兼容' : `NAI 直连（${via}）`}`,
  ]
  if (images.length === 0) {
    summary.push('⚠️ 图片没能作为附件随结果返回，因此你看不到画面内容；请依据归档路径回复用户。')
  }
  if (failed.length > 0) {
    summary.push('未能附加到结果的图片：')
    for (const item of failed) summary.push(`  - ${item}`)
  }

  // 计费信息（仅直连通道）。放在图片落地之后：先把图交出去，
  // 再花一次请求查余额 —— 万一查额度卡住，用户至少已经看到图。
  const billing = extra.client
    ? billingLine({
      channel: result.meta?.channel,
      ...(await collectBilling(extra.client, result)),
    })
    : null

  return {
    images,
    saved,
    summary: summary.join('\n'),
    ...(billing === null ? {} : { billing }),
  }
}

/** 取路径末段。 */
function basename(path) {
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] || String(path)
}
