/**
 * jmbots 的入口：既能起 Web 服务，也能当命令行用（用户 11-02：“main.ts……提供了两种功能：开启成为一个 Web 服务；通过 CLI 命令解析并执行”）。
 * 依赖（运行时、数据库、模型、引擎、飞书）都在这里创建一次，再当参数传下去。
 *
 * 用法（--runtime 不写就用环境变量 JMBOTS_RUNTIME，再不写就是 F:\aidata\AIJMBots）：
 *   bun src/Main.ts run "要做的事" [--bot 名字 | --agent 名字 | --model 供应商/模型] [--workspace 名字] [--session 会话ID]
 *       跑一次，打印回复。机器人、智能体、模型都不写时由分派智能体决定交给谁；写了 --session 就接着那个会话。
 *   bun src/Main.ts approve <待确认ID> [--note 话]     同意执行一条等确认的命令，并接着做完
 *   bun src/Main.ts reject <待确认ID> [--note 话]      拒绝，并接着做完（模型会看到“用户拒绝”）
 *   bun src/Main.ts list models|bots|agents|workspaces|sessions|approvals
 *   bun src/Main.ts logs <会话ID>                     从数据库重新生成这个会话的日志文件
 *   bun src/Main.ts serve [--host 0.0.0.0] [--port 30086] [--mode candidate] [--mode candidate]
 *     --mode candidate：试运行的新版本（scripts/Swap_Serve.ts 用）：只起 HTTP，不接飞书、不跑事件循环、不改执行状态
 *       起 HTTP 服务、飞书长连接（config.yaml 里开了的话）和事件循环
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as feishu from './channels/Feishu.ts';
import * as feishuDoc from './channels/FeishuDoc.ts';
import * as feishuMedia from './channels/FeishuMedia.ts';
import * as http from './channels/Http.ts';
import * as engineModule from './core/Engine.ts';
import * as model from './core/Model.ts';
import * as runtimeModule from './core/Runtime.ts';
import * as events from './store/Events.ts';
import * as logs from './store/Log.ts';
import * as checks from './utils/Checks.ts';
import * as utils from './utils/Utils.ts';


/** 读好的命令行：位置参数和 --名字 值。 */
interface Args {
  /** 位置参数（第一个是命令）。 */
  positional: string[];

  /** --名字 值。 */
  options: Record<string, string>;
}


/** 用法说明。 */
const USAGE = `用法：
  bun src/Main.ts run "要做的事" [--bot 名字 | --agent 名字 | --model 供应商/模型] [--workspace 名字] [--session 会话ID]
  bun src/Main.ts approve <待确认ID> [--note 话]
  bun src/Main.ts reject <待确认ID> [--note 话]
  bun src/Main.ts list models|bots|agents|workspaces|sessions|approvals
  bun src/Main.ts logs <会话ID>
  bun src/Main.ts serve [--host 0.0.0.0] [--port 30086]
共同参数：--runtime 运行时目录（默认 ${runtimeModule.DEFAULT_RUNTIME_DIR}）`;


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
  /** 运行时。 */
  runtime: runtimeModule.Runtime;
  /** 数据库。 */
  store: events.EventStore;
  /** 模型。 */
  ai: model.Ai;
  /** 引擎。 */
  engine: engineModule.Engine;
  /** 飞书传输层（config.yaml 里开了飞书时有）。 */
  feishuTransport?: feishu.FeishuTransport;
}


/**
 * 建依赖：打开运行时（检查有没有模型）、数据库、连模型、建引擎；开了飞书就准备好发消息（还不收消息）。
 * @param args 命令行。
 * @throws 没有模型、连不上模型供应商时抛错。
 */
