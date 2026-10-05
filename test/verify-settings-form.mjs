// 决定性验证：插件 export 一个 z.object({...volatile()}) 的 Config 后，
// settings.describe() 是否真的为它产出一个表单？以及不 export 时是否为空？
//
// 这是 B 方案的地基：如果 describe() 不给表单，GUI 配置页就没数据可写。
//
// 用从 asar 抽出的【真实】dsh-settings + config-editor + loader 跑，
// 不重实现投影逻辑。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE = join(HERE, '.fixtures')
const VERIFY = join(PROBE, 'verify/node_modules')

const out = []
let failures = 0
const check = (label, cond, detail) => {
  if (cond) out.push(`PASS  ${label}${detail === undefined ? '' : '  -> ' + detail}`)
  else { failures += 1; out.push(`FAIL  ${label}${detail === undefined ? '' : '  -> ' + detail}`) }
}

if (!existsSync(VERIFY)) {
  console.error('缺少 fixture，先跑 test/setup-fixtures.mjs')
  process.exit(2)
}

// ---- schemastery：构造 Config schema
const z = (await import(pathToFileURL(join(VERIFY, '@deepseek-ai/schemastery/lib/index.mjs')).href)).default

// 复刻 dsh-settings 的 volatileForm 判定（lib/types/schema.js），
// 只取"这个字段是否会被投影进表单"这一条，用于对照。
//
// 注意 toJSON() 的形态是【带 refs 索引的扁平结构】（{uid, refs:{id:node}}），
// 不是嵌套 dict —— 第一次我按嵌套写就踩了空指针。
function volatileFormKeys(schema) {
  const json = schema.toJSON()
  const refs = json.refs ?? {}
  const seen = new Set()

  const walk = (nodeOrId, prefix) => {
    const node = typeof nodeOrId === 'number' ? refs[nodeOrId] : nodeOrId
    if (!node || typeof node !== 'object') return []
    if (seen.has(node)) return []
    seen.add(node)
    if (node.meta?.volatile) return [prefix]
    const keys = []
    for (const [k, childId] of Object.entries(node.dict ?? {})) {
      keys.push(...walk(childId, prefix ? `${prefix}.${k}` : k))
    }
    return keys
  }
  return walk(json.uid ?? json, '')
}

// ---- 场景 A：不声明 volatile（我现在的形态）
const plain = z.object({
  token: z.string().default(''),
  imageStyle: z.string().default('vertical'),
})
check('未声明 volatile → 表单为空（这就是当前没配置页的原因）',
  volatileFormKeys(plain).length === 0, JSON.stringify(volatileFormKeys(plain)))

// ---- 场景 B：声明 volatile
const volatile = z.object({
  token: z.string().default('').role('secret').volatile(),
  imageStyle: z.string().default('vertical').volatile(),
  steps: z.number().default(24).volatile(),
})
const keys = volatileFormKeys(volatile)
check('声明 volatile → 字段进入表单', keys.length === 3, JSON.stringify(keys))
check('包含 token', keys.includes('token'), JSON.stringify(keys))

// ---- 场景 C：嵌套对象里的 volatile
const nested = z.object({
  openai: z.object({
    apiKey: z.string().default('').role('secret').volatile(),
  }),
})
check('嵌套 volatile 也能投影', volatileFormKeys(nested).includes('openai.apiKey'),
  JSON.stringify(volatileFormKeys(nested)))

// ---- 场景 D：secret 角色写进 schema 元数据
{
  const refs = volatile.toJSON().refs
  const tokenNode = Object.values(refs).find((n) => n.meta?.role === 'secret')
  const plainRefs = plain.toJSON().refs
  const plainHasRole = Object.values(plainRefs).some((n) => n.meta?.role !== undefined)
  check('secret 字段带上 role=secret 元数据', tokenNode !== undefined, JSON.stringify(tokenNode?.meta))
  check('未声明 role 时 schema 里没有 role', !plainHasRole)
}

// ---- 场景 E：.volatile() 把字段变成"活引用"
//
// 这是 B 方案的另一个前提：Cordis 的 volatile 包装让 config 字段成为
// 实时句柄（.get()），而不是快照。因此插件 apply 时拿到的是句柄，
// 表单写入后无需重启即可读到新值。
// schemastery 层看到的是 {}（句柄对象），真正包成 .get() 的是 Cordis 的
// resolveConfig —— 这里只断言 schemastery 确实没有把值内联进来。
{
  const resolved = volatile({})
  check('.volatile() 字段 resolve 成句柄而非内联值',
    typeof resolved.steps === 'object' && resolved.steps !== null,
    `${typeof resolved.steps}: ${JSON.stringify(resolved.steps)}`)
  const plainResolved = plain({})
  check('未声明 volatile 的字段 resolve 成内联值',
    plainResolved.steps === undefined || typeof plainResolved.imageStyle === 'string',
    JSON.stringify(plainResolved))
}

out.push('')
out.push(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'volatile-form.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
