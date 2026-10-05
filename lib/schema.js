/**
 * Config schema 与 schemastery 的自适应加载。
 *
 * ## 为什么需要自适应加载
 *
 * DSH 的 GUI 配置表单只投影【声明了 `.volatile()` 的 Config 字段】
 * （见 dsh-settings 的 volatileForm）。没有 Config schema，插件在
 * 「插件 → dsh-nai-image」页面里一个可编辑字段都不会出现。
 *
 * 但插件目录下没有 node_modules，`import '@deepseek-ai/schemastery'`
 * 会直接 ERR_MODULE_NOT_FOUND —— 实测过，走 DSH 自己的 Electron 运行时
 * 也一样。而 schemastery 随 DSH 安装包一起发布，就在 app.asar 里。
 *
 * 因此这里从 `process.execPath` 反推安装目录，用 createRequire 从该锚点
 * 取 schemastery。这样：
 *   - 不硬编码任何绝对路径，换台机器、换个安装位置都能工作；
 *   - 用的是宿主自带的同一份 schemastery，版本不会漂移。
 *
 * 取不到时（例如在纯 Node 下跑测试）返回 undefined，由调用方降级 ——
 * 插件的业务功能不依赖 Config schema，只有 GUI 表单依赖。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 缓存：模块级，避免每次调用都探测文件系统。 */
let cached
let probed = false

/**
 * 定位并加载宿主自带的 schemastery。
 *
 * @returns {object|undefined} schemastery 模块（其 default 是 z 构造器）；
 *   找不到时 undefined。
 */
export function loadSchemastery() {
  if (probed) return cached
  probed = true

  const exeDir = dirname(process.execPath)
  // 候选锚点：桌面端是 resources/app.asar，开发态是 resources/app。
  // 顺序按「先打包态、后开发态」排，命中即返回。
  const anchors = [
    join(exeDir, 'resources', 'app.asar', 'dsh', 'package.json'),
    join(exeDir, 'resources', 'app.asar', 'package.json'),
    join(exeDir, 'resources', 'app', 'dsh', 'package.json'),
    join(exeDir, 'resources', 'app', 'package.json'),
  ]

  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue
    try {
      const require = createRequire(anchor)
      cached = require('@deepseek-ai/schemastery')
      return cached
    } catch {
      // 该锚点解析不到：换下一个
    }
  }
  cached = undefined
  return cached
}

/** 取 z 构造器；加载不到时 undefined。 */
export function schemastery() {
  const mod = loadSchemastery()
  if (mod === undefined) return undefined
  return mod.default ?? mod
}

/**
 * 构造插件的 Config schema。
 *
 * 字段选择遵循一条原则：**只有用户会改的东西才进表单**。
 * 因此 `verbose` 这类诊断开关也放进来，而派生量（如 activeModel）
 * 不放——它们由其他字段决定，不该单独可编辑。
 *
 * `.volatile()` 让字段成为「实时句柄」：写入后无需重启即可读到新值。
 * `.role('secret')` 让 token 不通过 remote 回传明文（只给存在性标记）。
 *
 * @returns {object|undefined} Config schema；schemastery 不可用时 undefined。
 */
