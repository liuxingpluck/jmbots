/**
 * 演示（第 2 步：真模型、工具、插话）。在 Windows 上跑：bun src/agentLoop/Main.ts（F5 选“会话状态机”也是它）。
 * 打印的每一行同时写进本目录的 运行日志.log，每次运行重写。
 *
 * 真实调用模型：config.yaml 里 magpie 的地址和密钥（程序用 Resources 读，不打印），模型 workbuddy/hy4free；
 * 系统提示词是运行时的 prompts/00_base_dsh.md。这些都写在 Config.json。
 * 工具只有 think：等 5 秒，模拟“想一想”，制造一段“工具在跑”的时间。
 *
 * 剧本（故意制造各种情况）：
 *   第一件事
 *     第 0 秒            用户：请先调用 think 想一想，再回答        → 请求模型
 *     第 0.5 秒          用户插话（模型在跑）                       → 排队
 *     模型要调 think     → 执行工具（5 秒）
 *     工具开始后 1 秒    用户又插话（工具在跑）                     → 排队
 *     工具开始后 2 秒    换模型事件：最多输出改成 2000              → 状态不变，下一次请求起用
 *     工具做完           → 工具结果和两条插话一起交给模型 → …… → 模型不再调工具 → 回复用户
 *   第二件事（第一件做完、空闲 1 秒后）
 *     用户：不用调工具，直接说晚霞为什么是红的                     → 请求模型
 *     0.3 秒后           用户插话（模型在跑）                       → 排队
 *     模型回话（不调工具）→ 回复用户 → 拿插话接着请求模型（接话）→ 再回复用户
 *   都做完、空闲了就退出；超过 Config.json 的 timeoutSeconds 还没做完，打印超时退出。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as resourcesModule from '../resources/Resources.ts';
import * as clientModule from './ModelClient.ts';
import * as sessionModule from './Session.ts';
import * as thinkModule from './ThinkTool.ts';


/** Config.json 的样子。 */
interface DemoConfig {
  /** 运行时目录（绝对路径）：从它的 config.yaml 读供应商的地址和密钥。 */
  runtimeDir: string;
  /** 系统提示词文件（绝对路径）。 */
  systemPromptPath: string;
  /** 一开始用的模型。 */
  model: clientModule.ModelConfig;
  /** 工具在跑时，换模型事件把最多输出改成多少。 */
  changedMaxOutputTokens: number;
  /** think 工具想多少秒。 */
  thinkSeconds: number;
  /** 一次请求模型最多等多少秒。 */
  requestTimeoutSeconds: number;
  /** 整个演示最多跑多少秒，超过就打印超时退出。 */
  timeoutSeconds: number;
}


/** 剧本里用户说的话。 */
const LINES = {
  /** 第一件事。 */
  first: '请先调用 think 工具想一想“天空为什么是蓝色的”，想好了再用两三句话回答我。',
  /** 第一件事里，模型在跑时的插话。 */
  whileModel: '补充一下：回答的时候顺便告诉我你调用了什么工具。',
  /** 第一件事里，工具在跑时的插话。 */
  whileTool: '再补充一句：整个回答控制在 80 字以内。',
  /** 第二件事。 */
  second: '不用调用任何工具，直接用一句话告诉我：晚霞为什么是红的？',
  /** 第二件事里，模型在跑时的插话。 */
  whileModelAgain: '顺便也用一句话说说朝霞。',
};


/** 剧本：按时间往会话里送事件，故意在模型和工具在跑时插话。 */
class DemoScript {
  /** 演的是哪个会话。 */
  private readonly session: sessionModule.Session;

  /** 换模型事件换上的模型：还是同一个，只是最多输出改了。 */
  private readonly changedModel: clientModule.ModelConfig;

  /** 工具在跑时的插话安排过了：只在第一次执行工具时安排。 */
  private toolInterruptScheduled = false;

