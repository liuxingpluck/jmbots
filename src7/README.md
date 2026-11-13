# src7：jmbots 第 7 版骨架

**现在这里只有骨架：类型、函数签名、伪代码注释。函数体都是 `throw new Error('待实现')`。** 没有跑过。

设计的来龙去脉在 `docs/src6开发/骨架_从零版_模块和流程.md`。

## 一条规矩：骨架少之又少

- 骨架是本目录里 `plugins/` 以外的文件，只留让一条消息走通的最少代码，要一眼读得懂。
- 各种业务功能都做成插件，以后也是往 `plugins/` 里加。给骨架加函数、加事件之前，先想能不能做成插件。
- 校验、审核、安全这类非写不可的，放 `utils/`，骨架的模块里只留主线。

## 文件

```text
src7/
  Main.ts            入口：挂骨架 → 照 config.yaml 的 plugins 挂插件 → 接着跑没跑完的会话
  Resources.ts       资源：文件夹、数据库、配置、pi 的供应商、系统提示词
  Bots.ts            机器人：收消息放进默认对话、交办、喊停
  Sessions.ts        会话：记录 + 循环。最重要的一个文件，六个事件都在这里声明
  Tools.ts           工具：登记、报清单、执行
  Chat.ts            一个函数 chat()：用 pi 发一次模型请求
  Channel.ts         渠道基类
  utils/
    Checks.ts        校验：命令行参数、config.yaml、别人写的插件
    Trace.ts         跟踪点长什么样
  plugins/
    Index.ts         插件的约定，和自带插件的名单
    cli/             命令行渠道
    base-tools/      自带工具：read、list_dir、write、summary
    default-dialog/  默认对话的本事：往来记录、最近 50 条当背景、看会话、交办、喊停
    compress/        压缩：会话里嵌一场小会话
    trace/           打印：一条消息走过哪些模块、哪些函数、哪些事件
```

每个插件是一个文件夹，入口是它里面的 `index.ts`。

## 谁依赖谁

```text
resources ← tools
resources ← sessions（还直接调 Chat.ts 的 chat()）
resources、sessions ← bots
bots ← 渠道（Channel 的子类）
```

## 事件

六个干活的事件全是会话发的，外加一个跟踪点。

| 事件 | 怎么发 | 什么时候 | 响应的人干什么 |
|---|---|---|---|
| `session/prompt` | 挨个问 | 每一步 | 往 `parts` 里加系统提示词的段落 |
| `session/tools` | 挨个问 | 每一步 | 往 `tools` 里加自己的工具（清单里已经有就不加） |
| `session/context` | 挨个问 | 每一步，发请求之前 | 改 `messages`：压缩、检索、给默认对话拼最近往来 |
| `session/before-calls` | 挨个问 | 模型要了工具，执行之前 | 把关：给某一项直接填上“未执行：理由”，或者把会话改成等用户点头 |
| `session/calls` | 挨个问 | 把关之后 | 执行自己的工具，把结果填进 `calls[i].result` |
| `session/change` | 通知 | 会话每次变化 | 渠道回话；记往来；将来的界面、流水。工具执行完的结果也从这里看 |
| `trace` | 通知 | 骨架和插件走到关键的地方 | 打印插件打一行 |

- **挨个问**：照插件挂上去的先后一个个 `await`，每个插件都会被问到，后面的看得到前面改的。实现用 `ctx.serial`，所以监听的函数不许有返回值；有了返回值，Cordis 就不再问后面的人了。
- **通知**：只是告诉大家，谁也不许靠它改流程。`session/change` 用 `ctx.parallel`（等大家办完）；`trace` 用 `ctx.emit`（不等）。
- **执行工具前有事件，执行后没有单独的事件**。执行前要能拦，而且不能靠“审核插件碰巧挂在工具模块前面”来保证，所以单开一个 `session/before-calls`。执行后只是看结果，`session/change` 里已经带着刚接进对话的工具结果。
- 调模型不走事件，会话直接调 `chat()`。启动、喊停是方法（`Session.run()`、`Session.stop()`），不是事件。

## 插件

### 约定：导出三样

自带的、别人写的都一样。一个插件的 `index.ts` 导出：

```ts
/** 插件名：日志和跟踪里按它显示。 */
export const name = 'weather';

/** 要用到哪些服务；不用别的服务就不写。 */
export const inject = ['tools'];

/** 挂上时调一次：在这里听事件、登记工具、起渠道。 */
export function apply(ctx: Context, config: unknown): void {
  // ctx.on('session/context', (event) => { … });
  // ctx.tools.register({ … });
}
```

- 这和 Cordis、DSH 的插件约定是同一套（DSH 的第三方插件也是导出 `name`、`inject`、`apply`）。
- 拔掉插件时不用自己收拾：通过 `ctx` 登记的监听和工具会自动撤掉。
- 业务代码照旧写成 class，`apply` 里 `new` 出来就行，看 `plugins/cli/index.ts`。
- 插件能做的事只有三样：听上面的事件；调 `ctx.tools.register()` 登记工具；做一个新渠道（自带的继承 `Channel`）。

### 加一个自带的

1. 在 `plugins/` 下新建一个文件夹，里面写 `index.ts`。
2. 在 `plugins/Index.ts` 的名单里加一行。发版是编译成单文件，磁盘上没有这些文件夹，所以自带的要静态 import 这一次。
3. 在 `config.yaml` 的 `plugins` 段写上它的名字。

### 接一个别人写的

不用改 jmbots 的代码：

