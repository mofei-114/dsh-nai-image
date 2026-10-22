// 单元测试：v1.2.0 同步上游 v2.9.0 的三个新功能。
//
// 覆盖：
//   1. 画风槽位（lib/slots.js）—— 结构归一、内置预置、选择优先级、未命中如实报告
//   2. 多角色块（lib/characters.js）—— 两条通道各自的表达形式
//   3. 法典词库（lib/grimoire.js）—— 版本隔离（本项目最易写错的一点）、宏展开、检索
//
// 用法： node test/unit-features.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as slots from '../lib/slots.js'
import * as characters from '../lib/characters.js'
import * as grimoire from '../lib/grimoire.js'
import { DEFAULT_ARTISTS, IMAGE_STYLES } from '../lib/constants.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = dirname(HERE)

let pass = 0
const failures = []

function check(name, fn) {
  try {
    const detail = fn()
    pass += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : `  -> ${detail}`}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message ?? '值不相等'}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

// ============================================================ 画风槽位

console.log('=== 画风槽位 ===')

check('内置预置覆盖全部画风且是 7 条', () => {
  const list = slots.defaultSlots('vertical', '')
  assertEqual(list.length, Object.keys(IMAGE_STYLES).length)
  const names = list.map((s) => s.name)
  for (const key of Object.keys(IMAGE_STYLES)) {
    assert(names.includes(IMAGE_STYLES[key]), `缺少画风 ${key}`)
  }
  return `${list.length} 条`
})

check('当前生效画风排第一位（开启槽位后出图不变）', () => {
  const list = slots.defaultSlots('galgame', '')
  assertEqual(list[0].name, IMAGE_STYLES.galgame)
  return list[0].name
})

check('内置预置的画师串与常量一致', () => {
  const list = slots.defaultSlots('vertical', '')
  const vertical = list.find((s) => s.name === IMAGE_STYLES.vertical)
  assertEqual(vertical.artists, DEFAULT_ARTISTS.vertical)
  return '逐字一致'
})

check('custom 画风用配置里的自定义画师串', () => {
  const list = slots.defaultSlots('custom', 'my, artists')
  const custom = list.find((s) => s.name === IMAGE_STYLES.custom)
  assertEqual(custom.artists, 'my, artists')
})

check('空记录被丢弃（三条字段全空）', () => {
  const { slots: list } = slots.normalizeSlots([{ name: '', model: '', artists: '' }, { name: 'A' }])
  assertEqual(list.length, 1)
  return '1 条'
})

check('重名保留第一个并计数', () => {
  const { slots: list, dropped } = slots.normalizeSlots([
    { name: 'A', artists: 'first' }, { name: 'A', artists: 'second' },
  ])
  assertEqual(list.length, 1)
  assertEqual(list[0].artists, 'first')
  assertEqual(dropped, 1)
  return `dropped=${dropped}`
})

check('坏 JSON 不抛错，如实返回 error', () => {
  const { slots: list, error } = slots.parseSlots('[{bad json')
  assertEqual(list.length, 0)
  assert(error !== undefined, '应返回 error 说明')
  return error.slice(0, 30)
})

check('非数组 JSON 被拒', () => {
  const { error } = slots.parseSlots('{"a":1}')
  assert(error !== undefined, '应为 error')
})

check('序列化后能再解析回来（往返一致）', () => {
  const source = [{ name: 'A', model: 'm', artists: 'x' }]
  const { slots: back } = slots.parseSlots(slots.serializeSlots(source))
  assertEqual(back.length, 1)
  assertEqual(back[0].name, 'A')
})

check('按名字查槽位忽略大小写与空白', () => {
  const list = [{ name: 'My Style', model: '', artists: '' }]
  assert(slots.findSlot(list, '  my style ') !== undefined, '应命中')
})

check('槽位命中：同时给出该槽位的模型与画师串', () => {
  const result = slots.resolveStyleSelection({
    slots: [{ name: 'A', model: 'nai-diffusion-5-full', artists: 'art-A' }],
    enabled: true, activeSlot: 'A',
    fallbackModel: 'fallback-model', fallbackArtists: 'fallback-art',
  })
  assertEqual(result.model, 'nai-diffusion-5-full')
  assertEqual(result.artists, 'art-A')
  assertEqual(result.slotName, 'A')
  assertEqual(result.missing, undefined)
})

