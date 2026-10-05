// 验证客户端半侧（lib/client.js）满足 DSH 的 bundle 契约。
//
// DSH 的发现链（均已从源码核实）：
//   1. package.json 的 exports["./client"] 给出 bundle 相对路径
//      —— clientExportOf()
//   2. dsh.client.platform === 'web' 才算客户端包
//   3. bundle 必须是 `window.__ModuleLoader__.load({id, factory})` 形态，
//      factory(require) 返回 { apply, inject, ... }
//   4. 注册的 slot 必须已声明（plugins.item），locale 命名空间要自带字典
//
// 本测试用真实的 js-yaml/文本解析 + 一个最小 __ModuleLoader__ 桩来跑，
// 不重实现 DSH 的判定逻辑。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

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

const manifest = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf8'))

// ---- 1) 发现链：exports["./client"] + platform
out.push('=== DSH 发现链 ===')
{
  // 复刻 clientExportOf()
  const clientExportOf = (pkgName, exportsField) => {
    if (typeof exportsField !== 'object' || exportsField === null) return undefined
    const client = exportsField['./client']
    if (client === undefined) return undefined
    if (typeof client === 'string') return client
    if (typeof client === 'object' && client !== null && typeof client.default === 'string') return client.default
    throw new Error(`${pkgName} exports["./client"] must be a string or an object with a string default`)
  }
  const rel = clientExportOf(manifest.name, manifest.exports)
  check('exports["./client"] 可解析', typeof rel === 'string', String(rel))
  check('指向的文件存在', rel !== undefined && existsSync(join(PROJECT, rel)), rel)
  check('dsh.client.platform === "web"', manifest.dsh?.client?.platform === 'web',
    JSON.stringify(manifest.dsh?.client))
}

// ---- 2) bundle 形态：window.__ModuleLoader__.load({id, factory})
out.push('')
out.push('=== bundle 形态 ===')
const bundlePath = join(PROJECT, manifest.exports['./client'])
const source = readFileSync(bundlePath, 'utf8')

check('调用 window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\(/.test(source))
check('注册 id 与包名一致', source.includes(`id: '${manifest.name}'`) || source.includes(`id: "${manifest.name}"`),
  manifest.name)
check('导出 factory 函数', /factory:\s*\(require\)\s*=>/.test(source))
// bundle 里不能有运行时 import（纯 CJS + 平台 require）
check('没有顶层 import 语句', !/^\s*import\s/m.test(source))

// ---- 3) 真实执行：用最小 require 桩喂给 factory
out.push('')
out.push('=== factory 执行（模拟平台基座）===')
const registered = []
/** 捕获 SettingsFormModel 的构造参数，供回归断言用。 */
const formModelCtorArgs = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (reg) => { registered.push(reg) },
    },
  },
  console,
}
// 平台基座的最小替身：react 只需 createElement；primitives 只要组件与工厂函数存在
/**
 * 极简 hooks 运行时，供 `renderTree` 把组件真正渲染出来。
 *
 * 只覆盖本插件用到的 useState/useEffect/useMemo/useCallback。语义要点：
 * - 状态按调用序存在槽位里，`setState` 写槽并同步重渲染；
 * - `useEffect` 在渲染提交后执行，依赖用浅比较决定是否重跑；
 * - 清理函数在重跑或卸载前调用。
 */
const hooksRuntime = (() => {
  let slots = []
  let cursor = 0
  let effects = []
  let rerender = null
  let rendering = false
  let pendingRerender = false

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  return {
    /** 开始一次渲染：重置游标并收集本轮 effect。**不清空状态槽**（状态要跨渲染存活）。 */
    begin(renderFn) {
      cursor = 0
      effects = []
      rerender = renderFn
      rendering = true
      pendingRerender = false
    },
    /** 渲染结束。 */
    end() { rendering = false },
    /** 是否有待处理的重渲染。 */
    pending() { return pendingRerender },
    /** 清除待重渲染标记（由驱动循环在每轮渲染后调用）。 */
    clearPending() { pendingRerender = false },
    /** 结束一次树的生命周期：重置全部状态，供下一个用例从干净状态开始。 */
    reset() { cursor = 0; effects = []; rerender = null; slots = [] },
    /** 渲染提交后执行本轮 effect。 */
    commit() {
      const pending = effects
      effects = []
      for (const { deps, fn, slot } of pending) {
        if (slot.cleanup !== undefined) { slot.cleanup(); slot.cleanup = undefined }
        const cleanup = fn()
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
    },
    /** 卸载：跑掉所有剩余清理函数。 */
    unmount() {
      for (const slot of slots) {
        if (slot !== null && typeof slot === 'object' && typeof slot.cleanup === 'function') slot.cleanup()
      }
      slots = []
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) {
        slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = slots[index]
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        // setState 永远不同步重渲染（React 也不这么干）：
        // 渲染中只标记，渲染外也只置位，由 renderTree 的循环驱动下一轮。
        if (rendering) { pendingRerender = true; return }
        pendingRerender = true
      }
      return [slot.value, setState]
    },
    useEffect(fn, deps) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { deps: undefined, cleanup: undefined }
      const slot = slots[index]
      if (sameDeps(slot.deps, deps)) return
      slot.deps = deps
      effects.push({ deps, fn, slot })
    },
  }
})()

