// 一次跑完全部验证。
//
// 用法： node test/run-all.mjs
// 退出码 0 表示全部通过；非 0 表示有失败（或环境缺 fixture）。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = dirname(HERE)

/** 套件：需要 fixtures 的排在最前，由下面的引导逻辑先建好 fixture。 */
const suites = [
  { name: 'bundle', file: 'verify-bundle.mjs', needsFixtures: true },
  { name: 'client', file: 'verify-client-bundle.mjs', needsFixtures: true },
  { name: 'schema', file: 'verify-plugin.mjs', needsFixtures: true },
  { name: 'form', file: 'verify-settings-form.mjs', needsFixtures: true, needsElectron: true },
  { name: 'override', file: 'verify-config-override.mjs', needsFixtures: true },
  { name: 'secret', file: 'verify-secret-chain.mjs' },
  { name: 'cred-timing', file: 'verify-cred-timing.mjs' },
  { name: 'store', file: 'unit-store.mjs' },
  { name: 'e2e', file: 'e2e.mjs' },
  { name: 'adversarial', file: 'adversarial.mjs' },
  { name: 'config', file: 'config-robust.mjs' },
  { name: 'diff-size', file: 'diff-size.mjs' },
]

const fixtures = join(HERE, '.fixtures', 'verify', 'node_modules', '@deepseek-ai', 'dsh-tools')
if (!existsSync(fixtures)) {
  console.log('首次运行：正在从 app.asar 抽出 DSH 自身的包作为校验 fixture…')
  const setup = spawnSync(process.execPath, [join(HERE, 'setup-fixtures.mjs')], { stdio: 'inherit' })
  if (setup.status !== 0) {
    console.error('\nfixture 建立失败。schema 套件无法运行；其余套件仍会执行。')
  }
}

/**
 * 找 DSH 自己的 Electron 可执行文件。
 *
 * `form` 套件要 import schemastery —— 它只在 DSH 安装目录里，
 * 插件的 lib/schema.js 靠 process.execPath 反推安装位置来取它。
 * 因此这个套件必须用 DSH 的运行时跑，用系统 node 跑会取不到而 skip。
 *
 * @returns {string|undefined} 可执行文件路径。
 */
function findDshRuntime() {
  const candidates = [
    process.env.DSH_RUNTIME,
    'E:/1/harness/deepseek-harness-zhuomian/DeepSeek Harness.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe'),
    'C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe',
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return undefined
}

const dshRuntime = findDshRuntime()

const failedNames = []

for (const suite of suites) {
  // stdio: 'inherit' 而非 'pipe'：某些受限环境下捕获子进程输出会 EPERM，
  // 而这里的价值只是"跑一遍并看结果"，继承 stdio 更稳且输出更实时。
  console.log(`\n===== ${suite.name} (${suite.file}) =====`)

  let command = process.execPath
  let args = [join(HERE, suite.file)]
  if (suite.needsElectron === true) {
    if (dshRuntime === undefined) {
      console.log(`SKIP  ${suite.name}：找不到 DSH 运行时（该套件需要 schemastery）。`)
      continue
    }
    command = dshRuntime
    args = [join(HERE, suite.file)]
  }

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: PROJECT,
    env: { ...process.env, ...(suite.needsElectron === true ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  })
  const ok = result.status === 0
  if (!ok) failedNames.push(suite.name)
  console.log(`----- ${suite.name}: ${ok ? 'OK' : 'FAILED'} (exit ${result.status}) -----`)
}

console.log(`\n未通过的套件：${failedNames.length === 0 ? '(无)' : failedNames.join(', ')}`)
process.exit(failedNames.length === 0 ? 0 : 1)
