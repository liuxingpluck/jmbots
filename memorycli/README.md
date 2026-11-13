# memorycli：代码和文档的记忆搜索

把一个目录里的代码和文档摄取成**一个 SQLite 文件**，然后：

- **搜**：给一个词，返回相关的文件，以及每个文件里有什么（AI 摘要、标签、命中的函数和标题、正文片段、相关文件）。中文两个字的词也搜得到。
- **查关系图谱**：谁调用了谁、谁导入了谁、哪篇文档提到了哪段代码、哪些文件是同一个主题（AI 标签）。
- **AI 整合**：配一个模型（OpenAI、Anthropic、Gemini 三种接口格式都行），它给每个文件写一句摘要、打几个标签，再把意思一样的标签合并。原本没有直接联系的文档和代码，会因为讲的是同一件事连到一起。

单个可执行文件，不用装数据库、不用联网（不配模型时），Linux、macOS、Windows 都能用。

## 快速开始

```bash
cd memorycli && cargo build --release     # 可执行文件在 target/release/memorycli
```

多平台编译的 GitHub Actions 工作流在 `ci/memorycli.yml`（Linux x64/arm64、macOS arm64/x64、Windows x64：测试、编译、冒烟，推 `memorycli-v*` 标签发 Release）。
memorycli 只提交自己这个文件夹，所以工作流没放进 `.github/`；要启用就把它复制到 `.github/workflows/memorycli.yml`。

```bash
memorycli ingest --root 你的项目              # 第一次全量，之后每次只处理变了的文件
memorycli search 记忆 --root 你的项目         # 搜
memorycli graph handleMessage --root 你的项目 # 查一个函数的关系
memorycli graph --root 你的项目 --html 图.html # 整张图写成网页，浏览器打开就能看
memorycli serve --root 你的项目               # HTTP 服务，默认 127.0.0.1:30090
memorycli serve --libs 库目录                 # 一个服务挂好几个库：库目录下每个子目录里一个 index.db，子目录名是库名
memorycli search 记忆 --libs 库目录 --lib memory,jmbots   # 在好几个库里一起搜
```

索引放在 `<项目>/.memorycli/index.db`（`--db` 可以改），配置在 `<项目>/.memorycli/config.yaml`（第一次运行自动写一份模板）。
输出都是 JSON，AI 和程序直接读；进度打到 stderr。

## 四个命令

| 命令 | 做什么 |
|---|---|
| `ingest [--no-ai]` | 摄取。按内容哈希比对：新文件加进来，改了的重新解析，删了的去掉，没变的不动。配了模型就给还没打过标签（或内容变了）的文件打标签，有新标签就整合一次。最后重算图谱。 |
| `search 词... [--limit 10]` | 正文（全文检索 BM25）、声明名、AI 标签、路径四路一起找，用 RRF 合成排名；配了嵌入模型（`embedding`）再多一路向量（按意思找）。几个词是“或”，都命中的排前面。 |
| `graph [名字] [--depth 1] [--html 文件]` | 名字可以是文件路径（或结尾，如 `Engine.ts`）、声明（`handleMessage` 或 `createEngine.handleMessage`）、标签、节点 ID。不写名字导出整张图（文件这一层）。 |
| `serve [--host] [--port]` | HTTP 服务，见下。 |

## HTTP 接口

| 接口 | 说明 |
|---|---|
| `GET /health` | 活着吗；挂了哪些库、各有多少东西（只挂一个库时顶层还有 root、totals） |
| `POST /ingest` `{"ai": true, "lib": "名字"}` | 开始摄取（增量），**马上返回**，在后台线程用自己的数据库连接跑，搜索不用等；同一个库正在跑时回 409。只挂一个库时 lib 可以不写 |
| `GET /ingest?lib=名字` | 这个库最近一次摄取：在不在跑、开始时间、用了几秒、统计或出错原因 |
| `GET /search?q=词&limit=10&lib=a,b` | 搜索；lib 不写就搜全部库。每条命中带 `lib`（库名）和 `abs_path`（绝对路径，库里记着根目录时才有） |
| `GET /graph?q=名字&depth=1&lib=名字` | 关系图谱；不写 q 是整张图，不写 lib 用第一个库；加 `&format=html` 回能拖、缩放、点节点的网页 |

