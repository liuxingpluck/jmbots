# DSH 对话归档方案（待 Ah Ko 审核，未动手）

> 2026-11-15 11:30 ET，jm开发。本文只是方案。调查全程只读：没有复制、导出、删除或建链接，也没调 DSH 接口、没发 DSH 消息。
> 数字来自虚拟机对 `F:\aidata\.dsh-beta` 的只读全量扫描（每个会话文件都在内存里解压过一遍）。

## 一、现状：DSH 把对话存在哪、存成什么样

**位置**：DSH 主目录是 `F:\aidata\.dsh-beta`（虚拟机上是 `~/project/faidata/.dsh-beta`），对话在它下面的 `sessions\` 里。

```
F:\aidata\.dsh-beta\
├─ sessions\                         ← 对话原件，518 MB（zstd 压缩）
│   └─ --F-aidata-source-jmbots--\   ← 按会话的 cwd 推导出的工作区文件夹（盘符:\a\b → --盘符-a-b--）
│       └─ <会话ID>\session.v4.jsonl.zstd   ← 一个会话一个文件夹、一个文件
├─ storages\workspace.json           ← 工作区登记表：工作区标题、路径、界面里显示哪些会话、已归档会话名单
├─ storages\session_projcache\       ← 投影缓存（193 MB，能从原件重算，不用归档）
├─ attachments\v1\objects\xx\<sha256>   ← 图片等附件，按内容哈希存放（2292 个，1.24 GB）
├─ .dsh-memory\                      ← DSH 自己的记忆（1593 个文件，18 MB）
├─ logs\  recovery\  im\  bot\  dsh-ops\  …  ← 运行日志、IM 配置等，不算对话
└─ 备份_会话改cwd_20261103\           ← 11-03 迁移 cwd 时的旧备份（40 MB）
```

**数量**：

| 项 | 数 |
|---|---|
| 工作区文件夹 | 17 个（workspace.json 里登记了 14 个工作区） |
| 会话文件 | 970 个，另有 1 个空文件夹（`session-763aa991…`） |
| 其中子代理会话（文件头 `origin: subagent`，带 `parentSession`） | 540 个 |
| 界面里登记的会话 / 已归档会话 | 418 个 / 130 个 |
| 时间跨度 | 2026-10-15 04:34 ET 到 2026-11-15 00:39 ET |
| 压缩后 / 解压后 | 518 MB / 1586 MB（约 1.6 GB jsonl） |
| 事件行 / 轮次 / 工具调用 | 614,517 行 / 5,470 轮 / 116,216 次 |
| 单个会话最大（解压后） | 74 MB |
| 附件 | 2292 个，每个都有会话引用 |

**各工作区（会话数 / 轮次 / 缓存命中率）**：jmbots 439 / 1151 / 98.0%，AOPC 257 / 3196 / 98.0%，AOBB 53 / 365，aigame 52 / 105，jmai 49 / 123，aios 30 / 145，aidata 17，AIvideo 17，AOBW 16，.dsh-beta-im 14，FuZhu 7，Xiao_He 5，Han_Xin 4，bot-workspace 3，deepseek 默认工作区 3（空），Zhang_Liang 2，WeKnora 2。

**格式**：`session.v4.jsonl.zstd` 是多帧 zstd（每次追加写一帧、带校验和），解开后是 JSONL，一行一个事件：`{type, seq, time, data, surfaceOp?}`。第一行是文件头 `{type:"session", version:4, id, createdAt, cwd, parentSession, origin, delegationDepth, agentPreset}`。970 个文件全部能解开，没有坏行，没有写了一半的尾巴。

主要事件类型（括号里是我们要的信息）：

- `user/message`：用户消息（`data.content[]`，含 text / image；`source.kind=user` 是你本人打的字，其他是系统注入的）
- `assistant/message`：模型回复（`content[]` 里有 text、reasoning 思考、tool-call 工具调用；**`usage`：inputTokens、outputTokens、cacheReadTokens、cacheWriteTokens、reasoningTokens、totalTokens**；`source.provider/model`；`stream`：逐字流和时间戳）
- `tool/call`（工具名、参数）、`tool/result`（完整输出文字或图片、isError）、`job/registered/settled`（命令起止时间、退出码）
- `turn/start|end`（结束原因，比如 error / NO_ADAPTER）、`step/start|end`、`llm/retry`、`assistant/attempt`（失败的尝试）
- `model/selection`、`session/title`、`todo/write`、`goal/change`、`compaction/*`（上下文压缩和摘要）、`team/*`、`subagent/*`、`request/header`（每次请求带的工具清单和配置）、`request/context`（上下文窗口）
- `surfaceOp`：`append` 是新增，`{op:"replace",startSeq,endSeq}` 是界面层替换（比如压缩后）。原始事件都还在，导出时按原始事件来。

**token、命中率、费用**：
- 每条 assistant 消息都有 usage。全部会话合计：input 3.92 亿、cacheRead 156.9 亿、output 4559 万、reasoning 643 万。cacheWrite 全是 0。整体命中率 cacheRead/(input+cacheRead) ≈ 97.6%。cacheRead 是每一步把整个上下文重读一遍累加出来的，所以数字很大，这是正常的。
- **日志里没有费用字段**（cost/price/usd 只出现在聊天正文里）。要算钱，只能按模型配一张单价表来估，见“待你决定”第 4 条。

**DSH 自带的导出**（源码 `source/deepseek-harness/packages/session-query/session-log-export`，DSH 0.2.2-alpha.2）：
- `GET /api/session.export?sessionId=…`：下载 ZIP。里面有解压后的 `session.v4.jsonl`、子会话 `subagents/<id>/…` 和附件，是无损的。
- `GET /api/session.markdown?sessionId=…`：复制成 Markdown。但它**会省略**思考、system / developer 消息、请求头、usage、运行记录，工具活动也折叠了，**不满足“完完整整”**。
- 两个接口都要登录。现有 `ztools/dsh-control/.env` 里还是旧 token。要用接口，得你同意后把 `.env` 换成新地址（本次没改）。

**⚠ 有一块不在 jsonl 里，可能已经丢了**：工具输出太长时，DSH 会把全文 “spill” 到 Windows 临时目录 `C:\Users\leon\AppData\Local\Temp\dsh-spill-XXXX\session-…\`，jsonl 里只留预览和这个路径。扫下来 **294 个会话、1328 处**这样的引用。DSH 启动时会清掉过期的 spill 文件（`spill-local/cleanup.ts`，按 cleanupPeriodDays），虚拟机看不到 C 盘，所以**现在还剩多少不知道**，要在 Windows 上查。

**还不知道的**：Windows 上 `%TEMP%\dsh-spill-*` 还剩多少；C 盘有没有别的 DSH 主目录或 profile（目前所有迹象都指向 `F:\aidata\.dsh-beta`）；DSH 界面的“删除会话”是删文件还是只移出登记（要看源码或实测）。

## 二、归档放在哪、怎么链接

**建议放在** `F:\aidata\AIJMBots\DSH归档\`，和 `jmbotsData` 同级，**不放进 jmbotsData 里面**。原因：
- jmbotsData 是开发运行目录，有过整体换掉的先例（`bak\before_jmbotsData_…`、`废目录_20261104`）。
- 归档放在外面，删运行目录也删不到它。

运行目录要用时，在 jmbotsData 里建一个**目录联接（junction）**：

```
F:\aidata\AIJMBots\jmbotsData\dsh-archive  ⇒  F:\aidata\AIJMBots\DSH归档
命令（Windows）：mklink /J F:\aidata\AIJMBots\jmbotsData\dsh-archive F:\aidata\AIJMBots\DSH归档
```

- **为什么用 junction、不用 symlink**：junction 不需要管理员或开发者模式，同盘就能用（都在 F 盘）。symlink（`mklink /D`）要提权，可能触发 UAC 或 360 提示。
- **删运行目录时**：资源管理器、`rmdir /s`、Node 的 `fs.rm` 删到 junction 都只删链接本身，不会进去删目标。**有一个坑**：老版 Windows PowerShell 5.1 的 `Remove-Item -Recurse` 对 junction 有过会删到目标内容的问题。所以建议再加两道保险：
  1. 归档完成后给 `DSH归档` 设只读 ACL（只允许读，删除和写入要单独放开），或者干脆每次只读挂载；
  2. 另外再存一份冷备（另一块盘、NAS，或者打成 7z），见“待你决定”第 2 条。
- **360**：mklink 是系统命令，一般不会拦，但可能会提示。按规定我们不改 360 信任区，提示了由你点。
- **其实可以不建链接**：`Doc_Import.ts` 的 `--dir` 是按数据目录算的相对路径，写 `--dir ../DSH归档/kb` 就能直接读。链接只是为了在运行目录里看着顺手。
- **虚拟机这边**：vmhgfs 共享未必能正确穿过 Windows junction。虚拟机里的脚本一律直接用真实路径 `~/project/faidata/AIJMBots/DSH归档`。

**jmbots 运行时会不会强行建目录、会不会误删**（查了源码）：
- `jmbots-memory`（memsvc）只在 `memory.yaml` 的 `store_dir: data/memory` 下 `create_dir_all` 建它自己的库，不碰别的目录；`remove_dir_all` 只出现在单元测试里，删的是系统临时目录。
- `src7` 里没有递归删目录的代码。`rmSync` 只用在单个文件上（pid 文件、上传临时文件、记忆文件删除动作、微信读取临时文件）。
- 结论：运行时不会去动 `dsh-archive` 这个链接，也不会主动删它。**知识库导入后的数据在 `jmbotsData\data\memory\memory.db`（开发目录，可能丢）**，不过它随时能从归档重新导入，丢了也不要紧。

## 三、归档目录结构（照 DSH 原样）

```
F:\aidata\AIJMBots\DSH归档\
├─ README.md                  说明、来源、导出时间、工具版本
├─ 总索引.md / index.json      工作区 → 会话：标题、创建时间、轮次、模型、token 合计、命中率、父子关系、文件路径
├─ SHA256SUMS                 每个文件的哈希
├─ _dsh元数据\                 workspace.json、schedule.json、.dsh-memory\ 原样拷贝（DSH 自己的记忆也有价值）
├─ attachments\v1\objects\…   附件原样拷贝（按哈希存，同一张图只存一份）
├─ _spill\                    从 Windows %TEMP%\dsh-spill-* 抢救回来的工具全文输出（还有多少拷多少）
├─ sessions\                  ← 和 DSH 一模一样：工作区文件夹\会话ID\
│   └─ --F-aidata-source-jmbots--\
│       └─ session-2ab1a747-…\
│           ├─ session.v4.jsonl.zstd   原件，逐字节一致（这才是“原始数据”）
│           ├─ session.v4.jsonl        解压后的原始 JSONL，一字不改
│           ├─ 对话.md                 完整文字版（格式见下）
│           └─ meta.json               标题、cwd、父会话 / 子会话、模型、轮次、各类 token 合计、命中率、工具调用统计、引用的附件和 spill、两个文件的 sha256
└─ kb\                        给知识库用的精简文本（见第五节），可以随时重新生成
```

- 子代理会话照 DSH 原样平放在同一个工作区文件夹里，靠 meta.json 和 对话.md 里的“父会话 / 子会话”链接互相跳转，不搬家，好和原件逐一核对。
- 估算大小：zstd 原件 0.52 GB + jsonl 1.6 GB + md 约 0.6–0.9 GB + 附件 1.24 GB + 元数据，**一共约 4–4.5 GB**。如果不存解压版 jsonl（zstd 本身就是无损的，脚本随时能解开），可以省 1.6 GB，见“待你决定”第 1 条。

## 四、对话.md 格式（每个会话一份，什么都不省）

````markdown
# claude 微信监听改版（session-2ab1a747-…）
- 工作区：jmbots（F:\aidata\source\jmbots）　原件：sessions/--F-aidata-source-jmbots--/session-2ab1a747-…/session.v4.jsonl.zstd
- 创建：2026-11-14 22:10 ET　轮次 12　步数 163　工具调用 145（read 40 / pwsh 33 / edit 20 …）
- 模型：magpie/bailian-token-plan/qwen4-max-preview（xhigh）
- token 合计：输入 23.1 万 · 缓存读 512 万 · 输出 1.8 万 · 思考 0.3 万 · 命中率 95.7%
- 父会话：— 　子会话：[23019019-…](../23019019-…/对话.md)

## 第 1 轮　2026-11-14 22:11 ET　（结束：completed，用时 6 分 12 秒）

### 👤 用户（22:11:05）
> 原文……

### 🤖 助手 · 第 1 步（22:11:20 · qwen4-max-preview · 输入 23117 / 缓存读 0 / 输出 353 / 思考 0 · 命中 0%）
<details><summary>思考</summary>

思考原文……
</details>

正文原文……

#### 🔧 工具调用 pwsh（call_9078…，22:11:20 → 22:11:27，退出码 0）
```json
{"description":"…","command":"…"}   ← 参数完整，不截断
```
<details><summary>结果（12,756 字，isError=false）</summary>

```text
完整输出……（如果是 spill，附上 _spill/ 里的全文链接；如果全文已经丢了，标注“DSH 只留了预览”）
```
</details>

![图片 Image_Push_Test.png 1200×800](../../../attachments/v1/objects/85/8579…)

### ⚙ 系统 / 注入（approval 变更、inbox 插入、压缩摘要、重试、失败尝试 NO_ADAPTER …）
````

- 每一条 user / assistant / tool / system / developer 事件都按 seq 顺序写进来，包括失败的尝试、重试、压缩摘要、todo、goal、team 任务。`request/header`（工具清单）每个会话只写一次摘要，原文留在 jsonl 里。
- `stream` 里的逐字流不写进 md（太大），只算出首字延迟和解码用时写进去，原文留在 jsonl 里。
- 自己写渲染器。DSH 自带的 `formatSessionMarkdown` 会丢掉思考、usage 和 system 消息，只拿来对照。

## 五、导入我们的知识库

- **用什么导**：`ztools/doc-import/Doc_Import.ts` → jmbots-memory（memsvc，端口 15823）的 `/ingest`。嵌入用本地 `bge-m3-int8`，**嵌入不花钱，只占 CPU**。
- **花钱和费时的是三元组抽取**：memsvc 会对每一段在后台调 `extract_model`（minimax-code/MiniMax-M3.1-Flash，并发 2）。`Doc_Import.ts` 现在**不传 `graph:false`**，所以导多少段就要抽多少次。需要给它加一个小参数 `--no-graph`（memsvc 本来就支持 `graph:false`：能搜，但不抽）。
- **不能把 1.6 GB 原样灌进去**。各类文字量（全量扫描）：你本人打的字 230 万字、助手正文 490 万、压缩摘要 660 万、思考 4950 万、工具参数 5580 万、工具输出 2.46 亿。建议 `kb\` 精简版只放：
  - 你的原话；
  - 助手正文；
  - 压缩摘要；
  - 每次工具调用一行（工具名、参数前 200 字、结果前 300 字、是否报错）。
  这样大约 1500–2500 万字，按 700 字一段，约 **2–3.5 万段**。思考和完整输出不进库，要用的时候按 meta 里的路径回原件查。
- **隔离**（很重要）：DSH 对话里有命令行、路径，甚至 token。所以：
  1. 用 `--scope history --customer dsh:<工作区>`（比如 `dsh:jmbots`、`dsh:AOPC`）导入。memsvc 规定查聊天记录必须带客户号，所以给客户用的机器人、/wechat-kefu 都搜不到这些内容。
  2. 生成 kb 文本时**先脱敏**：token、key、`?token=`、open_id、密码这一类替换成 `***`。原件不动，原件就是原始数据。
- **分批**：
  1. 先导 jmbots 工作区（439 个会话），开三元组，看效果和用时；
  2. 其余工作区用 `--no-graph`，只走 BM25 + 向量；
  3. 想要关系图时，再对选中的工作区跑 `/graph/retry` 或重新导入。
  三元组只用 Magpie 的 minimax / workbuddy。用之前先确认 Magpie（3425 端口）开着。
- **检索出处**：每段的 source 写成 `dsh/<工作区>/<会话ID>#第N轮`。/memory 页面已经能显示出处路径，点进去就是 对话.md。

## 六、清理 DSH 之前必须核对（不过不清）

1. **数量对得上**：17 个工作区文件夹、970 个会话文件（+1 个空文件夹）、2292 个附件，和归档里一一对应。导出那一刻要重新数，因为 DSH 一直在写新会话。
2. **字节一致**：每个 `session.v4.jsonl.zstd` 的 sha256 和原件相同；解压后的 jsonl 的 sha256 和从原件现解的相同；附件哈希等于文件名。
3. **内容完整**：每个会话按 jsonl 重新数一遍事件行、轮次、工具调用、usage 合计，要和 meta.json、对话.md 里的数一致（例如全量合计 614,517 行、5,470 轮、116,216 次工具调用）；对话.md 里 tool/call 和 tool/result 一一配对。
4. **spill**：列出 1328 处 spill 引用里，哪些已经找回全文、哪些只剩预览，交给你确认。
5. **冷备**：归档再打一份 7z 或拷到另一处，并试着解压校验一次。
6. **导出的时候 DSH 要停**：最好先退出 DSH 再拷，避免拷到正在写的半帧（脚本会检查文件末尾有没有不完整的帧）。
7. **清理方式**：先在 DSH 里归档或删一两个会话看看效果，再整批清理。整批之前把整个 `sessions\` 改名留着（比如 `sessions.清理前_日期`），过一周确认没问题再删。删除由你本人操作，或者你明确点头后再做。

## 七、风险

- spill 全文可能已经被 DSH 清掉，这部分**可能已经不是无损**，只能尽量抢救。
- 归档里**原样保留**了对话里出现过的 token 和密钥。目录不要共享，也不要进 git；只有 kb 版是脱敏的。
- 体积约 4–4.5 GB。vmhgfs 读写慢，全量导出估计 10–30 分钟（只读扫描一遍 27 秒，写入会慢很多）。
- 知识库一次灌 2–3.5 万段：嵌入要跑几个小时 CPU；如果全开三元组，minimax 调用数会到几万次。所以分批，默认 `--no-graph`。
- junction 碰上老版 PowerShell 的递归删除，有误删目标的历史问题，所以要加只读 ACL 和冷备。

## 八、要做的事（审核通过后）

1. 写 `ztools/dsh-archive/Dsh_Archive.mjs`（零依赖，Node 内置 zstd）：
   - 只读 `.dsh-beta`；
   - 写到 `DSH归档`；
   - 生成 jsonl、md、meta、index、SHA256SUMS、kb 精简版；
   - 自带 `--verify` 核对模式。
   先在小工作区（WeKnora、Zhang_Liang）试，结果给你看。
2. Windows 上（由你或 DSH 执行）：
   - 统计并拷贝 `%TEMP%\dsh-spill-*` 到 `_spill\`；
   - `mklink /J` 建链接；
   - 设只读 ACL。
3. `Doc_Import.ts` 加 `--no-graph` 和脱敏两个小改动，然后分批导入，用 /memory 抽查。
4. 你确认核对报告后，再清理 DSH。

## 九、待你决定

1. 解压版 `session.v4.jsonl` 要不要也存（多 1.6 GB）？默认：存，方便直接看。
2. 冷备放哪：另一块盘、NAS，还是 F 盘另一个目录打成 7z？
3. 归档目录名用 `F:\aidata\AIJMBots\DSH归档`，链接名用 `jmbotsData\dsh-archive`，可以吗？
4. 费用要不要按模型单价表估算一栏（日志里本身没有费用，我会给出单价来源）？
5. 知识库范围：先只导 jmbots，还是 17 个工作区全导？三元组只给哪些工作区开？
6. 子代理会话（540 个）也进知识库吗？默认：进归档，知识库只放主会话加子代理的最终回复。
7. 现在 `.env` 里是旧 token。要不要换成新地址（只在需要 DSH 接口时才换；本方案直接读文件，用不上接口）？

## 十、执行命令清单（2026-11-15 13:55 ET 定稿，等你审核；以下命令一条都还没执行写入）

**你 11-15 定的**：
- 解压版 jsonl 也存；
- 知识库导入全部工作区，子代理会话也进；关系抽取默认关闭（`--no-graph`）；
- 费用按单价估算；
- 归档放 `F:\aidata\AIJMBots\DSH归档\`，**暂不建链接，也不做冷备**；
- Windows 临时目录里的 spill 长输出**不管**。

**为什么 spill 可以不管**（只读看过数据）：涉及 spill 的工具结果一共 702 条（之前数的 1328 处里含同一路径的重复引用）。按工具分：glob 304、grep 131、web_fetch 104、pwsh 62、ops_bash 25、job_output 22、read 34、其他 20。jsonl 里每条都留了 2–5 万字预览，被外置的主要是文件清单、搜索结果和下载进度这类，确实不重要。

**脚本**：
- `ztools/dsh-archive/Dsh_Archive.mjs`：新文件，零依赖，Node ≥ 22.15，所有路径都从参数传。
- `ztools/dsh-archive/prices.example.json`：单价表模板。各模型的单价和 inputTokens 计数口径都还没核实，所以全部先填 null，不按 0 元冒算。

脚本有四个子命令：
- `survey`：只读统计；
- `render`：把一个会话的 md 打到屏幕，只读；
- `export`：归档，带 `--dry-run` 时只算不写；
- `verify`：只读核对。

**已做的只读演练**（13:49 ET，`export --dry-run`，全量，45 秒，什么都没写）：

| 内容 | 文件数 | 大小 |
|---|---|---|
| 会话 | 971 个（又多了 1 个新的）+ 1 个空文件夹 | — |
| zstd 原件 | 971 | 518 MB |
| 解压 jsonl | 971 | 1849 MB |
| 对话.md | 971 | 611 MB |
| meta.json | 971 | 2 MB |
| kb 精简版 | 971 | 71 MB |
| 附件 | 2292 | 1238 MB |
| `_dsh元数据` | — | 18 MB |
| **合计** | **8748** | **4.21 GB** |

附件内容哈希和文件名全部一致。

### 步骤

| # | 在哪跑 | 读什么 | 写什么 | 预计 |
|---|---|---|---|---|
| 0 | 你 | — | — | 先**退出 DSH**（或者确认没有会话在跑），免得拷到写了一半的帧；脚本碰到没写完的文件会直接报错停下 |
| 1 | 虚拟机 | DSH 主目录 | 无 | 只读统计，核对会话数和大小 |
| 2 | 虚拟机 | DSH 主目录 | 无 | 全量演练（`--dry-run`），确认 4.2 GB、8748 个文件 |
| 3 | 虚拟机 | DSH 主目录 | `F:\aidata\AIJMBots\DSH归档\`（新目录，4.2 GB） | 正式归档；虚拟机经 vmhgfs 写 F 盘，估计 5–15 分钟。断了就加 `--resume` 接着做 |
| 4 | 虚拟机 | DSH 主目录 + 归档 | 无 | 核对：原件和解压文件的哈希、事件/轮次/工具调用/usage 合计、对话.md 里工具调用和结果数、附件数、SHA256SUMS 全量复核 |
| 5 | 你 | 归档 | 无 | 打开 `总索引.md` 和几份 `对话.md` 抽查 |
| 6 | 虚拟机 | — | `Doc_Import.ts` 小改动（改前先备份） | 加 `--no-graph` 参数，见下方说明 |
| 7 | Windows | 归档里的 `kb\` | 无（`--dry-run`） | 看每个工作区切成多少段 |
| 8 | Windows | 归档里的 `kb\` | jmbots-memory 库 `jmbotsData\data\memory` | 逐个工作区导入知识库。嵌入在本地 CPU 上算，不花钱，估计 1–3 小时 |
| 9 | 你 | /memory 页面 | 无 | 抽查检索效果 |
| 10 | 以后 | — | — | 清理 DSH 之前：先 `export --resume`（只补新增或变化的会话），再跑 `verify`，`pass: true` 才能清 |

### 命令原文

```bash
# ---- 虚拟机（leonppp@130）----
cd ~/project/faidata/source/jmbots/ztools/dsh-archive
H=~/project/faidata/.dsh-beta            # DSH 主目录 = F:\aidata\.dsh-beta
O=~/project/faidata/AIJMBots/DSH归档      # 归档目录 = F:\aidata\AIJMBots\DSH归档（现在还不存在）

# 1 只读统计
node Dsh_Archive.mjs survey --dsh-home "$H"
# （可选）只读看一个会话渲染出来的样子
node Dsh_Archive.mjs render --dsh-home "$H" --session session-ec7234e5-7511-424d-947d-81580c269cbd --prices prices.example.json | less
node Dsh_Archive.mjs render --dsh-home "$H" --session session-ec7234e5-7511-424d-947d-81580c269cbd --kb | less

# 2 全量演练（不写）
node --max-old-space-size=8192 Dsh_Archive.mjs export --dsh-home "$H" --out "$O" --prices prices.example.json --dry-run

# 3 正式归档（写 4.2 GB）；断了就在末尾加 --resume 重跑
node --max-old-space-size=8192 Dsh_Archive.mjs export --dsh-home "$H" --out "$O" --prices prices.example.json

# 4 核对（只读），最后输出 "pass": true 才算过
node --max-old-space-size=8192 Dsh_Archive.mjs verify --dsh-home "$H" --out "$O"
```

```powershell
# ---- Windows（你或 DSH 执行）----
cd F:\aidata\source\jmbots
$bun = 'D:\dev\nodejsnpm\node_modules\bun\bin\bun.exe'
$kb  = 'F:\aidata\AIJMBots\DSH归档\kb'

# 7 演练：只切段、不入库
Get-ChildItem $kb -Directory | ForEach-Object {
  & $bun ztools/doc-import/Doc_Import.ts --runtime F:\aidata\AIJMBots\jmbotsData --dir "..\DSH归档\kb\$($_.Name)" `
    --customer "dsh:$($_.Name.Trim('-'))" --scope history --no-images --no-graph --dry-run
}

# 8 正式导入（要 jmbots-memory 15823 端口在线；断了加 --keep 重跑就是接着导）
Get-ChildItem $kb -Directory | ForEach-Object {
  & $bun ztools/doc-import/Doc_Import.ts --runtime F:\aidata\AIJMBots\jmbotsData --dir "..\DSH归档\kb\$($_.Name)" `
    --customer "dsh:$($_.Name.Trim('-'))" --scope history --no-images --no-graph --batch 50
}
```

- **客户号**：每个工作区一个，比如 `dsh:F-aidata-source-jmbots`、`dsh:F-aidata-AOPC`，一共 17 个。按 memsvc 的规定，查聊天记录必须带客户号，所以给客户用的机器人和 /wechat-kefu 都搜不到。想跨工作区一起搜，以后可以用 `POST /customers/merge` 合并成一个。
- **为什么导入要在 Windows 上跑**：虚拟机连不到 `192.168.200.1:15823`（13:50 ET 测过，超时）。
- **段数**：kb 一共 71 MB，按 700 字一段估计 **5–7 万段**；第 7 步的演练会给出准确数字。

### 第 6 步：Doc_Import.ts 要改的地方（还没改）

1. `interface Doc` 加一个可选字段 `graph?: boolean`。
2. 切段生成 docs 时，带了 `--no-graph` 就给每段加 `graph: false`。memsvc 的 MemoryDoc 本来就有这个字段：能用 BM25 和向量搜，但后台不做三元组抽取，也不调 minimax。
3. 在文件头注释和 `ztools/doc-import/README.md` 的参数说明里补上 `--no-graph`。
4. （可选）现在归档在数据目录外面，source 只记文件名，形如 `doc-import:dsh:<工作区>:<日期_标题_会话ID>.md`。如果想让 /memory 页面显示完整路径，可以再加一个 `--source-root` 参数，按归档根目录记相对路径。默认不做。

### 费用

`费用估算.md` 会按模型列出各项 token 数。模板里还没有任何单价，也没确认 inputTokens 是否已经含缓存 token，所以现在每个模型都显示“未定价”。要出钱数，先把单价表里的 input、cacheRead、cacheWrite、output（每百万 token）、`inputIncludesCache` 和来源 `source` 填完整，再用同一条命令带 `--prices` 重跑第 3 步（加 `--resume` 只会跳过没变的会话；费用汇总每次都会重算）。

### 不会做的事

- 不改 DSH 的任何文件；
- 不动 `.env`，不调 DSH 接口；
- 不建 junction；
- 不碰 jmbotsDataS4；
- 不删任何东西。

清理 DSH 由你本人操作，要等第 10 步核对通过之后。
