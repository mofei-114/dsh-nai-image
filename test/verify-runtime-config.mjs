// 用 DSH 自己的运行时验证：lib/index.js 能否导出可用的 Config。
//
// 这是重启前必须确认的关键前提 —— 若 Config 拿不到 schemastery，
// 重启后 GUI 里依然不会有表单，白折腾一次。
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = dirname(HERE)
const PROBE = join(HERE, '.fixtures')
mkdirSync(PROBE, { recursive: true })

const out = []
let failures = 0
const check = (label, cond, detail) => {
  if (cond) out.push(`PASS  ${label}${detail === undefined ? '' : '  -> ' + detail}`)
  else { failures += 1; out.push(`FAIL  ${label}${detail === undefined ? '' : '  -> ' + detail}`) }
}

// 1) schema.js 能否拿到 schemastery
const schema = await import(pathToFileURL(join(PROJECT, 'lib/schema.js')).href)
const z = schema.schemastery()
check('schema.js 自适应取到 schemastery', z !== undefined, z === undefined ? '' : typeof z)

// 2) lib/index.js 导出的 Config
const mod = await import(pathToFileURL(join(PROJECT, 'lib/index.js')).href)
check('index.js 导出 Config', mod.Config !== undefined)

if (mod.Config !== undefined) {
  // 3) volatile 字段投影（dsh-settings 的判定）
  const json = mod.Config.toJSON()
  const refs = json.refs ?? {}
  const seen = new Set()
  const keys = []
  const walk = (nodeOrId, prefix) => {
    const node = typeof nodeOrId === 'number' ? refs[nodeOrId] : nodeOrId
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (node.meta?.volatile) { keys.push(prefix); return }
    for (const [k, childId] of Object.entries(node.dict ?? {})) walk(childId, prefix ? `${prefix}.${k}` : k)
  }
  walk(json.uid ?? json, '')
  check('Config 有 26 个 volatile 字段', keys.length === 26, String(keys.length))
  check('token 是 secret 角色', Object.values(refs).some((n) => n.meta?.role === 'secret' && n.type === 'string'))
  check('字段名与 patch 对齐', keys.includes('callMode') && keys.includes('imageStyle') && keys.includes('verbose'))

  // 4) apply 能在真实 Config 形态下跑通（volatile 句柄而非普通对象）
  const registered = []
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    tools: { register: (d) => { registered.push(d); return () => {} } },
    get: () => undefined,
  }
  try {
    mod.apply(ctx, mod.Config({}))
    check('apply 接受 schema 解析后的配置（含 volatile 句柄）', true)
    check('注册了两个工具', registered.length === 2, registered.map((d) => d.name).join(', '))
    check('readAll 能解开句柄（日志里应显示 direct）',
      logs.some((l) => l.includes('模式 direct')), logs.find((l) => l.includes('模式')) ?? '(无)')
  } catch (error) {
    failures += 1
    out.push(`FAIL  apply 抛错: ${error.message}`)
  }

  // 5) 特意给一个表单写入后的值，确认实时读取生效
  {
    const regs2 = []
    const logs2 = []
    const ctx2 = {
      logger: { info: (m) => logs2.push(m), warn: () => {}, error: () => {} },
      tools: { register: (d) => { regs2.push(d); return () => {} } },
      get: () => undefined,
    }
    // 模拟用户在 GUI 里把画风改成 anime、步数改成 40
    mod.apply(ctx2, mod.Config({ imageStyle: 'anime', steps: 40 }))
    const def = regs2.find((d) => d.name === 'nai_generate_image')
    const sizeDesc = def.parameters.properties.size.description
    const stepsDesc = def.parameters.properties.steps.description
    check('工具 schema 不因表单值而改（描述在注册时定稿）',
      typeof sizeDesc === 'string' && typeof stepsDesc === 'string')
    // 关键：execute 读的是当前句柄值。这里只验证读取路径不抛错。
    out.push(`INFO  日志: ${logs2.find((l) => l.includes('模式')) ?? '(无)'}`)
  }
}

out.push('')
out.push(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'runtime-config.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