const fakeReact = {
  // 忠实于 React.createElement：children 既可写在 props 里，也可作为第三个起的位置参数。
  // 位置参数存在时覆盖 props.children（真实语义如此）。
  createElement: (type, props, ...rest) => {
    const merged = { ...(props ?? {}) }
    if (rest.length === 1) merged.children = rest[0]
    else if (rest.length > 1) merged.children = rest
    return { type, props: merged }
  },
  useRef: (v) => ({ current: v }),

  // ---- 真实可用的状态与副作用 ----
  //
  // 旧桩是 `useState: (v) => [v, () => {}]` + `useEffect: () => {}`：
  // setter 是空操作、effect 从不执行。于是「组件是否真的取到图并重绘」
  // 这类行为**根本测不出来** —— 图片渲染的回归用例因此长期虚假通过。
  // 现在挂一个最小的 hooks 运行时：按调用序槽位存取，setState 触发重渲染，
  // effect 在渲染后执行。
  useState: (initial) => hooksRuntime.useState(initial),
  useEffect: (fn, deps) => hooksRuntime.useEffect(fn, deps),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
const fakePrimitives = {
  SettingsForm: function SettingsForm() {},
  // 点击缩略图弹出的就地放大层。真实实现由 ui-primitives 导出，
  // props 契约：{ src, alt, labels: { dialog, close }, onClose }。
  //
  // 桩必须**返回一个可辨认的元素**：expand() 会执行函数组件，
  // 若返回 undefined，弹层就会从树里消失，断言无从下手。
  ImageLightbox: function ImageLightbox(props) {
    return {
      type: 'img',
      props: {
        className: 'stub-lightbox',
        src: props.src,
        alt: props.alt,
        // 保留原始 props，供断言检查 labels / onClose
        'data-labels': props.labels,
        'data-onclose': props.onClose,
      },
    }
  },
  // SettingsFormModel 的最小忠实替身：真类提供 bind/field/shell/actions/dispose。
  // 桩必须与真实实现同形，否则测不出「我调了不存在的方法」这类错误。
  SettingsFormModel: class SettingsFormModel {
    constructor(scope, specs, secrets = []) {
      // 记录构造参数：回归用例要检查 secrets 的形态（必须带 write）
      formModelCtorArgs.push([scope, specs, secrets])
      this.scope = scope
      this.specs = new Map(specs.map((s) => [s.field, s]))
      this.secretSpecs = new Map(secrets.map((s) => [s.field, s]))
      this.staged = new Map()
    }
    bind(project) {
      const store = { getSnapshot: () => project(), subscribe: () => () => {} }
      this._project = project
      return store
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field(name) {
      return { text: '', overridden: false, invalid: false }
    }
    actions() {
      return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
    }
    dispose() {}
  },
  SettingsValueField: function SettingsValueField() {},
  SettingsSecretField: function SettingsSecretField() {},
  settingsNumberField: (f) => ({ field: f, kind: 'number' }),
  settingsTextField: (f) => ({ field: f, kind: 'text' }),
}
const modules = {
  'react': fakeReact,
  '@deepseek-ai/dsh-client-ui-primitives': fakePrimitives,
}
const fakeRequire = (spec) => {
  if (Object.hasOwn(modules, spec)) return modules[spec]
  throw new Error(`bundle 请求了未在平台基座里的模块: ${spec}`)
}

try {
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  check('bundle 可在沙箱中执行', registered.length === 1, `注册 ${registered.length} 次`)
} catch (error) {
  failures += 1
  out.push(`FAIL  bundle 执行抛错: ${error.message}`)
}

let clientModule
if (registered.length === 1) {
  check('注册 id 正确', registered[0].id === manifest.name, registered[0].id)
  try {
    clientModule = registered[0].factory(fakeRequire)
    check('factory 返回模块对象', typeof clientModule === 'object' && clientModule !== null)
  } catch (error) {
    failures += 1
    out.push(`FAIL  factory 抛错: ${error.message}`)
  }
}

if (clientModule) {
  check('导出 apply', typeof clientModule.apply === 'function')
  check('导出 inject 含 slots/locale/configForms/remote.credentials',
    Array.isArray(clientModule.inject)
    && ['slots', 'locale', 'configForms', 'remote.credentials'].every((s) => clientModule.inject.includes(s)),
    JSON.stringify(clientModule.inject))
  check('NS 与 Loader 条目 id 一致（configForms 按它寻址）',
    clientModule.NS === 'dsh-nai-image', String(clientModule.NS))
}

// ---- 渲染辅助：把组件真的跑起来，而不是只调一次拿返回值 ----

/**
 * 渲染一个函数组件，返回提交后的元素树。
 *
 * 关键点：
 * - 组件的 effect 里可能有异步 setState（取图片 URL 就是），所以允许重渲染，
 *   并在返回前把所有微任务跑完；
 * - 子组件（例如 NaiImageStrip）是**函数类型**的节点，必须递归展开，
 *   否则断言只能看到 `{type: fn}` 而看不到它画出的 DOM。
 *
 * @param component - 函数组件。
 * @param props - 它的 props。
 * @param overrides - 可选，覆盖 props（例如注入一个会 reject 的 loadImage）。
 * @returns Promise<元素> 提交后的树。
 */
/** 最近一次 renderTree 的组件与 props，供 triggerClick 重渲染用。 */
const lastRender = { component: null, props: null }

async function renderTree(component, props, overrides = {}, keepState = false) {
  const merged = { ...props, ...overrides }
  lastRender.component = component
  lastRender.props = props
  // 默认从干净状态开始（hooks 状态不可跨用例泄漏）；
  // triggerClick 会传 keepState=true，以便保留刚 setState 的「已放大」状态。
  if (!keepState) hooksRuntime.reset()
  let tree = null
  // 渲染一整棵树：展开子组件（各自跑 hooks）→ 提交所有 effect。
  // setState（含 effect 里的异步 setState）只置「待重渲染」标记，
  // 由下面的循环驱动下一轮，绝不递归。
  const draw = () => {
    hooksRuntime.clearPending()
    hooksRuntime.begin(draw)
    tree = expand(component(merged))
    hooksRuntime.end()
    hooksRuntime.commit()
  }
  draw()
  // 反复「让出微任务 + 重渲染」，直到没有新状态。
  // 固定跑满若干轮：effect 里的 promise 是在**未来**的微任务里才 setState 的，
  // 只看第一轮的 pending 会立刻退出、错过异步到达的图片 URL。
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
    if (!hooksRuntime.pending()) continue
    draw()
  }
  return tree
}

/**
 * 递归展开函数类型的子组件，直到只剩主机元素。
 *
 * 展开子组件时要走同一套 hooks 运行时（它们自己也会调 useState）。
 * 顺序上先展开再提交 effect，与 React 的子先于父一致。
 *
 * @param node - 元素、数组或标量。
 * @returns 展开后的树。
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') {
    // 子组件自己也要跑 hooks：给它一段独立的游标区间，
    // 否则它会读写到父组件（或兄弟）的状态槽，行为不可预测。
    const rendered = node.type(node.props ?? {})
    return expand(rendered)
  }
  if (node.props !== undefined && 'children' in node.props) {
    return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  }
  return node
}

/**
 * 模拟点击：调用节点的 onClick，然后按最近一次 renderTree 的组件重渲染。
 *
 * @param node - 带 onClick 的元素节点。
 * @returns Promise<元素> 点击后的树；node 不可点时返回 null。
 */
async function triggerClick(node) {
  if (node === null || typeof node.props?.onClick !== 'function') return null
  node.props.onClick()
  return renderTree(lastRender.component, lastRender.props, {}, true)
}

/**
 * 在元素树里深度优先找第一个满足条件的节点。
 *
 * @param node - 元素、数组或标量。
 * @param predicate - 判定函数，收到元素节点 `{ type, props }`。
 * @returns 命中的节点，或 null。
 */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return findNode(node.props?.children, predicate)
}