async function createDeps(args: Args): Promise<Deps> {
  //M 1. 运行时：没有模型就说清楚，不往下走。
  /** 运行时。 */
  const runtime = await runtimeModule.Runtime.load(args.options.runtime ?? process.env.JMBOTS_RUNTIME);
  /** 发现的问题。 */
  const problems = runtime.problems();
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }

  //M 2. 数据库、模型。
  const store = events.openEventStore(runtime.dbFile);
  const ai = await model.connect(runtime);

  //M 3. 飞书：开了就建传输层，AI 可以用 feishu_send 发消息。
  /** 飞书设置。 */
  const settings = feishu.readSettings(runtime);
  /** 飞书传输层。 */
  const feishuTransport = settings
    ? feishu.createSdkTransport({ enabled: true, app_id: settings.app_id, app_secret: settings.app_secret, bot: settings.bot })
    : undefined;
  /** 引擎。 */
  const engine = engineModule.createEngine({    runtime,
    store,
    ai,
    sendFeishu: feishuTransport ? feishu.createSender(feishuTransport, store) : undefined,
    sendChoice: feishuTransport ? feishu.createChoiceSender(feishuTransport, store) : undefined,
    sendFeishuMedia: feishuTransport ? feishu.createMediaSender(feishuTransport, store) : undefined,
    createFeishuDoc: settings ? feishuDoc.createDocSender(feishuDoc.createDocPublisher(feishuMedia.createOpenApi(settings.app_id, settings.app_secret)), store) : undefined,
  });
  return { runtime, store, ai, engine, feishuTransport };
}


/**
 * 打印一个会话做完后的情况：回复，加上会话 ID、状态、日志目录；等确认时说明怎么确认。
 * @param deps 依赖。
 * @param session 会话。
 */
function printSession(deps: Deps, session: events.SessionRow): void {
  console.log(session.lastReply ?? '（没有回复）');
  console.log(`\n（会话 ${session.id}，${session.status}；日志在 ${deps.runtime.sessionDir(session)}）`);
  for (const approval of deps.store.listPendingApprovals(session.id)) {
    console.log(`等你确认：bun src/Main.ts approve ${approval.id}   或   bun src/Main.ts reject ${approval.id} --note "理由"`);
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
    /** 提交结果。 */
    const submitted = deps.engine.submit({
      input: text,
      source: '命令行',
      sessionId: args.options.session,
      bot: args.options.bot,
      agent: args.options.agent,
      model: args.options.model,
      workspace: args.options.workspace,
    });
    await deps.engine.runPending(submitted.sessionId);
    printSession(deps, await deps.engine.waitIdle(submitted.sessionId));
  } finally {
    deps.store.close();
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
    /** 对应的会话和事件。 */
    const decided = deps.engine.decide(approvalId, decision, args.options.note, '命令行');
    await deps.engine.runPending(decided.sessionId);
    printSession(deps, await deps.engine.waitIdle(decided.sessionId));
  } finally {
    deps.store.close();
  }
}


/**
 * list：列资源。
 * @param args 命令行。
 */
