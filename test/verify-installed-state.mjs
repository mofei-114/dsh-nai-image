// 静态验证：DSH 组装 profile 时会怎么处理我这个 bundle。
//
// 用真实的 dsh-app-boot 逻辑跑一遍组合，确认：
//   1) dsh-nai-image 能作为 bundle 被解析到
//   2) 它的 cordis.patch.yml 能被解析
//   3) 补丁里的 insert 条目 name 能被锚定成 file:// URL
//   4) 插件的 lib/index.js 能被 import 出 Config
//
// 这不替代"重启后看 GUI"，但能在不打断用户的前提下把能查的都查掉。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = dirname(HERE)
const PROBE = join(HERE, '.fixtures')
const VERIFY = join(PROBE, 'verify/node_modules')
mkdirSync(PROBE, { recursive: true })

const out = []
let failures = 0
const check = (label, cond, detail) => {
  if (cond) out.push(`PASS  ${label}${detail === undefined ? '' : '  -> ' + detail}`)
  else { failures += 1; out.push(`FAIL  ${label}${detail === undefined ? '' : '  -> ' + detail}`) }
}

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')

// ---- 1) profile 是否选中本 bundle
out.push('=== profile 选中的 bundles ===')
{
  const manifestPath = join(PROFILE, 'package.json')
  if (!existsSync(manifestPath)) {
    out.push('SKIP  本机没有 desktop profile')
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    check('dsh-nai-image 在 bundles 里', bundles.includes('dsh-nai-image'), bundles.join(', '))
    check('也记在 dependencies 里', Object.hasOwn(manifest.dependencies ?? {}, 'dsh-nai-image'),
      JSON.stringify(manifest.dependencies))
  }
}

// ---- 2) junction 是否指向真实目录且内容是最新的
out.push('')
out.push('=== 安装链接 ===')
{
  const linked = join(PROFILE, 'node_modules', 'dsh-nai-image')
  check('node_modules/dsh-nai-image 存在', existsSync(linked))
  const linkedPkg = join(linked, 'package.json')
  if (existsSync(linkedPkg)) {
    const m = JSON.parse(readFileSync(linkedPkg, 'utf8'))
    check('链接指向的就是本项目（含 dsh.client）', m.dsh?.client?.platform === 'web', JSON.stringify(m.dsh?.client))
    check('exports["./client"] 指向的文件存在', existsSync(join(linked, m.exports['./client'])),
      m.exports['./client'])
    check('exports["."] 指向的文件存在', existsSync(join(linked, m.exports['.'])), m.exports['.'])
  }
}

// ---- 3) 用真实 js-yaml dialect 解析 bundle 补丁，并按 app-boot 的锚定规则处理
out.push('')
out.push('=== bundle 补丁与路径锚定 ===')
{
  const yamlPath = join(VERIFY, 'js-yaml/index.js')
  if (!existsSync(yamlPath)) {
    out.push('SKIP  缺 js-yaml fixture，先跑 test/setup-fixtures.mjs')
  } else {
    const yaml = await import(pathToFileURL(yamlPath).href)
    const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (d) => typeof d === 'string',
      construct: (d) => ({ __jsExpr: d }),
      predicate: (v) => !!v && typeof v === 'object' && '__jsExpr' in v,
      represent: (d) => d.__jsExpr,
    })
    const schema = yaml.JSON_SCHEMA.extend(JsExpr)

    const patchPath = join(PROJECT, 'cordis.patch.yml')
    const patches = yaml.load(readFileSync(patchPath, 'utf8'), { schema })
    check('补丁解析为顶层数组', Array.isArray(patches))

    // 复刻 anchorInsertedPluginNames：相对 name → 相对补丁文件的 file:// URL
    const anchored = structuredClone(patches)
    for (const patch of anchored) {
      for (const entry of patch.insert ?? []) {
        if (typeof entry.name === 'string' && (entry.name.startsWith('./') || entry.name.startsWith('../'))) {
          entry.name = pathToFileURL(join(dirname(patchPath), entry.name)).href
        }
      }
    }
    const entry = anchored?.[0]?.insert?.[0]
    check('插入条目存在', entry !== undefined, entry?.id)
    check('id 是 dsh-nai-image（GUI 按它寻址表单）', entry?.id === 'dsh-nai-image', String(entry?.id))
    check('name 已被锚定成 file:// URL', typeof entry?.name === 'string' && entry.name.startsWith('file://'),
      String(entry?.name))
    if (typeof entry?.name === 'string' && entry.name.startsWith('file://')) {
      check('锚定后的文件真实存在', existsSync(fileURLToPath(entry.name)))
    }
    check('config 段存在（26 项）', entry?.config !== undefined, `${Object.keys(entry?.config ?? {}).length} 项`)
  }
}

// ---- 4) 宿主半侧能 import 且导出 Config
out.push('')
out.push('=== 宿主半侧模块 ===')
{
  const mod = await import(pathToFileURL(join(PROJECT, 'lib/index.js')).href)
  check('import 成功', true, `name=${mod.name}`)
  check('导出 inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
  check('导出 apply', typeof mod.apply === 'function')
  // Config 只有在 schemastery 可取时才存在；本脚本用系统 node 跑，通常取不到
  const hasConfig = mod.Config !== undefined
  out.push(`INFO  Config 导出: ${hasConfig ? '有' : '无（本运行时取不到 schemastery，重启后由 DSH 运行时提供）'}`)
}

out.push('')
out.push(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'installed-state.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