/**
 * 等图片条的异步加载落地，取出每张图的最终状态。
 *
 * 图片条会为每张图调一次 loadImage，并在 promise 结算后 setState 重绘。
 * 这里渲染后读 `<img src>`：有 src 说明成功，没有则看是否处于失败态。
 *
 * @param strip - 图片条节点（可能是 null）。
 * @returns Promise<Array<string|null>> 每张图的 URL，失败为 null。
 */
function settleStrip(strip) {
  if (strip === null) return []
  const tiles = []
  const collect = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    const cls = node.props?.className
    // 注意区分容器 'nai-toolrow-images' 与单元 'nai-toolrow-image'：
    // 用按空格切分的精确匹配，避免子串误判。
    const parts = typeof cls === 'string' ? cls.split(/\s+/) : []
    if (parts.includes('nai-toolrow-image') || parts.includes('nai-toolrow-image-pending')) tiles.push(node)
    collect(node.props?.children)
  }
  collect(strip)
  return tiles.map((tile) => {
    if (tile.props?.['data-failed'] === 'true') return null
    const img = findNode(tile, (n) => n.type === 'img')
    return typeof img?.props?.src === 'string' ? img.props.src : null
  })
}

// ---- 4) apply() 的真实行为：注册字典 + slot + 表单
out.push('')
out.push('=== apply() 行为 ===')
if (clientModule) {
  const effects = []
  const locales = []
  const slotRegs = []
  const formGets = []

  const ctx = {
    effect: (fn, label) => { effects.push(label); const d = fn(); return typeof d === 'function' ? d : () => {} },
    locale: {
      bind: (ns) => (key) => `[${ns}]${key}`,
      register: (ns, dicts) => { locales.push({ ns, dicts }); return () => {} },
    },
    configForms: {
      get: (ns) => { formGets.push(ns); return { subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', writable: true }), set: async () => true, unset: async () => true, mutate: async () => true } },
      describe: () => ({ namespace: () => undefined }),
      whileServed: (namespaces, register) => { register(new Set(namespaces)); return () => {} },
    },
    remote: {
      // secret 走凭据域：桩必须在场，否则 apply 里的 refreshCredentials 会炸
      credentials: {
        describe: async (refs) => ({
          ok: true,
          value: Object.fromEntries(refs.map((r) => [r, { configured: false, writable: true }])),
        }),
        set: async () => {},
      },
    },
    slots: {
      inject: (key, cb) => { cb(); return () => {} },
      register: (options, component) => { slotRegs.push({ options, component }); return () => {} },
    },
  }

  try {
    clientModule.apply(ctx)
    check('apply 未抛错', true)

    const dict = locales.find((l) => l.ns === 'dsh-nai-image')
    check('注册了字典', dict !== undefined, dict === undefined ? '' : `zh=${Object.keys(dict.dicts.zh).length} en=${Object.keys(dict.dicts.en).length}`)
    check('字典 zh/en 键集合一致',
      dict !== undefined && JSON.stringify(Object.keys(dict.dicts.zh).sort()) === JSON.stringify(Object.keys(dict.dicts.en).sort()))

    check('configForms.get 用了正确条目 id', formGets.includes('dsh-nai-image'), JSON.stringify(formGets))

    // 回归：secret 的 spec 必须是 { field, write }，不能是字符串。
    //
    // 曾经传字符串数组 → SettingsFormModel.plan() 里 secret.write 为 undefined
    // → 保存时抛错 → 界面显示「本部署没有接受这些值」。这是实测踩到的坑。
    const ctorArgs = formModelCtorArgs[0]
    if (ctorArgs !== undefined) {
      const secrets = ctorArgs[2]
      check('SettingsFormModel 收到 secrets 数组', Array.isArray(secrets), JSON.stringify(secrets))
      check('每个 secret spec 都是 { field, write } 对象',
        Array.isArray(secrets) && secrets.length > 0
        && secrets.every((s) => s !== null && typeof s === 'object'
          && typeof s.field === 'string' && typeof s.write === 'function'),
        JSON.stringify((secrets ?? []).map((s) => (typeof s === 'string' ? s : Object.keys(s ?? {})))))
    } else {
      failures += 1
      out.push('FAIL  没有捕获到 SettingsFormModel 的构造参数')
    }

    // ---- 工具调用行 ----
    //
    // 关键约束：tool.call.images 子槽只能由一个条目声明，且已被
    // read-image-toolview 占用。我们再声明一次会让整个客户端插件 load 失败，
    // 所以注册里【必须没有】children。
    {
      const rows = slotRegs.filter((s) => s.options.name === 'tool.call.toolview')
      check('注册了 2 个工具行（generate / quota）', rows.length === 2,
        rows.map((r) => r.options.key).join(', '))
      check('key 是真实的工具名',
        rows.some((r) => r.options.key === 'nai_generate_image')
        && rows.some((r) => r.options.key === 'nai_quota'),
        rows.map((r) => r.options.key).join(', '))
      check('没有声明 children（避免与 read_image 争抢 tool.call.images）',
        rows.every((r) => r.options.children === undefined),
        JSON.stringify(rows.map((r) => r.options.children)))
      check('每个行都有组件', rows.every((r) => typeof r.component === 'function'))
    }

    // ---- 工具行渲染冒烟 ----
    {
      const row = slotRegs.find((s) => s.options.name === 'tool.call.toolview' && s.options.key === 'nai_generate_image')
      const t = (k) => `T:${k}`
      /** 记录 renderSlot 调用。**任何**调用都是缺陷（见下方断言）。 */
      const renderCalls = []
      const baseProps = {
        t,
        toolName: 'nai_generate_image',
        callId: 'call_1',
        useDisclosure: () => ({ open: false, toggle: () => {} }),
        // 官方契约（dsh-client-ui-attachment/lib/client.js:754）：
        // loadImage(attachment) -> Promise<string>，peek 给已缓存的 URL。
        loadImage: Object.assign(
          (attachment) => Promise.resolve(`blob:${attachment.attachmentId}`),
          { peek: () => null },
        ),
        openFile: () => {},
        // 忠实于真实实现：renderSlot 只能渲染本 entry children 里声明过的 key，
        // 否则抛 SlotOwnershipError。桩若不还原这一点，就会把缺陷测成通过。
        renderSlot: (key) => {
          renderCalls.push({ key })
          throw new Error(
            `SlotOwnershipError: slot '${key}' is not declared by this entry's children`,
          )
        },
      }

      const ATTACHMENT = {
        attachmentId: 'sha256:abc123',
        mediaType: 'image/png',
        bytes: 100,
        width: 832,
        height: 1216,
        name: 'a.png',
      }

      /** 造一个完成态的 block。 */
      const settled = (argsRaw, content, isError = false) => ({
        kind: 'tool', isError,
        call: { name: 'nai_generate_image', argsRaw },
        content,
      })

      const cases = [
        ['完成态（带参数与结果文本）',
          settled(JSON.stringify({ prompt: 'a cat', size: '横图', steps: 40, count: 2 }),
            [{ type: 'text', text: '已生成 2 张图片。\n已归档: C:/x.png' }, { type: 'image', attachment: ATTACHMENT }])],
        ['旧记录里残留 style（老会话回放）',
          settled(JSON.stringify({ prompt: 'a cat', style: 'anime', size: '横图' }),
            [{ type: 'text', text: 'ok' }])],
        ['失败态', settled(JSON.stringify({ prompt: 'x' }), [{ type: 'text', text: 'http_4xx: HTTP 401' }], true)],
        ['参数是坏 JSON', settled('{not json', [{ type: 'text', text: 'ok' }])],
        ['没有参数', settled('', [])],
        ['结果没有文本块', settled(JSON.stringify({ prompt: 'x' }), [{ type: 'image', attachment: ATTACHMENT }])],
        ['超长提示词', settled(JSON.stringify({ prompt: 'x'.repeat(500) }), [{ type: 'text', text: 'ok' }])],
        ['进行中（running）', { phase: 'running', argsRaw: JSON.stringify({ prompt: 'y' }), callId: 'c' }],
        ['准备中（preparing）', { phase: 'preparing', callId: 'c' }],
      ]

      for (const [label, block] of cases) {
        renderCalls.length = 0
        try {
          const node = row.component({ ...baseProps, block })
          check(`工具行渲染：${label}`, node !== null && typeof node === 'object')
        } catch (error) {
          failures += 1
          out.push(`FAIL  工具行渲染「${label}」抛错: ${error.message}`)
        }
      }

      // ---- 图片渲染（「GUI 不显示图片」的回归用例）----
      //
      // 关键教训：上一版这里断言「调用了 renderSlot('conversation.message.images')」，
      // 而那个调用在真实运行时必然抛 SlotOwnershipError（renderSlot 只能渲染
      // 本 entry children 里声明过的 key）。桩把 renderSlot 当成任意可用，
      // 于是测试给了虚假的通过。现在改为断言**真实行为**：
      // 组件必须自己用 loadImage 取图并画出 <img>。
      const settledImage = settled(JSON.stringify({ prompt: 'a cat' }),
        [{ type: 'text', text: 'done' }, { type: 'image', attachment: ATTACHMENT }])

      // 走真实 React：把行渲染成树，再沿树找出图片条。
      const mounted = await renderTree(row.component, { ...baseProps, block: settledImage })
      const strip = findNode(mounted, (n) => n.props?.className === 'nai-toolrow-images')
      check('有图片时渲染出图片条容器', strip !== null)

      // 图片条必须自己取图（异步），等它 settle。
      const urls = settleStrip(strip)
      check('图片条对每张图调用 loadImage 取到 URL',
        urls.length === 1 && urls[0] === `blob:${ATTACHMENT.attachmentId}`, JSON.stringify(urls))

      const withImg = findNode(mounted, (n) => n.props?.className === 'nai-toolrow-image')
      check('图片被画进行内（<img> 的 src 是 loadImage 的结果）',
        withImg !== null
        && findNode(withImg, (n) => n.type === 'img' && n.props?.src === `blob:${ATTACHMENT.attachmentId}`) !== null)

      // 点击放大：缩略图必须是可点的按钮，点击后弹出 ImageLightbox。
      //
      // 曾经用 <a target="_blank">，而 loadImage 返回的是 blob: URL ——
      // 那种 URL 只在本页上下文有效，新标签页根本打不开，表现为「点了没反应」。
      check('缩略图是可点击的按钮（不是新标签页链接）',
        withImg !== null && withImg.type === 'button' && typeof withImg.props?.onClick === 'function'
        && withImg.props?.href === undefined && withImg.props?.target === undefined,
        `type=${String(withImg?.type)} href=${String(withImg?.props?.href)}`)

      // 未点击时不该有弹层
      check('未点击时不渲染 lightbox',
        findNode(mounted, (n) => n.props?.className === 'stub-lightbox') === null)

      // 模拟点击 -> 重渲染 -> 断言弹层带着正确的 src
      const clicked = await triggerClick(withImg)
      const lightbox = findNode(clicked, (n) => n.props?.className === 'stub-lightbox')
      check('点击后弹出 ImageLightbox', lightbox !== null)
      check('lightbox 的 src 指向同一张图',
        lightbox?.props?.src === `blob:${ATTACHMENT.attachmentId}`, String(lightbox?.props?.src))
      check('lightbox 带关闭回调与 labels',
        typeof lightbox?.props?.['data-onclose'] === 'function'
        && typeof lightbox?.props?.['data-labels']?.close === 'string',
        JSON.stringify(Object.keys(lightbox?.props?.['data-labels'] ?? {})))

      check('不再调用 renderSlot（那必然抛 SlotOwnershipError）', renderCalls.length === 0, String(renderCalls.length))

      // 没有图片时不该有图片条
      const noImgTree = await renderTree(row.component,
        { ...baseProps, block: settled(JSON.stringify({ prompt: 'x' }), [{ type: 'text', text: 'ok' }]) })
      check('没有图片时不渲染图片条',
        findNode(noImgTree, (n) => n.props?.className === 'nai-toolrow-images') === null)

      // 失败态不显示图片
      const errTree = await renderTree(row.component, {
        ...baseProps,
        block: settled(JSON.stringify({ prompt: 'x' }), [{ type: 'image', attachment: ATTACHMENT }], true),
      })
      check('失败态不渲染图片',
        findNode(errTree, (n) => n.props?.className === 'nai-toolrow-images') === null)

      // 缺陷附件（缺 attachmentId）整批放弃，不画破图
      const badTree = await renderTree(row.component, {
        ...baseProps,
        block: settled(JSON.stringify({ prompt: 'x' }), [{ type: 'image', attachment: { mediaType: 'image/png' } }]),
      })
      check('附件缺 attachmentId 时整批放弃',
        findNode(badTree, (n) => n.props?.className === 'nai-toolrow-images') === null)

      // loadImage 失败时要显示失败态，而不是空白或破图
      const failTree = await renderTree(row.component,
        { ...baseProps, block: settledImage },
        { loadImage: () => Promise.reject(new Error('boom')) })
      const failStrip = findNode(failTree, (n) => n.props?.className === 'nai-toolrow-images')
      const failed = settleStrip(failStrip)
      check('loadImage 失败时显示失败态而非破图',
        failed.length === 1 && failed[0] === null, JSON.stringify(failed))

      // owner 没给 loadImage 时不能抛
      try {
        const { loadImage: _omit, ...noLoad } = baseProps
        const node = row.component({ ...noLoad, block: settledImage })
        check('owner 未提供 loadImage 时不抛', node !== null && typeof node === 'object')
      } catch (error) {
        failures += 1
        out.push(`FAIL  缺少 loadImage 时抛错: ${error.message}`)
      }

      // 摘要里应能看到提示词
      try {
        const node = row.component({
          ...baseProps,
          block: settled(JSON.stringify({ prompt: 'a cat' }), [{ type: 'text', text: 'ok' }]),
        })
        const flat = JSON.stringify(node)
        check('摘要包含提示词', flat.includes('a cat'), flat.slice(0, 120))
      } catch (error) {
        failures += 1
        out.push(`FAIL  摘要检查抛错: ${error.message}`)
      }

      // 画风不可传参：即使旧记录里带着 style，也不该再渲染「画风」标签。
      try {
        const node = row.component({
          ...baseProps,
          block: settled(JSON.stringify({ prompt: 'a cat', style: 'anime', size: '横图' }),
            [{ type: 'text', text: 'ok' }]),
        })
        const flat = JSON.stringify(node)
        check('参数标签里没有画风（style 已不是调用参数）',
          !flat.includes('T:rowStyle') && !flat.includes('anime'), flat.slice(0, 160))
        check('画幅标签仍在', flat.includes('T:rowSize'), flat.slice(0, 160))
      } catch (error) {
        failures += 1
        out.push(`FAIL  画风标签检查抛错: ${error.message}`)
      }

      // ---- 计费行渲染（「本次消耗 / 剩余点数」）----
      //
      // 宿主把计费拼成「计费: 本次消耗: N / 剩余点数: M」一行塞进结果文本；
      // 界面读不到结构化输出值，只能解析这一行。
      const billingCases = [
        ['消耗与剩余都有',
          '已生成 1 张图片。\n计费: 本次消耗: 1 / 剩余点数: 456',
          { cost: '1', balance: '456' }],
        ['只有消耗（额度接口没查成功）',
          '已生成 1 张图片。\n计费: 本次消耗: 3',
          { cost: '3', balance: null }],
        ['上游未返回消耗',
          '已生成 1 张图片。\n计费: 本次消耗: 上游未返回 / 剩余点数: 12',
          { cost: 'T:rowCostUnknown', balance: '12' }],
        ['小数消耗',
          '计费: 本次消耗: 2.5 / 剩余点数: 10',
          { cost: '2.5', balance: '10' }],
      ]
      for (const [label, text, expect] of billingCases) {
        try {
          const node = row.component({
            ...baseProps,
            block: settled(JSON.stringify({ prompt: 'x' }), [{ type: 'text', text }]),
          })
          const flat = JSON.stringify(node)
          check(`计费行渲染：${label}`,
            flat.includes('T:rowCost') && flat.includes(String(expect.cost)),
            flat.slice(0, 200))
          if (expect.balance === null) {
            check(`计费行渲染：${label} —— 不显示剩余`, !flat.includes('T:rowBalance'), flat.slice(0, 200))
          } else {
            check(`计费行渲染：${label} —— 显示剩余`,
              flat.includes('T:rowBalance') && flat.includes(String(expect.balance)), flat.slice(0, 200))
          }
        } catch (error) {
          failures += 1
          out.push(`FAIL  计费行渲染「${label}」抛错: ${error.message}`)
        }
      }

      // 没有计费行时（OpenAI 通道）整段不渲染
      try {
        const node = row.component({
          ...baseProps,
          block: settled(JSON.stringify({ prompt: 'x' }),
            [{ type: 'text', text: '已生成 1 张图片。\n通道：OpenAI 兼容' }]),
        })
        const flat = JSON.stringify(node)
        check('无计费行时整段不渲染',
          !flat.includes('T:rowCost') && !flat.includes('T:rowBalance'), flat.slice(0, 200))
      } catch (error) {
        failures += 1
        out.push(`FAIL  无计费行检查抛错: ${error.message}`)
      }
    }

    const slot = slotRegs.find((s) => s.options.name === 'plugins.item')
    check('注册进 plugins.item slot', slot !== undefined)
    if (slot) {
      check('slot 有 id 与 order', typeof slot.options.id === 'string' && typeof slot.options.order === 'number',
        `id=${slot.options.id} order=${slot.options.order}`)
      check('slot 带 locale 命名空间', slot.options.locale === 'dsh-nai-image', String(slot.options.locale))
      check('slot 提供 inject 面', typeof slot.options.inject === 'function')
      const face = slot.options.inject()
      check('inject 面含 hooks.card', face.hooks !== undefined && face.hooks.card !== undefined)
      check('inject 面含 edit/resetField/save/discard',
        ['edit', 'resetField', 'save', 'discard'].every((k) => typeof face[k] === 'function'),
        Object.keys(face).join(', '))
    }

    // 渲染冒烟：summary 与 page 两种视图都不抛。
    const slotComp = slotRegs.find((s) => s.options.name === 'plugins.item')
    if (slotComp) {
      const t = (k) => `T:${k}`
      const state = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
      const baseProps = {
        t,
        view: 'summary',
        useCard: (sel) => sel(state),
        edit: () => {},
        resetField: () => {},
        save: () => {},
        discard: () => {},
      }
      try {
        const summary = slotComp.component(baseProps)
        check('summary 视图返回一行文本', typeof summary === 'string', String(summary).slice(0, 40))
      } catch (error) {
        failures += 1
        out.push(`FAIL  summary 渲染抛错: ${error.message}`)
      }
      try {
        const full = slotComp.component({ ...baseProps, view: 'page' })
        check('page 视图返回表单节点', full !== null && typeof full === 'object')
        // SettingsForm 的 children 应覆盖全部 26 个字段的控件（外加分区标题）
        const kids = full.props?.children
        const childCount = Array.isArray(kids) ? kids.length : (kids === undefined ? 0 : 1)
        check('表单渲染了所有控件', childCount >= 26, `children=${childCount}`)
        // 每个字段都应有对应控件：统计渲染出的控件 type。
        const types = (Array.isArray(kids) ? kids : [kids]).map((k) => k?.type?.name ?? typeof k?.type)
        const fieldCtrls = types.filter((n) => n === 'SettingsValueField' || n === 'SettingsSecretField').length
        check('控件数 = 受控字段数', fieldCtrls === 26, `${fieldCtrls} 个控件`)
        // secret 控件必须拿到 configured 布尔（否则标签会显示 undefined）
        const secretNodes = (Array.isArray(kids) ? kids : [kids]).filter((k) => k?.type?.name === 'SettingsSecretField')
        check('secret 控件都带 configured 布尔', secretNodes.every((n) => typeof n.props.configured === 'boolean'),
          `${secretNodes.length} 个 secret 控件`)
        check('secret 控件都带 stateLabel', secretNodes.every((n) => typeof n.props.stateLabel === 'string'))
      } catch (error) {
        failures += 1
        out.push(`FAIL  page 渲染抛错: ${error.message}`)
      }
    }
  } catch (error) {
    failures += 1
    out.push(`FAIL  apply 抛错: ${error.message}`)
  }
}

// ---- 5) 字段覆盖：schema 与 client 的字段集合必须一致
out.push('')
out.push('=== 字段集合一致性 ===')
{
  const schema = await import(pathToFileURL(join(PROJECT, 'lib/schema.js')).href)
  const Config = schema.buildConfig()
  if (Config === undefined) {
    out.push('SKIP  schemastery 不可用（在纯 Node 下跑）')
  } else {
    // 从 schema 取 volatile 字段
    const json = Config.toJSON()
    const refs = json.refs ?? {}
    const seen = new Set()
    const volatileKeys = []
    const walk = (nodeOrId, prefix) => {
      const node = typeof nodeOrId === 'number' ? refs[nodeOrId] : nodeOrId
      if (!node || typeof node !== 'object' || seen.has(node)) return
      seen.add(node)
      if (node.meta?.volatile) { volatileKeys.push(prefix); return }
      for (const [k, childId] of Object.entries(node.dict ?? {})) walk(childId, prefix ? `${prefix}.${k}` : k)
    }
    walk(json.uid ?? json, '')

    // 从 client 源码取字段名（GROUPS 里的）
    const fieldsBlock = source.slice(source.indexOf('const GROUPS = ['), source.indexOf('/** 所有受控字段名'))
    const clientFields = [...fieldsBlock.matchAll(/\['([A-Za-z][A-Za-z0-9]*)',\s*'(?:text|number|secret)'\]/g)].map((m) => m[1])

    check('client 声明了字段', clientFields.length > 0, `${clientFields.length} 个`)
    const missingInClient = volatileKeys.filter((k) => !clientFields.includes(k))
    const missingInSchema = clientFields.filter((k) => !volatileKeys.includes(k))
    check('schema 的每个 volatile 字段都有控件', missingInClient.length === 0, missingInClient.join(', ') || '(无)')
    check('每个控件都在 schema 里声明', missingInSchema.length === 0, missingInSchema.join(', ') || '(无)')
  }
}

out.push('')
out.push(`FAILURES: ${failures}`)
writeFileSync(join(PROBE, 'client-bundle.txt'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
process.exit(failures === 0 ? 0 : 1)
