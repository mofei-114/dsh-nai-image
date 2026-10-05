// 差分测试：把插件的尺寸收敛逻辑与参考 Python 实现逐例对比。
//
// 参考实现取自 astrbot_plugin_nai_image 的 main.py:1591-1627（见 ref_size.py）。
// 这类"照抄语义"的移植最容易在细节上偏（例如 Python 的 // 是向下取整，
// 写成 Math.round 会让整个白名单错一档），所以拿原实现做逐例对照。
//
// 用法： node test/diff-size.mjs
// Python 路径可用 PYTHON 环境变量覆盖。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

/** 本文件所在目录（test/）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件项目根。 */
const PROJECT = dirname(HERE)
/** fixture 与产物目录。 */
const PROBE = join(HERE, '.fixtures')
mkdirSync(PROBE, { recursive: true })

const CASES = join(PROBE, 'diff-cases.json')
const REF = join(PROBE, 'diff-ref.json')

/** 覆盖：分档名、白名单、边界、畸形、超大、非 64 倍数、单边 64。 */
const cases = [
  '方图', '竖图', '横图', '2K方图', '2K竖图', '2K横图', '4K方图', '4K竖图', '4K横图',
  '640x640', '832x1216', '1216x832', '1024x1024', '1024x1536', '1536x1024',
  '1472x1472', '1088x1920', '1920x1088',
  '100x100', '1x1', '63x63', '64x64', '65x65', '96x96',
  '1000x1000', '1920x1920', '1921x1921', '2048x2048', '4096x4096',
  '3000x100', '100x3000', '8000x8000',
  '832x1215', '833x1216', '1023x1025', '100x100000',
  'abc', '', '12', 'x100', '100x', '0x0', '64x64x64',
  '832X1216', ' 832 x 1216 ',
]

writeFileSync(CASES, JSON.stringify(cases), 'utf8')

// 找 Python：环境变量优先，其次 DSH 自带运行时，最后 PATH。
//
// 注意 stdio 用 'ignore' 而非 'pipe'：受限环境下捕获子进程输出会 EPERM。
// 这里本来也不需要它的 stdout —— ref_size.py 把结果写进文件，我们读文件。
const PYTHON_CANDIDATES = [
  process.env.PYTHON,
  join(process.env.DSH_HOME ?? '', 'dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'),
  'python',
  'python3',
].filter(Boolean)

let py = null
for (const candidate of PYTHON_CANDIDATES) {
  const probe = spawnSync(candidate, ['-c', 'pass'], { stdio: 'ignore' })
  if (probe.status === 0) { py = candidate; break }
}
if (py === null) {
  console.error('找不到可用的 Python，无法跑差分测试。设 PYTHON 环境变量指定解释器。')
  console.error('已尝试：\n  ' + PYTHON_CANDIDATES.join('\n  '))
  process.exit(2)
}

const ran = spawnSync(py, [join(HERE, 'ref_size.py'), CASES, REF], { stdio: 'ignore' })
if (ran.status !== 0 || !existsSync(REF)) {
  console.error(`参考实现执行失败（exit ${ran.status}）。`)
  console.error('若本机 Python 不可用，可设 PYTHON 环境变量指向解释器。')
  process.exit(2)
}

const refOut = JSON.parse(readFileSync(REF, 'utf8'))
const CONST = await import(pathToFileURL(join(PROJECT, 'lib/constants.js')).href)
const { normalizeOpenAISize } = await import(pathToFileURL(join(PROJECT, 'lib/nai-client.js')).href)

const rows = []
let mismatches = 0
for (const entry of refOut) {
  const mapped = CONST.OPENAI_SIZE_MAP[entry.case] ?? entry.case
  const mine = normalizeOpenAISize(mapped)
  const same = entry.ref === mine
  if (!same) mismatches += 1
  rows.push(`${same ? 'ok  ' : 'DIFF'}  in=${JSON.stringify(entry.case).padEnd(16)} ref=${entry.ref.padEnd(12)} mine=${mine}`)
}

const footer = `\n共 ${refOut.length} 例，不一致 ${mismatches} 例`
writeFileSync(join(PROBE, 'diff-size.txt'), rows.join('\n') + footer, 'utf8')
console.log(rows.join('\n') + footer)
console.log(mismatches === 0
  ? `PASS  尺寸收敛与参考实现完全一致（${refOut.length} 例）`
  : `FAIL  有 ${mismatches} 例与参考实现不一致`)
process.exit(mismatches === 0 ? 0 : 1)
