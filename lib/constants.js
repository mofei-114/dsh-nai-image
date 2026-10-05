/**
 * 上游契约常量。
 *
 * 全部照抄参考实现 astrbot_plugin_nai_image v2.7.3 的源码常量
 * （main.py / command_args.py）。这些字符串是【中转站契约】的一部分，
 * 不是样式偏好——画师串与负面词逐字照搬，改动会改变出图结果。
 *
 * 来源：https://github.com/woakato/astrbot_plugin_nai_image
 */

/** 默认上游地址。第三方中转站（Nai2API），非 NovelAI 官方 API。 */
export const DEFAULT_BASE_URL = 'https://nai.sta1n.cn'

/** 调用模式。 */
export const CALL_MODES = ['direct', 'openai']

/** 直连通道可选模型（配置面板只给这两个）。 */
export const DIRECT_MODELS = ['nai-diffusion-4-5-full', 'nai-diffusion-5-full']

/** OpenAI 兼容通道模型列表。 */
export const OPENAI_COMPATIBLE_MODELS = [
  'nai-diffusion-5-full',
  'nai-diffusion-5-curated',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-full',
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-3',
  'nai-diffusion-furry-3',
]

/** 支持精准参考（director）的模型集合；不在集合内会被强制切到 4-5-full。 */
export const OPENAI_DIRECTOR_MODELS = new Set([
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai45',
  'nai45-curated',
  'nai-diffusion-5-full',
  'nai-diffusion-5-curated',
  'nai5',
  'nai5-curated',
])

/** 精准参考 base_caption 枚举。 */
export const OPENAI_DIRECTOR_CAPTIONS = ['character', 'style', 'character&style']

/** 采样器。配置面板只暴露前 6 个；ddim 仅指令层合法。 */
export const SAMPLERS = [
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
  'k_dpmpp_2s_ancestral',
  'k_euler_ancestral',
  'k_euler',
  'ddim',
]

/** 配置层允许的采样器（ddim 会被归一化回默认）。 */
export const CONFIG_SAMPLERS = SAMPLERS.slice(0, 6)

/** 噪声调度。运行时固定 karras，此处保留全集供单次覆盖。 */
export const NOISE_SCHEDULES = ['karras', 'native', 'exponential', 'polyexponential']

/** 直连中文分档名 → 内部键。 */
export const IMAGE_SIZES = {
  竖图: 'portrait',
  横图: 'landscape',
  方图: 'square',
  '2K竖图': '2k_portrait',
  '2K横图': '2k_landscape',
  '2K方图': '2k_square',
  '4K竖图': '4k_portrait',
  '4K横图': '4k_landscape',
  '4K方图': '4k_square',
}

/** 分档名别名（大小写不敏感）。 */
export const SIZE_ALIASES = {
  portrait: '竖图', vertical: '竖图', 竖图: '竖图',
  landscape: '横图', horizontal: '横图', 横图: '横图',
  square: '方图', 方图: '方图',
  '2k_portrait': '2K竖图', '2k-portrait': '2K竖图', '2k_vertical': '2K竖图', '2k-vertical': '2K竖图', '2k竖图': '2K竖图',
  '2k_landscape': '2K横图', '2k-landscape': '2K横图', '2k_horizontal': '2K横图', '2k-horizontal': '2K横图', '2k横图': '2K横图',
  '2k_square': '2K方图', '2k-square': '2K方图', '2k方图': '2K方图',
  '4k_portrait': '4K竖图', '4k-portrait': '4K竖图', '4k_vertical': '4K竖图', '4k-vertical': '4K竖图', '4k竖图': '4K竖图',
  '4k_landscape': '4K横图', '4k-landscape': '4K横图', '4k_horizontal': '4K横图', '4k-horizontal': '4K横图', '4k横图': '4K横图',
  '4k_square': '4K方图', '4k-square': '4K方图', '4k方图': '4K方图',
}

/** 分档名 → OpenAI 通道像素（4K 档降级为 2K 上限尺寸）。 */
export const OPENAI_SIZE_MAP = {
  方图: '1024x1024',
  竖图: '832x1216',
  横图: '1216x832',
  '2K方图': '1472x1472',
  '2K竖图': '1088x1920',
  '2K横图': '1920x1088',
  '4K方图': '1472x1472',
  '4K竖图': '1088x1920',
  '4K横图': '1920x1088',
}

/** OpenAI 通道常用像素白名单（宽高为 64 倍数、最大边 ≤1920、面积 ≤3686400）。 */
export const OPENAI_TOOL_SIZES = [
  '640x640', '832x1216', '1216x832', '1024x1024', '1024x1536',
  '1536x1024', '1472x1472', '1088x1920', '1920x1088',
]

/** OpenAI 通道尺寸契约上限。 */
export const OPENAI_MAX_SIDE = 1920
export const OPENAI_MAX_AREA = 3686400

/** 参考图张数上限（vibe 与 director 共用）；img2img 只用第 1 张。 */
export const OPENAI_MAX_REFERENCE_IMAGES = 8

/** 风格键 → 显示名。注意 r18/anime 的显示名反直觉，与上游一致。 */
export const IMAGE_STYLES = {
  vertical: '韩漫小清新风',
  comicDoujin: '漫画同人风',
  r18: '2.5D唯美风',
  lolita25d: '2.5D唯美风（萝）',
  anime: '本子里番风',
  galgame: 'GalGame风',
  custom: '自定义',
}

