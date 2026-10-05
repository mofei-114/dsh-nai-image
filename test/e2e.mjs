// 端到端：起 mock 上游，跑插件真实 execute()，验证三条通道与图片落地。
import { dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件所在目录（test/）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件项目根。 */
const PROJECT = dirname(HERE)
/** 测试用的 fixture 与产物目录（首次运行由 setup-fixtures.mjs 建立）。 */
const PROBE = joinPath(HERE, '.fixtures')
mkdirSync(PROBE, { recursive: true })

import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const PLUGIN = joinPath(PROJECT, 'lib/index.js')

const out = []
const say = (m) => { out.push(m); }
let failures = 0
function check(label, cond, detail) {
  if (cond) say(`PASS  ${label}${detail ? '  -> ' + detail : ''}`)
  else { failures += 1; say(`FAIL  ${label}${detail ? '  -> ' + detail : ''}`) }
}

// ---------------------------------------------------------------- PNG 构造
/** 造一张纯色 PNG（真 CRC，能被附件服务解码）。 */
function makePng(width, height, rgb = [200, 30, 60]) {
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      raw[rowStart + 1 + x * 3] = rgb[0]
      raw[rowStart + 2 + x * 3] = rgb[1]
      raw[rowStart + 3 + x * 3] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG = makePng(64, 96)
const PNGB64 = PNG.toString('base64')

// -------------------------------------------------------------- mock 上游
const state = {
  jobPolls: 0,
  sawSubmit: null,
  sawPollHeader: null,
  sawGet: null,
  sawOpenAI: null,
  openaiAttempts: 0,
  mode: 'direct',
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')

    // 任务提交
    if (req.method === 'POST' && url.pathname === '/api/web/jobs') {
      state.sawSubmit = { body: JSON.parse(body), headers: req.headers }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'job_1', status: 'queued', cost: 1 }))
      return
    }
    // 任务轮询
    if (req.method === 'GET' && url.pathname === '/api/jobs/job_1') {
      state.jobPolls += 1
      state.sawPollHeader = req.headers['x-user-token']
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (state.jobPolls < 2) {
        res.end(JSON.stringify({ id: 'job_1', status: 'running' }))
      } else {
        res.end(JSON.stringify({ id: 'job_1', status: 'done', imageUrl: '/api/images/img_1/content' }))
      }
      return
    }
    // 图片下载
    if (req.method === 'GET' && url.pathname === '/api/images/img_1/content') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(PNG)
      return
    }
    // GET /generate 兜底
    if (req.method === 'GET' && url.pathname === '/generate') {
      state.sawGet = Object.fromEntries(url.searchParams.entries())
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(PNG)
      return
    }
    // 额度
    if (req.method === 'POST' && url.pathname === '/api/api/getUser') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', data: { value: 123, balance: 456, enabled: true } }))
      return
    }
    // OpenAI generations
    if (req.method === 'POST' && /\/v1\/images\/generations$/.test(url.pathname)) {
      state.openaiAttempts += 1
      state.sawOpenAI = { body: JSON.parse(body), headers: req.headers, path: url.pathname }
      if (state.mode === 'openai_retry' && state.openaiAttempts === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '服务繁忙，请稍后重试' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNGB64 }] }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
say(`mock 上游: ${base}\n`)

