/**
 * 应用（docs/14_后端改成class.md 第 9 行）：建好所有对象、连起来、开起来。入口 Main.ts 的 serve 建一个，调 start。
 * 建的顺序就是依赖的顺序：
 *   资源 → 数据库、文件库、模型库、密钥替身、待确认
 *   → 渠道中心（往渠道发东西的出口，最先建好，谁要发东西构造时就拿着它）
 *   → 进度卡片、任务通道、记忆库搜索、工具库、小循环 → 分派、命令审核 → 会话运行器 → 机器人循环 → 命令窗口
 *   → 开渠道（start）→ 起机器人循环和定时的事。
 * 每个对象是一个只读字段：调试时点开 app 就看到全部，F12 能跳到各自的类。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as botLoopModule from '../bots/BotLoop.ts';
import * as agentTasksModule from '../capabilities/AgentTasks.ts';
import * as approvalsModule from '../capabilities/Approvals.ts';
import * as contextModule from '../capabilities/Context.ts';
import * as eventWatchModule from '../capabilities/EventWatch.ts';
import * as eventsModule from '../capabilities/Events.ts';
import * as filesModule from '../capabilities/Files.ts';
import * as miniLoopModule from '../capabilities/MiniLoop.ts';
import * as model from '../capabilities/Model.ts';
import * as progressModule from '../capabilities/Progress.ts';
import * as reviewModule from '../capabilities/Review.ts';
import * as secretsModule from '../capabilities/Secrets.ts';
import * as storeModule from '../capabilities/Store.ts';
import * as toolsModule from '../capabilities/tools/Tools.ts';
import * as updateWatchModule from '../capabilities/UpdateWatch.ts';
import * as channels from '../channels/index.ts';
import * as dispatchModule from '../dispatch/Dispatch.ts';
import * as agentLoop from '../executors/AgentLoop.ts';
import * as execReview from '../executors/ExecReview.ts';
import * as runsModule from '../executors/Runs.ts';
import * as resourcesModule from '../resources/Resources.ts';
import * as debug from '../utils/Debug.ts';
import * as utils from '../utils/Utils.ts';
import type * as channelModule from '../channels/Channel.ts';
import type * as http from '../channels/Http.ts';


/** 建应用要给的。 */
export interface AppOptions {
  /** 试运行（换版本时）：只开 HTTP 看健康，不开飞书、不起循环、不收拾数据库。 */
  candidate: boolean;
  /** 入口已经确定并校验过的 HTTP 端口。 */
  port: number;
}


/** 应用：所有对象都是它的字段。 */
export class App {
  /** 试运行（换版本时）：只开 HTTP 看健康，不开飞书、不起循环、不收拾数据库。 */
  readonly candidate: boolean;
  /** HTTP 端口（config 的 http.port，命令行 --port 可以换）。 */
  readonly port: number;
  /** 数据库：收件表和会话表。 */
  readonly store: storeModule.Store;
  /** 文件库：机器人文件夹里的文件、技能。 */
  readonly files: filesModule.Files;
  /** 密钥替身：工具结果进模型前过一遍。 */
  readonly secrets: secretsModule.Secrets;
  /** 待确认（只在内存里）。 */
  readonly approvals: approvalsModule.Approvals;
  /** 事件总线：主线在断点上报事件，写进事件表（docs/11）。 */
  readonly events: eventsModule.EventBus;
  /** 观察处理器：看事件，到 10 分钟、20 分钟报限时，思考、工具、搜索有问题也报（试运行不开）。 */
  readonly eventWatch: eventWatchModule.EventWatch;
  /** 渠道中心：开所有渠道，同时是往渠道发东西的出口（Outlet）。 */
  readonly hub: channels.ChannelHub;
  /** 进度卡片：一条消息一张卡。 */
  readonly progress: progressModule.Progress;
  /** 外部 AI 的任务通道：agent_task 工具和 /api/agents/* 共用。 */
  readonly agentTaskChannel: agentTasksModule.AgentTaskChannel;
  /** 记忆库搜索：memory 工具和开场召回共用（带着“已让基地建过索引的库”）。 */
  readonly memorySearch: contextModule.MemorySearch;
  /** 工具库：分派、命令审核、会话都用它。 */
  readonly toolBox: toolsModule.ToolBox;
  /** 小循环：分派的第 2 档、审核的第 3 档用，没有自己的状态。 */
  readonly miniLoop: miniLoopModule.MiniLoop;
  /** 分派：定打断哪些会话、放进哪个工作区、新开还是追加。 */
  readonly dispatcher: dispatchModule.Dispatcher;
  /** 命令审核：会话里的 exec 和命令窗口都用它。 */
  readonly reviewer: execReview.ExecReviewer;
  /** 会话运行器：跑会话（runSession），所有会话共用这一个。 */
  readonly runner: agentLoop.SessionRunner;
  /** 机器人循环：渠道收话（receive）、每个机器人起一条循环（start）。 */
  readonly botLoop: botLoopModule.BotLoop;
  /** 命令窗口：外面的 AI 经 /api/run* 直接让 jmbots 跑命令。构造时读出以前的记录，没跑完的记成 failed。 */
  readonly runs: runsModule.Runs;
  /** 盯新版本：发审核卡片，放行就叫基地换。 */
  readonly updateWatch: updateWatchModule.UpdateWatch;
  /** 定时复盘：空闲时挑做太久的事写复盘，问用户要不要写进公共记忆。 */
  readonly runReview: reviewModule.RunReview;
  /** 记忆库索引的定时刷新：跟着库目录里文件的修改走。 */
  readonly indexRefresher: contextModule.IndexRefresher;