/** 风格中文别名 → 键。 */
export const STYLE_ALIASES = {
  韩漫小清新风: 'vertical',
  comicdoujin: 'comicDoujin',
  comic_doujin: 'comicDoujin',
  漫画同人风: 'comicDoujin',
  '2.5d唯美风': 'r18',
  lolita25d: 'lolita25d',
  '2.5d唯美风（萝）': 'lolita25d',
  '2.5d唯美风(萝)': 'lolita25d',
  本子里番风: 'anime',
  galgame风: 'galgame',
  自定义: 'custom',
}

/** 内置画师串，逐字照抄。 */
export const DEFAULT_ARTISTS = {
  vertical:
    '[[[artist:dishwasher1910]]], {{yd_(orange_maru)}}, [artist:ciloranko], [artist:sho_(sho_lwlw)], [ningen mame], year 2024,',
  comicDoujin:
    '(masterpiece:1.3), (best quality:1.2), (highres), (absurdres),\n' +
    '(extremely detailed illustration:1.2), (anime style:1.1),\n\n' +
    '(artist:feipin zhanshi:1.0), (artist:nlebo-hentai:0.9), (artist:sos adult:0.85),\n' +
    '(artist:hews:0.4),\n\n' +
    '(detailed skin texture:1.15), (glossy skin:1.1),\n' +
    '(thick lineart:1.1), (high contrast:1.15),\n' +
    '(vivid colors:1.1), (detailed shading:1.15),\n' +
    '(warm color palette:1.05),\n' +
    '(cute face:1.1), (detailed eyes:1.15), (detailed face:1.1),',
  r18:
    '0.9::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, ' +
    'textless version, The image is highly intricate finished drawn. ' +
    "Only the character's face is in anime style, but their body is in realistic style. " +
    '1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, ' +
    'and lifelike flesh with little obliques::. 1.63::photorealistic::, 1.63::photo(medium)::, \n' +
    '20::best quality, absurdres, very aesthetic, detailed, masterpiece::,, very aesthetic, masterpiece, no text,',
  lolita25d:
    '0.9::misaka_12003-gou & dino, rurudo,  mignon,wanke & liduk::, year 2025, realistic, 4k, -2::green ::, ' +
    'textless version, The image is highly intricate finished drawn. ' +
    "Only the character's face is in anime style, but their body is in realistic style. " +
    '1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, ' +
    'and lifelike flesh with little obliques::. 1.63::photorealistic::, 1.63::photo(medium)::, \n' +
    '20::best quality, absurdres, very aesthetic, detailed, masterpiece::,, very aesthetic, masterpiece, no text,',
  anime:
    '1.4::asanagi::,{{{{{artist:asanagi}}}}},1.2::xiaoluo_xl::,1.3::Artist: misaka_12003-gou::,' +
    '1.2::Artist:shexyo::,0.7::Artist:b.sa_(bbbs)::,1::Artist:qiandaiyiyu::,' +
    '1.05::artist:natedecock::,1.05::artist:kunaboto::,0.75::artist:kandata_nijou::,' +
    '1.05::artist:zer0.zer0 ::,1.05::artist:jasony::,0.75::misaka_12003-gou ::, ' +
    'dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, ' +
    '{textless version, The image is highly intricate finished drawn,write realistically,true to life}, ' +
    '1.35::A highly finished photo-style artwork that has lively color, graphic texture, ' +
    'realistic skin surface, and lifelike flesh with little obliques::, ' +
    '1.63::photorealistic::,3::age slider::,1.63::photo(medium)::, ' +
    '2::best quality, absurdres, very aesthetic, detailed, masterpiece::,-4::Muscle definition, abs::',
  // 注意：源码里这里的 \n 是【字面反斜杠+n】，不是真实换行，照抄保持原样。
  galgame:
    'artist:ningen_mame,, noyu_(noyu23386566),, toosaka asagi,, location,\\n' +
    '20::best quality, absurdres, very aesthetic, detailed, masterpiece::,:,, ' +
    'very aesthetic, masterpiece, no text,',
}

/** 默认反向提示词，逐字照抄。 */
export const DEFAULT_NEGATIVE =
  '{{bad anatomy}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,' +
  '{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,' +
  '{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,ink eyes,ink hair,' +
  'jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers},' +
  '{{missing legs}},{{{more than 2 nipples}}},mutated hands,{{{mutation}}},normal quality,owres,' +
  '{{poorly drawn face}},{{poorly drawn hands}},reen eyes,signature,text,{{too many fingers}},' +
  '{{{ugly}}},username,uta,watermark,worst quality,{{{more than 2 legs}}},' +
  'awkward hand sign,weird hand gesture,contorted hand,unnatural finger pose,deformed hand gesture,' +
  '{shaka},{hang loose},{{rock on}},{shaka sign}'

/** OpenAI 通道可重试状态码。 */
export const OPENAI_RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504])

/** 指数退避间隔（秒）；索引上限 2，等待不会超过 8 秒。 */
export const OPENAI_RETRY_DELAYS = [2, 4, 8]

/** 瞬时故障关键词：命中即视为可重试（中转站会把瞬时故障包成 400）。 */
export const OPENAI_TRANSIENT_MARKERS = [
  '服务繁忙', '请稍后重试', '稍后再试',
  'try again later', 'service busy', 'temporarily unavailable',
  'too many requests', 'overloaded',
]

/** 任务接口超时与轮询节奏（秒）。 */
export const WEB_JOB_SUBMIT_TIMEOUT = 30
export const WEB_JOB_POLL_INTERVAL = 2
export const WEB_JOB_POLL_REQUEST_TIMEOUT = 15

/** 轮询连续失败容忍次数。 */
export const WEB_JOB_POLL_FAILURE_LIMIT = 3

/** 图片下载超时（秒）。 */
export const DOWNLOAD_TIMEOUT = 60

/** 主提示词长度上限，防止把上游打爆。 */
export const MAX_PROMPT_LENGTH = 4000
