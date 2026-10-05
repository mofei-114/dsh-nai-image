# 验证

一次跑完：

```powershell
node test/run-all.mjs
```

退出码 0 = 全绿。

## 套件

| 文件 | 覆盖 |
|---|---|
| `verify-bundle.mjs` | 按 GUI「添加插件」的判据逐条核对：`parseInstallSpec` 接受该目录、`dsh.bundle` 是对象（否则会被 `not-a-bundle` 拒）、补丁可解析、相对 `name` 能锚定成 `file://`、`exports` 指向的文件都存在 |
| `verify-plugin.mjs` | 从 `app.asar` 抽出**真实** `@deepseek-ai/dsh-tools`，用它的 `assertSupportedJsonSchema` / `validateJsonSchemaValue` 校验注册的 schema、参数、返回值与 `render` 产物 |
| `unit-store.mjs` | 图片头解析（PNG/JPEG/WebP/GIF）、尺寸读取的魔数校验、归档与上限清理、附件降级路径 |
| `e2e.mjs` | 起 mock 上游，跑插件真实 `execute()`：任务接口、404→GET 兜底、OpenAI 兼容、503 退避重试、额度查询、失败路径、非图片字节、参数覆盖与夹取 |
| `adversarial.mjs` | 垃圾参数（NaN / Infinity / 对象 / 数组 / 超长 / 注入串）不崩且夹取正确 |
| `config-robust.mjs` | 畸形配置不崩、闭合词表报错、开关生效 |
| `diff-size.mjs` | 尺寸收敛与参考 Python 实现逐例对比（`ref_size.py` 照抄自参考源码） |

## 为什么用 DSH 自己的校验器

`ctx.tools.register` 与 `defineTool` 接受的 schema 形态**不同**：

- `defineTool` 收 author spec（属性上写 `required: true`），在闭包里编译成 JSON Schema，并在 `execute` 外层做参数校验；
- `ctx.tools.register` 收**编译好的 raw JSON Schema 子集**（`required` 必须是字符串数组），且**不做分发期参数校验**。

本插件走的是后者（插件目录没有 `node_modules`，无法 import `defineTool`）。因此：

1. schema 必须过 `assertSupportedJsonSchema` —— 这正是 `verify-plugin.mjs` 做的；
2. 参数校验得自己做 —— 这正是 `adversarial.mjs` 锁住的。

自己重写一遍校验器没有意义：那只是把同一个误解写两遍。所以 `setup-fixtures.mjs` 把 DSH 真实的包从 `app.asar` 里抽出来。

## fixture

`setup-fixtures.mjs` 会写入 `test/.fixtures/`（约 1.4 MB），可随时删除重建；`run-all.mjs` 检测到缺失会自动建。

它按需解析 `app.asar`，并递归补齐传递依赖。若 DSH 装在别处，把路径加进该脚本的 `CANDIDATES`，或用环境变量指定。

## 差分测试的由来

尺寸收敛是"照抄语义"的移植，最容易在细节上偏：Python 的 `//` 是**向下取整**，写成 `Math.round` 会让 `832x1216` 变成 `896x1280` —— 白名单里的尺寸整体错一档。这个 bug 是被这一套测试抓出来的，所以保留 `ref_size.py` 做逐例对照。