多个库是 2026-11-04 加的：一个库只索引一个目录，而 jmbots 要一次搜到记忆库、技能库、自己的代码。各库分数是同一套四路 RRF 算的，直接按分数合并。
摄取时会把根目录记进库里（`meta` 表），绝对路径就是靠它拼的；更早建的库（jmindex 时期）没记，重新 `ingest --root` 跑一次就有了（没变的文件不重做，很快）。

## 配置（`.memorycli/config.yaml`）

```yaml
model:                       # 不写就不打 AI 标签，其余照常
  format: openai             # openai | anthropic | gemini
  base_url: http://127.0.0.1:3425/v1
  api_key: xxx               # 或 api_key_env: OPENAI_API_KEY
  model: workbuddy/deepseek-v4.1-flash
  concurrency: 4             # 同时打几个文件
  max_chars: 6000            # 每个文件最多给模型看多少字
embedding:                   # 不写就不用向量，只走四路（用户 11-05：“不存在就不用 rag”）
  base_url: http://127.0.0.1:11434/v1   # OpenAI 的 /embeddings 格式：本地起的（如 Ollama）或者供应商给的都行
  api_key_env: EMBEDDING_API_KEY        # 本地的一般不要密钥
  model: bge-m3
  max_chars: 2000            # 每块正文最多送多少字去算向量
exclude: []                  # 路径里含这些字就跳过（.gitignore、node_modules、target、dist 本来就不收）
http: { host: 127.0.0.1, port: 30090 }
```

三种格式的请求：

| format | 地址 | 密钥 |
|---|---|---|
| `openai` | `{base_url}/chat/completions` | `Authorization: Bearer` |
| `anthropic` | `{base_url}/v1/messages` | `x-api-key` |
| `gemini` | `{base_url}/models/{model}:generateContent` | `x-goog-api-key` |

## 收什么、怎么解析

| 种类 | 扩展名 | 取出来的东西 |
|---|---|---|
| 代码 | ts tsx js jsx mjs cjs rs go py | tree-sitter 解析：声明（带“外层.名字”的全名）、调用、回调、类型引用、导入 |
| 文档 | md markdown txt rst | Markdown 按标题切块，标题记成声明；链接、反引号里的代码名 |
| 配置 | yaml yml toml json | 只进全文检索 |

所有文件里提到的文件路径（如注释里的 `src/core/Engine.ts`、文档里的 `记忆.md`）都会连成 `mentions` 边。

## 图谱里的边

| 种类 | 从 → 到 | 置信度 |
|---|---|---|
| `contains` | 文件 → 声明 | 1.0 |
| `imports` | 文件 → 文件 / `pkg:外部包` | 1.0 |
| `calls` | 声明 → 声明（调用） | 同文件 0.9，导入了的文件 0.8，全局只有 1～3 个同名 0.4；同一级好几个同名的按个数平分 |
| `refs` | 声明 → 声明（当回调传出去、`{ handleMessage }`） | 同上，但不走全局那一级 |
| `types` | 声明 → 类型 | 同上 |
| `uses` | 文件 → 文件（calls/refs 汇总） | 取最大 |
| `mentions` | 文件 → 文件 / 声明（文字里提到） | 0.3～0.8 |
| `links` | Markdown 链接 → 文件 | 1.0 |
| `tagged` | 文件 → `tag:标签`（整合后的标准名） | 1.0 |

每条边记着出现在起点文件的哪些行（`lines`）。

## 准确度

只看语法，不知道一个名字到底指向哪个声明，所以要猜。拿 jmbots 自己的 TypeScript 代码，和用 TypeScript 语言服务的 codegraph 工具（`src/capabilities/tools/CodeGraph.ts`，当标准答案）比“谁用到了它”：

```
声明 299 个；标准答案里的引用处 1043 个
召回 94.0%，准确 80.9%
```

