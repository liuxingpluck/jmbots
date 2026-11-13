/**
 * 演示的边角情况：把 Main.ts 没走到的状态表第 2、7、8、9 行用真模型走一遍。
 * 在 Windows 上跑：bun src/agentLoop/MainEdge.ts。
 * 打印的每一行同时写进本目录的 运行日志_边角.log，每次运行重写。
 *
 * 模型、系统提示词、think 工具都和 Main.ts 一样，读 Config.json。
 * 出错用的是真出错：把模型换成一个不存在的模型 ID，让供应商真的回错误。
 *
 * 剧本（一段做完、会话空闲了再开始下一段）：
 *   第一段  建会话时不设模型；用户说话                         → 第 2 行：告诉用户先设模型
 *   第二段  换成不存在的模型                                   → 第 11 行
 *           用户说话                                           → 第 1 行：请求模型
 *           供应商回错误，没有排队                             → 第 7 行：告诉用户出错，回到空闲
 *   第三段  用户说话（还是不存在的模型）                       → 第 1 行
 *           同一刻插话                                         → 第 3 行：排队
 *           同一刻换回能用的模型                               → 第 11 行
 *           供应商回错误，有排队                               → 第 8 行：插话挪进对话，告诉用户出错，用新模型再请求
 *           模型回话，不调工具                                 → 第 5 行
 *   第四段  用户要模型一次调用两次 think                       → 第 4 行：两个工具同时开跑
 *           第一个做完，还有一个没做完                         → 第 9 行
 *           两个都做完                                         → 第 10 行：请求模型
 *           模型回话，不调工具                                 → 第 5 行
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as resourcesModule from '../resources/Resources.ts';
import * as clientModule from './ModelClient.ts';
import * as sessionModule from './Session.ts';
import * as thinkModule from './ThinkTool.ts';


/** Config.json 里这个演示用到的部分（完整的样子见 Main.ts 的 DemoConfig）。 */
interface EdgeConfig {
  /** 运行时目录（绝对路径）：从它的 config.yaml 读供应商的地址和密钥。 */
  runtimeDir: string;
  /** 系统提示词文件（绝对路径）。 */
  systemPromptPath: string;
  /** 能用的模型。 */
  model: clientModule.ModelConfig;
  /** think 工具想多少秒。 */
  thinkSeconds: number;
  /** 一次请求模型最多等多少秒。 */
  requestTimeoutSeconds: number;
  /** 整个演示最多跑多少秒，超过就打印超时退出。 */
  timeoutSeconds: number;
}


/** 不存在的模型 ID：换上它，供应商会真的回错误。 */
const MISSING_MODEL_ID = 'workbuddy/no-such-model-for-edge-demo';


/** 剧本里用户说的话。 */
const LINES = {
  /** 第一段：还没设模型时说的话。 */
  noModel: '你好，在吗？',
  /** 第二段：用不存在的模型时说的话。 */
  missingModel: '用一句话说说月亮为什么有圆缺。',
  /** 第三段：用不存在的模型时说的话。 */
  missingAgain: '用一句话说说为什么会有四季。',
  /** 第三段：同一刻的插话。 */
  whileFailing: '刚才那句不用管了，改成：用一句话说说为什么会打雷。',
  /** 第四段：要模型一次调用两次 think。 */
  twoTools:
    '请在同一次回复里同时调用两次 think 工具：一次想“天空为什么是蓝色的”，'
    + '一次想“大海为什么是蓝色的”。两次都想好了，再用两句话回答我。',
};


/** 剧本：一段一段往会话里送事件，每段等会话空闲了再往下。 */
class EdgeScript {
  /** 演的是哪个会话。 */
  private readonly session: sessionModule.Session;

  /** 能用的模型。 */
  private readonly goodModel: clientModule.ModelConfig;

  /** 不存在的模型。 */
  private readonly missingModel: clientModule.ModelConfig;

  /** 这一段做完时调用；没有在等的段时是 undefined。 */
  private markPartDone: (() => void) | undefined;

  /**
   * @param session 演的是哪个会话。
   * @param goodModel 能用的模型。
   * @param missingModel 不存在的模型。
   */
  constructor(
    session: sessionModule.Session,
    goodModel: clientModule.ModelConfig,
    missingModel: clientModule.ModelConfig,
  ) {
    this.session = session;
    this.goodModel = goodModel;
    this.missingModel = missingModel;
  }

