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
import { normalizeCharacterBlocks } from './characters.js'
import { effectiveSlots } from './config.js'
import { resolveStyleSelection } from './slots.js'
import {
  availability as grimoireAvailable,
  expandMacros,
  loadEntries,
  search as searchGrimoire,
} from './grimoire.js'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/** 稳定 Loader 标识。 */
export const name = 'dsh-nai-image'

/**
 * 本文件所在目录（插件根）。
 *
 * 用 import.meta.url 而不是假设 CWD —— 插件以 file URL 加载，
 * 进程工作目录与插件位置无关。
 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * 解析可写数据目录。
 *
 * DSH 约定是 `$DSH_HOME/plugin-data/<插件名>`；DSH_HOME 缺失时退到
 * `~/.dsh`。取不到家目录时返回空串，由调用方如实报「词库不可用」，
 * 而不是抛错让整个生图失败 —— 法典是增强功能，不该拖垮主链路。
 *
 * @returns {string} 绝对路径；无法确定时空串。
 */
function resolveDataDir() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  if (!home) return ''
  return join(home, 'plugin-data', 'dsh-nai-image')
}

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
 * ## 消耗以余额差值为准，`cost` 作交叉校验
 *
 * 实测（2026-10-06，nai.sta1n.cn，24 步竖图，空闲账号）：
 * 提交响应 `cost: 8`，余额差值也是 8 —— **两者一致**。
 * 响应里 `cost` 与 `routedSteps` 配套，是按「步数 × 画质档位」路由后的
 * 计价，所以它不等于步数（24 步 → 8 点）是正常的，不是错误。
 *
 * 取余额差值是因为它反映**账号实际扣费**（含任何档位换算），而 `cost`
 * 是上游自报值。两者一致时展示同一个数；不一致时以差值为准，并把
 * `cost` 一并标出，便于发现上游计价变化。
 *
 * @param {object} info - `{ channel, spent, balance, estimate }`。
 * @returns {string|null} 一行文本，或 null 表示无从展示（OpenAI 通道）。
 */
function billingLine(info) {
  if (info.channel !== 'direct') return null
  const parts = []
  if (info.spent !== undefined) {
    parts.push(`本次消耗: ${info.spent}`)
    // 上游自报值与实扣不符时点出来 —— 那是计价规则变了的信号
    if (info.estimate !== undefined && info.estimate !== info.spent) {
      parts.push(`（上游报 ${info.estimate}）`)
    }
  } else if (info.estimate !== undefined) {
    parts.push(`本次消耗: 约 ${info.estimate}（估算）`)
  } else {
    parts.push('本次消耗: 上游未返回')
  }
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
    // 法典词库需要两个**不同**的目录：
    //   pluginDir —— 随包分发的 data/grimoire.db.gz（可能只读）
    //   dataDir   —— 解压落点，必须在可写位置
    // 两者用 __ 前缀标明是内部派生量，不出现在用户配置里。
    return {
      ...config,
      token,
      openaiApiKey,
      __pluginDir: PLUGIN_DIR,
      __dataDir: resolveDataDir(),
    }
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
  if (boot.enableGrimoire) {
    ctx.tools.register(buildGrimoireTool(ctx, currentConfig, log))
    log('已注册 nai_search_grimoire（法典检索，改动需重启）')
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
  const styleDescription = '画风槽位名（如「韩漫小清新风」「GalGame风」）。选中后该槽位绑定的模型与画师串一起生效。留空使用插件当前配置的画风。'
  const charDescription = (ordinal) => `多角色块的${ordinal}个角色：只写该角色自身的标签（外貌、发色瞳色、表情、姿势、穿着），不要写场景/构图/画风。两个角色会分别居中于画面左右、各自独立不串色。留空表示该角色不存在。仅在插件开启「多角色块」时生效。`

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
        prompt: { type: 'string', description: '画面描述（主体提示词）。支持 【法典:词条名】 宏（需开启法典词库）。' },
        style: { type: 'string', description: styleDescription },
        char1_prompt: { type: 'string', description: charDescription('第一') },
        char2_prompt: { type: 'string', description: charDescription('第二') },
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
      const warnings = []
      const warn = (message) => { warnings.push(message); log(message, true) }

      let prompt = requirePrompt(args)

      // 法典词库：开启时读库并展开 【法典:词条名】 宏。
      // 关闭时**完全不读库**（对应用户「关掉就不该有开销」的预期）。
      let grimoireEntries = []
      if (config.enableGrimoire) {
        grimoireEntries = loadGrimoireEntries(ctx, config, warn)
        if (grimoireEntries.length > 0) {
          const expanded = expandMacros(grimoireEntries, prompt, activeModel(config))
          if (expanded.expanded.length > 0) {
            const hits = expanded.expanded.filter((x) => x.hit).map((x) => x.keyword)
            const misses = expanded.expanded.filter((x) => !x.hit).map((x) => x.keyword)
            if (hits.length > 0) log(`法典命中 ${hits.length} 条：${hits.join('、')}`)
            if (misses.length > 0) warn(`法典未命中：${misses.join('、')}（已保留原文）`)
            prompt = expanded.prompt
          }
        }
      }

      const request = buildRequest(config, args, prompt, { warn })
      const client = new NaiClient(config)

      const problem = client.readinessProblem()
      if (problem) throw new Error(problem)

      log(`生图：${request.n} 张，${request.size}，${request.steps} 步，风格 ${request.style}`)

      // 生图前先取额度基线：真实消耗 = 生成后额度 − 这个基线。
      // 上游的 cost 字段不可信（实测是基础档估算值，不是实扣），见 collectBilling。
      // 这次查询失败只是让消耗显示不出来，不影响生图。
      const balanceBefore = config.callMode === 'direct' ? await readBalance(client, exec.signal) : undefined

      const result = await client.generate(request, exec.signal)
      const historyDir = resolveHistoryDir(config.imageHistoryDir)
      // 槽位未命中要显式说出来：用户明明选了某个画风却拿到默认画风，
      // 是「我明明设了却没生效」里最难自查的一类。
      if (request.slotMissing) {
        warn(`画风槽位「${request.slotMissing}」不存在，本次已回落默认画风`)
      }
      return await collectImages(ctx, config, result, {
        request, historyDir, log, client, balanceBefore, warnings,
      })
    },
  }
}

