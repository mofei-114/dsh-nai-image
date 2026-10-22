/**
 * 多角色块。
 *
 * 移植自 astrbot_plugin_nai_image v2.9.0 的「多角色块」功能。
 *
 * ## 解决什么问题
 *
 * 单段 prompt 描述两个角色时，上游会把两个人的特征**互相串色**（同一个
 * `1girl` 标签被应用到两张脸上）。多角色块把每个角色拆成独立标注入：
 *
 *   - **OpenAI 兼容通道** → 原生 `characterPrompts` + `use_coords` 坐标块，
 *     两个角色分别居中于左右半幅
 *   - **直连通道** → 上游 `{人物 [...], {位置左} 人物}` 语法
 *
 * ## 开关语义（照搬参考实现）
 *
 * `enableCharacterBlocks` 关闭时，**必须忽略** `char1_prompt` / `char2_prompt`
 * 参数并留日志 —— 静默接受但不生效是最难自查的一类问题。
 */

/** 最多支持的角色数。 */
export const MAX_CHARACTERS = 2

/** 双角色时的坐标（左 25% / 右 75%，垂直居中）。 */
const COORDS_TWO = [[0.25, 0.5], [0.75, 0.5]]
/** 单角色时的坐标（画面中央）。 */
const COORDS_ONE = [[0.5, 0.5]]

/**
 * 规整角色块输入：去空白、去空项、截到上限、限长。
 *
 * @param {Array<unknown>} raw - 原始输入（通常是 [char1_prompt, char2_prompt]）。
 * @param {number} [maxLength] - 单块最大字符数。
 * @returns {string[]} 有效角色块。
 */
export function normalizeCharacterBlocks(raw, maxLength = 2000) {
  const out = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (text.length === 0) continue
    out.push(text.slice(0, maxLength))
    if (out.length >= MAX_CHARACTERS) break
  }
  return out
}

/**
 * 构造 OpenAI 兼容通道的角色坐标块。
 *
 * 需要同时设置 `use_coords: true` —— 只给 `characterPrompts` 而上游不知道
 * 使用坐标时，部分部署会忽略整块（参考实现里两者是配套的）。
 *
 * @param {string[]} blocks - 已规整的角色块。
 * @returns {{use_coords: boolean, characterPrompts: Array<object>, v4_prompt?: object}|undefined} 参数增量。
 */
export function buildOpenAICharacterParams(blocks) {
  if (blocks.length === 0) return undefined
  const coords = blocks.length === 1 ? COORDS_ONE : COORDS_TWO
  const entries = blocks.map((block, index) => {
    const [x, y] = coords[index] ?? coords[coords.length - 1]
    return { prompt: block, x, y }
  })
  return {
    use_coords: true,
    characterPrompts: entries.map((entry) => ({
      prompt: entry.prompt,
      center: { x: entry.x, y: entry.y },
    })),
    // v4_prompt 是 NAI V4 系列的结构化提示词；部分上游要求它和
    // characterPrompts 保持一致，否则坐标块被忽略。base_caption 由调用方补。
    v4_prompt: {
      char_captions: entries.map((entry) => ({
        char_caption: entry.prompt,
        centers: [{ x: entry.x, y: entry.y }],
      })),
    },
  }
}

/**
 * 构造直连通道的角色块语法。
 *
 * 直连（传统 GET / 任务接口）没有坐标数组，改用上游支持的
 * `{人物 [tags], {位置左} 人物}` 文本语法表达角色归属。
 *
 * @param {string[]} blocks - 已规整的角色块。
 * @returns {string} 追加到主提示词末尾的片段；无角色块时返回空串。
 */
export function buildDirectCharacterSuffix(blocks) {
  if (blocks.length === 0) return ''
  const wrapped = blocks.map((block, index) => {
    if (blocks.length === 1) return `{人物 [${block}] 人物}`
    const position = index === 0 ? '{位置左}' : '{位置右}'
    return `{人物 [${block}], ${position} 人物}`
  })
  return wrapped.join(', ')
}

/**
 * 把角色块并入主提示词（直连通道用）。
 *
 * @param {string} prompt - 主提示词。
 * @param {string[]} blocks - 已规整的角色块。
 * @returns {string} 合并后的提示词。
 */
export function mergeDirectPrompt(prompt, blocks) {
  const suffix = buildDirectCharacterSuffix(blocks)
  if (suffix.length === 0) return prompt
  const head = String(prompt ?? '').trim().replace(/[,，\s]+$/, '')
  return head.length === 0 ? suffix : `${head}, ${suffix}`
}
