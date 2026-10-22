/**
 * 内置法典词库。
 *
 * 移植自 astrbot_plugin_nai_image v2.9.0 的「内置法典词库」功能。
 *
 * ## 词库是什么
 *
 * 一份随插件分发的 SQLite 库（`data/grimoire.db.gz`，压缩后约 3.6MB，
 * 解压后约 19,663 条），每条记录是一组**经实测可用的 NovelAI 标签**：
 *
 *   id | volume | rating | model_ver | category | title | tags
 *
 * 用户或模型写 `【法典:白裙少女】`，插件就在生图前把这段宏替换成该词条的
 * `clean_tags`（剥离负面提示词与 Steps 等设置行后的正向标签）。
 *
 * ## 版本隔离（这是最容易写错的一点）
 *
 * - **V4.5 只查 V4.5 卷**（18,505 条）
 * - **V5 同查 V5 卷（1,158 条）+ V4.5 卷**，同名词条优先返回 V5 的
 *
 * 反向不成立：V4.5 用不了 V5 专属词条。参考实现里特意注释过——
 * **不能用 `'-5-' in name` 这类子串判断**，因为 V4.5 的 slug
 * `nai-diffusion-4-5-full` 同样含 `-5-`，会被误判成 NAI5，
 * 导致 V4.5 的 18,505 条一条都检索不到。这里照搬它的正则判据。
 *
 * ## DSH 侧的差异
 *
 * 原版解压到 AstrBot 插件数据目录（`StarTools.get_data_dir`）。DSH 没有该
 * 接口，改为解压到 `$DSH_HOME/plugin-data/dsh-nai-image/grimoire.db`，
 * 并保留「临时文件 + 条数校验 + 原子替换」的完整防半截逻辑（照搬）。
 *
 * 原版的 `/法典` 斜杠指令在 DSH 里没有对应物，因此只保留：
 *   - `expandMacros()`  —— 生图前展开 `【法典:词条】`
 *   - `search()`        —— 供 LLM 工具 `nai_search_grimoire` 调用的检索
 *   - `buildTranslationHint()` —— 转译参考（本项目暂无转译，先留能力）
 *
 * ## 依赖
 *
 * 只用 Node 内置模块：`node:zlib`（gunzip）、`node:fs`、`node:path`。
 * SQLite 读取**不引第三方包** —— 见下方 `readEntries` 的说明。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 词库最低可接受条目数；低于它视为解压不完整，需重新解压。 */
const EXPECTED_MIN_ROWS = 19000

/** 词库文件名。 */
const DB_NAME = 'grimoire.db'

/** 宏语法：`【法典:词条名】` 或 `[法典:词条名]`，中英文冒号都认。 */
const MACRO_RE = /[\[【]法典[:：]([^\]】]+)[\]】]/g

/**
 * NAI5 的模型 slug 判据。
 *
 * 形如 `nai-diffusion-5-full` / `nai-diffusion-5-curated` / `nai5`。
 * **不能**用子串 `-5-`：V4.5 的 `nai-diffusion-4-5-full` 也含它。
 */
const NAI5_PATTERNS = [
  /diffusion[-_]5(?:$|[-_])/,
  /(?:^|[-_])nai[-_]?5(?:$|[-_])/,
]

/**
 * 把模型名归一化成词库的 `model_ver`（`NAI4.5` 或 `NAI5`）。
 *
 * @param {string} [modelName] - 上游模型名。
 * @returns {'NAI5'|'NAI4.5'} 词库版本。
 */
export function normalizeModelVer(modelName) {
  const text = String(modelName ?? '').trim().toLowerCase()
  if (text === '5' || text === 'v5' || text === 'nai5') return 'NAI5'
  if (NAI5_PATTERNS.some((pattern) => pattern.test(text))) return 'NAI5'
  return 'NAI4.5'
}

/**
 * 当前模型可用的词库版本，按优先级排列（第一个是模型自身那一卷）。
 *
 * @param {string} [modelName] - 上游模型名。
 * @returns {string[]} 版本列表；空模型名返回空数组（= 不按版本过滤）。
 */
export function allowedModelVers(modelName) {
  if (!modelName) return []
  const locked = normalizeModelVer(modelName)
  return locked === 'NAI5' ? ['NAI5', 'NAI4.5'] : [locked]
}

/**
 * 从解压后的库里读出 `grimoire_entries` 全部行。
 *
 * 用 Node 内置的 `node:sqlite`（v22.5 起可用，本机 v24.19 实测可用）——
 * **不引第三方包**，符合「插件目录没有 node_modules」的硬约束。
 *
 * 只做一次全表读取并按 (路径, mtime, size) 缓存：19k 行约 20MB，
 * 解析一次约百毫秒，相对一次数十秒的生图可忽略。
 *
 * @param {string} dbPath - 解压后的库路径。
 * @returns {Array<object>} 行对象。
 */
