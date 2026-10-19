# dsh-plugin-prompt-optimizer · 手动优化提示词

在 DSH 输入框卡片内部右侧保留一个纯图标 ✨ 按钮，不添加侧边栏，不遮挡输入文字。

## 触发边界

- **只有点击优化按钮才发起优化请求。** 输入、粘贴、编辑、切换草稿、发送消息都不触发优化。
- 不必发送消息：写好草稿，按需点击按钮即可。
- 优化器只改写提示词，不回答或执行草稿里的任务，不自动发送消息。
- 使用已配置的默认模型路由，不需要为插件另配密钥。
- 有有效改写时替换草稿并提供撤销；没有实质改善时保持原文。
- 图标是 20px 无边框字形，悬停只提高不透明度，不出现任何底色块：它和模型选择器、发送按钮同处输入框工具行，不能做成第二个带框控件。
- 几何与颜色全部用**内联样式**写死（自带控件同样把 `border:none`、透明底写进样式）。壁纸之类的插件会重绘输入框底下的图层，页面级样式表一旦被压过，浏览器原生按钮的灰底就会露出来——内联样式没有这个问题。
- **工具行不出现状态文字**：「无需优化」「已改写 2.1s」「已撤销」只在悬停提示里；撤销也是图标而不是文字。只有真正的失败（HTTP 错误、模型不可用）会把短文字写在图标左侧，因为静默失败无法排查。
- 点击后若用户修改了草稿或正在提交，迟到的优化结果不覆盖当前输入。

## 0.3.0 的完整流程

```text
点击现有优化按钮
  → 检查请求方法、输入内容及长度
  → 固定本次元提示词快照，判断输入类型与优化模式
      ├─ 明确的寒暄/确认：不调用模型，记录结果，保持原文
      └─ 其他输入：进入改写
          → 普通模式一次生成；可能缺输出约定的任务，首次请求直接带补缺指引
          → 如果配置开启评测：并行候选 → 可选用例与实际输出对照 → 评分选择
          → 没有可用候选时，在剩余预算内退回普通改写
          → 空输出或明确截断：最多一次扩大预算重试
          → 清理模型前言与外层围栏
          → 占位符检查、能力保留、结构净变化、膨胀检查
          → 接受有效改写；检查失败、无改善或预算耗尽则保留原文
          → 记录运行日志及被接受的改写版本
          → 返回客户端；仅当草稿仍与点击时一致才回填，保留撤销
```

补缺不是删除，而是从“原样返回后的第二次请求”前移到第一次请求；空输出重试、评测、最终校验、回退和日志版本环节仍然保留。

本地分类只是提示：缺少关键词不等于真的缺少需求，不强制补齐栏目；提问也不会仅因带问号就被判为没有优化价值。

## 元提示词的职责

`prompt.md` 按“判断 → 五类改写 → 写法与结构 → 边界与交付 → 条件性加固 → 示例”组织：

1. 先判断是否存在实质问题，不为显示改动而换同义词。
2. 处理歧义、输出契约、不可检查的约束、材料混排及重复冲突。
3. 保留用户语言、语气、长度量级和要求强度，只在需要时分节。
4. 原有目标、全部步骤、顺序、分支、例外、约束和关键字面量不得遗漏。
5. 不编技术选型或业务需求，不加入占位符、追问或“稍后补充”的承诺。
6. 防泄露加固只在用户有此需求时处理，不承诺绝对安全。
7. 输出可直接替换原文的完整正文，而不是执行结果、建议或局部补丁。

只有当前调用采用的模式指令会附到模型请求中；不再重复附加“只要三项齐全就一律不改”的相互冲突规则。

## 调用成本与可选评测

下表描述代码调度，不是速度实测。调用数指插件发起的 `llm.stream()` 次数，不包含供应商适配器内部可能发生的重试。

| 路径 | 插件侧调用 | 行为 |
| --- | --- | --- |
| 明确寒暄、道谢、确认 | 0 | 点击后本地判定并保留原文 |
| `evaluate: off`（默认） | 通常 1，空输出/截断时最多 2 | 一次改写，必要时一次重试，再过全部闸门 |
| `evaluate: compare` | 正常 3 | 两个候选并行生成，随后评审；可拒绝两个候选 |
| `evaluate: full` | 默认两条用例时正常 10 | 候选、用例生成、原文与候选输出对照、评审 |

- `compare` 的两个候选并行；`full` 每条用例的原文和候选并行，单次优化最多同时运行 3 个模型流。
- 不提高默认评测级别；保留 `off / compare / full`。
- 显式选择 `brief` 或 `structure` 时，两个候选都遵守该模式。
- 评分顺序为“保真 → 实际改善 → 同等改善下更少改动”，避免只因更接近原文就否定有效优化。
- 评审接收完整原文和完整候选，不再截掉 2000 字之后的流程步骤；指令与待评审材料分开传递。
- 调用总预算覆盖评测、降级改写和重试。用例生成与最终评分都会预留预算。
- 无效候选先经过本地过滤，不为已知不合格的候选继续生成评测输出。
- 取消或超时后停止调度新调用。失败候选可丢弃，坏评分可退回可用候选，最后仍必须通过输出闸门。

## 输出保护

