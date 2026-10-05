# dsh-nai-image

NovelAI 生图插件，用于 DSH。移植自 AstrBot 的 [`astrbot_plugin_nai_image`](https://github.com/woakato/astrbot_plugin_nai_image)（v2.7.3，MIT）。

上游契约（端点、字段名、枚举、阈值、重试策略）照搬参考实现；交互方式按 DSH 的插件模型重做——AstrBot 用 `/image` 斜杠指令，DSH 用工具调用。

## 它做什么

给模型一个 `nai_generate_image` 工具：模型按用户要求组织提示词，生成图片，并把**图片本身**作为工具结果返回。图片会同时：

1. 作为 DSH 附件进入对话（模型与界面都能看到）；
2. 原图归档到磁盘（`$DSH_HOME/plugin-data/dsh-nai-image/image_history/`），用户可直接取用。

另有一个 `nai_quota` 工具查询账号剩余点数（不生图、不扣费）。

## 装

### 方式一：GUI（推荐）

本插件按**组合包（bundle）**打包——`package.json` 里声明了 `dsh.bundle.patch`。这不是可选项：DSH 的插件页只会安装组合包，普通插件会被 `inspect` 以 `not-a-bundle` 直接拒绝。

1. 侧栏点**插件**（不是「设置 → 内置插件」，那个是只读清单）；
2. 点**添加插件**；
3. 在输入框里填下面任一种：

   ```
   https://github.com/mofei-114/dsh-nai-image     # Git 地址：最新版，免下载
   ```

   ```
   <你克隆/解压出来的插件目录绝对路径>              # 本地路径
   ```

   例如 Windows 上可能是 `D:\plugins\dsh-nai-image`。

   GUI 接受包名、Git 地址、`.tgz` 压缩包或本地绝对路径。本地路径必须是绝对的（相对路径会被拒绝，因为浏览器里的相对路径没有意义）。**压缩包只认 `.tgz` / `.tar.gz`，不认 `.zip`**——这是 DSH 的硬性限制。

4. 点**安装**。装完会问**立即启用**，选它。

装完插件出现在**已安装**分组。之后可以在这个页面里开关它、看它的行、改它的配置。

**升级**：GUI 目前不支持自动更新，卸载后重装新版。同一目录重装前要先卸载（否则报 `already-installed`）。

### 配 token（关键）

装完后：**侧栏 → 插件 → 找到「NovelAI 生图」卡片 → 点进去**，里面有 26 个字段的表单。

**token 存在凭据域，不写进设置文件。** 表单上的「生图 Token」是一个密码框：

- 它**不会回显**已保存的值，只显示「已配置 / 未配置」；
- 填好点**保存**，值会写进 `~/.dsh/.credentials.yaml` 的 `refs.NAI_IMAGE_TOKEN`；
- 留空点保存 = 不修改（不会被清空）。

这是复用 DSH 官方做法（见 `ui-settings-web-search` 的 apiKey）：密钥不进 `cordis.patch.yml` 明文。

其余字段（画风、画幅、步数等）走 settings 命名空间，写入 profile 的 `cordis.patch.yml`。

### 不想用 GUI 也可以手改

token 走凭据域，但**手工写在 `cordis.patch.yml` 里同样生效**（凭据域没配时回落到这里）：

```yaml
- id: dsh-nai-image
  config:
    token: '你的 token'
    imageStyle: vertical
    imageSize: 竖图
```

⚠️ 补丁的 `config` 是**整体替换**，不是深合并。覆盖时未写出的项回落到 `lib/config.js` 的默认值（默认值与参考实现一致），所以只写要改的项就行。

### 方式二：手工挂载

不想走 GUI，也可以直接引用目录里的补丁：

1. 编辑 `~/.dsh/cordis.patch.yml`，在**末尾**追加：

   ```yaml
   - insert:
       - id: dsh-nai-image
         name: 'file:///<插件目录绝对路径>/lib/index.js'
         config:
           callMode: direct
           token: '你的 token'
   ```

   `name` 必须是 `file://` URL。中文路径要按 URL 规则转义（空格写 `%20`），不确定就直接走 GUI 安装——它会替你算好。

2. 重启 DSH。新增 loader 条目这一路径没有走热重载的先例，重启最稳。

插件**不需要** `npm install`：它只依赖 Node 内置模块；唯一需要的第三方包（schemastery，用于 Config schema）从 DSH 安装目录自适应取用，取不到就降级（业务照常，只是没 GUI 表单）。

### 验证加载

日志里会出现：

```
[dsh-nai-image] 已注册 nai_generate_image（模式 direct，模型 nai-diffusion-4-5-full）
[dsh-nai-image] 已注册 nai_quota
```

没出现就查两处：路径是否正确，以及配置项是否合法——写错会打 `配置项 xxx ...` 并保持停用（闭合词表写错是**报错停用**，不是静默换默认值）。

需要确认工具进了模型可见列表，直接问模型「你现在有哪些生图工具」即可。插件**没有** `nai_status` 这类自检命令。

上游接口的完整契约（端点、字段名、枚举、阈值、重试表）见 [`docs/上游接口契约.md`](docs/上游接口契约.md)。`lib/constants.js` 里的常量全部对照它逐字核过。

## 两条通道

配置项 `callMode` 二选一。

### `direct`：NAI 直连

默认通道。**主路径是任务接口，不是 GET**：

1. `POST {baseUrl}/api/web/jobs` —— token 走 body，支持 1–50 步，按「步数 × 画质」计价，失败退点；
2. 轮询 `GET {baseUrl}/api/jobs/{id}` —— 每 2 秒一次，token 走 `x-user-token` 头，容忍连续 3 次失败；
3. 下载 `imageUrl`。

**只有**任务接口返回 404（旧版自建 Nai2API 没有该接口）时，才回退 `GET {baseUrl}/generate`——此时 token 进 query，且上游会把步数按 28 截断。

需要 `baseUrl` + `token`。

### `openai`：OpenAI 兼容

`POST {openaiBaseUrl}/v1/images/generations`，`Authorization: Bearer {openaiApiKey}`。

- 尺寸直接用像素（`832x1216`），自动收敛到「宽高 64 倍数、最大边 ≤1920、面积 ≤3686400」；
- 画师串没有独立字段，拼进 `prompt` 前缀；
- `scale` 被上游收敛到 0–10（直连是 0–20）；
- 遇到 408/429/502/503/504，或错误文案命中「服务繁忙 / 请稍后重试 / try again later」等关键词时，按 2s、4s、8s 退避重试（`maxRetries`，默认 2）；
- **超时不重试**——上游通常仍在生成并照常扣费，重试会导致一次需求被多次扣费。

需要 `openaiBaseUrl`；`openaiApiKey` 可留空（部分中转站不校验）。

## 配置项

见 `cordis.patch.yml`，每一项都有注释。几个容易踩的点：

| 配置 | 说明 |
|---|---|
| `token` | 走凭据域（`~/.dsh/.credentials.yaml` 的 `NAI_IMAGE_TOKEN`），不进设置文件明文。手工写在 patch 里也生效 |
| `steps` | 直连任务接口支持到 50；走 GET 兜底时上游按 28 截断 |
| `imageSize` | 直连用中文分档名（`竖图`）；OpenAI 通道可直接写像素 |
| `imageStyle` | `r18` 的显示名是「2.5D唯美风」、`anime` 是「本子里番风」——这是上游的命名，照抄未改 |
| `negative` | 留空则用参考实现的内置默认反向词（一长串，见 `lib/constants.js`） |
| `imageHistoryLimit` | 只清理本插件自己产生的 `nai_*` 文件 |

### 配置改完要不要重启

- **GUI 表单里改的**（除下面两个）：**立刻生效**。这些字段是 `.volatile()`，插件每次生图重新读一遍，不缓存。
- `enableTool` / `enableQuotaTool`：**需要重启**。它们决定注册哪些工具，而工具只在插件加载时注册一次。
- 手改 `cordis.patch.yml`：改了已有条目的 config 通常热生效；新增条目建议重启。

### 配置写错会怎样

**闭合词表**（`callMode`、`imageStyle`、`imageSize`、`sampler`、`noiseSchedule`）写错时，插件会打日志并**保持停用**，而不是悄悄用默认值：

```
[dsh-nai-image] 配置项 imageStyle 只能是 vertical / comicDoujin / ... 收到 "anime风"
```

这是一条刻意的设计：静默回退会让"我明明设了"和"实际没生效"难以区分。不写（缺省、`null`、空白串）才走默认值。

**自由文本项**（`baseUrl`、`openaiBaseUrl` 等）类型不对同样报错，避免把 `12345` 之类的值当成地址发出去。

数字项越界则是夹到合法区间（`steps: 999` → `50`，`scale: -100` → `0`），因为这是"意图明确、只是超范围"，夹取比报错更有用。

GUI 表单里这些约束由 Config schema 先挡一道（`z.number().min(1).max(50)` 之类），表单外的路径才由上面这套兜底。

## 工具参数

`nai_generate_image`：

| 参数 | 说明 |
|---|---|
| `prompt` | 必填。逗号分隔的英文 tag 效果最好 |
| `style` | 覆盖本次画风 |
| `size` | 覆盖本次画幅/尺寸 |
| `negative` | 覆盖本次反向词 |
| `steps` / `scale` / `seed` / `count` | 覆盖本次生成参数（`seed` 固定可复现） |

单次参数只影响当次调用，不写回配置。越界值会被夹到合法区间（如 `steps: 999` → `50`）。

## 代码结构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口：`name` / `inject` / `Config` / `apply`，工具定义与结果装配 |
| `lib/schema.js` | Config schema（26 字段）+ schemastery 自适应加载 + volatile 句柄解包 |
| `lib/client.js` | **浏览器半侧**：GUI 配置表单（手写 bundle，无构建） |
| `lib/nai-client.js` | HTTP 客户端：任务接口、GET 兜底、OpenAI 兼容、重试、尺寸收敛 |
| `lib/config.js` | 配置归一化与默认值、凭据引用名 |
| `lib/store.js` | 图片落地：格式嗅探、尺寸解析、磁盘归档、附件登记 |
| `lib/constants.js` | 上游契约常量（模型、采样器、画师串、负面词、阈值、重试表） |

`lib/constants.js` 里的画师串与负面词是**逐字照抄**的，它们是上游契约的一部分，改动会改变出图结果。

## 配置表单是怎么来的

DSH 的配置页机制是「宿主给数据 + 插件自绘界面」，没有通用的自动表单：

- 宿主（`dsh-settings`）把声明了 `.volatile()` 的 Config 字段投影成数据；
- 但渲染要插件自己写 —— 官方四个配置页（shell / agent-loop / subagent / web-search）**全都是插件自带的浏览器半侧**。`dsh-settings` 的 README 明说 `autoGenerate`「目前没有已发布的客户端这样做」。

所以本插件有 `lib/client.js`。它注册进「插件」页的 `plugins.item` slot，用 DSH 的 `ui-primitives` 提供的 `SettingsForm` / `SettingsValueField` / `SettingsSecretField` 渲染。

**两条写入通道**：

| 通道 | 字段 | 落到哪 |
|---|---|---|
| settings | 其余 24 项 | profile 的 `cordis.patch.yml` |
| credentials | `token`、`openaiApiKey` | `~/.dsh/.credentials.yaml` |

secret 走凭据域是**复用官方做法**，好处是密钥不落进设置文件明文。代价是表单拿不到值，只能显示「已配置 / 未配置」。

## 图片怎么回到界面上

三条通路，各自独立：

| 通路 | 机制 |
|---|---|
| **对话里显示** | 工具结果带 `{ type:'image', attachment }` 块 → DSH 登记为附件 → 画廊渲染 |
| **模型能看到** | 同一个图片块进模型上下文，所以模型能"看见"自己生成的图 |
| **磁盘留档** | 插件把原图写进 `$DSH_HOME/plugin-data/dsh-nai-image/image_history/` |

`lib/client.js` 注册的**工具调用行**把这些放在一起：提示词摘要、画风/画幅/步数/张数标签、状态，以及**图片画廊**（`nai_generate_image` 与 `nai_quota` 各一条）。

### 图片渲染为什么绕了一层

DSH 有个 `tool.call.images` 子槽，看起来是「工具卡片内嵌图片」的正路。但它有两个坑，都实测确认过：

1. **子槽声明是全局独占的。** 注册第二个声明同一子槽的条目会直接抛
   `slot "tool.call.images" is already declared (by …)`。它已被 `read-image-toolview` 占用。
2. **注册 toolview 的 key 会顶掉通用行。** `ToolCall` 的写法是
   `renderSlot('tool.call.toolview', owner, { fallback: GenericToolCard })`，而通用行自己也**不**渲染图片——`ToolRow` 的 `imageBody` 只有 `ReadImageRow` 会传。

所以「注册自定义行」和「显示图片」在原方案里是互斥的：**加了行，图就没了**（这正是踩到的 bug）。

最终做法：行照常注册，图片**自己渲染**——复用 `conversation.message.images` 这个公开的 single slot（`ui-attachment` 在其中注册了画廊，props 契约是公开的 `{ images, loadImage, align }`）。我们只负责把结果里的 image 块解析成 `[{ attachment }]`，解析规则照抄官方 `imageReferences`（任一项不合规就整批放弃，不画破图）。

测试锁住了这条：有图片时必须调用 `renderSlot('conversation.message.images', …)`，没有图片时不得调用，失败态与缺陷附件都不得调用。

## 已验证

跑 `node test/run-all.mjs`，**280 条断言 + 45 例差分全部通过**。见 [`test/README.md`](test/README.md)。

| 套件 | 覆盖 |
|---|---|
| bundle | 按 GUI 的 `inspect` / `installBundle` 判据逐条核对：spec 解析、`dsh.bundle` 判定、补丁可解析、相对路径锚定成 `file://` |
| client | 客户端 bundle：发现链、`__ModuleLoader__` 契约、字典中英对齐、26 个控件渲染、secret spec 形态、工具调用行（8 种 block 形态 + 图片画廊分发） |
| schema | 从 `app.asar` 抽出**真实** `@deepseek-ai/dsh-tools`，用它校验注册的 schema、参数、返回值与 `render` 产物 |
| form | 在 **DSH 自己的运行时**下验证 Config 投影出 26 个 volatile 字段、`token` 是 secret 角色 |
| override | 补丁覆盖语义：只写 token 与写全等价（默认值兜住其余项） |
| secret | secret 链路：宿主与 client 的引用名一致、从凭据域解析、每次操作重新解析、空凭据不覆盖 |
| store | 图片头解析（PNG/JPEG/WebP/GIF）、归档与上限清理、附件降级路径 |
| e2e | 三条通道端到端、503 退避重试、额度查询、失败路径、非图片字节、参数夹取 |
| adversarial | 垃圾参数（NaN/Infinity/对象/数组/超长/注入串）不崩且夹取正确 |
| config | 畸形配置不崩、闭合词表报错、开关生效 |
| diff-size | 尺寸收敛与参考 Python 实现逐例对比，0 差异 |

### 测试抓到的真实缺陷

1. **`openai` 通道尺寸取整用错语义** —— 参考实现是 Python 的 `//`（向下取整），我写成 `Math.round`，把 `832x1216` 推成 `896x1280`，白名单尺寸整体错一档。差分测试逐例对出。
2. **图片尺寸解析未验魔数** —— 从垃圾字节读出 `4294967295x4294967295` 假尺寸。
3. **secret spec 形态错** —— `SettingsFormModel` 的第三个参数必须是 `{ field, write }` 对象数组，我传了字符串数组，导致保存时 `secret.write` 为 undefined、界面显示「本部署没有接受这些值」。现已用回归用例锁住。
4. **字典 zh/en 键名不一致** —— 改了 `zh` 没改 `en`。

一处按「消除病因」而非打补丁处理：手动注册的 tool definition **不会**在分发层做参数校验（那是 `defineTool` 在自己闭包里做的事），因此 `execute` 自己做全部收敛，并用对抗性用例锁住。

## 打包成组合包的理由

`dsh.bundle` 不是装饰。DSH 插件页的 `inspect` 会读 `package.json`：

```js
const bundle = declared !== undefined && typeof declared.bundle === 'object' && declared.bundle !== null;
if (!inspection.bundle) return refused('not-a-bundle', `${inspection.name} declares no dsh.bundle`);
```

没有 `dsh.bundle` 的包在安装前就被拒。所以插件以 bundle 形态发布，补丁里的 `name` 写成相对路径 `./lib/index.js`——Loader 以补丁文件所在目录为基准锚定成 `file://`，整包移到哪都能用。

## 已知边界

- **参考图（vibe / img2img / director）未实现**。参考实现有这三种参考图模式，本插件当前只做文生图。要加的话，`lib/nai-client.js` 的 `openaiPayload` 已留好 `parameters` 组装点。
- **多角色坐标（`characterPrompts` / `v4_prompt`）未实现**。
- **提示词 LLM 转译未实现**（参考实现的 `enable_translate`）。DSH 里模型本来就能直接产出 tag，通常不需要中间层。
- **`/price`、用量统计、服装缓存池未移植**。
- 附件登记失败时（例如图片超出部署字节上限），插件会如实报告「模型看不到画面内容」并给出归档路径，**不会假装出图成功**。