/**
 * 载入法典词库（带缓存）。
 *
 * 插件目录用于找随包分发的 `data/grimoire.db.gz`；数据目录用于放解压后的库。
 * 两者不同：插件目录可能只读（安装位置），数据目录一定可写。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} config - 运行配置。
 * @param {(m: string) => void} warn - 告警回调。
 * @returns {Array<object>} 词库行；不可用时空数组。
 */
function loadGrimoireEntries(ctx, config, warn) {
  const pluginDir = config.__pluginDir
  const dataDir = config.__dataDir
  if (!pluginDir || !dataDir) {
    warn('法典词库不可用：插件目录或数据目录未解析到')
    return []
  }
  const entries = loadEntries(pluginDir, dataDir)
  if (entries.length === 0) warn('法典词库未就绪（缺少 data/grimoire.db.gz 或解压失败）')
  return entries
}

/**
 * 法典检索工具定义。
 *
 * 原版是 `/法典` 斜杠指令（DSH 没有指令体系），这里改成模型可调用的工具：
 * 模型写提示词前先查词条，拿到经过实测的标签，比凭空编 tag 更稳。
 *
 * @param {() => Promise<object>} currentConfig - 读当前配置。
 * @param {(m: string, force?: boolean) => void} log - 日志。
 * @returns {object} 工具定义。
 */