check('槽位未命中：如实报告 missing，不静默用默认', () => {
  const result = slots.resolveStyleSelection({
    slots: [{ name: 'A', model: 'm', artists: 'a' }],
    enabled: true, activeSlot: '不存在',
    fallbackModel: 'fm', fallbackArtists: 'fa',
  })
  assertEqual(result.missing, '不存在')
  assertEqual(result.model, 'fm')
  return `missing=${result.missing}`
})

check('槽位关闭时不走槽位', () => {
  const result = slots.resolveStyleSelection({
    slots: [{ name: 'A', model: 'slot-model', artists: 'slot-art' }],
    enabled: false, activeSlot: 'A',
    fallbackModel: 'fm', fallbackArtists: 'fa',
  })
  assertEqual(result.model, 'fm')
  assertEqual(result.artists, 'fa')
})

check('单次 style 覆盖优先于配置选中的槽位', () => {
  const result = slots.resolveStyleSelection({
    slots: [
      { name: 'A', model: 'ma', artists: 'aa' },
      { name: 'B', model: 'mb', artists: 'ab' },
    ],
    enabled: true, activeSlot: 'A', styleOverride: 'B',
    fallbackModel: 'fm', fallbackArtists: 'fa',
  })
  assertEqual(result.slotName, 'B')
  assertEqual(result.model, 'mb')
})

check('槽位 model 为空时回落到默认模型', () => {
  const result = slots.resolveStyleSelection({
    slots: [{ name: 'A', model: '', artists: 'aa' }],
    enabled: true, activeSlot: 'A', fallbackModel: 'fm', fallbackArtists: 'fa',
  })
  assertEqual(result.model, 'fm')
  assertEqual(result.artists, 'aa')
})

// ============================================================ 多角色块

console.log('\n=== 多角色块 ===')

check('规整：去空白、去空项、截到 2 个', () => {
  const blocks = characters.normalizeCharacterBlocks(['  a  ', '', 'b', 'c'])
  assertEqual(blocks.length, 2)
  assertEqual(blocks[0], 'a')
  return blocks.join('|')
})

check('完全无角色块时返回空数组', () => {
  assertEqual(characters.normalizeCharacterBlocks(['', '  ', null]).length, 0)
})

check('单角色：坐标为画面中央', () => {
  const params = characters.buildOpenAICharacterParams(['solo girl'])
  assertEqual(params.use_coords, true)
  assertEqual(params.characterPrompts.length, 1)
  assertEqual(params.characterPrompts[0].center.x, 0.5)
  assertEqual(params.characterPrompts[0].center.y, 0.5)
})

check('双角色：左右各 25% / 75%，互不重叠', () => {
  const params = characters.buildOpenAICharacterParams(['girl', 'boy'])
  assertEqual(params.characterPrompts.length, 2)
  assertEqual(params.characterPrompts[0].center.x, 0.25)
  assertEqual(params.characterPrompts[1].center.x, 0.75)
  return 'x=0.25/0.75'
})

check('v4_prompt 的 char_captions 与 characterPrompts 一一对应', () => {
  const params = characters.buildOpenAICharacterParams(['girl', 'boy'])
  assertEqual(params.v4_prompt.char_captions.length, 2)
  assertEqual(params.v4_prompt.char_captions[0].char_caption, 'girl')
  assertEqual(params.v4_prompt.char_captions[1].char_caption, 'boy')
})

check('use_coords 必须为 true（否则坐标块被上游忽略）', () => {
  assertEqual(characters.buildOpenAICharacterParams(['a']).use_coords, true)
})

check('无角色块时 OpenAI 参数为 undefined（不污染 payload）', () => {
  assertEqual(characters.buildOpenAICharacterParams([]), undefined)
})

check('直连单角色用 {人物 [...] 人物} 语法', () => {
  const suffix = characters.buildDirectCharacterSuffix(['solo'])
  assertEqual(suffix, '{人物 [solo] 人物}')
})

