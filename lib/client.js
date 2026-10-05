/**
 * dsh-nai-image 的浏览器半侧：在「插件」页里给本插件渲染一个配置表单。
 *
 * ## 为什么必须有这个文件
 *
 * DSH 的配置表单机制是「宿主提供数据 + 插件自绘界面」：
 *   - 宿主（dsh-settings）把声明了 `.volatile()` 的 Config 字段投影成
 *     `ctx.remote.settings.describe()` 的数据；
 *   - 但**没有任何通用渲染器**。dsh-settings 的 README 明说 `autoGenerate`
 *     「目前没有已发布的客户端这样做」，所以官方每个配置页都是插件自带的
 *     浏览器半侧（shell / agent-loop / subagent / web-search 四个都是）。
 *
 * 本文件就是那一半：注册进「插件」页的 `plugins.item` slot，用自己的
 * 文案与控件渲染 `dsh-nai-image` 这个 Loader 条目的配置。
 *
 * ## 为什么手写 bundle 而不构建
 *
 * bundle 就是 `exports['./client']` 指向的普通 JS，格式是
 * `window.__ModuleLoader__.load({ id, factory })`。不引入 tsdown/vite
 * 就不必给插件加构建链——代价是不能用 JSX，只能 `createElement`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-nai-image',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      SettingsForm,
      SettingsFormModel,
      SettingsValueField,
      SettingsSecretField,
      settingsNumberField,
      settingsTextField,
      ImageLightbox,
    } = primitives

    const h = React.createElement

    /**
     * 表单编辑的 Loader 条目 id。
     * 必须与 cordis.patch.yml 里那条 insert 的 `id` 完全一致 ——
     * configForms 就是按这个 id 寻址的。
     */
    const NS = 'dsh-nai-image'

    /** 字典命名空间（本插件自有）。 */
    const LOCALE_NS = 'dsh-nai-image'

    // ------------------------------------------------------------ 字典
    const zh = {
      title: 'NovelAI 生图',
      description: '用 NovelAI（经中转站）生图：直连与 OpenAI 兼容两条通道。',
      unavailable: '宿主未提供该插件的设置，暂时无法配置。若刚装好，重启一次 DSH。',
      readOnly: '本部署的设置为只读。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '请填数字；留空表示使用默认值。',
      overridden: '已覆盖',
      reset: '恢复默认',

      groupChannel: '调用通道',
      groupDirect: 'NAI 直连',
      groupOpenai: 'OpenAI 兼容',
      groupRender: '生成参数',
      groupNetwork: '网络',
      groupArchive: '归档',
      groupMisc: '开关',

      callMode: '调用模式',
      callModeHint: 'direct = NAI 直连（任务接口优先，GET 兜底）；openai = OpenAI 兼容中转站。改这里不会自动切换下面的字段，两条通道的配置可以都留着。',
      baseUrl: '生图服务地址',
      baseUrlHint: '上游是第三方中转站，不是 NovelAI 官方 API。',
      token: '生图 Token',
      tokenHint: '直连模式必填。到 nai.sta1n.cn 取 toUserId 那一串。出于安全考虑，已保存的 Token 不会回显——留空表示不修改。',
      secretConfigured: '已配置',
      secretNotConfigured: '未配置',
      model: '直连模型',
      openaiBaseUrl: 'OpenAI 兼容接口地址',
      openaiBaseUrlHint: '填到 /v1 为止即可，插件自己补 /images/generations。',
      openaiApiKey: 'OpenAI 兼容密钥',
      openaiApiKeyHint: '部分中转站不校验，可留空。已保存的密钥不会回显。',
      openaiModel: 'OpenAI 兼容模型名',

      imageStyle: '画风',
      imageStyleHint: '取值：vertical / comicDoujin / r18 / lolita25d / anime / galgame / custom。注意上游命名反直觉：r18 是「2.5D唯美风」、anime 是「本子里番风」。',
      customArtists: '自定义画师串',
      customArtistsHint: '仅画风为 custom 时生效。',
      imageSize: '画幅',
      imageSizeHint: '直连用中文分档名：竖图/横图/方图/2K竖图/2K横图/2K方图/4K竖图/4K横图/4K方图。OpenAI 通道可直接写像素，如 832x1216。',
      steps: '采样步数',
      stepsHint: '1-50。直连任务接口支持满 50；走 GET 兜底时上游按 28 截断。步数越高越慢、越贵。',
      scale: '提示词引导强度',
      scaleHint: '直连 0-20；OpenAI 通道上游会收敛到 0-10。',
      cfg: 'CFG Rescale',
      cfgHint: '0-1。',
      sampler: '采样器',
      samplerHint: 'k_dpmpp_2m_sde / k_dpmpp_2m / k_dpmpp_sde / k_dpmpp_2s_ancestral / k_euler_ancestral / k_euler',
      noiseSchedule: '噪声调度',
      noiseScheduleHint: 'karras / native / exponential / polyexponential',
      negative: '反向提示词',
      negativeHint: '留空则使用参考实现的内置默认反向词。',
      seed: '随机种子',
      seedHint: '-1 表示每次随机；固定同一个种子可复现同一张图。',
      defaultCount: '默认生成张数',
      defaultCountHint: '工具未指定 count 时用这个值，1-6。',

      requestTimeout: '请求超时（秒）',
      requestTimeoutHint: '30-600。直连下同时是任务轮询的总等待上限。',
      maxRetries: '失败重试次数',
      maxRetriesHint: '0-3。仅 OpenAI 通道生效，且只对 408/429/502/503/504 与瞬时故障文案重试。',

      saveImageHistory: '保存生成的图片',
      saveImageHistoryHint: 'true / false。开启后原图归档到磁盘。',
      imageHistoryDir: '归档目录',
      imageHistoryDirHint: '留空 = $DSH_HOME/plugin-data/dsh-nai-image/image_history',
      imageHistoryLimit: '最多保留张数',
      imageHistoryLimitHint: '0 表示只保存不清理。',

      enableTool: '启用生图工具',
      enableToolHint: 'true / false。改这项需要重启 DSH。',
      enableQuotaTool: '启用额度查询工具',
      enableQuotaToolHint: 'true / false。改这项需要重启 DSH。',
      verbose: '输出插件日志',
      verboseHint: 'true / false。',

      // ------------------------------------------------------ 工具调用行
      'state.preparing': '准备中',
      'state.running': '生成中…',
      'state.ok': '完成',
      'state.error': '失败',
      'state.stopped': '已中断',
      rowCost: '本次消耗',
      rowCostUnknown: '上游未返回',
      rowBalance: '剩余点数',
      rowSize: '画幅',
      rowSteps: '步数',
      rowCount: '张数',
      imageLabel: '生成的图片',
      imageLoading: '加载中…',
      imageFailed: '图片加载失败',
      imageOpen: '点击放大',
      imageClose: '关闭',
    }

    const en = {
      title: 'NovelAI image generation',
      description: 'Generate images with NovelAI (via a relay): direct and OpenAI-compatible channels.',
      unavailable: 'The deployment does not expose this plugin’s settings right now. Restart DSH if you just installed it.',
      readOnly: 'This deployment stores settings read-only.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      overridden: 'Overridden',
      reset: 'Reset to default',

      groupChannel: 'Channel',
      groupDirect: 'NAI direct',
      groupOpenai: 'OpenAI-compatible',
      groupRender: 'Generation',
      groupNetwork: 'Network',
      groupArchive: 'Archive',
      groupMisc: 'Switches',

      callMode: 'Call mode',
      callModeHint: 'direct = NAI direct (jobs API first, GET fallback); openai = OpenAI-compatible relay. Switching does not clear the other channel’s fields.',
      baseUrl: 'Service base URL',
      baseUrlHint: 'The upstream is a third-party relay, not the official NovelAI API.',
      token: 'Generation token',
      tokenHint: 'Required for direct mode. A saved token is never echoed back — leaving this blank means “do not change”.',
      secretConfigured: 'configured',
      secretNotConfigured: 'not configured',
      model: 'Direct model',
      openaiBaseUrl: 'OpenAI-compatible base URL',
      openaiBaseUrlHint: 'Stop at /v1; the plugin appends /images/generations.',
      openaiApiKey: 'OpenAI-compatible key',
      openaiApiKeyHint: 'Some relays do not check it. A saved key is never echoed back.',
      openaiModel: 'OpenAI-compatible model',

      imageStyle: 'Style',
      imageStyleHint: 'vertical / comicDoujin / r18 / lolita25d / anime / galgame / custom.',
      customArtists: 'Custom artist tags',
      customArtistsHint: 'Only used when the style is custom.',
      imageSize: 'Size',
      imageSizeHint: 'Direct mode uses Chinese tiers (竖图/横图/方图/2K…/4K…). The OpenAI channel accepts pixels such as 832x1216.',
      steps: 'Sampling steps',
      stepsHint: '1-50. The jobs API supports the full range; the GET fallback is truncated to 28 upstream.',
      scale: 'Prompt guidance',
      scaleHint: '0-20 for direct; the OpenAI channel clamps to 0-10 upstream.',
      cfg: 'CFG rescale',
      cfgHint: '0-1.',
      sampler: 'Sampler',
      samplerHint: 'k_dpmpp_2m_sde / k_dpmpp_2m / k_dpmpp_sde / k_dpmpp_2s_ancestral / k_euler_ancestral / k_euler',
      noiseSchedule: 'Noise schedule',
      noiseScheduleHint: 'karras / native / exponential / polyexponential',
      negative: 'Negative prompt',
      negativeHint: 'Empty uses the built-in default negative prompt.',
      seed: 'Seed',
      seedHint: '-1 randomises each run; a fixed seed reproduces the same image.',
      defaultCount: 'Default image count',
      defaultCountHint: 'Used when the tool omits count, 1-6.',

      requestTimeout: 'Request timeout (s)',
      requestTimeoutHint: '30-600. In direct mode this is also the job-polling deadline.',
      maxRetries: 'Retry attempts',
      maxRetriesHint: '0-3. OpenAI channel only, and only for 408/429/502/503/504 plus transient-failure wording.',

      saveImageHistory: 'Archive generated images',
      saveImageHistoryHint: 'true / false. Writes each generated image to disk.',
      imageHistoryDir: 'Archive directory',
      imageHistoryDirHint: 'Empty = $DSH_HOME/plugin-data/dsh-nai-image/image_history',
      imageHistoryLimit: 'Archive limit',
      imageHistoryLimitHint: '0 keeps everything.',

      enableTool: 'Enable the generation tool',
      enableToolHint: 'true / false. Requires a DSH restart.',
      enableQuotaTool: 'Enable the quota tool',
      enableQuotaToolHint: 'true / false. Requires a DSH restart.',
      verbose: 'Plugin logging',
      verboseHint: 'true / false.',

      // ------------------------------------------------------ tool call row
      'state.preparing': 'Preparing',
      'state.running': 'Generating…',
      'state.ok': 'Done',
      'state.error': 'Failed',
      'state.stopped': 'Stopped',
      rowCost: 'Cost',
      rowCostUnknown: 'upstream did not report',
      rowBalance: 'Remaining',
      rowSize: 'Size',
      rowSteps: 'Steps',
      rowCount: 'Count',
      imageLabel: 'Generated image',
      imageLoading: 'Loading…',
      imageFailed: 'Image failed to load',
      imageOpen: 'Click to enlarge',
      imageClose: 'Close',
    }

    /**
     * 表单分区：只影响排版，不影响写入。
     * 每个条目是 [字段名, 控件类型, 文案键]；控件类型决定用哪个转换器。
     */
    const GROUPS = [
      { title: 'groupChannel', fields: [['callMode', 'text']] },
      {
        title: 'groupDirect',
        fields: [['baseUrl', 'text'], ['token', 'secret'], ['model', 'text']],
      },
      {
        title: 'groupOpenai',
        fields: [['openaiBaseUrl', 'text'], ['openaiApiKey', 'secret'], ['openaiModel', 'text']],
      },
      {
        title: 'groupRender',
        fields: [
          ['imageStyle', 'text'], ['customArtists', 'text'], ['imageSize', 'text'],
          ['steps', 'number'], ['scale', 'number'], ['cfg', 'number'],
          ['sampler', 'text'], ['noiseSchedule', 'text'], ['negative', 'text'],
          ['seed', 'number'], ['defaultCount', 'number'],
        ],
      },
      {
        title: 'groupNetwork',
        fields: [['requestTimeout', 'number'], ['maxRetries', 'number']],
      },
      {
        title: 'groupArchive',
        fields: [['saveImageHistory', 'text'], ['imageHistoryDir', 'text'], ['imageHistoryLimit', 'number']],
      },
      {
        title: 'groupMisc',
        fields: [['enableTool', 'text'], ['enableQuotaTool', 'text'], ['verbose', 'text']],
      },
    ]

    /** 所有受控字段名，顺序即分区顺序。 */
    const FIELDS = GROUPS.flatMap((g) => g.fields.map(([f]) => f))

    /** secret 字段：走写-only 控件，明文不从宿主读回。 */
    const SECRET_FIELDS = GROUPS.flatMap((g) => g.fields.filter(([, k]) => k === 'secret').map(([f]) => f))

    /** 数值字段。 */
    const NUMBER_FIELDS = new Set(GROUPS.flatMap((g) => g.fields.filter(([, k]) => k === 'number').map(([f]) => f)))

    /**
     * secret 字段 → credentials 域里的引用名。
     *
     * 官方做法是「secret 不进 settings 明文，走 credentials 域」
     * （见 ui-settings-web-search 的 apiKey）。这里沿用同一套路：
     * 表单只负责收集明文，落盘由 credentials 域负责。
     */
    const SECRET_REFS = {
      token: 'NAI_IMAGE_TOKEN',
      openaiApiKey: 'NAI_IMAGE_OPENAI_KEY',
    }

    /** 每个字段的转换器，供 SettingsFormModel 解析草稿。 */
    function specFor(field) {
      return NUMBER_FIELDS.has(field) ? settingsNumberField(field) : settingsTextField(field)
    }

    /**
     * 表单外壳文案。SettingsForm 需要这一组标签。
     * @param t - 本页的字典读取器。
     * @returns 标签集合。
     */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /**
     * 桥接 settings scope、credentials 域与页面控件。
     *
     * 两条写入通道：
     *   - 普通字段 → settings 命名空间（`form` 的 mutate）
     *   - secret 字段 → credentials 域（`form` 的第三参数 write 回调）
     * 二者共用同一次保存，所以「填 token 同时改画风」是一次操作。
     */
    class CardController {
      /**
       * @param scope - configForms.get(NS) 返回的表单 scope。
       * @param ctx - 浏览器插件上下文（需要 remote.credentials）。
       */
      constructor(scope, ctx) {
        this.scope = scope
        this.ctx = ctx
        /** 每个 secret 引用的当前状态，按引用名缓存。 */
        this.credentials = new Map()

        // 第三参数必须是 { field, write } 形态。
        // 传字符串数组会让 plan() 里 secret.write 变成 undefined，
        // 保存时抛错、界面显示「本部署没有接受这些值」—— 踩过这个坑。
        this.form = new SettingsFormModel(
          scope,
          FIELDS.map(specFor),
          SECRET_FIELDS.map((field) => ({
            field,
            write: (text) => this.writeSecret(field, text),
          })),
        )
        this.store = this.form.bind(() => this.projection())
        this.unsubscribe = scope.subscribe(() => {
          this.refreshCredentials()
        })
        this.refreshCredentials()
      }

      /** 当前投影：外壳状态 + 普通字段 + secret 状态。 */
      projection() {
        const out = { ...this.form.shell() }
        for (const field of FIELDS) out[field] = this.form.field(field)
        for (const field of SECRET_FIELDS) {
          const state = this.credentials.get(SECRET_REFS[field])
          // 控件要的是「已配置 / 未配置」，不是明文。
          out[`${field}Configured`] = state?.configured === true
          out[`${field}Writable`] = state?.writable !== false
        }
        return out
      }

      /**
       * 写入一个 secret。
       *
       * @param {string} field - 字段名。
       * @param {string} value - 用户输入的明文。
       * @returns {Promise<boolean>} 宿主是否确认已配置。
       */
      async writeSecret(field, value) {
        const ref = SECRET_REFS[field]
        if (ref === undefined) return false
        await this.ctx.remote.credentials.set(ref, value)
        await this.refreshCredentials()
        return this.credentials.get(ref)?.configured === true
      }

      /** 从 credentials 域读每个 secret 的存在性。 */
      async refreshCredentials() {
        const refs = SECRET_FIELDS.map((f) => SECRET_REFS[f]).filter((r) => typeof r === 'string')
        if (refs.length === 0) return
        try {
          const response = await this.ctx.remote.credentials.describe(refs)
          if (!response.ok) return
          let changed = false
          for (const ref of refs) {
            const view = response.value?.[ref]
            const next = { configured: view?.configured ?? false, writable: view?.writable ?? true }
            const previous = this.credentials.get(ref)
            if (previous === undefined || previous.configured !== next.configured || previous.writable !== next.writable) {
              this.credentials.set(ref, next)
              changed = true
            }
          }
          if (changed) this.store.set(this.projection())
        } catch {
          // credentials 域不可用时保持上次状态，不阻断表单其余部分
        }
      }

      /** slot 注册要注入的面。 */
      inject() {
        return {
          hooks: { card: this.store },
          ...this.form.actions(),
        }
      }

      /** 释放订阅。 */
      dispose() {
        this.form.dispose()
      }
    }

    /**
     * 渲染一个分区标题。
     * @param t - 字典读取器。
     * @param key - 分组文案键。
     * @returns 标题节点。
     */
    function groupHeading(t, key) {
      return h('h4', { className: 'nai-group-title', key }, t(key))
    }

    /**
     * 渲染一个普通字段（text 或 number）。
     */
    function valueField(t, props, field, state, kind) {
      return h(SettingsValueField, {
        key: field,
        id: `nai-${field}`,
        label: t(field),
        hint: t(`${field}Hint`),
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        numeric: kind === 'number',
        disabled: !state.writable,
        ...state[field],
        onEdit: (text) => props.edit(field, text),
        onReset: () => props.resetField(field),
      })
    }

    /**
     * 渲染一个 secret 字段（写-only）。
     *
     * 控件显示状态标签而不是明文：secret 走 credentials 域，
     * 表单只从那里读「配没配」，永远拿不到值。
     *
     * @param t - 字典读取器。
     * @param props - 页面 props。
     * @param field - 字段名。
     * @param state - 表单投影。
     * @returns 控件节点。
     */
    function secretField(t, props, field, state) {
      const configured = state[`${field}Configured`] === true
      return h(SettingsSecretField, {
        key: field,
        id: `nai-${field}`,
        label: t(field),
        hint: t(`${field}Hint`),
        // SettingsSecretField 的真实 props：configured 决定标签色调，stateLabel 是标签文本。
        configured,
        stateLabel: configured ? t('secretConfigured') : t('secretNotConfigured'),
        disabled: !state.writable || state[`${field}Writable`] === false,
        text: state[field]?.text ?? '',
        onEdit: (text) => props.edit(field, text),
      })
    }

    /**
     * 页面组件：`view === 'summary'` 时给一行说明，否则给完整表单。
     * @param props - 页面传入的视图、字典、快照与动作。
     * @returns React 节点。
     */
    function NaiImageCard(props) {
      const t = props.t
      const state = props.useCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')

      const children = []
      for (const group of GROUPS) {
        children.push(groupHeading(t, group.title))
        for (const [field, kind] of group.fields) {
          children.push(kind === 'secret'
            ? secretField(t, props, field, state)
            : valueField(t, props, field, state, kind))
        }
      }

      return h(SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children,
      })
    }

    /**
     * 需要客户端服务：slot 注册、字典、配置表单、凭据域。
     *
     * `remote.credentials` 是 secret 的落盘通道 —— token 不进 settings 明文。
     */
    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

    /**
     * 工具调用行：参数摘要 + 生图结果里的图片。
     *
     * ## 为什么图片不能走 `tool.call.images`
     *
     * 那是「工具卡片内嵌图片」的官方通路，但它要求注册方**声明该子槽**，
     * 而子槽声明确实是全局独占的（`dsh-client-ui-slots`：
     * `slot "…" is already declared (by …)` 直接抛错）。它已被
     * `read-image-toolview` 占用，我们抢先声明会让客户端插件加载失败。
     *
     * 更关键的是：**注册这个 keyed key 会把通用行顶掉**
     * （`renderSlot('tool.call.toolview', owner, { fallback: GenericToolCard })`）。
     * 而通用行本身也不渲染图片（`ToolRow` 的 `imageBody` 只有 `ReadImageRow`
     * 会传），所以图片本来就只能靠 `message.images` 那条路 —— 换句话说，
     * 我们注册自定义行之前，图片同样不在这里显示。
     *
     * ## 采用的方案
     *
     * 自己渲染图片：复用 `conversation.message.images` 这个**公开的 single slot**
     * （`ui-attachment` 在其中注册了画廊渲染器，props 契约公开：
     * `{ images, loadImage, align }`）。我只需要把工具结果里的 image 块
     * 解析成 `{ attachment }` 数组。
     *
     * @param props - 工具行 props：block、loadImage、renderSlot、字典等。
     * @returns 行的 React 节点。
     */
    function NaiToolRow(props) {
      const { block, toolName, t } = props

      const args = parseArgs(block)

      // 状态：与官方 toolRowModel 同一套判定
      const done = block !== null && typeof block === 'object' && 'kind' in block
      const state = !done
        ? (block?.phase === 'preparing' ? 'preparing' : 'running')
        : (block.error?.code === 'interrupted' ? 'stopped' : (block.isError ? 'error' : 'ok'))

      const statusLabel = t(`state.${state}`)

      // 摘要：优先显示提示词，那是用户最关心的
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      const summary = prompt.length > 0 ? truncate(prompt, 90) : t('title')

      // 参数小标签：只显示被本次调用显式指定的项。
      // 画风不在此列 —— 它只来自配置，不是调用参数。
      const chips = []
      if (typeof args?.size === 'string' && args.size.length > 0) chips.push(`${t('rowSize')}: ${args.size}`)
      if (typeof args?.steps === 'number') chips.push(`${t('rowSteps')}: ${args.steps}`)
      if (typeof args?.count === 'number') chips.push(`${t('rowCount')}: ${args.count}`)

      // 结果摘要：归档路径等
      const resultText = done && !block.isError ? firstText(block) : null
      const errorText = done && block.isError ? firstText(block) : null

      // 图片：从结果里解析出附件引用，交给公开的画廊 slot 渲染。
      const images = done && !block.isError ? imageRefs(block) : []

      // 计费行：宿主侧把「本次消耗 / 剩余点数」拼成带固定前缀的一行文本
      // 塞进结果里（界面读不到结构化输出值）。OpenAI 通道没有这一段，
      // 解析结果就是 null，那一行不渲染。
      const billing = done && !block.isError ? parseBilling(resultText) : null

      return h('div', { className: 'nai-toolrow', 'data-state': state }, [
        h('div', { className: 'nai-toolrow-head', key: 'head' }, [
          h('span', { className: 'nai-toolrow-title', key: 'title' }, toolName),
          h('span', { className: 'nai-toolrow-state', key: 'state', 'data-state': state }, statusLabel),
        ]),
        h('div', { className: 'nai-toolrow-prompt', key: 'prompt' }, summary),
        billing !== null
          ? h('div', { className: 'nai-toolrow-billing', key: 'billing' }, [
            billing.cost !== null
              ? h('span', { className: 'nai-toolrow-cost', key: 'cost' },
                `${t('rowCost')}: ${billing.cost === undefined ? t('rowCostUnknown') : billing.cost}`)
              : null,
            billing.balance !== null && billing.balance !== undefined
              ? h('span', { className: 'nai-toolrow-balance', key: 'balance' },
                `${t('rowBalance')}: ${billing.balance}`)
              : null,
          ].filter(Boolean))
          : null,
        chips.length > 0
          ? h('div', { className: 'nai-toolrow-chips', key: 'chips' }, chips.map((c, i) => h('span', { key: i }, c)))
          : null,
        images.length > 0
          ? h(NaiImageStrip, {
            key: 'imgs',
            images,
            loadImage: props.loadImage,
            labels: {
              image: t('imageLabel'),
              loading: t('imageLoading'),
              failed: t('imageFailed'),
              open: t('imageOpen'),
              close: t('imageClose'),
            },
          })
          : null,
        errorText !== null
          ? h('div', { className: 'nai-toolrow-error', key: 'err' }, truncate(errorText, 200))
          : null,
      ].filter(Boolean))
    }

    /**
     * 生图结果的图片条。
     *
     * ## 为什么必须自己渲染
     *
     * DSH 不会在工具卡片里渲染 mídia。工具结果里的 image 块会被搬到一条
     * 独立的 follow-up 消息（原地留下 `[Tool output media moved to the
     * following user message]`），而那条消息由 `conversation.message.images`
     * 渲染 —— 对于工具结果，DSH 并不挂载这条消息，所以图片没有呈现路径。
     *
     * 另外两条路都被堵死（均已在本仓库的 DSH 源码里核对）：
     *
     * - `tool.call.images`：子槽声明确实**全局按名字唯一**
     *   （`dsh-client-ui-slots` 里 `slot "…" is already declared (by …)`），
     *   已被 `read-image-toolview` 占用；
     * - `renderSlot`：只能渲染该 entry 的 `children` 里声明过的 key，否则抛
     *   `SlotOwnershipError`（见 `dsh-client-ui-slots/lib/index.js:17`）。
     *
     * ## 采用的方案
     *
     * 自己画。`loadImage` 由工具行 props 直接给出，契约与官方
     * `MessageImage`（`dsh-client-ui-attachment/lib/client.js:754`）一致：
     *
     * - `loadImage(attachment)` → `Promise<string>`（对象 URL / data URL）
     * - `loadImage.peek?.(attachment)` → 已缓存的字符串，或 null
     * - 图片项形态为 `{ attachment }`
     *
     * @param props - `{ images, loadImage }`。
     * @returns 图片条的 React 节点。
     */
    function NaiImageStrip(props) {
      const { images, loadImage, labels } = props

      // 每张图一个 URL。undefined = 还没加载完，null = 加载失败。
      const [urls, setUrls] = React.useState(() => images.map(() => undefined))

      // 依赖必须用「内容签名」而不是 images 数组本身：
      // 父组件每次渲染都会新建数组，用它当依赖会让 effect 无限重跑
      // （setUrls → 重渲染 → 新数组 → effect 再跑 → …）。
      const key = images.map((item) => item.attachment.attachmentId).join('|')

      React.useEffect(() => {
        if (typeof loadImage !== 'function') return undefined
        let live = true
        // 先吃缓存，避免已加载过的图闪一下空白。
        const cached = images.map((item) =>
          (typeof loadImage.peek === 'function' ? loadImage.peek(item.attachment) : null) ?? undefined)
        setUrls(cached)
        images.forEach((item, index) => {
          if (cached[index] !== undefined) return
          Promise.resolve(loadImage(item.attachment))
            .then((url) => {
              if (!live || typeof url !== 'string') return
              setUrls((prev) => {
                const next = prev.slice()
                next[index] = url
                return next
              })
            })
            .catch(() => {
              if (!live) return
              setUrls((prev) => {
                const next = prev.slice()
                next[index] = null
                return next
              })
            })
        })
        return () => { live = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- key 是 images 的内容签名
      }, [key, loadImage])

      // 点击放大：官方 ImageLightbox 是就地弹层，并且负责 Esc / 点背景关闭、
      // 焦点归还。不要用 target=_blank —— loadImage 给的是 blob: URL，
      // 它只在当前页面上下文有效，开新标签页打不开。
      const [zoomed, setZoomed] = React.useState(null)

      if (images.length === 0) return null

      const tiles = images.map((item, index) => {
        const url = urls[index]
        const label = item.attachment.name ?? labels.image
        if (typeof url === 'string' && url.length > 0) {
          return h('button', {
            key: item.attachment.attachmentId ?? index,
            type: 'button',
            className: 'nai-toolrow-image',
            title: labels.open,
            'aria-label': labels.open,
            onClick: () => setZoomed({ url, alt: label }),
          }, h('img', { src: url, alt: label, loading: 'lazy' }))
        }
        // url === null → 失败；undefined → 加载中。两者都不画破图。
        return h('span', {
          key: item.attachment.attachmentId ?? index,
          className: 'nai-toolrow-image nai-toolrow-image-pending',
          'data-failed': url === null ? 'true' : undefined,
        }, url === null ? labels.failed : labels.loading)
      })

      return h('div', { className: 'nai-toolrow-images' }, [
        ...tiles,
        zoomed !== null && typeof ImageLightbox === 'function'
          ? h(ImageLightbox, {
            key: 'lightbox',
            src: zoomed.url,
            alt: zoomed.alt,
            labels: { dialog: zoomed.alt, close: labels.close },
            onClose: () => setZoomed(null),
          })
          : null,
      ].filter(Boolean))
    }

    /**
     * 从工具结果里取出图片引用。
     *
     * 形态照官方 `imageReferences`：结果 content 里的 `image` 块，
     * 其 `attachment` 是一个 ImageAttachmentRef（attachmentId/mediaType/…）。
     * 画廊要的是 `[{ attachment: ref }]`。
     *
     * 任何一项不合规就整批放弃（而不是画出一堆破图），与官方一致。
     *
     * @param {object} block - 工具节点。
     * @returns {Array<{attachment: object}>} 图片引用数组，可能是空的。
     */
    function imageRefs(block) {
      try {
        const content = block?.content
        if (!Array.isArray(content)) return []
        const refs = []
        for (const part of content) {
          if (part === null || typeof part !== 'object') continue
          if (part.type !== 'image') continue
          const attachment = part.attachment
          if (attachment === null || typeof attachment !== 'object' || Array.isArray(attachment)) return []
          if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId.length === 0) return []
          if (typeof attachment.mediaType !== 'string') return []
          refs.push({ attachment })
        }
        return refs
      } catch {
        return []
      }
    }

    /**
     * 解析一次调用的参数。
     *
     * 形态取自官方 `parsedToolCall`：完成态的 block 有 `kind` 与 `call.argsRaw`，
     * 进行中只有 `argsRaw`。解析失败一律返回 undefined，绝不抛。
     *
     * @param {object} block - 工具节点。
     * @returns {object|undefined} 参数对象。
     */
    function parseArgs(block) {
      try {
        const raw = block !== null && typeof block === 'object' && 'kind' in block
          ? block.call?.argsRaw
          : block?.argsRaw
        if (typeof raw !== 'string' || raw.length === 0) return undefined
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 取结果里的第一个文本块。
     *
     * 生图工具的结果是 `[text, image]`，文本块里是摘要与归档路径。
     *
     * @param {object} block - 工具节点。
     * @returns {string|null} 文本，或 null。
     */
    function firstText(block) {
      try {
        const content = block?.content
        if (!Array.isArray(content)) return null
        for (const part of content) {
          if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
            return part.text
          }
        }
        return null
      } catch {
        return null
      }
    }

    /** 截断长文本，避免行被撑爆。 */
    function truncate(text, max) {
      const value = String(text)
      return value.length <= max ? value : `${value.slice(0, max - 1)}…`
    }

    /**
     * 从结果文本里解析计费行。
     *
     * 宿主把「计费: 本次消耗: N / 剩余点数: M」这样一行放进结果文本，
     * 字段本身可能缺失（上游没返回 cost 时是「上游未返回」，查不到余额时
     * 整段没有）。解析不出来就返回 null —— 调用方据此不渲染这一行。
     *
     * @param {string|null} text - 结果里的第一段文本。
     * @returns {{cost: number|undefined|null, balance: number|null}|null} 计费信息。
     */
    function parseBilling(text) {
      if (typeof text !== 'string') return null
      const line = text.split('\n').find((l) => l.startsWith('计费: '))
      if (line === undefined) return null
      const body = line.slice('计费: '.length)

      // 本次消耗：数字，或「上游未返回」（此时 cost === undefined，仍要显示）
      let cost = null
      const costMatch = /本次消耗:\s*([0-9]+(?:\.[0-9]+)?)/.exec(body)
      if (costMatch !== null) cost = Number(costMatch[1])
      else if (body.includes('本次消耗: 上游未返回')) cost = undefined

      // 剩余点数：可选
      let balance = null
      const balanceMatch = /剩余点数:\s*([0-9]+)/.exec(body)
      if (balanceMatch !== null) balance = Number(balanceMatch[1])

      if (cost === null && balance === null) return null
      return { cost, balance }
    }

    /**
      * 注入本插件自己的样式。
      *
      * 用 style 元素而不是 import CSS：bundle 是手写的普通 JS，
      * 没有构建步骤来处理样式导入。只在首次 apply 时插一次。
      */
    function installStyles() {
      const STYLE_ID = 'dsh-nai-image-styles'
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.nai-toolrow{display:flex;flex-direction:column;gap:6px;padding:8px 10px;font-size:13px;line-height:1.5}',
        '.nai-toolrow-head{display:flex;align-items:center;gap:8px;justify-content:space-between}',
        '.nai-toolrow-title{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.nai-toolrow-state{font-size:12px;opacity:.7}',
        '.nai-toolrow-state[data-state="error"]{color:#e5484d;opacity:1}',
        '.nai-toolrow-state[data-state="ok"]{color:#30a46c;opacity:1}',
        '.nai-toolrow-prompt{opacity:.85;word-break:break-word}',
        '.nai-toolrow-chips{display:flex;flex-wrap:wrap;gap:6px}',
        '.nai-toolrow-chips>span{font-size:12px;padding:1px 6px;border-radius:4px;background:rgba(128,128,128,.15)}',
        '.nai-toolrow-billing{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;opacity:.85}',
        '.nai-toolrow-cost{font-variant-numeric:tabular-nums}',
        '.nai-toolrow-balance{font-variant-numeric:tabular-nums}',
        '.nai-toolrow-error{color:#e5484d;font-size:12px;white-space:pre-wrap;word-break:break-word}',
        '.nai-toolrow-images{margin-top:4px;display:flex;flex-wrap:wrap;gap:6px}',
        '.nai-toolrow-image{display:block;border-radius:6px;overflow:hidden;line-height:0;border:1px solid rgba(128,128,128,.25);padding:0;background:none;cursor:zoom-in}',
        '.nai-toolrow-image:hover{border-color:rgba(128,128,128,.5)}',
        '.nai-toolrow-image img{border-radius:5px;width:132px;height:auto;display:block}',
        '.nai-toolrow-image-pending{width:132px;height:88px;display:flex;align-items:center;justify-content:center;font-size:12px;opacity:.7;background:rgba(128,128,128,.12);line-height:1.4;text-align:center;padding:0 6px;box-sizing:border-box;cursor:default}',
        '.nai-toolrow-image-pending[data-failed="true"]{color:#e5484d;opacity:1}',
      ].join('\n')
      document.head.appendChild(style)
    }

    /**
     * 挂载配置页。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-nai-image: dictionaries')
      ctx.effect(() => { installStyles(); return () => {} }, 'dsh-nai-image: styles')

      const card = new CardController(ctx.configForms.get(NS), ctx)
      ctx.effect(() => () => { card.dispose() }, 'dsh-nai-image: form subscription')

      // 只在宿主确实服务这个命名空间时注册页面，否则不显示任何痕迹。
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: 'dsh-nai-image',
        order: 60,
        label: () => t('title'),
        locale: LOCALE_NS,
        inject: () => card.inject(),
      }, NaiImageCard))), 'dsh-nai-image: page')

      // 工具调用行。keyed slot 按工具名分发；未注册的 key 走通用行。
      // 注意：这里【不】声明 children —— tool.call.images 已被 read_image 独占。
      ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'nai_generate_image',
        locale: LOCALE_NS,
      }, NaiToolRow)), 'dsh-nai-image: generate tool row')

      ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'nai_quota',
        locale: LOCALE_NS,
      }, NaiToolRow)), 'dsh-nai-image: quota tool row')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