  /**
   * 建好所有对象（不开渠道、不起循环；开起来用 start）。资源由入口加载，模型库由 App.create 连接。
   * @param resources 资源：config.yaml、机器人、提示词（只读）。
   * @param ai 模型库（已经向各供应商拉过模型清单）。
   * @param options 入口已校验的试运行模式和端口。
   * 副作用：打开数据库；命令窗口读出以前的记录。
   */
  private constructor(
    readonly resources: resourcesModule.Resources,
    readonly ai: model.Ai,
    options: AppOptions,
  ) {
    this.candidate = options.candidate;
    this.port = options.port;
    //M 1. 底层：数据库、文件库、密钥替身、待确认。
    /** 持久化数据库的位置，由入口传入的资源目录派生。 */
    const databaseFile = path.join(resources.dir, 'data', 'jmbots.db');
    this.store = new storeModule.Store(databaseFile);
    //M 每真调一次模型记一行用量（docs/15）：模型库只管报，写库在这里。
    ai.onUsage((row) => this.store.addUsage(row));
    this.files = new filesModule.Files(resources);
    /** 用于日志脱敏的凭证值，仅在内存交给替身库。 */
    const secretValues = resources.getSecretValues();
    this.secrets = new secretsModule.Secrets(secretValues);
    this.approvals = new approvalsModule.Approvals();
    this.events = new eventsModule.EventBus(this.store, resources, this.secrets);
    ai.setEvents(this.events);
    this.eventWatch = new eventWatchModule.EventWatch(this.events, resources);
    //M 2. 出口先建好：渠道开起来以前发东西会报“渠道没开”，开起来以后就是真的。
    /** 渠道共享入口已经确定的监听端口和运行模式。 */
    const channelOptions = {
      port: this.port,
      candidate: this.candidate,
    };
    this.hub = new channels.ChannelHub(channelOptions);
    //M 3. 进度卡片、任务通道、记忆库搜索、工具库、小循环。
    this.progress = new progressModule.Progress(resources, this.store, ai, this.hub, this.events);
    this.agentTaskChannel = new agentTasksModule.AgentTaskChannel(resources.dir, this.events);
    this.memorySearch = new contextModule.MemorySearch(resources);
    this.toolBox = new toolsModule.ToolBox(
      resources,
      this.store,
      this.files,
      ai,
      this.secrets,
      this.hub,
      this.agentTaskChannel,
      this.memorySearch,
      this.events,
    );
    this.miniLoop = new miniLoopModule.MiniLoop(ai, this.secrets);
    //M 4. 分派、命令审核、会话运行器、机器人循环、命令窗口。
    this.dispatcher = new dispatchModule.Dispatcher(
      resources,
      this.store,
      this.files,
      ai,
      this.approvals,
      this.miniLoop,
      this.toolBox,
      this.events,
    );
    this.reviewer = new execReview.ExecReviewer(
      resources,
      this.store,
      this.files,
      ai,
      this.approvals,
      this.miniLoop,
      this.toolBox,
      this.hub,
    );
    /** 会话循环要用的对象。 */
    const runnerParts: agentLoop.RunnerParts = {
      resources,
      store: this.store,
      files: this.files,
      ai,
      out: this.hub,
      progress: this.progress,
      reviewer: this.reviewer,
      toolBox: this.toolBox,
      memorySearch: this.memorySearch,
      events: this.events,
    };
    this.runner = new agentLoop.SessionRunner(runnerParts);
    this.botLoop = new botLoopModule.BotLoop(
      resources,
      this.store,
      this.files,
      ai,
      this.approvals,
      this.hub,
      this.dispatcher,
      this.runner,
      this.progress,
      this.events,
    );
    //M 进度卡片要用机器人循环转新会话（限时第 5 条）；BotLoop 构造时要先有 Progress，所以建完再接上。
    this.progress.attachBotLoop(this.botLoop);
    this.runs = new runsModule.Runs(resources, this.approvals, this.reviewer);
    //M 5. 定时的三样（start 里才开起来，试运行不开）。
    this.updateWatch = new updateWatchModule.UpdateWatch(resources, this.approvals, this.hub);
    this.runReview = new reviewModule.RunReview(
      resources,
      this.store,
      this.files,
      ai,
      this.approvals,
      this.hub,
    );
    this.indexRefresher = new contextModule.IndexRefresher(resources);
  }