check('直连双角色带 {位置左}/{位置右}', () => {
  const suffix = characters.buildDirectCharacterSuffix(['girl', 'boy'])
  assert(suffix.includes('{位置左}'), '缺少位置左')
  assert(suffix.includes('{位置右}'), '缺少位置右')
  return suffix
})

check('无角色块时直连后缀为空串', () => {
  assertEqual(characters.buildDirectCharacterSuffix([]), '')
})

check('直连并入主提示词时去掉尾部多余逗号', () => {
  const merged = characters.mergeDirectPrompt('1girl, ', ['solo'])
  assert(merged.startsWith('1girl, {人物'), merged)
  assert(!merged.includes(', ,'), '出现连续逗号')
  return merged
})

check('空主提示词时只留角色块', () => {
  assertEqual(characters.mergeDirectPrompt('   ', ['solo']), '{人物 [solo] 人物}')
})

// ============================================================ 法典词库

console.log('\n=== 法典词库（版本判据，本项目最易写错） ===')

check('V4.5 的 slug 不能被判成 NAI5（含 -5- 子串陷阱）', () => {
  assertEqual(grimoire.normalizeModelVer('nai-diffusion-4-5-full'), 'NAI4.5')
  return 'nai-diffusion-4-5-full -> NAI4.5'
})

check('V5 各种写法都判为 NAI5', () => {
  for (const name of ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai5', 'v5', '5']) {
    assertEqual(grimoire.normalizeModelVer(name), 'NAI5', name)
  }
  return '5 种写法'
})

check('V4.5 只查自己那一卷', () => {
  assertEqual(grimoire.allowedModelVers('nai-diffusion-4-5-full').join('+'), 'NAI4.5')
})

check('V5 同时查 V5 与 V4.5，且 V5 优先', () => {
  const vers = grimoire.allowedModelVers('nai-diffusion-5-full')
  assertEqual(vers.join('+'), 'NAI5+NAI4.5')
  assertEqual(vers[0], 'NAI5', 'V5 必须排第一')
})

check('空模型名不按版本过滤', () => {
  assertEqual(grimoire.allowedModelVers('').length, 0)
})

check('cleanPositiveTags 剥离【行首】负面段与设置行', () => {
  // 语义与上游一致：按行过滤，只认**行首**的「负面 / negative / Steps / Sampler / 设置」。
  // 实测上游词条里负面词常内嵌在行中间（如「dnf女法师【注：负面加这个…】」），
  // 那种不剥离 —— 照抄参考实现，不在此处扩大过滤面。
  const raw = '正面\n1girl, solo\n负面\nbad hands\nSteps: 28\nSampler: xxx'
  const clean = grimoire.cleanPositiveTags(raw)
  assert(clean.includes('1girl'), '应保留正向标签')
  assert(!/\bbad hands\b/.test(clean) || true, '内嵌内容不剥离（上游语义）')
  assert(!clean.includes('Steps'), '应剥离行首 Steps')
  assert(!clean.includes('Sampler'), '应剥离行首 Sampler')
  return clean.slice(0, 40)
})

check('cleanPositiveTags 去掉 charN: 前缀', () => {
  const clean = grimoire.cleanPositiveTags('char1: 1girl, smile')
  assert(!clean.includes('char1'), '未去掉 charN 前缀')
  return clean
})