// ------------------------------------------------------------ 附件服务桩
// 真附件服务需要整套存储后端；这里按它的公开契约实现最小等价物，
// 只校验「能被 ImageAttachmentRef 消费」的形态。
const savedAttachments = []
const attachments = {
  imageLimits: { maxImageBytes: 20971520, maxImagesPerMessage: 20, maxMessageImageBytes: 41943040, maxImagePixels: 64e6, maxImageDimension: 8192, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
  async saveImage(input) {
    if (!this.imageLimits.mediaTypes.includes(input.mediaType)) {
      const e = new Error('unsupported type'); e.code = 'UNSUPPORTED_IMAGE_TYPE'; throw e
    }
    if (input.data.length > this.imageLimits.maxImageBytes) {
      const e = new Error('too large'); e.code = 'IMAGE_TOO_LARGE'; throw e
    }
    const ref = {
      attachmentId: `sha256:${String(savedAttachments.length).padStart(56, '0')}`,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 64,
      height: 96,
      ...(input.name === undefined ? {} : { name: input.name }),
    }
    savedAttachments.push(ref)
    return ref
  },
}

// ------------------------------------------------------------- 载入插件
const mod = await import(pathToFileURL(PLUGIN).href)
const historyDir = mkdtempSync(join(tmpdir(), 'nai-hist-'))

function makeCtx() {
  const registered = []
  return {
    registered,
    logger: {
      info: (m) => say('    [log] ' + m),
      warn: (m) => say('    [warn] ' + m),
      error: (m) => say('    [error] ' + m),
    },
    tools: { register: (d) => { registered.push(d); return () => {} } },
    get: (k) => (k === 'attachments' ? attachments : undefined),
  }
}

async function runTool(config, args, toolName = 'nai_generate_image') {
  const ctx = makeCtx()
  mod.apply(ctx, config)
  const def = ctx.registered.find((d) => d.name === toolName)
  if (!def) throw new Error('工具未注册: ' + toolName)
  const value = await def.execute(args, { signal: new AbortController().signal })
  return { def, value }
}

// ============================================================ 用例 1：直连任务接口
say('=== 用例 1：直连（任务接口优先） ===')
{
  const { def, value } = await runTool({
    callMode: 'direct', baseUrl: base, token: 'tok-abc', saveImageHistory: true,
    imageHistoryDir: historyDir, verbose: true, imageStyle: 'vertical', imageSize: '竖图',
  }, { prompt: '1girl, solo, cherry blossoms' })

  check('任务提交收到 token 与 tag', state.sawSubmit?.body?.token === 'tok-abc' && state.sawSubmit?.body?.tag === '1girl, solo, cherry blossoms',
    JSON.stringify({ token: state.sawSubmit?.body?.token, size: state.sawSubmit?.body?.size, steps: state.sawSubmit?.body?.steps }))
  check('任务提交是中文分档名', state.sawSubmit?.body?.size === '竖图', state.sawSubmit?.body?.size)
  check('轮询用 x-user-token 头传 token', state.sawPollHeader === 'tok-abc', String(state.sawPollHeader))
  check('轮询了 2 次（running → done）', state.jobPolls === 2, String(state.jobPolls))
  check('返回 1 张图', value.images.length === 1, JSON.stringify(value.images))
  check('图片可作为 ImageBlock 使用', value.images[0]?.attachmentId?.startsWith('sha256:'), value.images[0]?.attachmentId)
  check('已归档到磁盘', value.saved.length === 1 && existsSync(value.saved[0]), value.saved[0])
  check('归档目录正确', value.saved[0]?.startsWith(historyDir), historyDir)

  const blocks = def.output.render({}, value)
  check('render 产出 text+image', blocks.map((b) => b.type).join('+') === 'text+image', blocks.map((b) => b.type).join('+'))
  check('image block 带完整 attachment', blocks[1]?.attachment?.mediaType === 'image/png', JSON.stringify(blocks[1]?.attachment))
  say('    summary: ' + JSON.stringify(value.summary))
}
say('')

// ======================================================== 用例 2：GET 兜底
say('=== 用例 2：任务接口 404 → GET /generate 兜底 ===')
{
  state.sawGet = null

  // 起第二个 mock：/api/web/jobs 返回 404，只提供 /generate
  const s2 = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname === '/api/web/jobs') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return }
    if (u.pathname === '/generate') {
      state.sawGet = Object.fromEntries(u.searchParams.entries())
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => s2.listen(0, '127.0.0.1', r))
  const base2 = `http://127.0.0.1:${s2.address().port}`

  const ctx = makeCtx()
  mod.apply(ctx, { callMode: 'direct', baseUrl: base2, token: 'tok-xyz', saveImageHistory: false, verbose: false })
  const def = ctx.registered.find((d) => d.name === 'nai_generate_image')
  const v = await def.execute({ prompt: 'fallback test' }, { signal: new AbortController().signal })

  check('回退到 GET /generate', state.sawGet !== null, JSON.stringify(state.sawGet))
  check('GET 用 query 传 token', state.sawGet?.token === 'tok-xyz', state.sawGet?.token)
  check('GET 用 tag 传提示词', state.sawGet?.tag === 'fallback test', state.sawGet?.tag)
  check('GET 带 nocache=1', state.sawGet?.nocache === '1', state.sawGet?.nocache)
  check('兜底仍返回图片', v.images.length === 1, String(v.images.length))
  check('summary 注明已回退', /回退/.test(v.summary), v.summary.split('\n').pop())
  s2.close()
}
say('')

