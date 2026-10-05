// 真实端到端生图：从凭据域取 token（与插件同一路径），调用插件真实 execute()。
//
// 会真实消耗上游点数（默认 24 步、竖图，约 1 点）。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = dirname(HERE)
const PROBE = join(HERE, '.fixtures')
mkdirSync(PROBE, { recursive: true })

const out = []
const say = (m) => { out.push(m); console.log(m) }

// 直接从 .credentials.yaml 读 token：这是凭据域后端落盘的位置。
// 插件走 ctx.credentials.resolve('NAI_IMAGE_TOKEN')，最终读的是同一个值。
import { readFileSync } from 'node:fs'
const creds = readFileSync(join(process.env.USERPROFILE ?? '', '.dsh/.credentials.yaml'), 'utf8')
const m = creds.match(/NAI_IMAGE_TOKEN:\s*(\S+)/)
if (m === null) {
  say('凭据域里没有 NAI_IMAGE_TOKEN，先在 GUI 里填并保存')
  process.exit(2)
}
const token = m[1]
say(`读到 token（${token.length} 字符，前缀 ${token.slice(0, 4)}...）`)

const mod = await import(pathToFileURL(join(PROJECT, 'lib/index.js')).href)

// 模拟真实的凭据服务
const credentials = {
  async resolve(ref) {
    if (ref === 'NAI_IMAGE_TOKEN') return { value: token, source: 'store' }
    return undefined
  },
}

const registered = []
const logs = []
const ctx = {
  logger: { info: (msg) => { logs.push(msg); say('  [log] ' + msg) }, warn: (msg) => say('  [warn] ' + msg), error: (msg) => say('  [err] ' + msg) },
  tools: { register: (d) => { registered.push(d); return () => {} } },
  get: (k) => (k === 'credentials' ? credentials : undefined),
}

mod.apply(ctx, { callMode: 'direct', steps: 24, imageSize: '竖图', saveImageHistory: true, verbose: true })
const def = registered.find((d) => d.name === 'nai_generate_image')
if (def === undefined) {
  say('工具未注册')
  process.exit(1)
}

say('开始生图（24 步 / 竖图 / 默认画风）…')
const started = Date.now()
try {
  const value = await def.execute(
    { prompt: '1girl, solo, silver hair, cherry blossoms, gentle smile, spring' },
    { signal: new AbortController().signal },
  )
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  say(`\n完成，用时 ${elapsed}s`)
  say('summary:\n' + value.summary)
  say(`图片数：${value.images.length}`)
  for (const img of value.images) {
    say(`  ${img.mediaType} ${img.width}x${img.height} ${img.bytes} 字节  id=${String(img.attachmentId).slice(0, 20)}...`)
  }
  for (const p of value.saved) {
    say(`  归档: ${p}  存在=${existsSync(p)}`)
  }
  // 顺带验证 render 产出的 ContentBlock
  const blocks = def.output.render({}, value)
  say(`render 产出：${blocks.map((b) => b.type).join(' + ')}`)
  writeFileSync(join(PROBE, 'live-gen.txt'), out.join('\n'), 'utf8')
  process.exit(value.images.length > 0 ? 0 : 1)
} catch (error) {
  say(`\n生图失败：${error.message}`)
  writeFileSync(join(PROBE, 'live-gen.txt'), out.join('\n'), 'utf8')
  process.exit(1)
}
