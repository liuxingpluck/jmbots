# pi-ai 类型速查

按项目安装的 `@earendil-works/pi-ai` 1.4.0 整理。声明位置以 `node_modules/@earendil-works/pi-ai/dist/` 为起点，使用位置以 `src7/` 为起点。表中字段是阅读会话、工具和模型请求时最常遇到的部分。带 `?` 的字段可省略。

## 对话与工具

| 类型 | 是什么 | 重要字段或取值 | 声明位置 | src7 使用位置 |
| --- | --- | --- | --- | --- |
| `Message` | 对话历史里的一条 | `role` 区分 `'system'`、`'user'`、`'assistant'`、`'toolResult'`，各分支各有 `content` 和毫秒 `timestamp` | `types.d.ts:436` | `Sessions.ts` 存取和广播对话，`plugins/bots/FrontDesk.ts` 暂存用户话，`plugins/context-fit/index.ts` 裁剪历史，journal 和 progress 记录历史 |
| `SystemMessage` | 改变后续模型指令或工具的消息 | `role: 'system'`，`content: string \| TextContent[]`，可选 `sections`、`toolsAdded`、`toolsRemoved` | `types.d.ts:346` | `plugins/bots/FrontDesk.ts` 以系统消息补往来背景 |
| `UserMessage` | 交给模型的用户输入 | `role: 'user'`，`content: string \| (TextContent \| ImageContent)[]`，`timestamp` | `types.d.ts:363` | `Sessions.ts` 接入用户话，`plugins/file-tools/BaseTools.ts` 在支持看图时补图片块 |
| `AssistantMessage` | 模型给出的一条回答 | `role: 'assistant'`，`content: (TextContent \| ThinkingContent \| ToolCall)[]`，`stopReason`、`usage`、`api`、`provider`、`model`、`errorMessage?` | `types.d.ts:368` | `Sessions.ts` 发请求和接回答，`plugins/model-catalog/Fallback.ts` 换模型重发，`plugins/context-fit/Compress.ts` 读用量，`plugins/web-api/Trace.ts` 关联轨迹 |
| `StopReason` | 模型响应的结束状态 | `'pending'`、`'stop'`、`'length'`、`'toolUse'`、`'error'`、`'aborted'`、`'deferred'` | `types.d.ts:307` | `Sessions.ts` 处理失败与取消，`plugins/screen/Screen.ts` 要求一条完整回答 |
| `ToolResultMessage` | 接进历史的单次工具结果 | `role: 'toolResult'`，`toolCallId` 配对调用，`toolName`、`content: (TextContent \| ImageContent)[]`、`isError`，可带 `details` | `types.d.ts:420` | `Sessions.ts` 封装结果，`plugins/context-fit/index.ts` 将旧结果换成占位文字，`tests/Session_Gates.test.ts` 核对工具关口 |
| `Tool` | 给模型看的工具定义 | `name`、`description`、TypeBox schema `parameters`、`constrainedSampling?: false \| ConstrainedSamplingConfig` | `types.d.ts:528` | `Tools.ts` 登记、筛选并校验参数，`Sessions.ts` 把定义交给模型 |
| `ToolCall` | 模型要求执行的一次工具调用 | `type: 'toolCall'`，`id`、`name`、`arguments: JsonObject`、`argumentsError?` | `types.d.ts:271` | `Sessions.ts` 从回答中识别，`Tools.ts` 执行，`plugins/bots/FrontDesk.ts` 查渠道回复工具 |
| `TextContent` | 文字内容块 | `type: 'text'`，`text`、`textSignature?` | `types.d.ts:252` | `Sessions.ts` 和 `Tools.ts` 封装工具文字，`plugins/screen/Screen.ts` 携带屏幕相关文字 |
| `ThinkingContent` | 模型思考内容块 | `type: 'thinking'`，`thinking`、`thinkingSignature?`、`redacted?` | `types.d.ts:257` | `Sessions.ts` 随模型回答存入对话 |
| `ImageContent` | 图片内容块 | `type: 'image'`，Base64 `data`、`mimeType` | `types.d.ts:266` | `Tools.ts` 返回图片，`plugins/file-tools/BaseTools.ts` 读取图片，`plugins/screen/Screen.ts` 附带截图 |
| `JsonObject` | 键为字符串、值为 JSON 的对象 | `[key: string]: JsonValue`，值可用 `null`、布尔、数字、字符串、数组或嵌套对象 | `types.d.ts:308–311` | `plugins/decision/index.ts` 传给分类器的状态，`Tools.ts` 处理的工具调用参数 |

