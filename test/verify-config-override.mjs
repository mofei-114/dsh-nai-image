// 验证「只覆盖 token」是否安全。
//
// 背景：Loader 的补丁语义是【整体替换】而非深合并（见 applyEntryPatches：
// 对 patch 里除 id/insert/name 外的每个键直接 target[key] = value）。
// 因此用户写 `- id: dsh-nai-image` + `config: {token: x}` 之后，最终 config
// 就只剩 {token: x}，其余键全部消失。
//
// 这种覆盖是否安全，取决于一个不变式：
//   bundle patch 里写的每个值  ==  lib/config.js 对同一键的默认值
// 只要成立，「只写 token」与「写全 + 改 token」结果完全相同，
// 用户就不必抄一长串配置。
//
// 用法： node test/verify-config-override.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 本文件所在目录（test/）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件项目根。 */
const PROJECT = dirname(HERE)
/** fixture 与产物目录。 */
const PROBE = join(HERE, '.fixtures')
mkdirSync(PROBE, { recursive: true })

const out = []
let failures = 0
const check = (label, cond, detail) => {
  if (cond) out.push(`PASS  ${label}${detail === undefined ? '' : '  -> ' + detail}`)
  else { failures += 1; out.push(`FAIL  ${label}${detail === undefined ? '' : '  -> ' + detail}`) }
}

// ---- 读 bundle patch 里的 config（用真实 YAML dialect）
const verify = join(PROBE, 'verify/node_modules/js-yaml/index.js')
if (!(await import('node:fs')).existsSync(verify)) {
  console.error('缺少 fixture，先跑 node test/setup-fixtures.mjs')
  process.exit(2)
}
const yaml = await import(pathToFileURL(verify).href)
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (d) => typeof d === 'string',
  construct: (d) => ({ __jsExpr: d }),
  predicate: (v) => !!v && typeof v === 'object' && '__jsExpr' in v,
  represent: (d) => d.__jsExpr,
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)

const manifest = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf8'))
const patchRel = manifest.dsh.bundle.patch
const patchPath = join(PROJECT, patchRel)
const patch = yaml.load(readFileSync(patchPath, 'utf8'), { schema })
const bundleConfig = patch[0].insert[0].config

const config = await import(pathToFileURL(join(PROJECT, 'lib/config.js')).href)
const { resolveConfig } = config

// ---- 1) 不变式：patch 里的值 == 代码默认值
out.push('=== 不变式：bundle patch 的值 == resolveConfig 的默认值 ===')
const defaults = resolveConfig({})
const mismatches = []
for (const [key, value] of Object.entries(bundleConfig)) {
  if (!Object.hasOwn(defaults, key)) {
    mismatches.push(`${key}: patch 里有但 resolveConfig 不产出该键`)
    continue
  }
  const fromPatch = resolveConfig(bundleConfig)[key]
  const fromEmpty = defaults[key]
  if (fromPatch !== fromEmpty) {
    mismatches.push(`${key}: patch→${JSON.stringify(fromPatch)} 默认→${JSON.stringify(fromEmpty)}`)
  }
}
if (mismatches.length === 0) {
  out.push(`PASS  ${Object.keys(bundleConfig).length} 个配置项的值与代码默认值一致`)
} else {
  failures += 1
  out.push('FAIL  以下项不一致（用户「只写 token」会改变这些行为）：')
  for (const m of mismatches) out.push('        ' + m)
}
out.push('')

// ---- 2) 只写 token 的覆盖结果 == 写全并改 token
out.push('=== 覆盖语义：整体替换下只写 token 是否安全 ===')

/** 复刻 applyEntryPatches 的语义（cordis-plugin-include/lib/index.js）。
 *  对 patch 里除 id/insert/name 外的键，直接整份替换到目标条目上。 */
function applyPatches(entries, patches) {
  const data = structuredClone(entries)
  const byId = new Map(data.map((e) => [e.id, e]))
  for (const p of patches) {
    const { id, insert, name, ...overrides } = p
    if (insert) { data.push(...insert); for (const e of insert) if (e.id) byId.set(e.id, e); continue }
    const target = byId.get(id)
    if (!target) continue
    if (name && name !== target.name) continue
    for (const [k, v] of Object.entries(overrides)) { if (k !== 'id') target[k] = v }
  }
  return data
}

const CHOSEN_TOKEN = 'tok-from-user'

// 场景 A：bundle 层 + 用户只写 token（config 被整体替换成 {token}）
const onlyToken = applyPatches(
  [{ id: 'dsh-nai-image', name: './lib/index.js', config: structuredClone(bundleConfig) }],
  [{ id: 'dsh-nai-image', config: { token: CHOSEN_TOKEN } }],
)[0].config

// 场景 B：用户写全所有项并改 token
const fullCopy = applyPatches(
  [{ id: 'dsh-nai-image', name: './lib/index.js', config: structuredClone(bundleConfig) }],
  [{ id: 'dsh-nai-image', config: { ...structuredClone(bundleConfig), token: CHOSEN_TOKEN } }],
)[0].config

check('场景 A 的 config 确实只剩 token（整体替换语义）',
  Object.keys(onlyToken).length === 1 && onlyToken.token === CHOSEN_TOKEN,
  JSON.stringify(onlyToken))

const a = resolveConfig(onlyToken)
const b = resolveConfig(fullCopy)

const diffs = []
for (const key of Object.keys(b)) {
  if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
    diffs.push(`${key}: A=${JSON.stringify(a[key])} B=${JSON.stringify(b[key])}`)
  }
}
if (diffs.length === 0) {
  out.push('PASS  只写 token 与写全的效果完全相同（默认值兜住了其余项）')
} else {
  failures += 1
  out.push('FAIL  两种写法效果不同：')
  for (const d of diffs) out.push('        ' + d)
}
check('token 确实生效', a.token === CHOSEN_TOKEN && b.token === CHOSEN_TOKEN, a.token)
out.push('')

// ---- 3) 覆盖能被解析（不会因缺项报错）
out.push('=== 覆盖后配置合法（不触发词表报错）===')
try {
  resolveConfig(onlyToken)
  out.push('PASS  resolveConfig 接受只写 token 的配置')
} catch (error) {
  failures += 1
  out.push(`FAIL  resolveConfig 拒绝: ${error.message}`)
}
// 反向确认：写错词表仍然报错（不是被兜底吞掉）
try {
  resolveConfig({ imageStyle: '不存在的画风' })
  failures += 1
  out.push('FAIL  imageStyle 写错却没报错')
} catch {
  out.push('PASS  imageStyle 写错仍会报错（词表校验没被削弱）')
}
out.push('')

// ---- 4) 打印给用户抄的最小覆盖片段
out.push('=== 最小覆盖片段（供 README 引用）===')
out.push('- id: dsh-nai-image')
out.push('  config:')
out.push(`    token: '你的 token'`)
out.push('')

out.push(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'verify-config-override.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
