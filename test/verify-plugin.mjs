// 用【真实】DSH 校验器验证插件注册结果：schema 合法性、参数校验、工具返回值、render 产物。
//
// 前置： node test/setup-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 本文件所在目录（test/）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件项目根。 */
const PROJECT = dirname(HERE)
/** fixture 与产物目录。 */
const PROBE = join(HERE, '.fixtures')
mkdirSync(PROBE, { recursive: true })

const VERIFY = join(PROBE, 'verify')
const PLUGIN = join(PROJECT, 'lib', 'index.js')

const out = []
const say = (m) => out.push(m)
let failures = 0

const check = (label, fn) => {
  try {
    const r = fn()
    say(`PASS  ${label}${r === undefined ? '' : '  -> ' + r}`)
  } catch (error) {
    failures += 1
    say(`FAIL  ${label}\n      ${error?.message ?? String(error)}`)
  }
}

const toolsUrl = pathToFileURL(join(VERIFY, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href
let tools
try {
  tools = await import(toolsUrl)
} catch (error) {
  console.error('无法导入真实 dsh-tools：' + error.message)
  console.error('请先运行： node test/setup-fixtures.mjs')
  process.exit(2)
}

const mod = await import(pathToFileURL(PLUGIN).href)
say(`插件：name=${mod.name}  inject=${JSON.stringify(mod.inject)}\n`)

const registered = []
const stubCtx = {
  logger: { info: (m) => say('  [log] ' + m), warn: (m) => say('  [warn] ' + m), error: (m) => say('  [error] ' + m) },
  tools: { register: (def) => { registered.push(def); return () => {} } },
  get: () => undefined,
}

check('apply() 注册两个工具', () => {
  mod.apply(stubCtx, { callMode: 'direct', token: 'dummy-token-for-schema-check' })
  if (registered.length !== 2) throw new Error(`期望 2 个工具，实际 ${registered.length}`)
  return registered.map((d) => d.name).join(', ')
})
say('')

for (const def of registered) {
  say(`--- ${def.name} ---`)

  check(`${def.name}: output 形态 { schema, render }`, () => {
    if (def.output === undefined || typeof def.output.render !== 'function') throw new Error('output 不符合 { schema, render }')
    return 'ok'
  })

  check(`${def.name}: parameters 通过 assertSupportedJsonSchema`, () => {
    tools.assertSupportedJsonSchema(def.parameters)
    return '通过'
  })

  check(`${def.name}: output.schema 通过 assertSupportedJsonSchema`, () => {
    tools.assertSupportedJsonSchema(def.output.schema)
    return '通过'
  })

  // def.parameters 已是编译好的 raw JSON Schema，因此用 validateJsonSchemaValue，
  // 而不是收 author spec 的 validateArgs。
  check(`${def.name}: 合法参数通过校验`, () => {
    const args = def.name === 'nai_generate_image'
      ? { prompt: 'a cat', size: '竖图', steps: 28, scale: 6, seed: -1, count: 2 }
      : {}
    const v = tools.validateJsonSchemaValue(def.parameters, args, 'parameters')
    if (v.length > 0) throw new Error('合法参数被拒: ' + v.join('; '))
    return 'violations=0'
  })

  // 画风不可传参：schema 里不能有 style，且因为 additionalProperties:false，
  // 调用了 style 会被判为非法参数。
  if (def.name === 'nai_generate_image') {
    check('参数表里没有 style（画风只认配置）', () => {
      if (def.parameters.properties.style !== undefined) {
        throw new Error('style 仍在参数表里: ' + JSON.stringify(Object.keys(def.parameters.properties)))
      }
      return JSON.stringify(Object.keys(def.parameters.properties))
    })
    check('传 style 会被 schema 拒绝', () => {
      const v = tools.validateJsonSchemaValue(def.parameters, { prompt: 'a', style: 'anime' }, 'parameters')
      if (v.length === 0) throw new Error('style 被接受了（本应因 additionalProperties:false 被拒）')
      return 'violations=' + v.length
    })
  }

  check(`${def.name}: 非法参数被拒`, () => {
    const args = def.name === 'nai_generate_image' ? {} : { nope: 1 }
    const v = tools.validateJsonSchemaValue(def.parameters, args, 'parameters')
    if (v.length === 0) throw new Error('非法参数未被拒')
    return 'violations=' + v.length
  })

  check(`${def.name}: 返回值满足 output.schema 且 render 产出合法 ContentBlock[]`, () => {
    const value = def.name === 'nai_generate_image'
      ? {
        images: [{ attachmentId: 'sha256:abcd', mediaType: 'image/png', bytes: 10, width: 4, height: 4, name: 'a.png' }],
        saved: ['C:/tmp/a.png'],
        summary: 'done',
      }
      : { summary: 'ok', value: 1 }
    const violations = tools.validateJsonSchemaValue(def.output.schema, value, 'value')
    if (violations.length > 0) throw new Error('返回值不符合 output.schema: ' + violations.join('; '))
    const blocks = def.output.render({}, value)
    if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('render 未返回非空数组')
    if (def.name === 'nai_generate_image' && blocks.filter((b) => b.type === 'image').length !== 1) {
      throw new Error('期望恰好 1 个 image block')
    }
    return blocks.map((b) => b.type).join('+')
  })

  say('')
}

say(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'verify-plugin.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
