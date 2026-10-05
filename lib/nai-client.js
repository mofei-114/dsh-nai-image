/**
 * 上游 HTTP 客户端：NAI 直连（任务接口优先 + GET 兜底）与 OpenAI 兼容两条通道。
 *
 * 只依赖全局 fetch / AbortSignal —— 插件以 file URL 加载，目录下没有
 * node_modules，不能 import 任何第三方包。
 *
 * 契约来源：astrbot_plugin_nai_image v2.7.3 源码（见 constants.js 注释）。
 */

import {
  DEFAULT_NEGATIVE,
  DOWNLOAD_TIMEOUT,
  OPENAI_DIRECTOR_CAPTIONS,
  OPENAI_DIRECTOR_MODELS,
  OPENAI_MAX_AREA,
  OPENAI_MAX_REFERENCE_IMAGES,
  OPENAI_MAX_SIDE,
  OPENAI_RETRY_DELAYS,
  OPENAI_RETRYABLE_STATUS,
  OPENAI_SIZE_MAP,
  OPENAI_TRANSIENT_MARKERS,
  WEB_JOB_POLL_FAILURE_LIMIT,
  WEB_JOB_POLL_INTERVAL,
  WEB_JOB_POLL_REQUEST_TIMEOUT,
  WEB_JOB_SUBMIT_TIMEOUT,
} from './constants.js'

/** 上游返回的可读错误；reason 为稳定的机器可读分类。 */
export class NaiError extends Error {
  /**
   * @param {string} reason - 稳定分类，如 http_4xx / timeout / web_job_failed。
   * @param {string} [detail] - 上游正文摘要，供人读。
   */
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = 'NaiError'
    this.reason = reason
    this.detail = detail
  }
}

/** 休眠；支持取消。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 上游 token 的字面样式（`STA1N-` 开头的一串）。
 *
 * 用于在把任何上游正文写进日志/错误信息之前先遮蔽。上游的 getUser
 * 响应会明文回显 token，而错误正文可能是非 JSON 的原样文本 ——
 * detail 最终会进工具结果与会话记录，所以必须在源头抹掉。
 */
const TOKEN_PATTERN = /\bSTA1N-[A-Za-z0-9_\-]{4,}/g

/**
 * 遮蔽字符串里的 token。
 *
 * @param {string} text - 任意文本。
 * @returns {string} 遮蔽后的文本。
 */
export function redactToken(text) {
  return String(text ?? '').replace(TOKEN_PATTERN, 'STA1N-***')
}

/** 把上游错误正文压成一行摘要，优先取 error/message 字段。 */
function summarizeErrorBody(text) {
  const raw = (text ?? '').trim()
  if (raw.length === 0) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const err = parsed.error
      if (typeof err === 'string' && err.trim()) return redactToken(err.trim()).slice(0, 200)
      if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.trim()) {
        return redactToken(err.message.trim()).slice(0, 200)
      }
      if (typeof parsed.message === 'string' && parsed.message.trim()) return redactToken(parsed.message.trim()).slice(0, 200)
    }
  } catch {
    // 非 JSON：落到下面的通用摘要
  }
  // 兜底路径最危险：非 JSON 正文原样截断，可能整段含 token
  return redactToken(raw.replace(/\s+/g, ' ')).slice(0, 200)
}

/** 按状态码归类成稳定 reason。 */
function classifyStatus(status) {
  if (status >= 400 && status < 500) return 'http_4xx'
  if (status >= 500 && status < 600) return 'http_5xx'
  return 'http_other'
}

/**
 * 带超时的 fetch。Node 的 AbortSignal.timeout 不便于叠加外部 signal，
 * 这里手工用 AbortController 串联两者。
 *
 * @param {string} url - 目标地址。
 * @param {object} init - fetch 选项。
 * @param {number} timeoutSec - 秒级超时。
 * @param {AbortSignal} [signal] - 调用方取消。
 * @returns {Promise<Response>} 响应。
 */