function readEntries(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(
      'SELECT id, volume, rating, model_ver, category, title, tags FROM grimoire_entries',
    ).all()
    // DatabaseSync 返回的是普通对象，但 null 字段统一成 undefined 便于调用方判断
    return rows.map((row) => ({
      id: row.id,
      volume: row.volume,
      rating: row.rating,
      model_ver: row.model_ver,
      category: row.category,
      title: row.title,
      tags: row.tags ?? '',
    }))
  } finally {
    db.close()
  }
}

/**
 * 词库缓存：按文件 (路径, mtime, size) 失效。
 */
let cache = { key: '', rows: [] }

/**
 * 拿到可用的词库行；缺失或损坏时尝试从 `data/grimoire.db.gz` 解压。
 *
 * @param {string} pluginDir - 插件目录（`.../dsh-nai-image`）。
 * @param {string} dataDir - 可写数据目录（`$DSH_HOME/plugin-data/dsh-nai-image`）。
 * @returns {Array<object>} 行；不可用时空数组。
 */
export function loadEntries(pluginDir, dataDir) {
  const target = join(dataDir, DB_NAME)

  // 已解压就用；文件消失时才重新解压
  if (existsSync(target) && statSync(target).size > 1_000_000) {
    const stat = statSync(target)
    const key = `${target}|${stat.mtimeMs}|${stat.size}`
    if (cache.key === key) return cache.rows
    const rows = readEntries(target)
    if (rows.length >= EXPECTED_MIN_ROWS) {
      cache = { key, rows }
      return rows
    }
    // 条数不够 = 解压不完整，落到下面重建
  }

  const gz = join(pluginDir, 'data', `${DB_NAME}.gz`)
  if (!existsSync(gz)) return []

  try {
    const buffer = gunzipSync(readFileSync(gz))
    // 临时文件 + 校验 + 原子替换：避免留下半截库（照搬参考实现的做法）
    mkdirSync(dataDir, { recursive: true })
    const tmp = join(dataDir, `.${DB_NAME}.${process.pid}.tmp`)
    try {
      writeFileSync(tmp, buffer)
      if (statSync(tmp).size !== buffer.length) throw new Error('写入长度不符')
      renameSync(tmp, target)
    } finally {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 清理失败不影响结果 */ }
    }
    // 解压完再读：条数不够说明来源文件本身不完整，按不可用处理
    const rows = readEntries(target)
    if (rows.length < EXPECTED_MIN_ROWS) return []
    cache = { key: `${target}|${statSync(target).mtimeMs}|${buffer.length}`, rows }
    return rows
  } catch {
    return []
  }
}

/**
 * 从法典原始词条里提取干净的正向标签。
 *
 * 原始 `tags` 是多行文本，混着负面提示词与 Steps/Sampler 等设置行；
 * 直接拼进生图会污染画面。这里按参考实现的规则逐行过滤。
 *
 * @param {string} rawTags - 原始 tags 字段。
 * @returns {string} 逗号分隔的正向标签。
 */
export function cleanPositiveTags(rawTags) {
  const lines = []
  for (const line of String(rawTags ?? '').split(/\r?\n/)) {
    const text = line.trim()
    if (text.length === 0) continue
    if (/^(负面|negative|Steps:|Sampler:|Prompt Guidance|设置)/i.test(text)) continue
    lines.push(text.replace(/^char\d+[:：]\s*/i, '').replace(/[,，\s]+$/, ''))
  }
  return lines.join(', ')
}

/**
 * 在词库里检索。
 *
 * @param {Array<object>} entries - 词库行。
 * @param {string} query - 查询串（空格/逗号/斜杠分隔的多个词，取前 5 个做 AND）。
 * @param {object} [options] - 选项。
 * @param {number} [options.limit] - 返回条数上限，默认 12，最大 50。
 * @param {string} [options.modelName] - 当前生图模型名，用于版本过滤。
 * @returns {Array<object>} 命中词条（含 clean_tags）。
 */