export function buildConfig() {
  const z = schemastery()
  if (z === undefined) return undefined

  return z.object({
    // ---------------------------------------------------------------- 通道
    callMode: z.union([z.const('direct'), z.const('openai')])
      .default('direct')
      .description('调用模式：direct = NAI 直连（任务接口优先，GET 兜底）；openai = OpenAI 兼容中转站')
      .volatile(),

    // ------------------------------------------------------ 直连（direct）
    baseUrl: z.string()
      .default('https://nai.sta1n.cn')
      .description('生图服务地址（第三方中转站，非 NovelAI 官方 API）')
      .volatile(),
    token: z.string()
      .default('')
      .role('secret')
      .description('生图 Token（直连模式必填）。填写后存入凭据域，不写入设置文件；留空表示保持当前值')
      .volatile(),
    model: z.string()
      .default('nai-diffusion-4-5-full')
      .description('直连模型：nai-diffusion-4-5-full 或 nai-diffusion-5-full')
      .volatile(),

    // ------------------------------------------------ OpenAI 兼容（openai）
    openaiBaseUrl: z.string()
      .default('')
      .description('OpenAI 兼容生图接口地址，填到 /v1 为止即可')
      .volatile(),
    openaiApiKey: z.string()
      .default('')
      .role('secret')
      .description('OpenAI 兼容接口的密钥（部分中转站不校验，可留空）。同样存入凭据域')
      .volatile(),
    openaiModel: z.string()
      .default('nai-diffusion-5-full')
      .description('OpenAI 兼容通道的模型名')
      .volatile(),

    // ------------------------------------------------------------ 生成参数
    imageStyle: z.union([
      z.const('vertical'), z.const('comicDoujin'), z.const('r18'),
      z.const('lolita25d'), z.const('anime'), z.const('galgame'), z.const('custom'),
    ])
      .default('vertical')
      .description('画风。注意上游命名：r18 显示为「2.5D唯美风」、anime 显示为「本子里番风」')
      .volatile(),
    customArtists: z.string()
      .default('')
      .description('自定义画师串，仅 imageStyle = custom 时生效')
      .volatile(),
    imageSize: z.string()
      .default('竖图')
      .description('画幅：竖图/横图/方图/2K竖图/2K横图/2K方图/4K竖图/4K横图/4K方图；OpenAI 通道可直接写像素如 832x1216')
      .volatile(),
    steps: z.number()
      .min(1).max(50).step(1)
      .default(24)
      .description('采样步数 1-50。直连任务接口支持满 50；GET 兜底通道上游按 28 截断')
      .volatile(),
    scale: z.number()
      .min(0).max(20)
      .default(6)
      .description('提示词引导强度。直连 0-20；OpenAI 通道上游会收敛到 0-10')
      .volatile(),
    cfg: z.number()
      .min(0).max(1)
      .default(1)
      .description('CFG Rescale 0-1')
      .volatile(),
    sampler: z.union([
      z.const('k_dpmpp_2m_sde'), z.const('k_dpmpp_2m'), z.const('k_dpmpp_sde'),
      z.const('k_dpmpp_2s_ancestral'), z.const('k_euler_ancestral'), z.const('k_euler'),
    ])
      .default('k_dpmpp_2m_sde')
      .description('采样器')
      .volatile(),
    noiseSchedule: z.union([
      z.const('karras'), z.const('native'), z.const('exponential'), z.const('polyexponential'),
    ])
      .default('karras')
      .description('噪声调度')
      .volatile(),
    negative: z.string()
      .default('')
      .description('反向提示词。留空使用参考实现的内置默认反向词')
      .volatile(),
    seed: z.number()
      .min(-1)
      .default(-1)
      .description('随机种子；-1 表示每次随机。固定同一个种子可复现同一张图')
      .volatile(),
    defaultCount: z.number()
      .min(1).max(6).step(1)
      .default(1)
      .description('工具未指定 count 时的默认生成张数 1-6')
      .volatile(),

    // ---------------------------------------------------------------- 网络
    requestTimeout: z.number()
      .min(30).max(600).step(1)
      .default(180)
      .description('请求超时（秒）。直连下同时是任务轮询的总等待上限')
      .volatile(),
    maxRetries: z.number()
      .min(0).max(3).step(1)
      .default(2)
      .description('OpenAI 通道失败重试次数 0-3（仅 408/429/502/503/504 与瞬时文案重试）')
      .volatile(),

    // ---------------------------------------------------------------- 归档
    saveImageHistory: z.boolean()
      .default(true)
      .description('是否把生成的图存到磁盘')
      .volatile(),
    imageHistoryDir: z.string()
      .default('')
      .description('归档目录；留空 = $DSH_HOME/plugin-data/dsh-nai-image/image_history')
      .volatile(),
    imageHistoryLimit: z.number()
      .min(0).step(1)
      .default(200)
      .description('最多保留张数；0 = 不清理')
      .volatile(),

    // ---------------------------------------------------------------- 开关
    enableTool: z.boolean()
      .default(true)
      .description('是否注册生图工具 nai_generate_image（改动需重启）')
      .volatile(),
    enableQuotaTool: z.boolean()
      .default(true)
      .description('是否注册额度查询工具 nai_quota（改动需重启）')
      .volatile(),
    verbose: z.boolean()
      .default(true)
      .description('是否输出插件日志')
      .volatile(),
  })
}

/**
 * 把 Cordis 的 volatile 句柄解开成普通值。
 *
 * `.volatile()` 字段在 config 对象上是 `{ get() }` 句柄而非值，
 * 因此读取时必须经这里。非 volatile 字段原样返回。
 *
 * @param {unknown} field - config 上的字段。
 * @param {unknown} fallback - 句柄不可用时的兜底值。
 * @returns {unknown} 普通值。
 */
export function readField(field, fallback) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    try {
      const value = field.get()
      return value === undefined ? fallback : value
    } catch {
      return fallback
    }
  }
  return field === undefined ? fallback : field
}

/**
 * 把整个 config 对象解成普通值快照。
 *
 * 只在需要一次性读取（如 apply 时算归档目录）时用；
 * 每次生图都应重新读，才能拿到表单刚写入的新值。
 *
 * @param {object} config - Cordis 传入的 config。
 * @returns {object} 普通值对象。
 */
export function readAll(config) {
  if (config === null || typeof config !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(config)) out[key] = readField(value, undefined)
  return out
}