function buildGrimoireTool(ctx, currentConfig, log) {
  return {
    name: 'nai_search_grimoire',
    description: [
      '检索内置 NovelAI 法典词库（19,663 条经实测的标签组合），用于撰写生图提示词。',
      '按当前生图模型自动限定版本：V4.5 只查 V4.5 卷；V5 同查 V5 卷与 V4.5 卷。',
      '返回每条词目的干净正向标签，可直接作为 prompt 使用。',
      '不生图、不消耗点数。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索关键词（中文，如「白裙少女」「夜景」「校服」）。留空则按 id 顺序列出前几条。' },
        limit: { type: 'integer', description: '返回条数 1-50，默认 12。' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                model_ver: { type: 'string' },
                category: { type: 'string' },
                clean_tags: { type: 'string' },
              },
              required: ['title', 'clean_tags'],
            },
          },
        },
        required: ['summary', 'items'],
      },
      render: (_args, value) => [textBlock(value.summary)],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    async execute(args, exec) {
      void exec
      const config = await currentConfig()
      if (!config.enableGrimoire) {
        throw new Error('法典词库未启用：请先在插件设置里打开「启用法典词库」')
      }
      const warnings = []
      const entries = loadGrimoireEntries(ctx, config, (m) => warnings.push(m))
      if (entries.length === 0) throw new Error(warnings[0] ?? '法典词库不可用')

      const model = activeModel(config)
      const items = searchGrimoire(entries, String(args?.query ?? ''), {
        limit: args?.limit,
        modelName: model,
      })
      if (items.length === 0) {
        return { summary: `未检索到匹配「${args?.query ?? ''}」的词条（模型 ${model}）。`, items: [] }
      }
      log(`法典检索「${args?.query ?? ''}」命中 ${items.length} 条`)
      const lines = [`检索「${args?.query ?? ''}」命中 ${items.length} 条（模型 ${model}）：`]
      for (const item of items) {
        lines.push(`- 《${item.title}》[${item.model_ver} / ${item.category}]`)
        lines.push(`  ${item.clean_tags}`)
      }
      return {
        summary: lines.join('\n'),
        items: items.map((item) => ({
          title: String(item.title ?? ''),
          model_ver: String(item.model_ver ?? ''),
          category: String(item.category ?? ''),
          clean_tags: String(item.clean_tags ?? ''),
        })),
      }
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
function buildRequest(config, args, prompt, extra = {}) {
  const blank = (v) => v === undefined || v === null || String(v).trim() === ''
  const size = blank(args?.size) ? config.imageSize : normalizeSize(args.size)

  // ---- 画风槽位（v1.2.0）----
  // 槽位把「画风名 / 适用模型 / 画师串」绑在一起，一次选择同时决定底模与画师串。
  // 未命中槽位**不静默回落**：把缺失名字带出去，由调用方告警并在摘要里说明。
  const styleOverride = blank(args?.style) ? '' : String(args.style).trim()
  const selection = resolveStyleSelection({
    slots: effectiveSlots(config),
    enabled: Boolean(config.enableArtistSlots),
    activeSlot: config.activeSlot,
    styleOverride,
    fallbackModel: activeModel(config),
    fallbackArtists: activeArtists({ imageStyle: config.imageStyle, customArtists: config.customArtists }),
  })

  // ---- 多角色块（v1.2.0）----
  // 未开启时忽略参数并留日志（静默接受不生效是最难自查的一类问题）。
  let characterBlocks = []
  const rawChars = [args?.char1_prompt, args?.char2_prompt]
  if (config.enableCharacterBlocks) {
    characterBlocks = normalizeCharacterBlocks(rawChars)
  } else if (rawChars.some((c) => typeof c === 'string' && c.trim().length > 0)) {
    extra.warn?.('多角色块未启用（enableCharacterBlocks），已忽略 char1_prompt/char2_prompt')
  }

  return {
    prompt,
    style: styleOverride || config.imageStyle,
    artist: selection.artists,
    negative: blank(args?.negative) ? config.negative : String(args.negative),
    model: selection.model,
    size,
    steps: clampInt(args?.steps, config.steps, 1, 50),
    scale: clampNum(args?.scale, config.scale, 0, 20),
    cfg: config.cfg,
    sampler: config.sampler,
    noiseSchedule: config.noiseSchedule,
    seed: blank(args?.seed) ? config.seed : clampInt(args.seed, config.seed, -1, 2147483647),
    n: clampInt(args?.count, config.defaultCount, 1, 6),
    characters: characterBlocks,
    slotName: selection.slotName,
    slotMissing: selection.missing,
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
 * 读一次剩余额度。
 *
 * 额度查询是**尽力而为**：失败（网络抖动、上游不认这个端点）返回 undefined，
 * 绝不因为查额度失败就让一次已扣费的生图报错。
 *
 * @param {object} client - NaiClient 实例。
 * @param {AbortSignal} [signal] - 取消。
 * @returns {Promise<number|undefined>} 剩余额度，或 undefined。
 */
async function readBalance(client, signal) {
  try {
    const data = await client.fetchQuota(signal)
    // `value` 是「剩余额度」——额度口径才是用户关心的点数。
    // `balance` 是另一个口径（实测这个部署下两者相同，但契约未保证），
    // 所以只在 value 缺失时才回落。
    return toInt(data?.value) ?? toInt(data?.balance)
  } catch {
    return undefined
  }
}

/**
 * 汇总本次调用的计费信息。
 *
 * 消耗优先用**余额差值**（反映账号实际扣费），`cost` 作为上游自报值与
 * 交叉校验。实测两者一致（24 步竖图 → 都是 8）。
 *
 * 差值只有在两个端点都拿到、且确实下降时才有意义。上涨（期间别处充值）
 * 或不变时不报差值，退回到 `cost`。
 *
 * @param {object} client - NaiClient 实例。
 * @param {object} result - 生图结果。
 * @param {number|undefined} before - 生图前的额度基线。
 * @param {AbortSignal} [signal] - 取消。
 * @returns {Promise<{spent: number|undefined, balance: number|undefined, estimate: number|undefined}>} 计费信息。
 */
async function collectBilling(client, result, before, signal) {
  // 上游自报的 cost（多张则求和）
  const costs = Array.isArray(result.meta?.costs) ? result.meta.costs : []
  const known = costs.filter((c) => typeof c === 'number' && Number.isFinite(c))
  const estimate = known.length > 0 ? known.reduce((a, b) => a + b, 0) : undefined

  const after = await readBalance(client, signal)

  // 只有在确实观察到一个下降区间时才认定为本次消耗。
  // 期间账号被别处消费会让差值偏大 —— 这是差值法的固有局限，
  // 上面 billingLine 里用 cost 做交叉提示正是为了暴露这种情况。
  const spent = before !== undefined && after !== undefined && before > after
    ? before - after
    : undefined

  return { spent, balance: after, estimate }
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
  /** 归档失败的原因。去重后在摘要里报一次，避免每张图重复同一句。 */
  const archiveErrors = []
  const stamp = Date.now()

  for (let index = 0; index < result.images.length; index += 1) {
    const data = result.images[index]
    const mediaType = sniffMediaType(data)

    // 嗅探失败说明上游给的不是受支持的图片：不猜类型、不登记附件，
    // 但仍然归档原始字节，让用户至少能拿到文件自己看。
    if (mediaType === undefined) {
      let archived
      if (config.saveImageHistory) {
        archived = await archiveImage({
          dir: extra.historyDir, data, mediaType: 'image/png', limit: config.imageHistoryLimit, stamp: `${stamp}_${index}`,
        })
        if (archived.path) saved.push(archived.path)
        else archiveErrors.push(archived.error)
      }
      failed.push(`无法识别的图片格式 / ${data.length} 字节`
        + (archived?.path ? `，原始文件在 ${archived.path}` : '，且未能归档'))
      continue
    }

    let archived
    if (config.saveImageHistory) {
      archived = await archiveImage({
        dir: extra.historyDir,
        data,
        mediaType,
        limit: config.imageHistoryLimit,
        stamp: `${stamp}_${index}`,
      })
      if (archived.path) saved.push(archived.path)
      else archiveErrors.push(archived.error)
    }
    const path = archived?.path

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
  // v1.2.0：槽位与角色块的实际生效情况（生效才写，避免噪音）
  if (extra.request.slotName) summary.push(`画风槽位：${extra.request.slotName}（模型 ${extra.request.model}）`)
  if (Array.isArray(extra.request.characters) && extra.request.characters.length > 0) {
    summary.push(`多角色块：${extra.request.characters.length} 个角色（各自独立不串色）`)
  }
  // 本次调用中的所有告警（法典未命中、多角色块未启用被忽略等）
  const warnings = Array.isArray(extra.warnings) ? extra.warnings : []
  for (const warning of warnings) summary.push(`⚠️ ${warning}`)
  if (images.length === 0) {
    summary.push('⚠️ 图片没能作为附件随结果返回，因此你看不到画面内容；请依据归档路径回复用户。')
  }
  if (failed.length > 0) {
    summary.push('未能附加到结果的图片：')
    for (const item of failed) summary.push(`  - ${item}`)
  }
  // 归档失败要显式说出来：图片仍能看，但磁盘上没有文件 ——
  // 不报的话用户只会看到「图在但文件找不到」，无从自查。
  if (archiveErrors.length > 0) {
    summary.push(`⚠️ 归档失败（图片本身仍可用）：${[...new Set(archiveErrors)].join('；')}`)
  }

  // 计费信息（仅直连通道）。放在图片落地之后：先把图交出去，
  // 再花一次请求查余额 —— 万一查额度卡住，用户至少已经看到图。
  const billing = extra.client
    ? billingLine({
      channel: result.meta?.channel,
      ...(await collectBilling(extra.client, result, extra.balanceBefore)),
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