export function search(entries, query, options = {}) {
  if (entries.length === 0) return []
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 12) || 12, 50))
  const allowed = allowedModelVers(options.modelName)
  const preferred = allowed[0]

  // 版本过滤
  let pool = entries
  if (allowed.length > 0) pool = entries.filter((row) => allowed.includes(row.model_ver))

  const tokens = String(query ?? '').split(/[\s,，/]+/).map((t) => t.trim()).filter(Boolean).slice(0, 5)
  if (tokens.length > 0) {
    pool = pool.filter((row) => tokens.every((token) => {
      const hay = `${row.title ?? ''} ${row.category ?? ''} ${row.tags ?? ''}`
      return hay.includes(token)
    }))
  }

  const first = tokens[0] ?? ''
  const score = (row) => {
    const title = String(row.title ?? '')
    let value = 0
    if (first) {
      if (title === first) value += 100
      else if (title.startsWith(first)) value += 60
      else if (title.includes(first)) value += 40
      if (String(row.category ?? '').includes(first)) value += 20
      // 同名同分时，模型自己那一卷排前面（V5 优先 V5 词条，再回退 V4.5）
      if (preferred && row.model_ver === preferred) value += 15
    } else {
      value = 10
    }
    return value
  }

  return pool
    .map((row) => ({ row, relevance: score(row) }))
    .sort((a, b) => (b.relevance - a.relevance)
      || (String(a.row.title ?? '').length - String(b.row.title ?? '').length)
      || ((a.row.id ?? 0) - (b.row.id ?? 0)))
    .slice(0, limit)
    .map(({ row }) => ({
      id: row.id,
      volume: row.volume,
      rating: row.rating,
      model_ver: row.model_ver,
      category: row.category,
      title: row.title,
      tags: row.tags,
      clean_tags: cleanPositiveTags(row.tags),
    }))
}

/**
 * 展开提示词里的 `【法典:词条名】` 宏。
 *
 * **未命中时保留原文**（不删宏、不换成空串）—— 参考实现如此，且这更安全：
 * 用户能一眼看出「这个词条没查到」，而不是画面莫名少了一块。
 *
 * @param {Array<object>} entries - 词库行。
 * @param {string} prompt - 原始提示词。
 * @param {string} [modelName] - 当前模型名。
 * @returns {{prompt: string, expanded: Array<{keyword: string, hit: boolean}>}} 展开结果。
 */
export function expandMacros(entries, prompt, modelName) {
  const text = String(prompt ?? '')
  const expanded = []
  if (!text.includes('法典:') && !text.includes('法典：')) {
    return { prompt: text, expanded }
  }
  const out = text.replace(MACRO_RE, (_match, keyword) => {
    const word = String(keyword).trim()
    const [hit] = search(entries, word, { limit: 1, modelName })
    if (hit !== undefined && hit.clean_tags) {
      expanded.push({ keyword: word, hit: true })
      return hit.clean_tags
    }
    expanded.push({ keyword: word, hit: false })
    return word
  })
  return { prompt: out, expanded }
}

/**
 * 从自然语言里提取命中的词条，供（未来的）转译模型参考。
 *
 * @param {Array<object>} entries - 词库行。
 * @param {string} text - 自然语言描述。
 * @param {string} [modelName] - 当前模型名。
 * @param {number} [maxMatches] - 最多几条，默认 5。
 * @returns {string} 追加到提示词末尾的参考块；无命中返回空串。
 */
export function buildTranslationHint(entries, text, modelName, maxMatches = 5) {
  const source = String(text ?? '').trim()
  if (source.length < 2 || entries.length === 0) return ''
  const allowed = allowedModelVers(modelName)
  const pool = allowed.length > 0
    ? entries.filter((row) => allowed.includes(row.model_ver))
    : entries

  // 只挑长度 2–14 的标题参与匹配（与参考实现一致）
  const candidates = pool.filter((row) => {
    const title = String(row.title ?? '')
    return title.length >= 2 && title.length <= 14 && source.includes(title)
  })
  candidates.sort((a, b) => String(b.title).length - String(a.title).length || (a.id ?? 0) - (b.id ?? 0))

  const skip = new Set(['其他', '杂项', '正面', '侧面', '背面', '室内', '室外', '日常', '内衣', '泳装', '睡衣'])
  const matched = candidates.filter((row) => !skip.has(row.title)).slice(0, Math.max(1, maxMatches))
  if (matched.length === 0) return ''

  const locked = allowed[0] ?? 'NAI4.5'
  const label = locked === 'NAI5' ? 'NAI5 + 兼容的 NAI4.5' : locked
  const lines = [`\n\n【NovelAI (${label}) 法典命中词条参考（若与用户意图一致，请优先采用或融合以下标签）】：`]
  for (const row of matched) {
    let clean = cleanPositiveTags(row.tags)
    if (clean.length > 260) clean = `${clean.slice(0, 260)}...`
    lines.push(`- 《${row.title}》(${row.volume} / ${row.category}): ${clean}`)
  }
  return lines.join('\n')
}

/**
 * 词库是否可用（供状态展示）。
 *
 * 判据是「已成功加载过且当前缓存非空」—— 不用单独的「路径已解析」标志位，
 * 那种标志很容易写了却忘了赋值，最后变成一个恒假的摆设。
 *
 * @param {Array<object>} entries - 词库行。
 * @returns {boolean} 是否可用。
 */
export function availability(entries) {
  return Array.isArray(entries) && entries.length > 0 && cache.rows.length > 0
}

/** 测试用：清空模块级缓存。 */
export function resetCache() {
  cache = { key: '', rows: [] }
}
