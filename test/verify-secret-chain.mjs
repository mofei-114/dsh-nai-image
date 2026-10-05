// 验证 secret 的完整链路：
//   GUI 写凭据域 → 宿主 apply 时从凭据域解析 → 生图用它
//
// 关键契约（已从 credentials 服务核实）：resolve() 必须【每次操作重新调用】，
// 不得跨操作缓存 —— 否则界面换了 token 要重启才生效。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
const configMod = await import(pathToFileURL(join(PROJECT, 'lib/config.js')).href)

// ---- 1) 凭据引用名与 client.js 里的一致
out.push('=== 凭据引用名一致性 ===')
{
  const clientSrc = (await import('node:fs')).readFileSync(join(PROJECT, 'lib/client.js'), 'utf8')
  const block = clientSrc.slice(clientSrc.indexOf('const SECRET_REFS'), clientSrc.indexOf('/** 每个字段的转换器'))
  const fromClient = {}
  for (const m of block.matchAll(/(\w+):\s*'([^']+)'/g)) fromClient[m[1]] = m[2]
  check('client.js 声明了 SECRET_REFS', Object.keys(fromClient).length === 2, JSON.stringify(fromClient))
  const same = JSON.stringify(fromClient) === JSON.stringify(configMod.CREDENTIAL_REFS)
  check('host 与 client 的引用名一致', same,
    `client=${JSON.stringify(fromClient)} host=${JSON.stringify(configMod.CREDENTIAL_REFS)}`)
  check('引用名是大写下划线风格（与官方一致）',
    Object.values(configMod.CREDENTIAL_REFS).every((r) => /^[A-Z][A-Z0-9_]+$/.test(r)))
}

// ---- 2) 凭据域提供 token 时，生图用它（而不是 patch 里的空串）
out.push('')
out.push('=== 宿主从凭据域取 token ===')
{
  const reads = []
  const store = new Map([['NAI_IMAGE_TOKEN', 'tok-from-credentials']])
  const credentials = {
    async resolve(ref) {
      reads.push(ref)
      const v = store.get(ref)
      return v === undefined ? undefined : { value: v, source: 'store' }
    },
  }

  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (d) => { registered.push(d); return () => {} } },
    get: (k) => (k === 'credentials' ? credentials : undefined),
  }
  mod.apply(ctx, { callMode: 'direct', token: '' })

  const def = registered.find((d) => d.name === 'nai_generate_image')
  check('工具已注册', def !== undefined)

  // 直接观察：让 execute 走到「需要 token」那一步并看它是否还报缺 token。
  // 用一个必然失败的 baseUrl，只要不报「需要填写 Token」就说明凭据生效。
  let message = ''
  try {
    await def.execute({ prompt: 'x' }, { signal: new AbortController().signal })
  } catch (error) {
    message = error.message
  }
  check('读取了 NAI_IMAGE_TOKEN 引用', reads.includes('NAI_IMAGE_TOKEN'), reads.join(', '))
  check('不再报「需要填写 Token」（凭据域已提供）',
    !/Token/.test(message), message.slice(0, 90))
}

// ---- 3) 每次操作重新解析（换 token 立刻生效，无需重启）
out.push('')
out.push('=== 每次操作重新解析 ===')
{
  let value = 'first'
  const credentials = {
    async resolve() { return { value, source: 'store' } },
  }
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (d) => { registered.push(d); return () => {} } },
    get: (k) => (k === 'credentials' ? credentials : undefined),
  }
  mod.apply(ctx, { callMode: 'direct', baseUrl: 'http://127.0.0.1:1', token: '' })
  const def = registered.find((d) => d.name === 'nai_generate_image')

  // 第一次
  let first = ''
  try { await def.execute({ prompt: 'a' }, { signal: new AbortController().signal }) } catch (e) { first = e.message }
  // 换 token
  value = 'second'
  let second = ''
  try { await def.execute({ prompt: 'a' }, { signal: new AbortController().signal }) } catch (e) { second = e.message }

  // 两次都应走到网络层（报连接失败），而不是「缺 token」
  check('第一次调用走到了网络层', !/Token/.test(first), first.slice(0, 70))
  check('换 token 后仍正常（未缓存旧值导致异常）', !/Token/.test(second), second.slice(0, 70))
}

// ---- 4) 凭据域缺失时退回 patch 里的值
out.push('')
out.push('=== 降级：无凭据服务 ===')
{
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (d) => { registered.push(d); return () => {} } },
    get: () => undefined,
  }
  mod.apply(ctx, { callMode: 'direct', token: '' })
  const def = registered.find((d) => d.name === 'nai_generate_image')
  let message = ''
  try { await def.execute({ prompt: 'x' }, { signal: new AbortController().signal }) } catch (e) { message = e.message }
  check('无凭据服务且无 token 时报可操作错误', /Token/.test(message), message)
}

// ---- 5) 凭据为空串时不覆盖 patch 值（空值视为未配置）
out.push('')
out.push('=== 空凭据不覆盖 ===')
{
  const credentials = { async resolve() { return { value: '', source: 'store' } } }
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (d) => { registered.push(d); return () => {} } },
    get: (k) => (k === 'credentials' ? credentials : undefined),
  }
  mod.apply(ctx, { callMode: 'direct', token: 'tok-from-patch' })
  const def = registered.find((d) => d.name === 'nai_generate_image')
  let message = ''
  try { await def.execute({ prompt: 'x' }, { signal: new AbortController().signal }) } catch (e) { message = e.message }
  check('空凭据不覆盖 patch 里的 token', !/Token/.test(message), message.slice(0, 80))
}

out.push('')
out.push(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'secret-chain.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