## 模型请求与供应商

| 类型 | 是什么 | 重要字段或取值 | 声明位置 | src7 使用位置 |
| --- | --- | --- | --- | --- |
| `Context` | 发请求时交给 pi-ai 的输入 | `systemPrompt?`、`messages: Message[]`、`tools?: Tool[]` | `types.d.ts:543` | `Sessions.ts` 会话请求，`plugins/programs/ChannelBridge.ts` 起草回复，screen 和 voice 的模型请求 |
| `SimpleStreamOptions` | 模型单次调用的选项 | `signal?`、`timeoutMs?`、`maxRetries?`、`maxTokens?`，思考档 `reasoning?` 取 `'minimal'`、`'low'`、`'medium'`、`'high'`、`'xhigh'`、`'max'`，`toolChoice?` 取 `'auto'` 或 `'none'` | `types.d.ts:233`，继承项见 48、107 行 | `Sessions.ts`、`plugins/screen/Screen.ts`、`plugins/voice/Models.ts` |
| `ModelThinkingLevel` | 模型统一思考档 | `'off'`、`'minimal'`、`'low'`、`'medium'`、`'high'`、`'xhigh'`、`'max'` | `providers/model-schema.d.ts:8、80` | `Sessions.ts` 定义 jmbots 的 `Thinking`。`'off'` 时会话请求省略 `reasoning` |
| `RetryPolicy` | 调用失败后的重试策略 | `enabled`、`maxRetries`、`baseDelayMs`、`maxAgentDelayMs?` | `utils/retry.d.ts:9` | `Sessions.ts` 的 `chat()` |
| `Usage` | 一次模型调用的用量和费用 | `input`、`output`、`cacheRead`、`cacheWrite`、`totalTokens`、`cost`，可选 `reasoning` 是已计入 `output` 的一部分 | `types.d.ts:285` | `Sessions.ts` 接收回答内的用量，`plugins/model-catalog/Usage.ts` 记账，`plugins/screen/Screen.ts` 收集用量 |
| `AssistantMessageEventStream` | 单次模型回答的异步事件流 | 异步遍历可读增量，`result()` 取最终 `AssistantMessage`，`push(event)` 写事件 | `utils/event-stream.d.ts:22`，`result()` 见 14 行，事件类型见 `types.d.ts:575` | `plugins/screen/Screen.ts` 读流，`plugins/screen/Screen.test.ts` 构造假流 |
| `Model<Api>` | 可发对话请求的目录项 | `id`、`provider`、`api`、`baseUrl`、`contextWindow`、`maxTokens`、`reasoning`、`input`、`cost` | `types.d.ts:643`，基础字段见 630 行 | `Resources.ts` 从配置生成模型，`plugins/screen/Screen.ts` 选支持看图的模型 |
| `Api` | 对话接口适配器标识 | 已知接口与扩展字符串。jmbots 会话模型用 `'openai-completions'`、`'openai-responses'`、`'anthropic-messages'` | `types.d.ts:20–21` | `Resources.ts`、`plugins/screen/Screen.ts` |
| `ClassifierModel<ClassifierApi>` | 可发分类请求的目录项 | `type: 'classifier'`，`id`、`api`、`contextWindow`、`compat?` | `types.d.ts:674`，基础字段见 630 行 | `plugins/decision/index.ts` 登记分类模型 |
| `ClassifierApi` | 分类接口适配器标识 | `'typesafe-system-one'`、`'cloudflare-workers-ai-system-one'`、`'llama-cpp-classify'`、`'openai-decisions'`，也接受扩展字符串 | `types.d.ts:24–25` | `plugins/decision/index.ts` 指定分类适配器 |
| `Provider` | 一个运行中的供应商实例 | `id`、`name`、`baseUrl?`、`auth`、`getModels()`、`streamSimple()` | `models.d.ts:72` | `Resources.ts` 按配置建好并登记供应商 |
| `ProviderAuth` | 供应商支持的鉴权方式 | `apiKey?` 的 `resolve()` 提供请求凭据，`oauth?` 提供登录和刷新 | `auth/types.d.ts:241` | `Resources.ts` 的 `getProviderAuth()` |
| `MutableModels` | 可更新的 pi-ai 供应商与模型集合 | `setProvider()`、`deleteProvider()`、`clearProviders()`，从 `Models` 继承查模型、发请求的方法 | `models.d.ts:201`，`Models` 见 137 行 | `Resources.ts` 管理供应商，`plugins/decision/index.ts` 维护分类器集合 |
