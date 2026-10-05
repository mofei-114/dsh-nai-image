// 配置健壮性：各种畸形/边界配置下 apply() 不应崩溃，且开关生效。
import { dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件所在目录（test/）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件项目根。 */
const PROJECT = dirname(HERE)
/** 测试用的 fixture 与产物目录（首次运行由 setup-fixtures.mjs 建立）。 */
const PROBE = joinPath(HERE, '.fixtures')
mkdirSync(PROBE, { recursive: true })

import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PLUGIN = joinPath(PROJECT, 'lib/index.js')
const mod = await import(pathToFileURL(PLUGIN).href)

const out = []
let failures = 0

function run(label, config, expectCount, expectThrow = false) {
  const regs = []
  const errors = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    tools: { register: (d) => { regs.push(d); return () => {} } },
    get: () => undefined,
  }
  let threw = null
  try { mod.apply(ctx, config) } catch (e) { threw = e }
  const ok = !expectThrow && threw === null && regs.length === expectCount && errors.length === 0
  const okInvalid = expectThrow && threw === null && errors.length === 1 && regs.length === 0
  if (ok || okInvalid) {
    out.push(`PASS  ${label}  -> tools=${regs.length} errors=${errors.length}`)
  } else {
    failures += 1
    out.push(`FAIL  ${label}  -> tools=${regs.length} errors=${errors.length} threw=${threw ? threw.message : 'no'}`)
  }
}

// 默认配置：token 为空但工具照样注册（错误推迟到调用时给可操作提示）
{
  const regs = []
  const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} }, tools: { register: (d) => { regs.push(d); return () => {} } }, get: () => undefined }
  mod.apply(ctx, undefined)
  if (regs.length === 2) out.push('PASS  无 config 也能注册（错误推迟到调用时）  -> tools=2')
  else { failures += 1; out.push(`FAIL  无 config 时 tools=${regs.length}`) }
}

run('空对象', {}, 2)
run('enableTool=false', { enableTool: false, enableQuotaTool: true }, 1)
run('enableQuotaTool=false', { enableTool: true, enableQuotaTool: false }, 1)
run('两个开关都关', { enableTool: false, enableQuotaTool: false }, 0)
run('callMode 非法 → 不注册', { callMode: 'bogus' }, 0, true)
run('callMode 为数字 → 不注册', { callMode: 42 }, 0, true)
run('callMode 大小写不匹配 → 不注册', { callMode: 'DIRECT' }, 0, true)

// 数值边界：各种垃圾值都不应崩
run('steps 为字符串', { steps: 'abc' }, 2)
run('steps 为 null', { steps: null }, 2)
run('steps 为对象', { steps: { a: 1 } }, 2)
run('steps 万亿', { steps: 1e12 }, 2)
run('steps 负', { steps: -99 }, 2)
run('scale Infinity', { scale: Number.POSITIVE_INFINITY }, 2)
run('cfg 越界', { cfg: 99 }, 2)
run('cfg 负', { cfg: -99 }, 2)
run('requestTimeout 极小', { requestTimeout: 0 }, 2)
run('requestTimeout 极大', { requestTimeout: 1e9 }, 2)
run('maxRetries 越界', { maxRetries: 99 }, 2)
run('maxRetries 负', { maxRetries: -5 }, 2)
run('imageHistoryLimit 负', { imageHistoryLimit: -1 }, 2)
run('defaultCount 0', { defaultCount: 0 }, 2)
run('defaultCount 999', { defaultCount: 999 }, 2)
run('seed 极大', { seed: 1e30 }, 2)
run('boolean 用字符串', { enableTool: 'false', enableQuotaTool: 'true' }, 2)  // 非 bool → 回退默认 true

// 字符串边界：自由文本类型不对 → 报错停用（避免 12345 被当成地址）
run('baseUrl 非字符串', { baseUrl: 12345 }, 0, true)
run('baseUrl 空串', { baseUrl: '' }, 2)
run('token 非字符串', { token: 999 }, 0, true)
run('negative 空串', { negative: '' }, 2)
run('imageHistoryDir 非字符串', { imageHistoryDir: 42 }, 0, true)
run('openaiBaseUrl 非字符串', { openaiBaseUrl: 42 }, 0, true)

// 闭合词表：写错必须报错，不能静默换成默认值
run('callMode 为数字 → 报错', { callMode: 42 }, 0, true)
run('imageStyle 非法 → 报错', { imageStyle: 'nope' }, 0, true)
run('imageSize 非法 → 报错', { imageSize: 'nope' }, 0, true)
run('sampler 非法 → 报错', { sampler: 'nope' }, 0, true)
run('noiseSchedule 非法 → 报错', { noiseSchedule: 'nope' }, 0, true)

// 但未配置（undefined/null/空白）仍走默认值
run('imageStyle 未配置', { imageStyle: undefined }, 2)
run('imageStyle 空白串', { imageStyle: '   ' }, 2)
run('sampler 未配置', { sampler: null }, 2)

// 词表的中文别名与合法值应当通过
run('imageStyle 中文别名', { imageStyle: '本子里番风' }, 2)
run('imageSize 像素写法', { imageSize: '832x1216' }, 2)
run('imageSize 英文别名', { imageSize: 'portrait' }, 2)
run('sampler 合法值', { sampler: 'k_euler' }, 2)

// 自由文本仍允许自定义
run('customArtists 非字符串 → 报错', { customArtists: 42 }, 0, true)
run('baseUrl 自定义 URL', { baseUrl: 'https://example.com' }, 2)

// tools.register 抛错时的行为（真实注册表会因重名/保留名而抛）
{
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: () => { throw new Error('tool name "run_code" is reserved') } },
    get: () => undefined,
  }
  let threw = null
  try { mod.apply(ctx, {}) } catch (e) { threw = e }
  if (threw !== null) out.push('PASS  注册失败时异常向上抛出（不静默吞掉）  -> ' + threw.message)
  else { failures += 1; out.push('FAIL  注册失败被静默吞掉') }
}

out.push(`\nFAILURES: ${failures}`)
writeFileSync(PROBE + '/config-robust.txt', out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