  /**
   * 建应用：接收入口准备好的资源，连接模型库，再建所有对象。
   * @param resources 入口已经加载的资源。
   * @param options 入口已校验的试运行模式和端口。
   * @returns 应用（还没开起来）。
   * 副作用：联网拉模型清单、打开数据库。
   */
  static async create(
    resources: resourcesModule.Resources,
    options: AppOptions,
  ): Promise<App> {
    /** 模型库。 */
    const ai = await model.Ai.connect(resources);
    return new App(resources, ai, options);
  }

  /**
   * 开起来：收拾数据库、开渠道、起每个机器人的循环和定时的事、接着跑重启前没跑完的会话。
   * 试运行只开 HTTP。
   * @returns 无（服务一直跑）。
   * 副作用：监听端口、连飞书、写 pid 文件、调模型……
   */
  async start(): Promise<void> {
    await debug.point('启动 1：读完配置', () => ({
      runtime: this.resources.dir,
      port: this.port,
      mode: this.candidate ? 'candidate' : 'normal',
      bots: this.resources.listBots().map((bot) => bot.name),
      defaultModel: this.resources.getDefaultModel(),
    }));
    //M 机器人文件夹先建好；“分派中”的消息改回新到、运行中的会话改回空闲（试运行不动数据库）。
    if (!this.candidate) {
      for (const bot of this.resources.listBots()) {
        await this.files.ensureBot(bot.name);
      }
    }
    /** 明确启用的机器人；历史会话仍保留，但不替停用机器人恢复执行。 */
    const enabledBots = new Set(this.resources.listBots().map((bot) => bot.name));
    /** 要接着跑的会话。 */
    const recovered = this.candidate ? [] : this.store.recover().filter((id) => {
      /** 数据库保留的会话所属机器人。 */
      const bot = this.store.getSession(id)?.bot;
      return bot !== undefined && enabledBots.has(bot) && !this.files.readBotSettings(bot).relayOnly;
    });
    await debug.point('启动 2：数据库开好、收拾完', () => ({
      db: path.join(this.resources.dir, 'data', 'jmbots.db'),
      recovered: recovered.length,
    }));

    //M 开渠道：HTTP 和配置里开着的；收到话交给机器人循环。
    await this.hub.start({ http: this.httpParts(), channels: this.channelParts() });
    await debug.point('启动 3：渠道开好', () => ({
      http: `0.0.0.0:${String(this.port)}`,
      channels: this.hub.channelStatus().map((item) => ({ name: item.name, connected: item.connected })),
    }));
    await fs.writeFile(path.join(this.resources.dir, 'data', `serve_${this.port}.pid`), String(process.pid));
    /** 试运行的说明。 */
    const candidateNote = this.candidate ? '，试运行（不接飞书、不起循环）' : '';
    console.log(`${utils.formatTime()} HTTP 服务：http://0.0.0.0:${this.port}（运行时 ${this.resources.dir}）${candidateNote}`);
    for (const problem of this.resources.problems()) {
      console.log(`${utils.formatTime()} 配置有问题：${problem}`);
    }
    if (this.candidate) {
      return;
    }

    //M 先开观察处理器（要看到每次运行的开始），再每个机器人起一条循环、开定时的三样，最后接着跑没跑完的会话。
    this.eventWatch.start();
    for (const bot of this.resources.listBots()) {
      this.botLoop.start(bot.name);
      console.log(`${utils.formatTime()} 机器人 ${bot.name} 的循环起来了`);
      await debug.point('启动 4：机器人循环起来了', () => ({ bot: bot.name }));
    }
    this.updateWatch.start();
    this.runReview.start();
    this.indexRefresher.start();
    for (const id of recovered) {
      void this.runner.runSession(id);
    }
    await debug.point('启动 5：等消息', () => ({ web: `http://127.0.0.1:${this.port}/` }));
  }

  /**
   * HTTP 这一层要用的对象（src/channels/Http.ts 的 HttpParts）。
   * @returns 一包对象，都是这个应用的字段。
   */
  private httpParts(): http.HttpParts {
    return {
      resources: this.resources,
      store: this.store,
      files: this.files,
      ai: this.ai,
      secrets: this.secrets,
      approvals: this.approvals,
      progress: this.progress,
      out: this.hub,
      botLoop: this.botLoop,
      agentTaskChannel: this.agentTaskChannel,
      runs: this.runs,
      toolBox: this.toolBox,
      events: this.events,
    };
  }

  /**
   * 建飞书这些登记过的渠道时交给它们的对象（src/channels/Channel.ts 的 ChannelParts）。
   * @returns 一包对象，都是这个应用的字段。
   */
  private channelParts(): channelModule.ChannelParts {
    return {
      resources: this.resources,
      approvals: this.approvals,
      progress: this.progress,
    };
  }
}