  /** 第二件事开始了。 */
  private secondStarted = false;

  /** 剧本里的话都说完了：之后会话空闲、没有排队的插话，就演完了。 */
  private allSaid = false;

  /** 演完了。Main 等它。 */
  readonly finished: Promise<void>;

  /** 演完时调用，让 finished 结束。 */
  private readonly markFinished: () => void;

  /**
   * @param session 演的是哪个会话。
   * @param changedModel 换模型事件换上的模型。
   */
  constructor(session: sessionModule.Session, changedModel: clientModule.ModelConfig) {
    this.session = session;
    this.changedModel = changedModel;
    /** 一个等着结束的 Promise 和让它结束的函数。 */
    const finishSignal = Promise.withResolvers<void>();
    this.finished = finishSignal.promise;
    this.markFinished = finishSignal.resolve;
  }

  /** 开演：第 0 秒说第一件事，0.5 秒后插话（这时模型在跑）。 */
  start(): void {
    this.say(LINES.first, '第一件事');
    setTimeout(() => {
      this.say(LINES.whileModel, '插话，这时模型应该在跑');
    }, 500);
  }

  /** 会话开始执行工具时（toolStarted 监听）：第一次执行工具时，1 秒后插话，2 秒后换模型。 */
  whenToolStarted(): void {
    //G 只在第一次执行工具时安排。
    if (this.toolInterruptScheduled) {
      return;
    }
    this.toolInterruptScheduled = true;
    setTimeout(() => {
      this.say(LINES.whileTool, '插话，这时工具应该在跑');
    }, 1000);
    setTimeout(() => {
      this.changeModel();
    }, 2000);
  }

  /** 回复用户或出错之后（reply、failed 监听）：1 秒后看一眼剧本往下怎么走。 */
  whenTurnEnded(): void {
    setTimeout(() => {
      this.checkProgress();
    }, 1000);
  }

  /** 看一眼剧本往下怎么走：第一件做完了就开始第二件；话都说完了、会话空闲了，就演完了。 */
  private checkProgress(): void {
    /** 会话空闲，也没有排队的插话。 */
    const idle = this.session.state === sessionModule.SessionState.Idle && this.session.queue.length === 0;
    //G 还没闲下来（排队的插话接着请求模型了）：等下一次回复再看。
    if (!idle) {
      return;
    }

    //M 第一件做完了：开始第二件，0.3 秒后插话（这时模型在跑）。
    if (!this.secondStarted) {
      this.secondStarted = true;
      this.say(LINES.second, '第二件事');
      setTimeout(() => {
        this.say(LINES.whileModelAgain, '插话，这时模型应该在跑');
        this.allSaid = true;
      }, 300);
      return;
    }

    //M 话都说完了，会话也空闲了：演完。
    if (this.allSaid) {
      this.markFinished();
    }
  }

  /**
   * 用户说一句：变成用户消息事件，交给会话。
   * @param text 用户说的话。
   * @param note 剧本的说明，打印用。
   */
  private say(text: string, note: string): void {
    console.log('');
    console.log(`[剧本 第 ${this.session.elapsedSeconds()} 秒] 用户说话：${note}`);
    const event: sessionModule.UserMessageEvent = {
      type: sessionModule.SessionEventType.UserMessage,
      text,
    };
    this.session.handle(event);
  }

  /** 换模型：变成换模型事件，交给会话。 */
  private changeModel(): void {
    console.log('');
    console.log(`[剧本 第 ${this.session.elapsedSeconds()} 秒] 换模型：最多输出改成 ${this.changedModel.maxOutputTokens}`);
    const event: sessionModule.ChangeModelEvent = {
      type: sessionModule.SessionEventType.ChangeModel,
      model: this.changedModel,
    };
    this.session.handle(event);
  }
}


