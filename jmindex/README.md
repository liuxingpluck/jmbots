# jmindex：代码和文档的记忆搜索

把一个目录里的代码和文档摄取成**一个 SQLite 文件**，然后：

- **搜**：给一个词，返回相关的文件，以及每个文件里有什么（AI 摘要、标签、命中的函数和标题、正文片段、相关文件）。中文两个字的词也搜得到。
- **查关系图谱**：谁调用了谁、谁导入了谁、哪篇文档提到了哪段代码、哪些文件是同一个主题（AI 标签）。
- **AI 整合**：配一个模型（OpenAI、Anthropic、Gemini 三种接口格式都行），它给每个文件写一句摘要、打几个标签，再把意思一样的标签合并。原本没有直接联系的文档和代码，会因为讲的是同一件事连到一起。

单个可执行文件，不用装数据库、不用联网（不配模型时），Linux、macOS、Windows 都能用。

## 快速开始

```bash
cd jmindex && cargo build --release     # 可执行文件在 target/release/jmindex
```

多平台编译的 GitHub Actions 工作流在 `ci/jmindex.yml`（Linux x64/arm64、macOS arm64/x64、Windows x64：测试、编译、冒烟，推 `jmindex-v*` 标签发 Release）。
jmindex 只提交自己这个文件夹，所以工作流没放进 `.github/`；要启用就把它复制到 `.github/workflows/jmindex.yml`。

```bash
jmindex ingest --root 你的项目              # 第一次全量，之后每次只处理变了的文件
jmindex search 记忆 --root 你的项目         # 搜
jmindex graph handleMessage --root 你的项目 # 查一个函数的关系
jmindex graph --root 你的项目 --html 图.html # 整张图写成网页，浏览器打开就能看
jmindex serve --root 你的项目               # HTTP 服务，默认 127.0.0.1:30090
```

索引放在 `<项目>/.jmindex/index.db`（`--db` 可以改），配置在 `<项目>/.jmindex/config.yaml`（第一次运行自动写一份模板）。
输出都是 JSON，AI 和程序直接读；进度打到 stderr。

## 四个命令

| 命令 | 做什么 |
|---|---|
| `ingest [--no-ai]` | 摄取。按内容哈希比对：新文件加进来，改了的重新解析，删了的去掉，没变的不动。配了模型就给还没打过标签（或内容变了）的文件打标签，有新标签就整合一次。最后重算图谱。 |
| `search 词... [--limit 10]` | 正文（全文检索 BM25）、声明名、AI 标签、路径四路一起找，用 RRF 合成排名。几个词是“或”，都命中的排前面。 |
| `graph [名字] [--depth 1] [--html 文件]` | 名字可以是文件路径（或结尾，如 `Engine.ts`）、声明（`handleMessage` 或 `createEngine.handleMessage`）、标签、节点 ID。不写名字导出整张图（文件这一层）。 |
| `serve [--host] [--port]` | HTTP 服务，见下。 |

## HTTP 接口

| 接口 | 说明 |
|---|---|
| `GET /health` | 活着吗，索引里有多少东西 |
| `POST /ingest` `{"ai": true}` | 摄取（增量），返回统计 |
| `GET /search?q=词&limit=10` | 搜索 |
| `GET /graph?q=名字&depth=1` | 关系图谱；不写 q 是整张图 |

## 配置（`.jmindex/config.yaml`）

```yaml
model:                       # 不写就不打 AI 标签，其余照常
  format: openai             # openai | anthropic | gemini
  base_url: http://127.0.0.1:3425/v1
  api_key: xxx               # 或 api_key_env: OPENAI_API_KEY
  model: workbuddy/deepseek-v4.1-flash
  concurrency: 4             # 同时打几个文件
  max_chars: 6000            # 每个文件最多给模型看多少字
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

只看语法，不知道一个名字到底指向哪个声明，所以要猜。拿 jmbots 自己的 TypeScript 代码，和用 TypeScript 语言服务的 codegraph 工具（`src/tools/CodeGraph.ts`，当标准答案）比“谁用到了它”：

```
声明 299 个；标准答案里的引用处 1043 个
召回 94.0%，准确 80.9%
```

复现：`bun jmindex/bench/compare_codegraph.ts jmindex/demo/jmbots.db`。
漏的主要是 getter 的属性访问（`runtime.providers`）和 `Runtime.load` 这种静态访问；
多的主要是同一个文件里接口和实现同名的方法（`FeishuTransport.listen` 和 `createFeishu.listen`），没有类型信息分不清，所以权重平分。
graphify 漏掉的 `Feishu.ts` 里 `engine.handleMessage(...)` → `Engine.ts` 里嵌套的 `handleMessage` 这条边能查到（置信度 0.8）。

## 演示数据（`demo/`）

用 jmbots 自己的代码和文档（162 个文件：TypeScript、TSX、Go 壳子 shell/、Markdown 等）生成，没配模型（所以没有 AI 标签）：

| 文件 | 内容 |
|---|---|
| `jmbots.db` | 索引本身，可以直接 `jmindex search 词 --db jmindex/demo/jmbots.db` |
| `ingest_stats.json` | 摄取统计：162 个文件、1257 个声明、6590 条边 |
| `search_*.json` | 搜“记忆”“飞书 发件箱”“handleMessage”“审核”“SQLite”“看门狗”“自启”的结果 |
| `graph_files.json` / `.html` | 整张图（文件这一层） |
| `graph_handleMessage.json` / `.html` | `createEngine.handleMessage` 走两步的关系 |
| `graph_Engine.json` | `src/core/Engine.ts` 的关系 |
| `graph_shell.json` / `.html` | Go 壳子入口 `shell/cmd/jmshell/main.go` 走两步的关系（go.mod 在 `shell/` 子目录，内部包的导入照样连上） |
| `accuracy.txt` | 上面的准确度对比结果 |

重新生成（在 jmbots 根目录）：

```bash
jmindex/target/release/jmindex ingest --no-ai --db jmindex/demo/jmbots.db
```

## 提交约定

根目录 `.gitignore` 是白名单，`jmindex/` 不在里面（用户 11-03：这个功能单独写，只提交这个文件夹，免得和别的代码冲突）。
提交时按 `jmindex/.gitignore` 排除产物，只加 jmindex 自己的文件：

```bash
git ls-files -z -o -i --exclude-standard -- jmindex | grep -zv -e '^jmindex/target/' -e '/\.jmindex/' -e '\.db-wal$' -e '\.db-shm$' | xargs -0 git add -f
```

## 开发

```bash
cargo test                                  # 单元测试 + 整条流程（本机起假模型服务，三种格式都测）
cargo clippy --all-targets -- -D warnings
cargo fmt
```

代码结构见 `src/lib.rs` 开头的说明。