async function list(args: Args): Promise<void> {
  /** 列什么。 */
  const what = args.positional[1];
  /** 运行时（列机器人、智能体、工作区不用连模型）。 */
  const runtime = await runtimeModule.Runtime.load(args.options.runtime ?? process.env.JMBOTS_RUNTIME);
  if (what === 'bots' || what === 'agents') {
    for (const role of what === 'bots' ? runtime.bots : runtime.agents) {
      console.log(`${role.name}\t${role.model ?? `（默认 ${runtime.defaultModel ?? '无'}）`}\t${role.description}`);
    }
    return;
  }
  if (what === 'workspaces') {
    for (const workspace of await runtime.listWorkspaces()) {
      console.log(`${workspace.name}\t${workspace.dir}\t${workspace.description}`);
    }
    return;
  }
  if (what === 'models') {
    /** 模型（要连供应商拉清单）。 */
    const ai = await model.connect(runtime);
    console.log(`默认模型：${runtime.defaultModel ?? '无'}`);
    for (const item of ai.listModels()) {
      console.log(`${item.id}\t${item.kind}\t${item.contextWindow}`);
    }
    return;
  }
  if (what === 'sessions' || what === 'approvals') {
    const store = events.openEventStore(runtime.dbFile);
    try {
      if (what === 'sessions') {
        for (const session of store.listSessions({ limit: 50 })) {
          console.log(`${session.id}\t${session.status}\t${session.bot ?? session.agent ?? session.model ?? '未定'}\t${session.source}\t${session.title}`);
        }
      } else {
        for (const approval of store.listPendingApprovals()) {
          console.log(`${approval.id}\t会话 ${approval.sessionId}\t${approval.workDir}\t${approval.command}`);
        }
      }
    } finally {
      store.close();
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
  const runtime = await runtimeModule.Runtime.load(args.options.runtime ?? process.env.JMBOTS_RUNTIME);
  const store = events.openEventStore(runtime.dbFile);
  try {
    /** 写了的文件。 */
    const files = await logs.exportExecution({ store, runtime, sessionId });
    console.log(`写了 ${files.length} 个文件，在 ${path.dirname(files[0] ?? runtime.dir)}`);
  } finally {
    store.close();
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
  const { runtime, store, ai, engine } = deps;
  /** 是不是试运行的新版本。 */
  const candidate = args.options.mode === 'candidate';

  //M 1. 收拾上次没做完的：被打断的执行重新排队接着做，分派到一半的话重新分派（试运行的新版本不碰，它不干活）。
  if (!candidate) {
    /** 收拾的结果。 */
    const recovered = store.recoverInterrupted();
    if (recovered.resumed + recovered.failed + recovered.inbox > 0) {
      console.log(`${utils.formatTime()} 上次没做完的：${recovered.resumed} 个执行接着做，${recovered.failed} 个标成“程序中断”，${recovered.inbox} 句话重新分派。`);
    }
  }

  //M 2. HTTP：地址和端口命令行优先，其次 config.yaml 的 http，再其次 0.0.0.0:30086（用户 11-02 在 VSCode 里定：开发阶段默认全开，局域网和虚拟机都能连）。
  /** config.yaml 的 http。 */
  const httpConfig = checks.asRecord(runtime.config.http ?? {}, 'http');
  /** 地址和端口。 */
  const listen = checks.readListenOptions(
    { host: checks.optionalString(httpConfig.host, 'http.host') ?? '0.0.0.0', port: Number(httpConfig.port ?? 30086) },
    process.argv.slice(2),
  );
  const app = http.createHttp({
    runtime,
    store,
    engine,
    ai,
    token: checks.optionalString(httpConfig.token, 'http.token') ?? process.env.JMBOTS_TOKEN,
    webDir: path.resolve(import.meta.dir, '..', 'dist', 'web'),
  });
  await app.listen({ host: listen.host, port: listen.port });
  console.log(`${utils.formatTime()} HTTP 服务：http://${listen.host}:${listen.port}（运行时 ${runtime.dir}）${candidate ? '，试运行（不接飞书、不跑事件循环）' : ''}`);
  // 进程号写进 data\serve_<端口>.pid，换版本时按它停旧进程。
  await fs.writeFile(path.join(runtime.dir, 'data', `serve_${listen.port}.pid`), String(process.pid));
  if (candidate) {
    return;
  }

  //M 3. 飞书（开了才接）。
  /** 飞书设置。 */
  const settings = feishu.readSettings(runtime);
  if (settings && deps.feishuTransport) {
    await feishu.startFeishu({ transport: deps.feishuTransport, settings, store, engine, runtime });
    feishu.startOutbox(runtime, feishu.createSender(deps.feishuTransport, store));
    console.log(`${utils.formatTime()} 飞书：已接上，消息交给机器人 ${settings.bot}；${feishu.OUTBOX_DIR} 里的文件会发给最近私聊的人`);
  } else {
    console.log(`${utils.formatTime()} 飞书：没开（config.yaml 的 channels.feishu 没开或没填 app_id、app_secret）`);
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