复现：`bun memorycli/bench/compare_codegraph.ts memorycli/demo/jmbots.db`。
漏的主要是 getter 的属性访问（`runtime.providers`）和 `Runtime.load` 这种静态访问；
多的主要是同一个文件里接口和实现同名的方法（`FeishuTransport.listen` 和 `createFeishu.listen`），没有类型信息分不清，所以权重平分。
graphify 漏掉的 `Feishu.ts` 里 `engine.handleMessage(...)` → `Engine.ts` 里嵌套的 `handleMessage` 这条边能查到（置信度 0.8）。

## 速度

测试机器：云端 Linux 容器，4 核 Intel Xeon 2.1 GHz，release 编译，不打 AI 标签（`--no-ai`）；每项跑 3 次。
复现：`bash memorycli/bench/speed.sh [目录] [搜索词]`。

| | jmbots 本身（162 个文件，1257 个声明，6590 条边，索引 8 MB） | 大代码库：Rust 依赖源码（3972 个文件，29 万个声明，78 万条边，索引 550 MB） |
|---|---|---|
| 全量摄取 | 0.3 秒 | 18～25 秒 |
| 没变再摄取 | 11 毫秒 | 0.15 秒 |
| 改一个文件再摄取 | 70～85 毫秒 | 9～11 秒 |
| `search`（命令行，含启动进程） | 8 毫秒 | 80～220 毫秒 |
| `graph`（命令行，含启动进程） | 6～11 毫秒 | 30 毫秒 |
| HTTP `/search` | 3 毫秒 | 没测 |
| HTTP `/graph`（走两步） | 6 毫秒 | 没测 |

- 改了文件就要重算整张图：小项目无所谓，几十万条边时要 9～11 秒（读声明、对上调用、写回数据库各占一部分）。TODO：只重算受影响的那部分。
- 什么都没变时不重算图，只扫一遍文件比哈希，所以很快。
- 打 AI 标签的速度取决于模型：每个文件一次请求，按 `model.concurrency`（默认 4）并发；打过的文件内容不变就不再打。
- 没在 Windows 真机上测过速度。

## 演示数据（`demo/`，不进 git）

原先 jmindex 时期带了一份 9 MB 的演示索引（按框架改造前的 jmbots 生成），2026-11-04 迁进 jmbots 改名 memorycli 时没搬：它是生成物，而且已经过时。要就在 jmbots 根目录重新生成：

```bash
memorycli/target/release/memorycli ingest --no-ai --db memorycli/demo/jmbots.db
bun memorycli/bench/compare_codegraph.ts memorycli/demo/jmbots.db   # 准确度对比
```

## 来历

2026-11-03 由网页版 Claude Code 在分支 `claude/inspiring-davinci-ioi691` 的 `jmindex/` 里写成（最后一次提交 `cf4f280`）；
2026-11-04 用户要求迁进 jmbots 本身，改名 memorycli（命令名、索引目录 `.memorycli/`、HTTP 都跟着改）。
根目录 `.gitignore` 白名单已放行 `memorycli/`，产物（`target/`、`demo/`、`.memorycli/`）由 `memorycli/.gitignore` 排除，照常 `git add` 即可。

## 开发

要 Rust 1.90 以上（tree-sitter 0.27 的要求）。用户的 Windows 机器（2026-11-04 实测）：默认工具链是 1.89，编不过；另装了 1.99.1，
但 1.99.1 没装 clippy。所以在那台机器上：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path          # cargo 不在 PATH 里，只改本次会话
$env:CARGO_HOME = '<缓存目录>\cargo'; $env:CARGO_TARGET_DIR = '<缓存目录>\memorycli-target'   # <缓存目录> 换成自己放编译缓存的地方
$env:RUSTUP_TOOLCHAIN = '1.99.1'; cargo build --release; cargo test
Remove-Item Env:RUSTUP_TOOLCHAIN; cargo clippy --all-targets --ignore-rust-version -- -D warnings   # 用 1.89 的 clippy 看 lint
```

```bash
cargo test                                  # 单元测试 + 整条流程（本机起假模型服务，三种格式都测）
cargo clippy --all-targets -- -D warnings
cargo fmt
```

代码结构见 `src/lib.rs` 开头的说明。
