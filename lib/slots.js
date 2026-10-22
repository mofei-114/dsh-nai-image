/**
 * 画风槽位。
 *
 * 移植自 astrbot_plugin_nai_image v2.9.0 的「画风槽位」功能。
 *
 * ## 槽位是什么
 *
 * 一条槽位把三样东西绑在一起：
 *
 *   - **画风名**   —— 用户看得懂的名字（如「韩漫小清新风」），工具参数与下拉都用它
 *   - **适用模型** —— 选中该槽位时替换 `model` / `openaiModel`
 *   - **画师串**   —— 选中该槽位时替换 `artist`
 *
 * 这样一次选择就能同时决定「用什么底模 + 配什么画师串」，而不是让用户
 * 分别去改三个字段、还容易配错组合。
 *
 * ## 与原版的差异（DSH 侧）
 *
 * 原版把槽位存在 AstrBot 插件配置的 `template_list` 里（可在设置页增删改），
 * 并额外维护一个「正式生图启用槽位」下拉、还要把槽位名回写进 schema 的
 * labels（`_sync_slot_labels`）。DSH 没有那套 template_list 表单，也**不允许
 * 插件在运行时改写自己的 schema**，因此这里改为：
 *
 *   - 槽位表存在配置字段 `artistSlots`（JSON 字符串）里 —— 这是唯一数据源；
 *   - 「启用哪个槽位」由 `activeSlot`（槽位名）指出，不依赖下拉回写；
 *   - 提供 `parseSlots` / `serializeSlots` / `findSlot` 三个纯函数，
 *     便于单测直接覆盖，无需起插件。
 *
 * ## 为什么用 JSON 字符串而不是结构化数组
 *
 * schemastery 的 `z.array(z.object(...))` 在 DSH 的 GUI 表单里会渲染成
 * 可增删的表格，但本项目其余字段全是扁平标量，混用两种形态会让「手改
 * cordis.patch.yml」这条路径变得很难写。用 JSON 字符串可以让配置保持扁平，
 * 同时在设置页的描述里给出可复制的样例。
 */

import { DEFAULT_ARTISTS, IMAGE_STYLES } from './constants.js'

/** 槽位缺省绑定的模型（与原版一致：V4.5 full）。 */
export const DEFAULT_SLOT_MODEL = 'nai-diffusion-4-5-full'

/** 槽位名长度上限，防止把整段配置塞进名字里。 */
const MAX_SLOT_NAME = 60
/** 画师串长度上限，与主提示词上限同量级。 */
const MAX_SLOT_ARTISTS = 4000

/**
 * 把一条槽位记录规整成固定结构。
 *
 * 三条字段全空视为「这不是一条槽位」，返回 undefined 由调用方丢弃 ——
 * 与参考实现 `_normalize_slot` 同语义（空记录不该占一个位置）。
 *
 * @param {unknown} item - 任意输入。
 * @returns {{name: string, model: string, artists: string}|undefined} 规整后的槽位。
 */
export function normalizeSlot(item) {
  if (item === null || typeof item !== 'object') return undefined
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  const model = typeof item.model === 'string' ? item.model.trim() : ''
  const artists = typeof item.artists === 'string' ? item.artists.trim() : ''
  if (name.length === 0 && model.length === 0 && artists.length === 0) return undefined
  return {
    name: (name || '未命名画风').slice(0, MAX_SLOT_NAME),
    model,
    artists: artists.slice(0, MAX_SLOT_ARTISTS),
  }
}

/**
 * 规整整个槽位表；重名时保留第一个，后面的丢弃并计数。
 *
 * 重名必须处理：`activeSlot` 是按名字查的，两个同名槽位会让「选中的到底是
 * 哪一个」变得不确定。参考实现用 id 排序规避，DSH 侧直接用名字，故去重。
 *
 * @param {unknown} raw - 任意输入（通常是配置里的 JSON 字符串）。
 * @returns {{slots: Array<{name: string, model: string, artists: string}>, dropped: number}} 结果。
 */
export function normalizeSlots(raw) {
  const list = Array.isArray(raw) ? raw : []
  const slots = []
  const seen = new Set()
  let dropped = 0
  for (const item of list) {
    const slot = normalizeSlot(item)
    if (slot === undefined) continue
    if (seen.has(slot.name)) {
      dropped += 1
      continue
    }
    seen.add(slot.name)
    slots.push(slot)
  }
  return { slots, dropped }
}

/**
 * 内置画风预置：每个内置画风一条槽位。
 *
 * 「当前生效画风排第一位」是参考实现的刻意设计 —— 保证**刚开启槽位功能时
 * 第一次出图的结果与开启前完全一致**，用户不会因为打开一个开关而突然
 * 换了画风。这里照搬该行为。
 *
 * @param {string} currentStyle - 当前 `imageStyle` 键（如 'vertical'）。
 * @param {string} customArtists - `imageStyle === 'custom'` 时用的画师串。
 * @returns {Array<{name: string, model: string, artists: string}>} 槽位表。
 */