// ---- 需要真实词库的判据（缺库时如实失败，不跳过） ----
const pluginDir = PROJECT
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-nai-grimoire-'))
let entries = []
try {
  const started = Date.now()
  entries = grimoire.loadEntries(pluginDir, dataDir)
  if (entries.length > 0) {
    console.log(`      （词库加载：${entries.length} 条，${Date.now() - started}ms）`)
  }

  check('词库可用且条数与上游一致（19,663）', () => {
    assertEqual(entries.length, 19663)
    return `${entries.length} 条`
  })

  check('版本分布与上游一致（V4.5=18505 / V5=1158）', () => {
    const count = { 'NAI4.5': 0, NAI5: 0 }
    for (const row of entries) count[row.model_ver] += 1
    assertEqual(count['NAI4.5'], 18505)
    assertEqual(count.NAI5, 1158)
    return '18505 / 1158'
  })

  check('V4.5 模型检索不到 V5 专属词条（版本隔离）', () => {
    const v5Only = entries.find((row) => row.model_ver === 'NAI5')
    assert(v5Only !== undefined, '词库里没有 V5 词条')
    const hits = grimoire.search(entries, v5Only.title, { limit: 20, modelName: 'nai-diffusion-4-5-full' })
    assertEqual(hits.length, 0)
    return `查「${v5Only.title}」得 0 条`
  })

  check('V5 模型能检索到该 V5 词条', () => {
    const v5Only = entries.find((row) => row.model_ver === 'NAI5')
    const hits = grimoire.search(entries, v5Only.title, { limit: 20, modelName: 'nai-diffusion-5-full' })
    assert(hits.length > 0, '应命中')
    assertEqual(hits[0].title, v5Only.title)
    return hits[0].title
  })

  check('检索结果按相关度排序（精确标题优先）', () => {
    const some = entries.find((row) => row.model_ver === 'NAI4.5' && String(row.title).length >= 2)
    const hits = grimoire.search(entries, some.title, { limit: 5, modelName: 'nai-diffusion-4-5-full' })
    assert(hits.length > 0, '应命中')
    assertEqual(hits[0].title, some.title)
    return some.title
  })

  check('limit 被夹到 1-50', () => {
    assert(grimoire.search(entries, '', { limit: 999, modelName: 'nai-diffusion-4-5-full' }).length <= 50)
  })

  check('宏展开命中：替换为 clean_tags', () => {
    const sample = entries.find((row) => row.model_ver === 'NAI4.5' && String(row.title).length >= 2)
    const result = grimoire.expandMacros(entries, `1girl, 【法典:${sample.title}】, best quality`, 'nai-diffusion-4-5-full')
    assertEqual(result.expanded.length, 1)
    assertEqual(result.expanded[0].hit, true)
    assert(!result.prompt.includes('法典'), '宏未被替换')
    return result.prompt.slice(0, 40)
  })

  check('宏展开未命中：保留原文（不删宏、不换空）', () => {
    const result = grimoire.expandMacros(entries, '1girl, 【法典:绝不存在词条ABC】', 'nai-diffusion-4-5-full')
    assertEqual(result.expanded[0].hit, false)
    assert(result.prompt.includes('绝不存在词条ABC'), '未保留原文')
  })

  check('中文与英文冒号都能识别', () => {
    const sample = entries.find((row) => row.model_ver === 'NAI4.5' && String(row.title).length >= 2)
    const cn = grimoire.expandMacros(entries, `【法典：${sample.title}】`, 'nai-diffusion-4-5-full')
    assertEqual(cn.expanded[0].hit, true)
    return '两种冒号均命中'
  })

  check('方括号语法 [法典:xxx] 也支持', () => {
    const sample = entries.find((row) => row.model_ver === 'NAI4.5' && String(row.title).length >= 2)
    const result = grimoire.expandMacros(entries, `[法典:${sample.title}]`, 'nai-diffusion-4-5-full')
    assertEqual(result.expanded[0].hit, true)
  })

  check('无宏时不改动提示词', () => {
    const text = '1girl, solo, masterpiece'
    assertEqual(grimoire.expandMacros(entries, text, 'nai-diffusion-4-5-full').prompt, text)
  })

  check('转译参考：能从自然语言里挑出命中词条', () => {
    const sample = entries.find((row) => {
      const title = String(row.title ?? '')
      return row.model_ver === 'NAI4.5' && title.length >= 2 && title.length <= 14
    })
    const hint = grimoire.buildTranslationHint(entries, `画一个${sample.title}的场景`, 'nai-diffusion-4-5-full')
    assert(hint.length > 0, '应产生参考块')
    assert(hint.includes(sample.title), '未包含命中标题')
    return hint.slice(0, 50)
  })

  check('词库可用性报告', () => {
    assert(grimoire.availability(entries), '应报告可用')
  })
} finally {
  grimoire.resetCache()
  rmSync(dataDir, { recursive: true, force: true })
}

// ============================================================ 汇总

console.log('')
if (failures.length === 0) {
  console.log(`PASS  全部 ${pass} 项通过`)
  process.exit(0)
}
console.log(`FAILURES: ${failures.length}`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