  /** 四段按顺序演完。 */
  async run(): Promise<void> {
    //M 第一段：没设模型就说话。
    this.title('第一段：没设模型就说话（第 2 行）');
    const firstDone = this.waitPartDone();
    this.say(LINES.noModel, '没设模型时说话');
    await firstDone;

    //M 第二段：换成不存在的模型，说话，供应商回错误，没有排队。
    this.title('第二段：模型出错，没有排队（第 11、1、7 行）');
    this.changeModel(this.missingModel, '换成不存在的模型');
    const secondDone = this.waitPartDone();
    this.say(LINES.missingModel, '用不存在的模型说话');
    await secondDone;

    //M 第三段：说话，同一刻插话、换回能用的模型；供应商回错误时有排队。
    this.title('第三段：模型出错，有排队（第 1、3、11、8、5 行）');
    const thirdDone = this.waitPartDone();
    this.say(LINES.missingAgain, '用不存在的模型说话');
    this.say(LINES.whileFailing, '同一刻插话，这时模型在跑');
    this.changeModel(this.goodModel, '同一刻换回能用的模型');
    await thirdDone;

    //M 第四段：一次调用两个工具。
    this.title('第四段：一次调两个工具（第 4、9、10、5 行）');
    const fourthDone = this.waitPartDone();
    this.say(LINES.twoTools, '要模型一次调用两次 think');
    await fourthDone;
  }

  /** 回复用户或出错之后（reply、failed 监听）：会话空闲、没有排队了，这一段就做完了。 */
  whenTurnEnded(): void {
    /** 会话空闲，也没有排队的插话。 */
    const idle = this.session.state === sessionModule.SessionState.Idle
      && this.session.queue.length === 0;
    //G 还没闲下来（排队的插话接着请求模型了）：等下一次回复再看。
    if (!idle) {
      return;
    }
    //G 没有在等的段。
    if (!this.markPartDone) {
      return;
    }
    const markDone = this.markPartDone;
    this.markPartDone = undefined;
    markDone();
  }

  /**
   * 开始等这一段做完。要在送事件之前调：第一段的出错是在 handle() 里当场告诉用户的。
   * @returns 这一段做完时结束。
   */
  private waitPartDone(): Promise<void> {
    /** 一个等着结束的 Promise 和让它结束的函数。 */
    const doneSignal = Promise.withResolvers<void>();
    this.markPartDone = doneSignal.resolve;
    return doneSignal.promise;
  }

  /**
   * 打印一段的标题。
   * @param text 标题。
   */
  private title(text: string): void {
    console.log('');
    console.log(`==================== ${text} ====================`);
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

  /**
   * 换模型：变成换模型事件，交给会话。
   * @param model 换上的模型。
   * @param note 剧本的说明，打印用。
   */
  private changeModel(model: clientModule.ModelConfig, note: string): void {
    console.log('');
    console.log(`[剧本 第 ${this.session.elapsedSeconds()} 秒] 换模型：${note}`);
    const event: sessionModule.ChangeModelEvent = {
      type: sessionModule.SessionEventType.ChangeModel,
      model,
    };
    this.session.handle(event);
  }
}


//M 1. 打印同时写进日志文件：本目录的 运行日志_边角.log，每次运行重写。
/** 日志文件。 */
const logPath = path.join(import.meta.dir, '运行日志_边角.log');
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

//M 2. 读演示配置（和 Main.ts 同一个 Config.json）。
const configFile = Bun.file(`${import.meta.dir}/Config.json`);
const config = (await configFile.json()) as EdgeConfig;
console.log(`[开始] ${new Date().toLocaleString()}，配置 ${configFile.name}`);

//M 3. 供应商的地址和密钥：程序自己读 config.yaml（Resources），不打印。
const resources = await resourcesModule.Resources.load(config.runtimeDir);
const providers = resources.getProviders();
const requestTimeoutMs = config.requestTimeoutSeconds * 1000;
const modelClient = new clientModule.ModelClient(providers, requestTimeoutMs);

//M 4. 建会话：不设模型（第一段要用）。
const thinkTool = new thinkModule.ThinkTool(config.thinkSeconds);
const sessionOptions: sessionModule.SessionOptions = {
  systemPromptPath: config.systemPromptPath,
  tools: [thinkTool],
  modelClient,
};
const session = new sessionModule.Session(sessionOptions);
console.log(`[建会话] ID ${session.id}，状态 ${session.state}，没设模型`);
console.log(`  系统提示词 ${config.systemPromptPath}（${session.systemPrompt.length} 字）`);
console.log(`  工具 ${thinkTool.name}（想 ${config.thinkSeconds} 秒）`);

//M 5. 登记监听：回复用户、出错时看这一段做完没有。
/** 不存在的模型：和能用的模型只差模型 ID。 */
const missingModel: clientModule.ModelConfig = {
  ...config.model,
  modelId: MISSING_MODEL_ID,
};
const script = new EdgeScript(session, config.model, missingModel);
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
});

//M 6. 开演，等演完。保险：超过 timeoutSeconds 还没演完，打印超时退出。
const timeoutMs = config.timeoutSeconds * 1000;
const guardTimer = setTimeout(() => {
  console.log('');
  console.log(`[超时] ${config.timeoutSeconds} 秒还没演完，状态 ${session.state}，排队 ${session.queue.length} 条`);
  process.exit(1);
}, timeoutMs);
await script.run();
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