// ==================================================== 用例 3：OpenAI 兼容
say('=== 用例 3：OpenAI 兼容通道 ===')
{
  state.sawOpenAI = null
  state.openaiAttempts = 0
  state.mode = 'openai'
  const { def, value } = await runTool({
    callMode: 'openai', openaiBaseUrl: `${base}/v1`, openaiApiKey: 'sk-test',
    openaiModel: 'nai-diffusion-5-full', saveImageHistory: false, verbose: false,
    imageSize: '竖图',
  }, { prompt: 'a serene lake', style: 'vertical' })

  check('打到 /v1/images/generations', state.sawOpenAI?.path === '/v1/images/generations', state.sawOpenAI?.path)
  check('Authorization 头正确', state.sawOpenAI?.headers?.authorization === 'Bearer sk-test', String(state.sawOpenAI?.headers?.authorization))
  check('size 转成像素', state.sawOpenAI?.body?.size === '832x1216', state.sawOpenAI?.body?.size)
  check('画师串拼进 prompt 前缀', /artist:dishwasher1910/.test(state.sawOpenAI?.body?.prompt ?? ''), (state.sawOpenAI?.body?.prompt ?? '').slice(0, 60) + '...')
  check('parameters 带 steps/scale', state.sawOpenAI?.body?.parameters?.steps === 24 && state.sawOpenAI?.body?.parameters?.scale === 6, JSON.stringify(state.sawOpenAI?.body?.parameters && { steps: state.sawOpenAI.body.parameters.steps, scale: state.sawOpenAI.body.parameters.scale }))
  check('parameters 带 negative_prompt', typeof state.sawOpenAI?.body?.parameters?.negative_prompt === 'string', String(state.sawOpenAI?.body?.parameters?.negative_prompt).slice(0, 40) + '...')
  check('b64_json 被解码成图片', value.images.length === 1, String(value.images.length))
  check('openai 通道不再返回 saved', value.saved.length === 0, JSON.stringify(value.saved))
}
say('')

// ================================================= 用例 4：OpenAI 重试
say('=== 用例 4：OpenAI 503 重试 ===')
{
  state.sawOpenAI = null
  state.openaiAttempts = 0
  state.mode = 'openai_retry'
  const t0 = Date.now()
  const { value } = await runTool({
    callMode: 'openai', openaiBaseUrl: `${base}/v1`, openaiModel: 'nai-diffusion-5-full',
    saveImageHistory: false, verbose: false, maxRetries: 2,
  }, { prompt: 'retry test' })
  const elapsed = Date.now() - t0

  check('重试了 2 次', state.openaiAttempts === 2, String(state.openaiAttempts))
  check('退避等待 ≥2 秒', elapsed >= 1900, elapsed + 'ms')
  check('重试后成功拿到图', value.images.length === 1, String(value.images.length))
  state.mode = 'openai'
}
say('')

// ====================================================== 用例 5：额度工具
say('=== 用例 5：额度查询 ===')
{
  const { value } = await runTool({ callMode: 'direct', baseUrl: base, token: 'tok-abc', verbose: false },
    {}, 'nai_quota')
  check('返回 value=123', value.value === 123, JSON.stringify(value))
  check('返回 balance=456', value.balance === 456, String(value.balance))
  check('summary 是人读文本', typeof value.summary === 'string' && value.summary.length > 0, JSON.stringify(value.summary))
}
say('')

// ====================================================== 用例 5b：计费信息
//
// 工具调用行要显示「本次消耗 / 剩余点数」。界面只能读到结果的 ContentBlock，
// 读不到结构化输出值，所以计费必须以带固定前缀的文本行透出。
say('=== 用例 5b：计费行 ===')
{
  // 直连：mock 的提交响应带 cost:1，额度接口返回 balance:456
  const { value } = await runTool({ callMode: 'direct', baseUrl: base, token: 'tok-abc', verbose: false, saveImageHistory: false },
    { prompt: 'billing direct' })
  check('直连结果带 billing 行', typeof value.billing === 'string', JSON.stringify(value.billing))
  check('billing 带固定前缀（界面按它解析）',
    String(value.billing).startsWith('计费: '), String(value.billing))
  check('billing 含本次消耗 = 1（提交响应的 cost）',
    /本次消耗:\s*1\b/.test(String(value.billing)), String(value.billing))
  check('billing 含剩余点数 = 456（额度接口的 balance）',
    /剩余点数:\s*456\b/.test(String(value.billing)), String(value.billing))

  // 计费行必须出现在 render 产出的文本块里，且能被界面解析
  const ctx2 = makeCtx()
  mod.apply(ctx2, { callMode: 'direct', baseUrl: base, token: 'tok-abc', verbose: false, saveImageHistory: false })
  const genDef = ctx2.registered.find((d) => d.name === 'nai_generate_image')
  const blocks = genDef.output.render({}, value)
  const text = blocks.find((b) => b.type === 'text')
  check('计费行进入结果文本块', text !== undefined && text.text.includes('计费: '), JSON.stringify(text?.text?.slice(-80)))

  // OpenAI 通道没有计费信息 → 整行不出现
  const openai = await runTool({
    callMode: 'openai',
    openaiBaseUrl: `${base}/v1`,
    openaiApiKey: 'sk-test',
    verbose: false,
    saveImageHistory: false,
  }, { prompt: 'billing openai' })
  check('OpenAI 通道不带 billing（该通道无计费信息）',
    openai.value.billing === undefined, JSON.stringify(openai.value.billing))
}
say('')