//M 1. 打印同时写进日志文件：本目录的 运行日志.log，每次运行重写。
/** 日志文件。 */
const logPath = path.join(import.meta.dir, '运行日志.log');
fs.writeFileSync(logPath, '');
/** 原来的 console.log：打印到屏幕还用它。 */
const printToScreen = console.log.bind(console);
console.log = (...parts: unknown[]): void => {
  const line = parts.map(String).join(' ');
  printToScreen(line);
  fs.appendFileSync(logPath, `${line}\n`);
};

//M 没接住的错误也写进日志，然后退出（比如会话收到表里没有的组合）。
process.on('uncaughtException', (error) => {
  console.log(`[没接住的错误] ${String(error)}`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.log(`[没接住的错误] ${String(error)}`);
  process.exit(1);
});

//M 2. 读演示配置。
const configFile = Bun.file(`${import.meta.dir}/Config.json`);
const config = (await configFile.json()) as DemoConfig;
console.log(`[开始] ${new Date().toLocaleString()}，配置 ${configFile.name}`);

//M 3. 供应商的地址和密钥：程序自己读 config.yaml（Resources），不打印。
const resources = await resourcesModule.Resources.load(config.runtimeDir);
const providers = resources.getProviders();
const requestTimeoutMs = config.requestTimeoutSeconds * 1000;
const modelClient = new clientModule.ModelClient(providers, requestTimeoutMs);

//M 4. 建会话：自己生成 ID，读系统提示词，状态 idle，不请求模型。
const thinkTool = new thinkModule.ThinkTool(config.thinkSeconds);
const sessionOptions: sessionModule.SessionOptions = {
  systemPromptPath: config.systemPromptPath,
  model: config.model,
  tools: [thinkTool],
  modelClient,
};
const session = new sessionModule.Session(sessionOptions);
/** 模型的上下文，原样打印。 */
const modelText = JSON.stringify(session.model);
console.log(`[建会话] ID ${session.id}，状态 ${session.state}`);
console.log(`  模型 ${modelText}`);
console.log(`  系统提示词 ${config.systemPromptPath}（${session.systemPrompt.length} 字）`);
console.log(`  工具 ${thinkTool.name}（想 ${config.thinkSeconds} 秒）`);

//M 5. 登记监听：会话回复用户、出错、开始执行工具时，剧本往下走。
/** 换模型事件换上的模型：还是同一个，只把最多输出改了。 */
const changedModel: clientModule.ModelConfig = {
  ...config.model,
  maxOutputTokens: config.changedMaxOutputTokens,
};
const script = new DemoScript(session, changedModel);
session.on('reply', (text) => {
  console.log(`  监听 reply：用户收到回话（${text.length} 字）`);
  script.whenTurnEnded();
});
session.on('failed', (reason) => {
  console.log(`  监听 failed：用户收到出错（${reason.length} 字）`);
  script.whenTurnEnded();
});
session.on('toolStarted', (call) => {
  console.log(`  监听 toolStarted：工具 ${call.name} 开始跑了`);
  script.whenToolStarted();
});

//M 6. 开演，等演完。保险：超过 timeoutSeconds 还没演完，打印超时退出。
const timeoutMs = config.timeoutSeconds * 1000;
const guardTimer = setTimeout(() => {
  console.log('');
  console.log(`[超时] ${config.timeoutSeconds} 秒还没演完，状态 ${session.state}，排队 ${session.queue.length} 条`);
  process.exit(1);
}, timeoutMs);
script.start();
await script.finished;
clearTimeout(guardTimer);

//M 7. 最后看一眼存了什么。
console.log('');
console.log(`[最后 第 ${session.elapsedSeconds()} 秒] 状态 ${session.state}，排队 ${session.queue.length} 条，对话 ${session.messages.length} 条：`);
for (const message of session.messages) {
  /** 一条消息，原样打印。 */
  const messageText = JSON.stringify(message);
  console.log(`  ${messageText}`);
}

//M 连接池可能还挂着，演完直接退出。
process.exit(0);