- 输出预算按草稿长度增大：`min(6000, max(maxOutputTokens, ceil(1.5 × 字数) + 600))`。
- 不把会话的高 `reasoningEffort` 强加给简单改写任务。
- **不发送 `temperature`**：AgentRouter 的 OpenAI Responses 路由会以 `Unsupported parameter: 'temperature'` 直接返回 400。若其他供应商仍拒绝某个参数，插件自动去掉被点名的那个参数再试一次（最多 3 个）。
- 空正文或模型明确返回 `max-tokens` 时，最多以双倍预算重试一次，上限 8000。
- 仍为空、被截断或模型报错时不写入草稿；兼容只有 `block-end` 正文的适配器。
- 前言或外层围栏会清理；含模板占位符的候选整体作废。

| 最终闸门 | 当前检查 | 拒绝原因 |
| --- | --- | --- |
| 能力保留 | 检查提取出的数字、路径、URL、文件名、代码标识等是否仍存在 | `preserve-check` |
| 结构净变化 | 模板标记数量至少 4 个，且比原文净增至少 3 个 | `scaffold-guard` |
| 膨胀 | 候选长度大于原文长度 × 3 + 80 | `expansion-guard` |

这些是确定性防护，不是语义等价证明；语义与步骤完整性仍由元提示词约束及可选评审负责。

其他保留原文的原因包括 `already-clear`、`placeholder-output`、`judge-rejected` 和 `budget-exhausted`。

## 热读、日志与版本

- `prompt.md` 由 `lib/prompt.js` 按文件路径、修改时间和大小缓存；下一次点击读取变化，不在输入过程中调用模型。
- 每次优化固定一份提示词快照，候选、重试与日志使用同一份内容和 SHA-256，避免并发请求混用版本。
- 文件暂时不存在、为空或不可读时保留上一次可用文本；尚无可用文本时使用编译兜底。
- `runs.jsonl` 记录输入/输出 SHA-256、元提示词 SHA-256、模型、决策、实际 `calls`、`flow`、耗时及关联版本号。
- `flow` 含本地/模型路径、请求模式、初始改写模式和重试次数；评审选择另见 `evaluation.winner`。
- `versions/vNNNN-<sha8>.md` 保存服务端接受的改写。客户端可能因草稿已变化而不回填，版本留档不等于已发送消息。
- 日志目录默认 `<DSH_HOME>/storages/prompt-optimizer`，未设置 `DSH_HOME` 时为 `~/.dsh/storages/prompt-optimizer`；可用 `dataDir` 覆盖。
- 日志写失败不影响改写响应。

只读接口：

```text
GET /prompt-optimizer/health
GET /prompt-optimizer/runs?limit=20
GET /prompt-optimizer/versions
```

优化接口：

```text
POST /prompt-optimizer/optimize
{"text":"当前草稿","mode":"polish"}
```

成功响应保留 `text / changed / reason / provider / model / ms`，增加真实的 `calls` 和 `flow`；评测开启时另有 `evaluation`。客户端只由按钮点击发送此请求，不挂接消息发送事件。

## 安装与生效

1. 完全退出 DSH Desktop，包括托盘进程。
2. 双击 `scripts/install.bat`：定位活动 profile，复制插件到稳定目录，加入 `link:` 依赖和 bundle，创建 junction；首次安装保存 profile 备份。
3. 重新打开 DSH Desktop，在现有 GUI 刷新页面。

安装脚本会把插件放到 `%DSH_HOME%\plugins\dsh-plugin-prompt-optimizer`，并在活动 profile 的 `node_modules` 里建立指向它的 junction。

只改 `prompt.md` 可在下一次点击热读；修改 `lib/*.js` 或版本元数据需要重启 DSH。0.3.0 包含代码改动，刷新页面不足以更新宿主逻辑。

手动安装时，在 profile 的 `package.json` 中加入：

```json
{
  "dependencies": {
    "dsh-plugin-prompt-optimizer": "link:E:/path/to/dsh-plugin-prompt-optimizer"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-plugin-prompt-optimizer"]
    }
  }
}
```

将以上字段合并到原配置，不覆盖已有依赖和 bundles；确保 `node_modules` 能解析安装目录，然后重启。

卸载：退出 DSH Desktop 后运行 `scripts/uninstall.bat`，撤销插件依赖、bundle 和 junction，并移除安装目录；需要保留文件时使用卸载脚本的 `-KeepFiles` 参数。

## 配置

```yaml
- insert:
    - id: prompt-optimizer
      name: dsh-plugin-prompt-optimizer
      config:
        maxInputChars: 12000
        maxOutputTokens: 1800
        timeoutMs: 120000
        evaluate: off          # off | compare | full
        evalCases: 2           # 0–3
        evalBudget: 12         # 含评测、降级和重试的总调用上限
        keepVersions: true
        dataDir: ''
```

## 测试

```bash
node scripts/selftest-host.mjs     # 76 项
node scripts/selftest-client.mjs   # 25 项
```

两套脚本用假的 Cordis ctx、假 HTTP 请求响应和假 React 直接加载真实模块：不调用模型，也不需要启动 DSH。当前两套全部通过。

需要注意的是，这些自测只覆盖契约与闸门（路由、调用次数、补缺前置、空输出重试、占位符作废、能力保留/结构/膨胀检查、评测三层、日志与版本、内联样式与无文字状态）。**它们不能证明改写质量**：改写好坏仍取决于元提示词和你选的模型。

0.3.0 没有用真实模型做过速度或效果的对照实验，README 中的调用次数是调度上的上限，不是实测延迟。

## 参考与许可

- [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [weisun23/prompt-optimizer](https://github.com/weisun23/prompt-optimizer)
- MIT