export function defaultSlots(currentStyle, customArtists = '') {
  const keys = Object.keys(IMAGE_STYLES)
  const current = keys.includes(currentStyle) ? currentStyle : 'vertical'
  const ordered = [current, ...keys.filter((key) => key !== current)]
  return ordered.map((key) => ({
    name: IMAGE_STYLES[key] ?? key,
    model: DEFAULT_SLOT_MODEL,
    artists: key === 'custom' ? String(customArtists ?? '') : (DEFAULT_ARTISTS[key] ?? ''),
  }))
}

/**
 * 解析配置里的槽位表。
 *
 * 三种输入都接受，且**坏 JSON 不抛错**——它来自用户可编辑的文本框，
 * 一个手滑的逗号不该让插件起不来；改为返回空表并让调用方记日志。
 *
 * @param {unknown} raw - JSON 字符串 | 数组 | 空。
 * @returns {{slots: Array<object>, error: string|undefined}} 结果。
 */
export function parseSlots(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { slots: [], error: undefined }
  }
  if (Array.isArray(raw)) return normalizeSlots(raw)
  if (typeof raw !== 'string') {
    return { slots: [], error: `槽位表必须是 JSON 字符串或数组，收到 ${typeof raw}` }
  }
  const text = raw.trim()
  if (text.length === 0) return { slots: [], error: undefined }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { slots: [], error: `槽位表不是合法 JSON：${String(error?.message ?? error)}` }
  }
  if (!Array.isArray(parsed)) return { slots: [], error: '槽位表必须是数组' }
  return normalizeSlots(parsed)
}

/**
 * 序列化槽位表，用于回写配置（GUI 表单编辑后）。
 *
 * @param {Array<object>} slots - 槽位表。
 * @returns {string} 紧凑 JSON。
 */
export function serializeSlots(slots) {
  const { slots: normalized } = normalizeSlots(slots)
  return JSON.stringify(normalized)
}

/**
 * 按名字查槽位（大小写与首尾空白不敏感）。
 *
 * @param {Array<{name: string}>} slots - 槽位表。
 * @param {string} name - 槽位名。
 * @returns {object|undefined} 命中的槽位。
 */
export function findSlot(slots, name) {
  const target = String(name ?? '').trim().toLowerCase()
  if (target.length === 0) return undefined
  return slots.find((slot) => slot.name.trim().toLowerCase() === target)
}

/**
 * 解析一次生图实际使用的「画风名 / 模型 / 画师串」。
 *
 * 优先级（高 → 低）：
 *   1. 槽位（`enableArtistSlots` 为真且指定的槽位存在）
 *   2. 调用方单次传入的 `style`（仅影响画师串，不改模型）
 *   3. 配置默认值（`imageStyle` + 对应画师串 + 配置模型）
 *
 * **槽位未命中不能静默退回默认值** —— 用户明明选了某个画风却拿到别的画风，
 * 是最难自查的一类问题。因此这里返回 `missing` 标记，由调用方决定
 * 是报错还是告警（见 lib/index.js：告警并在摘要里说明）。
 *
 * @param {object} options - 解析输入。
 * @param {Array<object>} options.slots - 槽位表。
 * @param {boolean} options.enabled - 是否启用槽位。
 * @param {string} options.activeSlot - 选中的槽位名。
 * @param {string} options.styleOverride - 单次调用传入的画风名（可空）。
 * @param {string} options.fallbackModel - 槽位不可用时的模型。
 * @param {string} options.fallbackArtists - 槽位不可用时的画师串。
 * @returns {{model: string, artists: string, slotName: string|undefined, missing: string|undefined}} 生效值。
 */
export function resolveStyleSelection(options) {
  const {
    slots = [], enabled = false, activeSlot = '', styleOverride = '',
    fallbackModel = '', fallbackArtists = '',
  } = options

  // 1) 槽位：本次调用显式点名的优先，其次是配置里选中的槽位
  if (enabled) {
    const wanted = styleOverride.trim() || activeSlot.trim()
    if (wanted.length > 0) {
      const hit = findSlot(slots, wanted)
      if (hit !== undefined) {
        return {
          model: hit.model || fallbackModel,
          artists: hit.artists,
          slotName: hit.name,
          missing: undefined,
        }
      }
      // 没命中：如实报告缺失，由调用方决定报错还是告警。
      // 绝不静默换成默认画风 —— 那会让「我明明选了 X」变成无从自查的问题。
      return { model: fallbackModel, artists: fallbackArtists, slotName: undefined, missing: wanted }
    }
  }

  return {
    model: fallbackModel,
    artists: fallbackArtists,
    slotName: undefined,
    missing: undefined,
  }
}
