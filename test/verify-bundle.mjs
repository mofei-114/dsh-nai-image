// 验证插件是否满足 GUI「添加插件」的全部前置条件。
//
// GUI 走的是 plugin-manager 的 inspect + installBundle，本次【不实际安装】，
// 只按它读到的判据逐条核对：spec 解析、package.json 可读、name 存在、
// dsh.bundle 是对象、patch 文件存在且可解析、insert 条目 name 能解析成
// file:// URL、以及最终能真正 import 插件模块。
//
// 用法： node test/verify-bundle.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 本文件所在目录（test/）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件项目根（同时也是候选的 bundle 包目录）。 */
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

// ---- 复刻 plugin-manager 的 parseInstallSpec（只取与本地路径相关的分支）
// 见 dsh-plugin-manager/lib/types/install-spec.js
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i
function parseInstallSpec(raw) {
  const spec = raw.trim()
  if (spec === '') throw new Error('the package spec must not be empty')
  const path = spec.replace(/^(?:file|link):/, '')
  if (path !== spec || isAbsolute(path)) {
    if (!isAbsolute(path)) throw new Error('a local path must be absolute')
    return TARBALL_SPEC.test(path) ? { kind: 'tarball', spec, path } : { kind: 'path', spec, path }
  }
  if (/^\.{1,2}(?:[\\/]|$)/.test(spec)) throw new Error('a local path must be absolute')
  throw new Error('（本测试只校验本地路径分支）')
}

// ---- 1) spec 解析：GUI 要求绝对路径
out.push('=== GUI inspect：spec 解析 ===')
let parsed
check(`项目目录是绝对路径`, isAbsolute(PROJECT), PROJECT)
try {
  parsed = parseInstallSpec(PROJECT)
  check('parseInstallSpec 接受该目录', parsed.kind === 'path', `kind=${parsed.kind}`)
} catch (error) {
  failures += 1
  out.push(`FAIL  parseInstallSpec 拒绝: ${error.message}`)
}
out.push('')

// ---- 2) package.json：GUI 读它判断是不是 bundle
out.push('=== GUI inspect：package.json ===')
const manifestPath = join(PROJECT, 'package.json')
let manifest
check('package.json 存在', existsSync(manifestPath), manifestPath)
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check('package.json 是 JSON 对象', typeof manifest === 'object' && manifest !== null)
} catch (error) {
  failures += 1
  out.push(`FAIL  package.json 解析失败: ${error.message}`)
}

if (manifest) {
  // 复刻 inspectionOf 的 bundle 判定
  const declared = typeof manifest.dsh === 'object' && manifest.dsh !== null ? manifest.dsh : undefined
  const isBundle = declared !== undefined && typeof declared.bundle === 'object' && declared.bundle !== null
  check('声明了 name（GUI 要求）', typeof manifest.name === 'string' && manifest.name.length > 0, manifest.name)
  check('dsh.bundle 是对象 → GUI 认它是组合包', isBundle, JSON.stringify(manifest.dsh?.bundle))
  check('有 description（GUI 卡片展示）', typeof manifest.description === 'string' && manifest.description.length > 0)

  // bundlePatchFiles：patch 必须是字符串或字符串数组
  const patchDecl = declared?.bundle?.patch
  const files = typeof patchDecl === 'string' ? [patchDecl] : patchDecl
  check('dsh.bundle.patch 是字符串或字符串数组',
    Array.isArray(files) && files.length > 0 && files.every((f) => typeof f === 'string'),
    JSON.stringify(patchDecl))

  // patch 文件必须存在（loadOverlayPatches 缺失即抛错）
  for (const file of files ?? []) {
    const abs = join(PROJECT, file)
    check(`patch 文件存在：${file}`, existsSync(abs), abs)
  }
}
out.push('')

// ---- 3) patch 内容：insert 的 name 必须能解析成 file:// URL
out.push('=== 补丁解析与路径锚定 ===')
const patchFile = join(PROJECT, manifest?.dsh?.bundle?.patch ?? 'cordis.patch.yml')
let patchEntries
try {
  // 用真实的 YAML dialect（JSON_SCHEMA + !!js）
  const verify = join(PROBE, 'verify/node_modules/js-yaml/index.js')
  if (!existsSync(verify)) {
    throw new Error('缺少 js-yaml fixture，先跑 node test/setup-fixtures.mjs')
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
  const parsedPatch = yaml.load(readFileSync(patchFile, 'utf8'), { schema })
  check('补丁是顶层数组', Array.isArray(parsedPatch), Array.isArray(parsedPatch) ? `len=${parsedPatch.length}` : typeof parsedPatch)
  patchEntries = parsedPatch?.[0]?.insert
  check('第一条是 insert 列表', Array.isArray(patchEntries), Array.isArray(patchEntries) ? `len=${patchEntries.length}` : typeof patchEntries)
} catch (error) {
  failures += 1
  out.push(`FAIL  补丁解析失败: ${error.message}`)
}

if (Array.isArray(patchEntries)) {
  for (const entry of patchEntries) {
    check(`条目 ${entry.id} 有 id`, typeof entry.id === 'string' && entry.id.length > 0, entry.id)
    // anchorInsertedPluginNames：相对路径以补丁文件所在目录为基准
    const name = entry.name
    const isRel = typeof name === 'string' && (name.startsWith('./') || name.startsWith('../'))
    const isAbs = typeof name === 'string' && isAbsolute(name)
    check(`条目 ${entry.id} 的 name 是可锚定的路径`, isRel || isAbs, name)
    if (isRel) {
      const resolved = resolve(dirname(patchFile), name)
      check(`  → 解析到真实文件`, existsSync(resolved), resolved)
      // Loader 最终会 pathToFileURL 成这个 URL
      check(`  → 可转成 file:// URL`, pathToFileURL(resolved).href.startsWith('file://'), pathToFileURL(resolved).href)
    }
  }
}
out.push('')

// ---- 4) 插件模块真能被 import（GUI 装完要能加载）
out.push('=== 模块可加载性 ===')
try {
  const mod = await import(pathToFileURL(join(PROJECT, 'lib/index.js')).href)
  check('lib/index.js 可 import', true, `name=${mod.name}`)
  check('导出 name 与 package name 一致', mod.name === manifest?.name, `${mod.name} vs ${manifest?.name}`)
  check('导出 inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
  check('导出 apply 是函数', typeof mod.apply === 'function')
} catch (error) {
  failures += 1
  out.push(`FAIL  import 失败: ${error.message}`)
}
out.push('')

// ---- 5) exports 里声明的路径都存在
out.push('=== exports 指向的文件 ===')
if (manifest?.exports) {
  for (const [key, target] of Object.entries(manifest.exports)) {
    const rel = typeof target === 'string' ? target : Object.values(target)[0]
    if (typeof rel !== 'string' || !rel.startsWith('./')) continue
    check(`exports["${key}"] → ${rel}`, existsSync(join(PROJECT, rel)))
  }
}
out.push('')

out.push(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'verify-bundle.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