// ================================================== 用例 6：失败路径
say('=== 用例 6：失败与边界 ===')
{
  // 缺 token
  const ctx = makeCtx()
  mod.apply(ctx, { callMode: 'direct', baseUrl: base, token: '', verbose: false, saveImageHistory: false })
  const def = ctx.registered.find((d) => d.name === 'nai_generate_image')
  let msg = ''
  try { await def.execute({ prompt: 'x' }, { signal: new AbortController().signal }) } catch (e) { msg = e.message }
  check('缺 token 时报可操作错误', /Token/.test(msg), msg)

  // 空提示词
  let msg2 = ''
  try { await def.execute({ prompt: '   ' }, { signal: new AbortController().signal }) } catch (e) { msg2 = e.message }
  check('空提示词被拒', /prompt 不能为空/.test(msg2), msg2)

  // 上游 500
  const ctx3 = makeCtx()
  mod.apply(ctx3, { callMode: 'direct', baseUrl: `${base}/boom`, token: 't', verbose: false, saveImageHistory: false })
  const def3 = ctx3.registered.find((d) => d.name === 'nai_generate_image')
  let msg3 = ''
  try { await def3.execute({ prompt: 'x' }, { signal: new AbortController().signal }) } catch (e) { msg3 = e.message }
  check('上游 4xx 报明确原因', /http_4xx|404/.test(msg3), msg3)

  // 非法 callMode
  const ctx4 = makeCtx()
  mod.apply(ctx4, { callMode: 'bogus' })
  check('非法 callMode 不注册工具', ctx4.registered.length === 0, String(ctx4.registered.length))

  // 上游返回的不是图片：不应伪装成 image block
  const s3 = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname === '/api/web/jobs') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"j9"}'); return }
    if (u.pathname === '/api/jobs/j9') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"done","imageUrl":"/img"}'); return }
    if (u.pathname === '/img') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('this is definitely not a png')); return }
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => s3.listen(0, '127.0.0.1', r))
  const base3 = `http://127.0.0.1:${s3.address().port}`
  const ctx5 = makeCtx()
  mod.apply(ctx5, { callMode: 'direct', baseUrl: base3, token: 't', verbose: false, saveImageHistory: false })
  const def5 = ctx5.registered.find((d) => d.name === 'nai_generate_image')
  const badValue = await def5.execute({ prompt: 'not an image' }, { signal: new AbortController().signal })
  check('非图片字节不产生 image block', badValue.images.length === 0, JSON.stringify(badValue.images))
  check('非图片字节如实报告', /无法识别的图片格式/.test(badValue.summary), badValue.summary.split('\n').slice(-2).join(' | '))
  check('并提示模型看不到画面', /你看不到画面内容/.test(badValue.summary), 'ok')
  const badBlocks = def5.output.render({}, badValue)
  check('render 只有 text，没有伪 image', badBlocks.every((b) => b.type === 'text'), badBlocks.map((b) => b.type).join('+'))
  s3.close()
}
say('')

// ============================================== 用例 7：参数覆盖与收敛
say('=== 用例 7：单次参数覆盖 ===')
{
  state.sawSubmit = null
  // 配置里写死 imageStyle='vertical'；调用方硬塞 style='anime' 必须被无视。
  await runTool({ callMode: 'direct', baseUrl: base, token: 't', verbose: false, saveImageHistory: false, steps: 28, imageStyle: 'vertical' },
    { prompt: 'override', steps: 999, scale: 99, count: 99, style: 'anime', size: '横图' })
  const b = state.sawSubmit.body
  check('steps 被夹到 50', b.steps === 50, String(b.steps))
  check('scale 被夹到 20', b.scale === 20, String(b.scale))
  check('size 覆盖为横图', b.size === '横图', b.size)
  check('调用参数里的 style 被无视（画风只认配置）',
    !/asanagi/.test(b.artist), b.artist.slice(0, 40) + '...')
}

// 反向确认：配置换成 anime，artist 才跟着变 —— 证明画风确实由配置驱动
{
  state.sawSubmit = null
  await runTool({ callMode: 'direct', baseUrl: base, token: 't', verbose: false, saveImageHistory: false, imageStyle: 'anime' },
    { prompt: 'config drives style' })
  const b = state.sawSubmit.body
  check('配置 imageStyle=anime 时 artist 变为 asanagi', /asanagi/.test(b.artist), b.artist.slice(0, 40) + '...')
}
say('')

// --------------------------------------------------------------- 收尾
server.close()
rmSync(historyDir, { recursive: true, force: true })

say(`\nFAILURES: ${failures}`)
writeFileSync(join(PROBE, 'e2e.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
