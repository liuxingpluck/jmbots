/**
 * jmbots 的入口：既能起 Web 服务，也能当命令行用（用户 11-02：“main.ts……提供了两种功能：开启成为一个 Web 服务；通过 CLI 命令解析并执行”）。
 * 依赖（资源、数据库、模型、引擎、飞书）都在这里创建一次，再当参数传下去。
 *
 * 用法（--runtime 不写就用环境变量 JMBOTS_RUNTIME，再不写就是 F:\aidata\AIJMBots）：
 *   bun src/entries/Main.ts run "要做的事" [--bot 名字 | --agent 名字 | --model 供应商/模型] [--workspace 名字] [--session 会话ID]
 *       跑一次，打印回复。机器人、智能体、模型都不写时由分派智能体决定交给谁；写了 --session 就接着那个会话。
 *   bun src/entries/Main.ts approve <待确认ID> [--note 话]     同意执行一条等确认的命令，并接着做完
 *   bun src/entries/Main.ts reject <待确认ID> [--note 话]      拒绝，并接着做完（模型会看到“用户拒绝”）
 *   bun src/entries/Main.ts list models|bots|agents|workspaces|sessions|approvals
 *   bun src/entries/Main.ts logs <会话ID>                     从数据库重新生成这个会话的日志文件
 *   bun src/entries/Main.ts serve [--host 0.0.0.0] [--port 30086] [--mode candidate] [--mode candidate]
 *     --mode candidate：试运行的新版本（scripts/Swap_Serve.ts 用）：只起 HTTP，不接飞书、不跑事件循环、不改执行状态
 *       起 HTTP 服务、飞书长连接（config.yaml 里开了的话）和事件循环
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as channels from '../channels/index.ts';
import * as engineModule from '../events/Loop.ts';
import * as model from '../capabilities/Model.ts';
import * as resourcesModule from '../resources/Resources.ts';
import * as events from '../events/Events.ts';
import * as logs from '../capabilities/Log.ts';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';


/** 读好的命令行：位置参数和 --名字 值。 */
interface Args {
  /** 位置参数（第一个是命令）。 */
  positional: string[];

  /** --名字 值。 */
  options: Record<string, string>;
}


/** 用法说明。 */
const USAGE = `用法：
  bun src/entries/Main.ts run "要做的事" [--bot 名字 | --agent 名字 | --model 供应商/模型] [--workspace 名字] [--session 会话ID]
  bun src/entries/Main.ts approve <待确认ID> [--note 话]
  bun src/entries/Main.ts reject <待确认ID> [--note 话]
  bun src/entries/Main.ts list models|bots|agents|workspaces|sessions|approvals
  bun src/entries/Main.ts logs <会话ID>
  bun src/entries/Main.ts serve [--host 0.0.0.0] [--port 30086]
共同参数：--runtime 运行时目录（默认 ${resourcesModule.DEFAULT_RUNTIME_DIR}）`;


/**
 * 读命令行：--名字 后面跟一个值，其余是位置参数。
 * @param argv 命令行参数（不含 bun 和脚本路径）。
 * @throws --名字 后面没有值时抛错。
 */
