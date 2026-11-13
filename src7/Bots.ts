/**
 * 机器人：整个系统的核心。
 * Bots 是名单；Bot 是一个机器人，只会三件事：收消息放进自己的默认对话、把事交给干活的会话、喊停。
 * 渠道直接调 Bot.receive，不走事件。机器人之间互相找，调对方的 Bot.hand。
 *
 * 默认对话：每个机器人一场，所有渠道来的消息都先进它。
 * 它凭什么知道最近聊了什么、凭什么能交办，是插件 plugins/default-dialog 给的，不在骨架里。
 */
import * as cordis from 'cordis';
import type { BotConfig } from './Resources.ts';


declare module 'cordis' {
  interface Context {
    /** 机器人服务，实现在 src7/Bots.ts。 */
    bots: Bots;
  }
}


/** 渠道送进来的一条消息。 */
export interface IncomingMessage {
  /** 从哪个渠道来：cli、http、feishu…… */
  channel: string;
  /** 给哪个机器人。 */
  bot: string;
  /** 用户说的话。 */
  text: string;
  /** 毫秒时间戳。 */
  time: number;
}


/** 机器人服务：名单。 */
export class Bots extends cordis.Service {
  /** 用到的服务。 */
  static inject = ['resources', 'sessions'];

  /** 机器人名 → 机器人。 */
  private readonly bots = new Map<string, Bot>();

  /**
   * 照名单建好每个机器人。
   * @param ctx Cordis 给的 ctx。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'bots');
    //M resources.getBots() 的每一项 → new Bot(config, ctx)，放进 this.bots。
    for (const item of this.ctx.resources.getBots()) {
      this.bots.set(item.name, new Bot(item, this.ctx));
    }
  }

  /**
   * 取一个机器人。
   * @param name 机器人名。
   * @returns 没有这个机器人是 undefined；渠道用它校验名字。
   */
  get(name: string): Bot | undefined {
    return this.bots.get(name);
  }

  /** @returns 全部机器人。 */
  list(): Bot[] {
    return [...this.bots.values()];
  }

  /**
   * 启动时调一次：上一轮没走完的会话，各推一下。
   * 副作用：调 session.run()，不等。
   */
  resume(): void {
    //M sessions.unfinished() 的每一场 → void session.run()。
    for (const session of this.ctx.sessions.unfinished()) {
      void session.run();
    }
  }
}


/** 一个机器人。只由 Bots 的构造函数来建。 */
export class Bot {
  /** 机器人名。 */
  readonly name: string;

  /** 名单里那一项。 */
  readonly config: BotConfig;

  /**
   * @param config 名单里那一项。
   * @param ctx 取 sessions 用。
   */
  constructor(config: BotConfig, private readonly ctx: cordis.Context) {
    this.name = config.name;
    this.config = config;
  }

  /**
   * 渠道送来一条消息。收下就返回，不等模型。
   * @param message 渠道、机器人、文字、时间。
   * 副作用：记进默认对话；推默认对话往下走。
   */
  receive(message: IncomingMessage): void {
    //M 默认对话 = sessions.defaultOf(this.name)。
    const session = this.ctx.sessions.defaultOf(this.name);
    //T 跟踪：『机器人收到一条消息，放进默认对话』 代码 defaultOf(name).add('user', text, channel) 变量 { 渠道, 机器人, 字数 }
    this.ctx.emit('trace', {
      module: 'Bots',
      fn: 'receive',
      session: session.id,
      text: '机器人收到一条消息，放进默认对话',
      code: "defaultOf(name).add('user', text, channel)",
      vars: () => ({ 渠道: message.channel, 机器人: this.name, 字数: message.text.length }),
    });
    //M 默认对话.add('user', message.text, message.channel)。
    session.add('user', message.text, message.channel);
    //M void 默认对话.run()。它已经在转的话 run 直接返回，循环下一步读对话时自然带上这一条。
    void session.run();
  }

  /**
   * 把一件事交给一场干活的会话。默认对话的 hand_session 工具调它；别的机器人要找这个机器人办事也调它。
   * @param text 要办的事。
   * @param channel 办完回话往哪个渠道送。
   * @param sessionId 接着哪一场；不给就新开。
   * @returns 交给了哪一场的会话号。
   * 副作用：可能新开会话；记进去；推它往下走，不等。
   */
  hand(text: string, channel: string, sessionId?: string): string {
    /** 是不是新开的。 */
    let created = false;
    /** 交给的那场。 */
    let session;
    //M 给了 sessionId → sessions.open(sessionId)；没有这场 → 抛错（工具会把错误当结果给模型看）。
    if (sessionId !== undefined && sessionId !== '') {
      session = this.ctx.sessions.open(sessionId);
      if (session === undefined) {
        throw new Error(`没有这场会话 ${sessionId}`);
      }
    } else {
      //M 没给 → sessions.create({ bot: this.name, kind: 'work', channel })。
      session = this.ctx.sessions.create({ bot: this.name, kind: 'work', channel });
      created = true;
    }
    //T 跟踪：『把一件事交给一场干活的会话』 变量 { 会话号, 是不是新开的, 渠道 }
    this.ctx.emit('trace', {
      module: 'Bots',
      fn: 'hand',
      session: session.id,
      text: '把一件事交给一场干活的会话',
      vars: () => ({ 会话号: session.id, 是不是新开的: created, 渠道: channel }),
    });
    //M session.add('user', text, channel)；void session.run()；return session.id。
    session.add('user', text, channel);
    void session.run();
    return session.id;
  }

  /**
   * 喊停一场会话。界面按钮、默认对话的 stop_session 工具都走它。
   * @param sessionId 哪一场。
   * @param by 谁喊的。
   * @returns 没有这场，或者它没在跑，是 false。
   */
  stop(sessionId: string, by: string): boolean {
    //M sessions.open(sessionId)?.stop(by)。
    const session = this.ctx.sessions.open(sessionId);
    if (session === undefined) {
      return false;
    }
    const state = session.row.state;
    if (state === 'done' || state === 'stopped' || state === 'failed') {
      return false;
    }
    session.stop(by);
    return true;
  }
}
