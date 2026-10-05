// 把 DSH 自身的包从 app.asar 抽出来，供 test/ 里的校验用。
//
// 为什么需要这一步：验证插件注册的 schema 是否合法，唯一权威的判据是
// DSH 自己的 assertSupportedJsonSchema。自己重实现一遍校验器毫无意义
// ——那只是把同一个误解写两遍。所以这里把真实模块抽出来跑。
//
// 用法： node test/setup-fixtures.mjs
// 产物： test/.fixtures/verify/node_modules/@deepseek-ai/*（可随时删除重建）
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, '.fixtures', 'verify')

/** DSH 安装位置：桌面端把全部依赖打进 app.asar。 */
const CANDIDATES = [
  'E:/1/harness/deepseek-harness-zhuomian/resources/app.asar',
  join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar'),
  'C:/Program Files/DeepSeek Harness/resources/app.asar',
]

const ASAR = CANDIDATES.find((p) => p && existsSync(p))
if (!ASAR) {
  console.error('找不到 app.asar。请把它所在的 resources 目录路径加到 CANDIDATES 里。')
  console.error('已尝试：\n  ' + CANDIDATES.join('\n  '))
  process.exit(1)
}
const UNPACKED = join(dirname(ASAR), 'app.asar.unpacked')

// ---- asar 解析： [u32=4][u32=pickleSize] | [u32=4][u32=jsonLen][header] | 数据
const buf = readFileSync(ASAR)
const headerPickleSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
const baseOffset = 8 + headerPickleSize

const files = []
;(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (child.files) walk(child, p)
    else files.push({ path: p, size: child.size, offset: Number(child.offset), unpacked: !!child.unpacked })
  }
})(header, '')

/** asar 内存在的全部包名。 */
const known = new Set(files
  .map((f) => f.path.match(/^dsh\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//))
  .filter(Boolean).map((m) => m[1]))

const readBytes = (f) => {
  if (f.unpacked) return readFileSync(join(UNPACKED, f.path))
  const s = baseOffset + f.offset
  return buf.subarray(s, s + f.size)
}

/** 把一个包整棵抽出。 */
function extract(pkg) {
  const prefix = `dsh/node_modules/${pkg}/`
  const members = files.filter((f) => f.path.startsWith(prefix))
  if (members.length === 0) return false
  for (const f of members) {
    const dest = join(TARGET, 'node_modules', pkg, f.path.slice(prefix.length))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readBytes(f))
  }
  return true
}

const listDir = (dir) => {
  try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

/** 已抽出的包名集合。 */
function installed() {
  const set = new Set()
  const base = join(TARGET, 'node_modules')
  for (const entry of listDir(base)) {
    if (entry.name.startsWith('@')) {
      for (const sub of listDir(join(base, entry.name))) set.add(`${entry.name}/${sub.name}`)
    } else {
      set.add(entry.name)
    }
  }
  return set
}

/** 扫已抽出代码里的裸包名。 */
function scanSpecifiers() {
  const found = new Set()
  const stack = [join(TARGET, 'node_modules')]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of listDir(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue
      let text
      try { text = readFileSync(full, 'utf8') } catch { continue }
      const re = /(?:from\s*|import\s*\(|require\s*\(\s*)["']([^"'.][^"']*)["']/g
      let m
      while ((m = re.exec(text)) !== null) {
        const spec = m[1]
        if (spec.startsWith('node:')) continue
        const parts = spec.split('/')
        found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
      }
    }
  }
  return found
}

// 入口包：只要 dsh-tools 能 import 成功，其余依赖会被逐一补齐
if (!extract('@deepseek-ai/dsh-tools')) {
  console.error('从 asar 里抽不出 @deepseek-ai/dsh-tools —— app.asar 结构可能变了。')
  process.exit(1)
}

for (let round = 1; round <= 25; round += 1) {
  const have = installed()
  const missing = [...scanSpecifiers()].filter((n) => !have.has(n) && known.has(n))
  if (missing.length === 0) break
  for (const pkg of missing) extract(pkg)
}

// 顺带抽出 js-yaml 与 include 插件，供 YAML 方言校验用
extract('js-yaml')
extract('@deepseek-ai/cordis-plugin-include')

const final = installed()
console.log(`fixtures 就绪：${ASAR}`)
console.log(`  抽出 ${final.size} 个包 -> ${TARGET}`)