async function fetchWithTimeout(url, init, timeoutSec, signal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutSec * 1000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 判断一次失败是否来自超时（区别于调用方取消）。 */
function isTimeout(error) {
  return error instanceof Error && /timeout/i.test(String(error.message))
}

/**
 * 直连与 OpenAI 两条通道共用的客户端。
 */
export class NaiClient {
  /**
   * @param {object} config - 已归一化的运行配置。
   * @param {string} config.callMode - 'direct' | 'openai'。
   * @param {string} config.baseUrl - NAI 直连地址。
   * @param {string} config.token - 直连 token。
   * @param {string} config.openaiBaseUrl - OpenAI 兼容地址。
   * @param {string} config.openaiApiKey - OpenAI 兼容密钥。
   * @param {string} config.openaiModel - OpenAI 兼容模型名。
   * @param {string} config.model - 直连模型名。
   * @param {number} config.requestTimeout - 秒。
   * @param {number} config.maxRetries - OpenAI 通道重试次数（0-3）。
   * @param {boolean} config.bypassSystemProxy - 保留位；Node 侧无 aiohttp 等价开关。
   */
  constructor(config) {
    this.config = config
  }

  /** 当前通道是否具备必要条件。 */
  ready() {
    if (this.config.callMode === 'openai') {
      return this.config.openaiBaseUrl.trim().length > 0
    }
    return this.config.baseUrl.trim().length > 0 && this.config.token.trim().length > 0
  }

  /** 缺条件时给出可操作的说明。 */
  readinessProblem() {
    if (this.config.callMode === 'openai') {
      if (this.config.openaiBaseUrl.trim().length === 0) return 'OpenAI 兼容模式需要填写「OpenAI 兼容生图接口地址」'
      return undefined
    }
    if (this.config.baseUrl.trim().length === 0) return '直连模式需要填写「生图服务地址」'
    if (this.config.token.trim().length === 0) return '直连模式需要填写「生图 Token」（在插件设置里配置）'
    return undefined
  }

  /**
   * 按当前模式生图。
   *
   * @param {object} request - 归一化后的请求。
   * @param {string} request.prompt - 主体提示词。
   * @param {string} request.artist - 画师串（可空）。
   * @param {string} request.negative - 反向提示词。
   * @param {string} request.model - 模型名。
   * @param {string} request.size - 直连分档名或像素串。
   * @param {number} request.steps - 采样步数。
   * @param {number} request.scale - 提示词引导。
   * @param {number} request.cfg - CFG Rescale。
   * @param {string} request.sampler - 采样器。
   * @param {string} request.noiseSchedule - 噪声调度。
   * @param {number} request.seed - -1 表示随机。
   * @param {number} request.n - 张数。
   * @param {AbortSignal} [signal] - 取消。
   * @returns {Promise<{images: Buffer[], meta: object}>} 图片字节与说明。
   */
  async generate(request, signal) {
    if (this.config.callMode === 'openai') return this.generateOpenAI(request, signal)
    return this.generateDirect(request, signal)
  }

  // ---------------------------------------------------------------- 直连

  /**
   * 直连通道：任务接口优先，GET 兜底。
   *
   * v2.7.1 起固定为任务接口（支持 1-50 步、按步数计价、失败退点）；
   * 只有提交返回 404（旧版自建 Nai2API）才回退 GET /generate。
   */
  async generateDirect(request, signal) {
    const base = this.config.baseUrl.replace(/\/+$/, '')
    const out = []
    const notes = []
    const costs = []
    for (let i = 0; i < request.n; i += 1) {
      signal?.throwIfAborted()
      const one = await this.generateOneDirect(base, request, signal)
      out.push(one.bytes)
      notes.push(one.via)
      costs.push(one.cost)
    }
    return { images: out, meta: { channel: 'direct', via: notes, costs } }
  }

  /** 直连单张：先任务接口，404 时回退 GET。 */
  async generateOneDirect(base, request, signal) {
    const job = await this.submitWebJob(base, request, signal)
    if (job.kind === 'unavailable') {
      const bytes = await this.generateViaGet(base, request, signal)
      // GET 兜底是裸图片字节，没有任何计费信息
      return { bytes, via: 'GET /generate（任务接口不可用，已回退）', cost: undefined }
    }
    const bytes = await this.pollWebJob(base, job.id, signal)
    return { bytes, via: `任务接口 /api/web/jobs（job ${job.id}）`, cost: job.cost }
  }

  /** 把请求体字段拼成直连参数集合。 */
  directPayload(request) {
    return {
      tag: request.prompt,
      artist: request.artist || '',
      model: request.model,
      size: request.size,
      steps: request.steps,
      scale: request.scale,
      cfg: request.cfg,
      sampler: request.sampler,
      negative: request.negative,
      noise_schedule: request.noiseSchedule,
      nocache: 1,
    }
  }

  /**
   * 提交任务。token 经 body 传递，不进 URL。
   *
   * `cost` 是上游在**提交响应**里给出的实际扣费点数（契约里可选）。
   * 轮询响应没有这个字段，所以必须在提交这一跳就把它捞住，
   * 否则后面无从还原。
   *
   * @returns {Promise<{kind:'job', id:string, cost:number|undefined}|{kind:'unavailable'}>} 任务或需回退。
   */
  async submitWebJob(base, request, signal) {
    const payload = { token: this.config.token, ...this.directPayload(request) }
    // 步数钳到 1-50（任务接口契约）
    payload.steps = Math.max(1, Math.min(Math.trunc(request.steps) || 28, 50))

    let resp
    try {
      resp = await fetchWithTimeout(`${base}/api/web/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, WEB_JOB_SUBMIT_TIMEOUT, signal)
    } catch (error) {
      if (isTimeout(error)) throw new NaiError('timeout', '提交任务超时')
      throw new NaiError('exception', String(error?.message ?? error))
    }

    if (resp.status === 404) return { kind: 'unavailable' }
    const text = await resp.text()
    if (resp.status !== 200 && resp.status !== 202) {
      throw new NaiError(classifyStatus(resp.status), `HTTP ${resp.status} ${summarizeErrorBody(text)}`.trim())
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new NaiError('invalid_response', '任务提交响应不是 JSON')
    }
    const id = String(parsed?.id ?? '')
    if (!id) throw new NaiError('invalid_response', '任务提交响应缺少 id')
    // cost 可选：可能是 undefined / null / 非数字，一律收敛成 number|undefined
    const rawCost = parsed?.cost
    const costNum = typeof rawCost === 'number' ? rawCost : Number(rawCost)
    const cost = rawCost === undefined || rawCost === null || !Number.isFinite(costNum) ? undefined : costNum
    return { kind: 'job', id, cost }
  }

  /** 轮询任务直到 done / failed。 */
  async pollWebJob(base, jobId, signal) {
    const deadline = Date.now() + this.config.requestTimeout * 1000
    let failures = 0
    for (;;) {
      signal?.throwIfAborted()
      if (Date.now() > deadline) throw new NaiError('timeout', '任务轮询超时')

      let resp
      try {
        resp = await fetchWithTimeout(`${base}/api/jobs/${encodeURIComponent(jobId)}`, {
          method: 'GET',
          // 轮询用请求头传 token，不进 URL
          headers: { 'x-user-token': this.config.token },
        }, WEB_JOB_POLL_REQUEST_TIMEOUT, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        failures += 1
        if (failures >= WEB_JOB_POLL_FAILURE_LIMIT) {
          throw new NaiError('exception', `轮询连续失败 ${failures} 次：${String(error?.message ?? error)}`)
        }
        await sleep(WEB_JOB_POLL_INTERVAL * 1000, signal)
        continue
      }

      if (!resp.ok) {
        failures += 1
        if (failures >= WEB_JOB_POLL_FAILURE_LIMIT) {
          throw new NaiError(classifyStatus(resp.status), `轮询返回 HTTP ${resp.status}`)
        }
        await sleep(WEB_JOB_POLL_INTERVAL * 1000, signal)
        continue
      }

      failures = 0
      let job
      try {
        job = JSON.parse(await resp.text())
      } catch {
        await sleep(WEB_JOB_POLL_INTERVAL * 1000, signal)
        continue
      }

      const status = String(job?.status ?? '')
      if (status === 'done') {
        const imageUrl = String(job?.imageUrl ?? '')
        if (!imageUrl) throw new NaiError('invalid_response', '任务完成但缺少 imageUrl')
        return this.downloadImage(resolveUrl(base, imageUrl), signal)
      }
      if (status === 'failed') {
        throw new NaiError('web_job_failed', String(job?.error ?? '上游未返回原因'))
      }
      await sleep(WEB_JOB_POLL_INTERVAL * 1000, signal)
    }
  }

  /** GET /generate 兜底：token 在 query，成功即返回裸图片字节。 */
  async generateViaGet(base, request, signal) {
    const payload = this.directPayload(request)
    const query = new URLSearchParams()
    query.set('tag', payload.tag)
    query.set('token', this.config.token)
    query.set('model', payload.model)
    query.set('artist', payload.artist)
    query.set('size', payload.size)
    query.set('steps', String(payload.steps))
    query.set('scale', String(payload.scale))
    query.set('cfg', String(payload.cfg))
    query.set('sampler', payload.sampler)
    query.set('negative', payload.negative)
    query.set('nocache', '1')
    query.set('noise_schedule', payload.noise_schedule)

    let resp
    try {
      resp = await fetchWithTimeout(`${base}/generate?${query.toString()}`, { method: 'GET' },
        this.config.requestTimeout, signal)
    } catch (error) {
      if (isTimeout(error)) throw new NaiError('timeout', 'GET /generate 超时')
      throw new NaiError('exception', String(error?.message ?? error))
    }
    const buf = Buffer.from(await resp.arrayBuffer())
    if (!resp.ok) {
      throw new NaiError(classifyStatus(resp.status), `HTTP ${resp.status} ${summarizeErrorBody(buf.toString('utf8'))}`.trim())
    }
    if (buf.length === 0) throw new NaiError('empty_response', 'GET /generate 返回空响应体')
    return buf
  }

  /** 下载任务图片；上游用 x-error:1 标记错误占位图。 */
  async downloadImage(url, signal) {
    const resp = await fetchWithTimeout(url, { method: 'GET' }, DOWNLOAD_TIMEOUT, signal)
    if (resp.headers.get('x-error') === '1') {
      throw new NaiError('web_job_failed', '上游返回错误占位图（x-error: 1）')
    }
    if (!resp.ok) throw new NaiError(classifyStatus(resp.status), `下载图片 HTTP ${resp.status}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length === 0) throw new NaiError('empty_response', '下载图片为空')
    return buf
  }

  // ------------------------------------------------------- OpenAI 兼容

  /** 拼接 OpenAI 端点，兼容 base 带不带 /v1。 */
  openaiEndpoint(target) {
    const base = this.config.openaiBaseUrl.replace(/\/+$/, '')
    if (new RegExp(`/images/${target}$`).test(base)) return base
    if (/\/images\/(generations|edits)$/.test(base)) return base.replace(/\/images\/(generations|edits)$/, `/images/${target}`)
    if (/\/v1\/?$/.test(base) || base.includes('/v1/')) return `${base}/images/${target}`
    return `${base}/v1/images/${target}`
  }

  /**
   * OpenAI 兼容通道。带 408/429/502/503/504 与瞬时文案的退避重试。
   * 超时不重试——上游通常仍在生成并照常扣费。
   */
  async generateOpenAI(request, signal) {
    const endpoint = this.openaiEndpoint('generations')
    const payload = this.openaiPayload(request)
    const maxAttempts = Math.max(0, Math.min(this.config.maxRetries, 3)) + 1

    let lastError
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        const delay = OPENAI_RETRY_DELAYS[Math.min(attempt - 2, OPENAI_RETRY_DELAYS.length - 1)]
        await sleep(delay * 1000, signal)
      }
      signal?.throwIfAborted()
      try {
        const images = await this.openaiOnce(endpoint, payload, signal)
        return { images, meta: { channel: 'openai', attempts: attempt } }
      } catch (error) {
        lastError = error
        // 超时与取消不重试
        if (signal?.aborted) throw error
        if (error instanceof NaiError && error.reason === 'timeout') throw error
        const retryable = error instanceof NaiError
          && (OPENAI_RETRYABLE_STATUS.has(error.status)
            || OPENAI_TRANSIENT_MARKERS.some((m) => String(error.detail ?? '').toLowerCase().includes(m.toLowerCase())))
        if (!retryable) throw error
      }
    }
    throw lastError
  }

  /** 组装 OpenAI 通道请求体。 */
  openaiPayload(request) {
    // OpenAI 通道没有独立画师字段，画师串拼进 prompt 前缀
    const prompt = request.artist ? `${request.artist}, ${request.prompt}` : request.prompt
    // 该通道的上游契约把 scale 收敛到 0-10（直连通道是 0-20）
    const parameters = {
      steps: Math.max(1, Math.min(50, Math.trunc(request.steps) || 28)),
      scale: Math.max(0, Math.min(10, Number.isFinite(request.scale) ? request.scale : 5)),
    }
    if (request.sampler) parameters.sampler = request.sampler
    if (request.noiseSchedule) parameters.noise_schedule = request.noiseSchedule
    if (request.seed >= 0) parameters.seed = request.seed
    if (request.negative && request.negative.trim()) parameters.negative_prompt = request.negative.trim()

    const payload = {
      prompt,
      size: this.resolveOpenAISize(request.size),
      n: Math.max(1, request.n),
      model: request.model,
      action: 'generate',
      parameters,
    }
    return payload
  }

  /** 分档名 → 像素，或原样透传像素串，最后按契约收敛。 */
  resolveOpenAISize(size) {
    const mapped = OPENAI_SIZE_MAP[size] ?? size
    return normalizeOpenAISize(mapped)
  }

  /** 单次 OpenAI generations 请求（含参考图字段）。 */
  async openaiOnce(endpoint, payload, signal) {
    const headers = { 'Content-Type': 'application/json' }
    const key = this.config.openaiApiKey.trim()
    if (key) headers.Authorization = `Bearer ${key}`

    let resp
    try {
      resp = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }, this.config.requestTimeout, signal)
    } catch (error) {
      if (isTimeout(error)) throw new NaiError('timeout', 'OpenAI 兼容接口超时')
      throw new NaiError('exception', String(error?.message ?? error))
    }

    const text = await resp.text()
    if (resp.status >= 400) {
      const err = new NaiError(`http_${resp.status}`, summarizeErrorBody(text))
      err.status = resp.status
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new NaiError('invalid_response', '响应不是 JSON（上游可能返回了 HTML 页面）')
    }
    const items = Array.isArray(parsed?.data) ? parsed.data : []
    if (items.length === 0) throw new NaiError('empty_response', '响应 data 为空')

    const images = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const b64 = String(item.b64_json ?? '').trim()
      const url = String(item.url ?? '').trim()
      if (b64) {
        images.push(Buffer.from(b64, 'base64'))
      } else if (url) {
        const dl = await fetchWithTimeout(url, { method: 'GET' }, DOWNLOAD_TIMEOUT, signal)
        if (dl.ok) images.push(Buffer.from(await dl.arrayBuffer()))
      }
    }
    if (images.length === 0) throw new NaiError('empty_response', '响应中没有可用图片')
    return images
  }

  // ------------------------------------------------------------ 工具

  /**
   * 查询余额/额度：POST /api/api/getUser。
   *
   * ⚠️ 上游会在这个响应里**明文回显 token**（实测：
   * `{"data":{"value":N,"balance":N,"token":"STA1N-…","enabled":true}}`）。
   * 因此这里只挑出需要的三个字段返回，绝不把整个 `data` 往外传 ——
   * 否则任何一处 log / 工具输出 / 错误信息都可能把它带到会话记录里。
   *
   * @param {AbortSignal} [signal] - 取消。
   * @returns {Promise<{value?: number, balance?: number, enabled?: boolean}>} 仅额度字段。
   */
  async fetchQuota(signal) {
    const base = this.config.baseUrl.replace(/\/+$/, '')
    let resp
    try {
      resp = await fetchWithTimeout(`${base}/api/api/getUser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toUserId: this.config.token }),
      }, WEB_JOB_POLL_REQUEST_TIMEOUT, signal)
    } catch (error) {
      if (isTimeout(error)) throw new NaiError('timeout', '查询额度超时')
      throw new NaiError('exception', String(error?.message ?? error))
    }
    const text = await resp.text()
    if (!resp.ok) throw new NaiError(classifyStatus(resp.status), `HTTP ${resp.status} ${summarizeErrorBody(text)}`.trim())
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new NaiError('invalid_response', '额度响应不是 JSON')
    }
    if (String(parsed?.status ?? '') !== 'ok') {
      throw new NaiError('quota_failed', String(parsed?.message ?? '上游未返回 status: ok'))
    }

    // 白名单投影：只带走额度字段，token 等其余内容一律留在本地作用域
    const data = parsed.data
    if (data === null || typeof data !== 'object') return {}
    const pick = (key, type) => (typeof data[key] === type ? data[key] : undefined)
    return {
      value: pick('value', 'number'),
      balance: pick('balance', 'number'),
      enabled: pick('enabled', 'boolean'),
    }
  }
}

/** 相对 imageUrl 拼到 base 上；绝对地址原样返回。 */
function resolveUrl(base, url) {
  if (/^https?:\/\//i.test(url)) return url
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`
}

/**
 * OpenAI 尺寸契约收敛：宽高 64 倍数、最大边 ≤1920、面积 ≤3686400。
 * 无法解析回退 1024x1024。
 *
 * 取整必须用 floor，对应参考实现的 `(v + 32) // 64 * 64`（Python 的 // 是向下取整）。
 * 用 Math.round 会让 832 变成 896 —— 白名单里的尺寸会被整体推高一档。
 *
 * @param {string} size - 形如 "832x1216"。
 * @returns {string} 收敛后的像素串。
 */
export function normalizeOpenAISize(size) {
  const m = /^\s*(\d{1,5})\s*[x×*]\s*(\d{1,5})\s*$/i.exec(String(size ?? ''))
  if (!m) return '1024x1024'
  let width = Math.max(64, Math.floor((Number(m[1]) + 32) / 64) * 64)
  let height = Math.max(64, Math.floor((Number(m[2]) + 32) / 64) * 64)
  while (Math.max(width, height) > OPENAI_MAX_SIDE && Math.min(width, height) > 64) {
    if (width >= height) width -= 64
    else height -= 64
  }
  while (width * height > OPENAI_MAX_AREA && Math.min(width, height) > 64) {
    if (width >= height) width -= 64
    else height -= 64
  }
  return `${width}x${height}`
}

/**
 * 参考图等比缩小到上游契约内（最长边 ≤1920、面积 ≤3686400）。
 *
 * 只在超限时才需要重编码，因此这里返回【目标尺寸】而不是像素——
 * 真正的重编码交给调用方的附件投影能力。
 *
 * @param {number} width - 原宽。
 * @param {number} height - 原高。
 * @returns {{width:number,height:number,needsResize:boolean}} 目标尺寸。
 */
export function referenceTargetSize(width, height) {
  if (!(width > 0) || !(height > 0)) return { width, height, needsResize: false }
  const ratio = Math.min(1, OPENAI_MAX_SIDE / Math.max(width, height),
    Math.sqrt(OPENAI_MAX_AREA / (width * height)))
  if (ratio >= 1) return { width, height, needsResize: false }
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    needsResize: true,
  }
}

/** 供外部复用的导出，避免调用方重复实现契约。 */
export const openaiReferenceCapacity = OPENAI_MAX_REFERENCE_IMAGES
export const directorModels = OPENAI_DIRECTOR_MODELS
export const directorCaptions = OPENAI_DIRECTOR_CAPTIONS
export const defaultNegative = DEFAULT_NEGATIVE
