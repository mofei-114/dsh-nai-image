// 验证：ctx.get('credentials') 在 apply 时是否可用？
//
// 官方 web-search-deepseek 用的是 `ctx.get("credentials")`（不是 inject），
// 所以「用 ctx.get 而不是 inject」这个选择本身与官方一致。
//
// 但有一处必须查清：**时机**。如果 credentials 服务在插件 apply 之后才就绪，
// 那么 apply 时抓到的 undefined 会被闭包永久记住 —— 表现就是
// 「凭据明明配了，插件却一直说没配」。
//
// 这正是本次要复现的 bug。用一个延迟就绪的桩验证。
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

const mod = await import(pathToFileURL(join(PROJECT, 'lib/index.js')).href)

/**
 * 造一个 ctx：credentials 在 apply 之后才就绪。
 *
 * @param {number} readyAfterMs - 多久之后 get('credentials') 开始返回值。
 */
function makeLateCtx(readyAfterMs) {
  const started = Date.now()
  const state = { resolveCalls: 0 }
  const store = new Map([['NAI_IMAGE_TOKEN', 'tok-late']])
  const credentials = {
    async resolve(ref) {
      state.resolveCalls += 1
      const v = store.get(ref)
      return v === undefined ? undefined : { value: v, source: 'store' }
    },
  }
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (d) => { registered.push(d); return () => {} } },
    // 服务迟到：readyAfterMs 之前一律 undefined
    get: (k) => {
      if (k !== 'credentials') return undefined
      return Date.now() - started >= readyAfterMs ? credentials : undefined
    },
  }
  return { ctx, registered, state }
}

// ---- 场景 A：凭据服务在 apply 时已就绪
out.push('=== A. 服务就绪时 apply ===')
{
  const { ctx, registered, state } = makeLateCtx(0)
  mod.apply(ctx, { callMode: 'direct', token: '' })
  const def = registered.find((d) => d.name === 'nai_generate_image')
  let msg = ''
  try { await def.execute({ prompt: 'x' }, { signal: new AbortController().signal }) } catch (e) { msg = e.message }
  check('有凭据时不再报缺 token', !/Token/.test(msg), msg.slice(0, 70))
  check('确实调用了 resolve', state.resolveCalls > 0, String(state.resolveCalls))
}

// ---- 场景 B：凭据服务在 apply 之后才就绪（迟到）
out.push('')
out.push('=== B. 服务迟到（apply 时 undefined）===')
{
  const { ctx, registered, state } = makeLateCtx(50)
  mod.apply(ctx, { callMode: 'direct', token: '' })
  const def = registered.find((d) => d.name === 'nai_generate_image')

  // 等过了迟到窗口再调用
  await new Promise((r) => setTimeout(r, 80))
  let msg = ''
  try { await def.execute({ prompt: 'x' }, { signal: new AbortController().signal }) } catch (e) { msg = e.message }

  // 若实现把 credentials 在 apply 时抓死，这里会仍然报「需要填写 Token」
  const stillMissing = /Token/.test(msg)
  check('服务迟到时仍能在调用时拿到凭据', !stillMissing,
    stillMissing ? '仍报「需要填写 Token」→ 说明 apply 时把 undefined 抓死了' : msg.slice(0, 60))
  check('迟到场景下 resolve 也被调用', state.resolveCalls > 0, String(state.resolveCalls))
}

out.push('')
out.push(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'cred-timing.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