function parseArgs(argv: string[]): Args {
  /** 结果。 */
  const args: Args = { positional: [], options: {} };
  for (let index = 0; index < argv.length; index += 1) {
    /** 这一项。 */
    const item = argv[index]!;
    if (!item.startsWith('--')) {
      args.positional.push(item);
      continue;
    }
    /** 值。 */
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${item} 后面要跟一个值`);
    }
    args.options[item.slice(2)] = value;
    index += 1;
  }
  return args;
}


/** 一次命令要用的东西。 */
interface Deps {
  /** 资源：只读配置和目录，不联网。 */
  resources: resourcesModule.Resources;
  /** 打开数据库：**第一次调才真的打开**，之后复用。`list bots` 这种用不着库的命令不会碰它。 */
  store: () => events.EventStore;
  /** 连模型：**第一次调才真的联网**（向每个供应商拉模型清单），之后复用同一个。 */
  ai: () => Promise<model.Ai>;
  /**
   * 建引擎：**第一次调才真的连模型和飞书**，之后复用同一个。
   * @param owner 这个引擎叫什么（领事件时盖在事件上）；只有第一次调起作用。
   */
  engine: (owner?: string) => Promise<engineModule.Engine>;
  /** 关掉数据库。 */
  close: () => void;
}


/**
 * 建依赖：打开资源和数据库（都不联网），联网的那几样做成"用到时才建"。
 * 所有入口都调它，这样 list、logs 这些本来不用联网的命令断网也能用（用户 11-03 定）。
 * @param args 命令行。
 * 领取人（谁领走了这个事件）由 `engine(owner)` 的第一次调用决定：服务传 `serve@端口`
 * （换版本后进程号会变、端口不变，所以按端口记），命令行不传、默认 `cli#进程号`。
 * @returns 依赖；里面 store、ai、engine、feishuTransport 是函数，调了才真的建。
 * @throws 运行时目录读不了时抛错；缺模型、缺配置要到调 ai() 时才抛。
 */
async function createDeps(args: Args): Promise<Deps> {
  //M 1. 资源和数据库：纯本地，谁都能用。
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(args.options.runtime ?? process.env.JMBOTS_RUNTIME);
  //M 2. 数据库和下面三样联网的，都是"用到时才建"：记住第一次的结果，谁用谁触发。
  /** 打开数据库的那次，只开一次。 */
  let storeOnce: events.EventStore | undefined;
  /**
   * 打开数据库。
   * @returns 数据库。
   */
  const store = (): events.EventStore => {
    storeOnce ??= events.openEventStore(resources.dbFile);
    return storeOnce;
  };

  /** 连模型的那次，只连一次。 */
  let aiOnce: Promise<model.Ai> | undefined;
  /** 建引擎的那次，只建一次。 */
  let engineOnce: Promise<engineModule.Engine> | undefined;
  /**
   * 连模型；缺模型、缺配置在这里才报出来（本地命令不该被它挡住）。
   * @returns 模型。
   */
  const ai = (): Promise<model.Ai> => {
    aiOnce ??= (async (): Promise<model.Ai> => {
      /** 发现的问题。 */
      const problems = resources.problems();
      if (problems.length > 0) {
        throw new Error(problems.join('\n'));
      }
      return model.connect(resources);
    })();
    return aiOnce;
  };

  /**
   * 建引擎：连模型，并按 config.yaml 配好它能用的渠道本事（还不收消息）。
   * @param owner 这个引擎叫什么；只有第一次调起作用。
   * @returns 引擎。
   */
  const engine = (owner = `cli#${process.pid}`): Promise<engineModule.Engine> => {
    engineOnce ??= (async (): Promise<engineModule.Engine> => {
      /** 模型。 */
      const connected = await ai();
      return engineModule.createEngine({
        owner,
        resources,
        store: store(),
        ai: connected,
        //M 哪家渠道提供哪些本事，由 channels/index.ts 按 config.yaml 决定；这里不认识任何一家。
        channel: channels.buildChannelHooks(resources, store()),
      });
    })();
    return engineOnce;
  };

  //G 关的时候只关真开过的：没开过就什么都不用做。
  return { resources, store, ai, engine, close: () => { storeOnce?.close(); } };
}


/**
 * 打印一个会话做完后的情况：回复，加上会话 ID、状态、日志目录；等确认时说明怎么确认。
 * @param deps 依赖。
 * @param session 会话。
 */
function printSession(deps: Deps, session: events.SessionRow): void {
  console.log(session.lastReply ?? '（没有回复）');
  console.log(`\n（会话 ${session.id}，${session.status}；日志在 ${deps.resources.sessionDir(session)}）`);
  for (const approval of deps.store().listPendingApprovals(session.id)) {
    console.log(`等你确认：bun src/entries/Main.ts approve ${approval.id}   或   bun src/entries/Main.ts reject ${approval.id} --note "理由"`);
  }
}


/**
 * run：提交一条任务，在本进程跑完（服务开着时它也可能先领走，都没关系），打印回复。
 * @param args 命令行。
 */
async function runOnce(args: Args): Promise<void> {
  /** 要做的事。 */
  const text = checks.requireString(args.positional[1], 'run 后面要做的事');
  const deps = await createDeps(args);
  try {
    /** 引擎（这里才真的连模型）。 */
    const engine = await deps.engine();
    /** 提交结果。 */
    const submitted = engine.submit({
      input: text,
      source: '命令行',
      sessionId: args.options.session,
      bot: args.options.bot,
      agent: args.options.agent,
      model: args.options.model,
      workspace: args.options.workspace,
    });
    await engine.runPending(submitted.sessionId);
    printSession(deps, await engine.waitIdle(submitted.sessionId));
  } finally {
    deps.close();
  }
}


/**
 * approve、reject：对一条待确认命令做决定，接着把那次执行做完。
 * @param args 命令行。
 * @param decision 同意或拒绝。
 */
async function decideOnce(args: Args, decision: 'approved' | 'rejected'): Promise<void> {
  /** 待确认 ID。 */
  const approvalId = Number(checks.requireString(args.positional[1], '待确认 ID'));
  const deps = await createDeps(args);
  try {
    /** 引擎（这里才真的连模型）。 */
    const engine = await deps.engine();
    /** 对应的会话和事件。 */
    const decided = engine.decide(approvalId, decision, args.options.note, '命令行');
    await engine.runPending(decided.sessionId);
    printSession(deps, await engine.waitIdle(decided.sessionId));
  } finally {
    deps.close();
  }
}


/**
 * list：列资源。
 * @param args 命令行。
 */
async function list(args: Args): Promise<void> {
  /** 列什么。 */
  const what = args.positional[1];
  /** 依赖（建它不联网；只有 list models 那一支会真的连）。 */
  const deps = await createDeps(args);
  try {
    await listWith(deps, what);
  } finally {
    deps.close();
  }
}


/**
 * list 的正文：按列什么分支。
 * @param deps 依赖。
 * @param what 列什么。
 * @throws 不认识的种类时抛错。
 */
async function listWith(deps: Deps, what: string | undefined): Promise<void> {
  /** 资源。 */
  const { resources } = deps;
  if (what === 'bots' || what === 'agents') {
    for (const role of resources.listRoles(what === 'bots' ? 'bot' : 'agent')) {
      console.log(`${role.name}\t${role.model ?? `（默认 ${resources.getDefaultModel() ?? '无'}）`}\t${role.description}`);
    }
    return;
  }
  if (what === 'workspaces') {
    for (const workspace of await resources.listWorkspaces()) {
      console.log(`${workspace.name}\t${workspace.dir}\t${workspace.description}`);
    }
    return;
  }
  if (what === 'models') {
    //M 只有这一支要联网：向每个供应商拉模型清单。
    /** 模型。 */
    const ai = await deps.ai();
    console.log(`默认模型：${resources.getDefaultModel() ?? '无'}`);
    for (const item of ai.listModels()) {
      console.log(`${item.id}\t${item.kind}\t${item.contextWindow}`);
    }
    return;
  }
  if (what === 'sessions') {
    for (const session of deps.store().listSessions({ limit: 50 })) {
      console.log(`${session.id}\t${session.status}\t${session.bot ?? session.agent ?? session.model ?? '未定'}\t${session.source}\t${session.title}`);
    }
    return;
  }
  if (what === 'approvals') {
    for (const approval of deps.store().listPendingApprovals()) {
      console.log(`${approval.id}\t会话 ${approval.sessionId}\t${approval.workDir}\t${approval.command}`);
    }
    return;
  }
  throw new Error('list 后面写 models、bots、agents、workspaces、sessions 或 approvals');
}


/**
 * logs：从数据库重新生成一个会话的日志文件。
 * @param args 命令行。
 */
async function regenerateLogs(args: Args): Promise<void> {
  /** 会话 ID。 */
  const sessionId = checks.requireString(args.positional[1], '会话 ID');
  //M 纯本地：只用资源和数据库，不联网。
  const deps = await createDeps(args);
  try {
    /** 写了的文件。 */
    const files = await logs.exportExecution({ store: deps.store(), resources: deps.resources, sessionId });
    console.log(`写了 ${files.length} 个文件，在 ${path.dirname(files[0] ?? deps.resources.dir)}`);
  } finally {
    deps.close();
  }
}


/**
 * serve：起 HTTP 服务、飞书长连接和事件循环，一直跑到 Ctrl+C。
 * --mode candidate 是试运行的新版本（scripts/Swap_Serve.ts 换版本时先起一个试试）：只起 HTTP，
 * 不接飞书、不跑事件循环、不把别人的执行标成中断，免得和正在跑的旧版本抢活。
 * @param args 命令行。
 */
async function serve(args: Args): Promise<void> {
  const deps = await createDeps(args);
  const { resources } = deps;
  /** 数据库。 */
  const store = deps.store();
  /** 是不是试运行的新版本。 */
  const candidate = args.options.mode === 'candidate';

  //M 1. 顺序：建依赖 → 算端口 → 起 HTTP → 接渠道 → 起事件循环。
  //  收拾上次没做完的已经挪进 engine.startLoop() 的第一步，那是执行器的判断，不该放在这里；
  //  试运行的新版本不起循环，所以也不会去收拾。

  //M 2. 端口要先算出来：服务的领取人是 serve@端口，换版本后进程号会变、端口不变，
  //  这样新服务才认得出上一个自己没做完的活。
  /** 地址和端口（命令行 > config.yaml > 0.0.0.0:30086）。 */
  const listen = channels.resolveListen(resources, process.argv.slice(2));

  //M serve 一定要联网：在这里就把模型和引擎建起来，缺模型、连不上供应商立刻报错，别等到第一条消息进来才发现。
  /** 模型。 */
  const ai = await deps.ai();
  /** 引擎。 */
  const engine = await deps.engine(`serve@${listen.port}`);

  //M 3. 渠道：起 HTTP，再按 config.yaml 的 channels 把聊天渠道挨个接上。
  //  入口不认识任何一家渠道——"飞书"两个字只出现在 channels/ 里面（用户 11-04 要求）。
  /** 装配结果。 */
  const loaded = await channels.loadChannels({ resources, store, engine, ai, candidate, argv: process.argv.slice(2) });
  console.log(`${utils.formatTime()} HTTP 服务：http://${loaded.listen.host}:${loaded.listen.port}（运行时 ${resources.dir}）${candidate ? '，试运行（不接聊天渠道、不跑事件循环）' : ''}`);
  // 进程号写进 data\serve_<端口>.pid，换版本时按它停旧进程。
  await fs.writeFile(path.join(resources.dir, 'data', `serve_${loaded.listen.port}.pid`), String(process.pid));
  if (candidate) {
    return;
  }
  for (const note of loaded.started) {
    console.log(`${utils.formatTime()} ${note}`);
  }
  if (loaded.started.length === 0) {
    console.log(`${utils.formatTime()} 没有接上任何聊天渠道（config.yaml 的 channels 里没开，或设置不全）`);
  }

  //M 4. 事件循环：命令行、HTTP、飞书、AI（taskdbinsert）插进来的事件都在这里执行。
  engine.startLoop();
}


/**
 * 按第一个参数分派到各命令。
 * @param argv 命令行参数（不含 bun 和脚本路径）。
 */
async function main(argv: string[]): Promise<void> {
  /** 读好的命令行。 */
  const args = parseArgs(argv);
  switch (args.positional[0]) {
    case 'run':
      await runOnce(args);
      break;
    case 'approve':
      await decideOnce(args, 'approved');
      break;
    case 'reject':
      await decideOnce(args, 'rejected');
      break;
    case 'list':
      await list(args);
      break;
    case 'logs':
      await regenerateLogs(args);
      break;
    case 'serve':
      await serve(args);
      break;
    default:
      console.log(USAGE);
  }
}


await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`出错了：${utils.errorText(error)}`);
  process.exitCode = 1;
});
