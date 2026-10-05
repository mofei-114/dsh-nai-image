// 对抗性参数测试：插件手写 definition，DSH 分发层不做参数校验
// （defineTool 才在自己的闭包里 validate），因此 execute 必须自己扛住垃圾输入。
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
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PLUGIN = joinPath(PROJECT, 'lib/index.js')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64')

let lastBody = null
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/api/web/jobs') {
      try { lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { lastBody = null }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"j"}'); return
    }
    if (p === '/api/jobs/j') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"done","imageUrl":"/i"}'); return }
    if (p === '/i') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return }
    res.writeHead(404); res.end('{}')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const mod = await import(pathToFileURL(PLUGIN).href)
const out = []
let failures = 0

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  get: () => undefined,
}
const ctx2 = { ...ctx, get: () => undefined }
const regs = []
ctx2.tools = { register: (d) => { regs.push(d); return () => {} } }
mod.apply(ctx2, { callMode: 'direct', baseUrl: base, token: 't', verbose: false, saveImageHistory: false })
const def = regs.find((d) => d.name === 'nai_generate_image')

async function attempt(label, args, expect) {
  lastBody = null
  try {
    const v = await def.execute(args, { signal: new AbortController().signal })
    const ok = expect === 'ok'
    if (!ok) { failures += 1; out.push(`FAIL  ${label}：预期被拒但成功了（${JSON.stringify(v.summary).slice(0, 60)}）`) }
    else out.push(`PASS  ${label}  -> steps=${lastBody?.steps} scale=${lastBody?.scale} size=${lastBody?.size}`)
  } catch (error) {
    if (expect === 'throw') out.push(`PASS  ${label}  -> 抛出: ${error.message}`)
    else { failures += 1; out.push(`FAIL  ${label}：预期成功但抛错: ${error.message}`) }
  }
}

// --- 必填缺失 / 类型错误
await attempt('无参数对象', undefined, 'throw')
await attempt('空对象', {}, 'throw')
await attempt('prompt 为数字', { prompt: 123 }, 'throw')
await attempt('prompt 为 null', { prompt: null }, 'throw')
await attempt('prompt 为对象', { prompt: {} }, 'throw')
await attempt('prompt 全空白', { prompt: '   \t\n ' }, 'throw')
await attempt('prompt 超长', { prompt: 'x'.repeat(4001) }, 'throw')

// --- 数值参数是垃圾：应回退默认而不是崩
await attempt('steps 为字符串', { prompt: 'a', steps: 'abc' }, 'ok')
await attempt('steps 为 NaN', { prompt: 'a', steps: Number.NaN }, 'ok')
await attempt('steps 为 Infinity', { prompt: 'a', steps: Number.POSITIVE_INFINITY }, 'ok')
await attempt('steps 为对象', { prompt: 'a', steps: {} }, 'ok')
await attempt('steps 为数组', { prompt: 'a', steps: [1, 2] }, 'ok')
await attempt('steps 负值', { prompt: 'a', steps: -5 }, 'ok')
await attempt('steps 极大', { prompt: 'a', steps: 1e9 }, 'ok')
await attempt('scale 为字符串', { prompt: 'a', scale: 'huge' }, 'ok')
await attempt('scale 负值', { prompt: 'a', scale: -100 }, 'ok')
await attempt('count 为小数', { prompt: 'a', count: 2.9 }, 'ok')
await attempt('count 极大', { prompt: 'a', count: 1e9 }, 'ok')
await attempt('seed 为字符串', { prompt: 'a', seed: 'nope' }, 'ok')
await attempt('seed 负值', { prompt: 'a', seed: -5 }, 'ok')

// --- 字符串参数是垃圾
// style 已不是工具参数：传什么都应被静默无视（不报错、不影响画风）。
await attempt('style 不认识（应被忽略）', { prompt: 'a', style: '不存在的画风' }, 'ok')
await attempt('style 为空串（应被忽略）', { prompt: 'a', style: '' }, 'ok')
await attempt('style 为对象（应被忽略）', { prompt: 'a', style: { nested: true } }, 'ok')
await attempt('size 不认识', { prompt: 'a', size: '巨图' }, 'ok')
await attempt('size 为数字', { prompt: 'a', size: 12345 }, 'ok')
await attempt('negative 为数字', { prompt: 'a', negative: 999 }, 'ok')
await attempt('未知多余字段', { prompt: 'a', bogusField: { deep: [1, 2] } }, 'ok')

// --- 参数劫持尝试
await attempt('prompt 带模板注入', { prompt: '${process.exit(1)}' }, 'ok')
await attempt('prompt 带换行', { prompt: 'line1\nline2' }, 'ok')
await attempt('原型污染尝试', { prompt: 'a', __proto__: { polluted: true } }, 'ok')

// 校验夹取是否真的生效
lastBody = null
await def.execute({ prompt: 'clamp check', steps: -5, scale: -100, count: 1e9 }, { signal: new AbortController().signal })
const stepOk = lastBody?.steps === 1
const scaleOk = lastBody?.scale === 0
out.push(`${stepOk ? 'PASS' : 'FAIL'}  steps 负值被夹到 1  -> ${lastBody?.steps}`)
out.push(`${scaleOk ? 'PASS' : 'FAIL'}  scale 负值被夹到 0  -> ${lastBody?.scale}`)
if (!stepOk) failures += 1
if (!scaleOk) failures += 1

out.push(`\nFAILURES: ${failures}`)
writeFileSync(PROBE + '/adversarial.txt', out.join('\n'), 'utf8')
console.log(out.join('\n'))
server.close()
process.exit(failures === 0 ? 0 : 1)