1. 别人把插件做成一个文件夹，里面有 `index.ts`，或者编译好的 `index.js`，导出上面那三样。
2. 把文件夹放到运行时目录的 `plugins/` 下，放别处也行。
3. 在 `config.yaml` 的 `plugins` 段加一项，`name` 写文件夹路径。

写插件的人要知道：

- 只用传进来的 `ctx`，**不要自己 `import 'cordis'`**。发版以后 jmbots 是一个单文件程序，插件自己装的 cordis 和程序里的不是同一份。要类型就用 `import type`，运行时会被去掉。DSH 的第三方插件也是这么做的。
- 要用别的 npm 包，自己先用 `bun build` 打成一个 `index.js`，把依赖打进去。
- 外部的渠道插件不继承 `Channel`（它在程序里面，外面 import 不到），自己调 `ctx.bots.get(机器人).receive(消息)` 送进来、听 `session/change` 回话。
- **还没验证**：编译成单文件的 jmbots 能不能在运行时 `import()` 磁盘上的 `index.ts`。第一次接外部插件时，先在 Windows 上用编译版试一个最小的插件。

### config.yaml 怎么写

```yaml
plugins:
  - name: cli
  - name: base-tools
  - name: default-dialog
    config: { recent: 50 }
  - name: compress
    config: { at: 200000, keep: 6 }
  - name: trace
    disabled: true               # 想看执行路径时改成 false
  - name: ./plugins/weather      # 别人写的：以 . 开头的是文件夹路径，从 config.yaml 所在的目录算；也可以写绝对路径
    config: { city: 上海 }
```

- 照写的先后挂；先后也就是“挨个问”时的先后。
- 不写 `plugins` 段时，挂 `cli`、`base-tools`、`default-dialog` 三个。
- 写法照 DSH 的 `cordis.yml`：一项一个插件，`name` 是名字或路径，`config` 是给它的配置，`disabled: true` 是先不挂。

## 打印：看一条消息走过的路

挂上 `trace` 插件，控制台上就能看到一条消息从头到尾走过的路，一步一行：

```text
13:05:02.101 [      ] Channel.receive │ 渠道收到一句话，存下来，推给机器人 │ bots.get(bot).receive(message) │ 渠道=cli 机器人=周小灵 字数=14
13:05:02.103 [482913] Bots.receive │ 机器人收到一条消息，放进默认对话 │ defaultOf(name).add('user', text, channel)
13:05:02.110 ⟶ session/prompt（serial）听的人：resources
13:05:02.112 ⟶ session/context（serial）听的人：default-dialog、compress
13:05:02.115 [482913] Sessions.run │ 第 1 步：调模型 │ chat(request) │ step=1 对话=3 工具=6
```

- 每一行：时间、会话号、哪个模块或插件的哪个函数、在响应哪个事件、一句人话、一句代码、关键变量。
- 骨架和插件在关键的地方各发一个跟踪点：`this.ctx.emit('trace', { module, fn, text, code, vars })`，类型在 `utils/Trace.ts`。伪代码里 `//T` 开头的一行就是这里要发一个。
- 每发一个事件，打印插件还会打一行：事件名、怎么发的、现在有哪些插件在听。这一行不用谁去发，Cordis 自己会报。
- 它只看不改。拔掉它，骨架照常跑，只是不打印。

## 类型检查

在仓库根目录跑：

```text
node node_modules/typescript/bin/tsc -p tsconfig.src7.json --pretty false --noEmit --incremental false
```

共享目录上大约 3 分钟。**不要把 `src7/**/*.ts` 并进根目录的 `tsconfig.json` 或 `tsconfig.check.json`**：src7 和 src6 都在扩充 cordis 的 `Context`、`Events`（比如两边都有 `ctx.bots`，类型不同），合在一起会打架。`npm run typecheck` 暂时还不覆盖 src7。

## 怎么跑

```text
bun src7/Main.ts [--data 运行时目录] [--bot 机器人] 现在几点了
```

- 不写 `--data` 时，运行时目录是 `src7/jmbotsData/`（程序旁边）。里面要有 `config.yaml`。
- Windows 上用：`D:\dev\nodejsnpm\node_modules\bun\bin\bun.exe src7/Main.ts --data <运行时目录> 现在几点了`

### 离线假模型（开发机连不到模型 API 时）

在运行时目录的 `config.yaml` 里写一家名叫 `fake`、地址 `fake://` 的供应商，并把 `default_model` 写成 `fake/fake`。也可以设环境变量 `JMBOTS_FAKE=1`（不改配置，所有请求都走假模型）。

假模型不发 HTTP：第一步返回调用 `time` 工具，第二步根据工具结果回一句“现在是 …”。用来在 130 上离线跑通“渠道 → 机器人 → 会话 → 工具 → 回话”这条最短链路。真模型请在能上网的 Windows 上跑。

想看一条消息走过的路，在 `plugins` 段加上 `trace`（不要写 `disabled: true`）。

## 给写代码的 AI

- 照每个函数上面的伪代码写，一行伪代码对应一小段代码。`//M` 是主线，`//G` 是守卫，`//T` 是跟踪点。
- 名字、参数、返回值不要改；要改先改 `docs/src6开发/骨架_从零版_模块和流程.md`。
- 不要加文档里没有的函数、事件、校验、兜底。外部输入的校验都在 `utils/Checks.ts`，各自只查一次；插件收到的配置由插件自己在 `apply` 里查一次。
- 代码约定见根目录 `CLAUDE.md` 和 `docs/TypeScript书写规范.md`。
- 不照 `src/`、`src6/` 抄；它们只是参考。
