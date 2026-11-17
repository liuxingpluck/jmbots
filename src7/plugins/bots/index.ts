/**
 * 机器人：名单，加上每个机器人怎么收消息、怎么把事交给后台会话。
 * 骨架只管“一场会话怎么跑”；会话属于哪个机器人、话从哪个渠道来、回话往哪送，都是这个插件记在会话上的。
 *
 * 渠道（命令行、HTTP、飞书）直接调 Bot.receive，不走事件。
 * 机器人收到消息以后问一声“这条消息进哪场会话”（事件 bot/receive），由管分派的插件来答。
 * 现在答的是前台插件 plugins/bot-front-desk：每个机器人一场前台对话，所有消息先到它那儿。
 * 渠道（命令行、HTTP、飞书、微信）向本服务登记发送函数：ctx.bots.channel(name, send)；收话调 ctx.bots.receive，附件调 ctx.bots.saveFile。
 * 会话跑到一半要先跟用户说一句，调 ctx.bots.say(session, text)：发通知 bot/say，本服务按会话的渠道名找到登记的 send 发出去。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cordis from 'cordis';
import type { Thinking } from '../../Chat.ts';
import type { Session } from '../../Sessions.ts';


/** 插件名。 */
export const name = 'bots';

/** 用到的服务。 */
export const inject = ['resources', 'sessions'];


declare module 'cordis' {
  interface Context {
    /** 机器人服务，实现在 src7/plugins/bots/index.ts。 */
    bots: Bots;
  }
  interface Events {
    /**
     * 机器人收到一条消息，问：这条消息进哪场会话。照插件挂上去的先后一个个 await。
     * 管分派的插件把 event.session 填上；前面已经有人填了，后面的不要再填。监听的函数不许有返回值。
     * 排在前面的插件（比如 approval 认出“同意 3”）可以写 event.handled = true：这条已经处理掉，不进任何会话。
     */
    'bot/receive'(event: ReceiveEvent): void | Promise<void>;
    /** 会话跑到一半先跟用户说一句（通知）。渠道基类听它：是自己渠道的会话就发出去；前台听它记一条往来。 */
    'bot/say'(session: Session, text: string): void;
    /** 前台对群里没 @ 机器人的话判断完要不要接话（listen: judge）。会话在转时来的话是这一轮结束才判断，晚于收话那一刻，渠道听它补记一行流水。 */
    'bot/judged'(address: unknown, text: string, outcome: string): void;
  }
}


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 属于哪个机器人。 */
    bot: string;
    /** 回话往哪个渠道送：最后一句带渠道的话从哪来。小会话没有，所以没人给它回话。 */
    channel?: string;
    /** 渠道自己认得的回话地址，和 channel 一起记。形状归各渠道（HTTP 是 { messageId }，飞书是哪个应用、哪个聊天）。 */
    address?: unknown;
    /** 客户号：渠道在回话地址里写的 address.customer，收消息时由 bots.route 抄到这里。别的插件只读，不要自己推。 */
    customer?: string;
  }
}


/** 渠道把机器人的话交给用户。登记在 ctx.bots.channel(name, send)。 */
export type ChannelSend = (reply: string, session: Session) => void | Promise<void>;


/** bots 名单里的一项。除了 name，别的项原样留着，哪个插件要用哪个插件自己读（比如 language）。 */
export interface BotConfig {
  /** 机器人名，也是运行时目录 bots/ 下的文件夹名。 */
  name: string;
  [key: string]: unknown;
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
  /** 渠道自己认得的回话地址；这里不解释，原样记到会话上，回话时渠道自己拿。 */
  address?: unknown;
}


/** 这句话从哪来：渠道名和回话地址。会话照它记回话往哪送。 */
export interface Origin {
  /** 渠道名；不给就不改会话原来记的渠道和地址。 */
  channel?: string;
  /** 回话地址；只在给了渠道时才记。 */
  address?: unknown;
}


/** 事件 bot/receive 的数据。 */
export interface ReceiveEvent {
  /** 是哪个机器人收到的。 */
  bot: Bot;
  /** 收到的那条消息。 */
  message: IncomingMessage;
  /** 这条消息进哪场会话；管分派的插件填。 */
  session?: Session;
  /** 前面的插件已经把这条处理掉了：写了 true，这条就不进任何会话。 */
  handled?: boolean;
}


/** 校验以后给机器人服务的东西。 */
export interface BotsConfig {
  /** 机器人名单，照 config.yaml 里 bots 写的先后。 */
  bots: BotConfig[];
  /** 后台会话（干活的会话）用哪个思考档。 */
  thinking: Thinking;
}


/** 机器人服务：名单。 */
export class Bots extends cordis.Service {
  /** 机器人名 → 机器人，照名单的先后。 */
  private readonly bots = new Map<string, Bot>();

  /** 后台会话用哪个思考档；运行中新加的机器人也用它。 */
  private readonly thinking: Thinking;

  /** 渠道名 → 发送函数。渠道插件挂上时登记，拔掉时撤掉。 */
  private readonly sends = new Map<string, ChannelSend>();

  /**
   * 登记 bots 插件：把 Bots 作为服务挂到 Cordis 上（以后用 ctx.bots 取）；再照名单建好每个机器人（一个个调 add，和运行中新建走同一条路）。
   * 同时挂上“这一轮有结果了就回话”“会话中途先说一句”：按会话记的渠道名找登记的 send。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config 名单、后台会话的思考档。
   * @throws 名单里有空名字、重名时抛错。
   */
  constructor(ctx: cordis.Context, config: BotsConfig) {
    super(ctx, 'bots');
    this.thinking = config.thinking;
    for (const item of config.bots) {
      this.add(item);
    }

    this.ctx.on('session/change', (session) => {
      const row = session.row;
      //G 还在转、或没有渠道（小会话）→ 不管。
      if (row.state === 'running' || row.channel === undefined) return;
      const send = this.sends.get(row.channel);
      if (send === undefined) return;
      //T 跟踪：回话。
      const vars = { 渠道: row.channel, 会话: row.id, 状态: row.state, 话多少字: row.reply.length };
      this.ctx.emit('trace', 'Bots.onChange', '把机器人的话交给用户', 'send(reply, session)', vars);
      void send(row.reply, session);
    });

    //M 会话中途先说一句（bots.say 发的通知 bot/say）：有登记的渠道就发出去，和最后的回话走同一个 send。
    this.ctx.on('bot/say', (session, text) => {
      const name = session.row.channel;
      if (name === undefined) return;
      const send = this.sends.get(name);
      if (send !== undefined) void send(text, session);
    });
  }

  /**
   * 登记一个渠道的发送函数。渠道插件被拔掉时，把返回的函数交给 ctx.effect 就会自动撤掉。
   * @param name 渠道名：cli、http、feishu、wechat……
   * @param send 把机器人的话交给用户。
   * @returns 撤掉这次登记的函数。
   * 副作用：写入 sends；同名再登记会换掉旧的。
   */
  channel(name: string, send: ChannelSend): () => void {
    this.sends.set(name, send);
    return () => {
      if (this.sends.get(name) === send) this.sends.delete(name);
    };
  }

  /**
   * 收到用户一句话。渠道自己存一份，再直接推给对应的机器人，不走事件。
   * @param name 渠道名。
   * @param bot 给哪个机器人。
   * @param text 用户说的话。
   * @param address 渠道自己认得的回话地址；原样记到会话上。
   * @throws 没有这个机器人、没有插件管分派时抛错（渠道是外部入口，在这里校验一次）；怎么告诉用户由各渠道自己定。
   * 副作用：存到本地；推给机器人。
   */
  async receive(name: string, bot: string, text: string, address?: unknown): Promise<void> {
    const target = this.get(bot);
    if (target === undefined) {
      throw new Error(`没有这个机器人：${bot}`);
    }
    const message: IncomingMessage = { channel: name, bot, text, time: Date.now(), address };

    //T 跟踪：渠道收到一句话。
    const vars = { 渠道: name, 机器人: bot, 字数: text.length };
    this.ctx.emit('trace', 'Bots.receive', '渠道收到一句话，存下来，推给机器人', 'bot.receive(message)', vars);

    //M 渠道自己存一份：运行时目录 channels/<渠道名>/ 下，一天一个文件，一条一行 JSON。
    /** 本地日期，2026-11-13 的样子（sv-SE 这个地区的写法正好是它）。 */
    const day = new Date(message.time).toLocaleDateString('sv-SE');
    const file = path.join(this.ctx.resources.dir('channels', name), `${day}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(message)}\n`, 'utf8');

    //M 推给机器人。直接调，不走事件。
    await target.receive(message);
  }

  /**
   * 渠道收到的图片、文件存进这个机器人的工作区：工作区/inbox/<本地日期>/<时分秒毫秒>_<安全文件名>。
   * 存在工作区里，模型用工具 read 就能读到（base-tools 只许读工作区）。
   * @param bot 给哪个机器人。
   * @param name 原来的文件名；只取最后一段（/ 和 \ 都算分隔），去掉 Windows 不许的字符和控制字符，空白换成 _，空了叫“附件”。
   * @param data 文件内容。
   * @returns 存下的绝对路径；渠道把 @绝对路径 写进给机器人的话里。
   * @throws 没有这个机器人时抛错；同一毫秒同名撞上时抛错（不加序号重试），渠道接住告诉用户。
   * 副作用：建文件夹、写文件。
   */
  saveFile(bot: string, name: string, data: Uint8Array): string {
    const target = this.get(bot);
    if (target === undefined) {
      throw new Error(`没有这个机器人：${bot}`);
    }

    //M 一天一个文件夹，文件名前面带时分秒毫秒，免得同名覆盖。
    const now = new Date();
    const dir = path.join(target.workspace, 'inbox', now.toLocaleDateString('sv-SE'));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now.toLocaleTimeString('sv-SE').replaceAll(':', '') + String(now.getMilliseconds()).padStart(3, '0');
    const safe = path.win32.basename(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '_') || '附件';
    const full = path.join(dir, `${stamp}_${safe}`);

    //M wx：文件已经有了就抛错，不覆盖。
    fs.writeFileSync(full, data, { flag: 'wx' });
    return full;
  }

  /**
   * 加一个机器人：启动时照名单加，运行中新建（设置页 settings）也调它，加完马上能收消息。
   * 只加进内存；config.yaml 由调它的插件自己写。
   * @param config 名单里的一项：要有非空的 name，别的项原样留着。
   * @returns 建好的机器人。
   * @throws name 不是非空字符串、或者重名时抛错。
   * 副作用：建好它的工作区、记忆目录；放进名单末尾。
   */
  add(config: BotConfig): Bot {
    //M 名单项是外面进来的（config.yaml 的 bots 段、设置页新建），在这里校验一次。
    if (typeof config?.name !== 'string' || config.name === '') {
      throw new Error('机器人要有非空的 name');
    }
    if (this.bots.has(config.name)) {
      throw new Error(`已经有叫 ${config.name} 的机器人了`);
    }
    const bot = new Bot(config, this.thinking, this.ctx);
    this.bots.set(bot.name, bot);
    return bot;
  }

  /**
   * 取一个机器人。
   * @param botName 机器人名。
   * @returns 没有这个机器人是 undefined；渠道用它校验名字。
   */
  get(botName: string): Bot | undefined {
    return this.bots.get(botName);
  }

  /** @returns 全部机器人，照名单的先后。 */
  list(): Bot[] {
    return [...this.bots.values()];
  }

  /**
   * 改一场会话的回话往哪送：渠道和地址一起换（换了渠道，旧地址就作废；没给地址就清掉）。
   * 机器人收消息、交办时走它；别的插件（比如 relay 送回信前）也调它，不直接改 row.channel、row.address。
   * @param session 哪场会话。
   * @param origin 渠道和回话地址；不给渠道就什么也不改。
   * 副作用：改会话记录并存库。
   */
  route(session: Session, origin: Origin): void {
    if (origin.channel === undefined) return;
    session.row.channel = origin.channel;
    session.row.address = origin.address;
    //M 客户号由渠道写在 address.customer 里，这里抄到记录上；地址里没有就保留原来的（旧会话可能已经被补过）。
    const where = (typeof origin.address === 'object' && origin.address !== null && !Array.isArray(origin.address) ? origin.address : {}) as Record<string, unknown>;
    if (typeof where['customer'] === 'string' && where['customer'] !== '') {
      session.row.customer = where['customer'];
    }
    session.save();
  }

  /**
   * 会话跑到一半，先跟用户说一句（最后的回话照旧由渠道在这一轮结束时发）。
   * 没有渠道的会话（小会话）也照发，没人接就算了。
   * @param session 哪场会话：渠道从它的 row.channel、row.address 认出往哪送。
   * @param text 要说的话。
   * 副作用：发通知 bot/say（ctx.emit 是“通知”：挨个调听的函数，不等它们的结果，也不管有没有人听）。
   */
  say(session: Session, text: string): void {
    //T 跟踪：会话中途先跟用户说一句。
    const vars = { 会话: session.id, 渠道: session.row.channel ?? '（没有）', 字数: text.length };
    this.ctx.emit('trace', 'Bots.say', '会话中途先跟用户说一句', "ctx.emit('bot/say', session, text)", vars);
    this.ctx.emit('bot/say', session, text);
  }
}


/** 一个机器人。只由 Bots 的构造函数来建。 */
export class Bot {
  /** 机器人名。 */
  readonly name: string;

  /** 这个机器人的工作区：运行时目录 bots/<机器人>/workspace/。工具在这里读写文件。 */
  readonly workspace: string;

  /** 这个机器人的记忆目录：运行时目录 bots/<机器人>/memory/。 */
  readonly memory: string;

  /**
   * @param config 名单里那一项。
   * @param thinking 后台会话用哪个思考档。
   * @param ctx 取 sessions、resources，发事件用。
   */
  constructor(
    readonly config: BotConfig,
    private readonly thinking: Thinking,
    private readonly ctx: cordis.Context,
  ) {
    this.name = config.name;
    this.workspace = this.ctx.resources.dir('bots', this.name, 'workspace');
    this.memory = this.ctx.resources.dir('bots', this.name, 'memory');
  }

  /**
   * 渠道送来一条消息。定好进哪场会话就返回，不等模型。
   * @param message 渠道、机器人、文字、时间、回话地址。
   * @throws 没有插件处理、也没有插件管分派时抛错。
   * 副作用：这句话进那场会话；推它往下走。被前面的插件处理掉的，什么也不做。
   */
  async receive(message: IncomingMessage): Promise<void> {
    //M 问：这条消息进哪场会话。管分派的插件（现在是前台 bot-front-desk）把 event.session 填上。
    const event: ReceiveEvent = { bot: this, message };
    await this.ctx.serial('bot/receive', event);

    //G 前面的插件已经把这条处理掉了（handled）→ 不进会话。
    if (event.handled === true) {
      //T 跟踪：被前面的插件处理掉。
      const vars = { 渠道: message.channel, 字数: message.text.length };
      this.ctx.emit('trace', 'Bot.receive', '前面的插件已经处理掉，不进会话', 'event.handled === true', vars);
      return;
    }
    const session = event.session;
    if (session === undefined) {
      throw new Error(`机器人 ${this.name} 收到了消息，但没有插件管分派（plugins 里要挂 bot-front-desk 这类插件）`);
    }

    //T 跟踪：机器人收到一条消息。
    const vars = { 会话: session.id, 渠道: message.channel, 字数: message.text.length };
    this.ctx.emit('trace', 'Bot.receive', '消息交给这场会话，推它往下走', 'session.add(); session.run()', vars);
    this.deliver(session, message.text, { channel: message.channel, address: message.address });
  }

  /**
   * 把一件事交给一场后台会话。前台的 hand_session 工具调它；别的机器人要找这个机器人办事也调它。
   * @param text 要办的事。
   * @param origin 办完回话往哪送：渠道和回话地址；不给渠道就不改这场会话原来记的。
   * @param sessionId 接着哪一场；不给就新开一场。
   * @returns 交给了哪一场。
   * @throws 给了会话号、但没有这场时抛错。
   * 副作用：可能新开会话；这件事进那场会话；推它往下走，不等。
   */
  hand(text: string, origin: Origin, sessionId?: string): Session {
    let session: Session;
    if (sessionId === undefined || sessionId === '') {
      session = this.ctx.sessions.create({ kind: 'work', bot: this.name, thinking: this.thinking });
    } else {
      session = this.ctx.sessions.open(sessionId);
    }
    this.deliver(session, text, origin);
    return session;
  }

  /**
   * 把一句话交给一场会话：记下回话的渠道和地址，话进会话，推它往下走，不等。它已经在转的话，下一步会带上这句。
   * @param session 交给哪一场。
   * @param text 这句话。
   * @param origin 这句话从哪来；不给渠道就不改原来记的。
   */
  private deliver(session: Session, text: string, origin: Origin): void {
    //M 给了渠道，渠道和地址一起换：换了渠道，旧地址就作废（没给地址就清掉）。
    this.ctx.bots.route(session, origin);
    session.add(text);
    void session.run();
  }
}


/**
 * 挂上机器人服务。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务都就绪，
 * 再调一次 apply(ctx, 配置)。详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config config.yaml 的 plugins 段里写给它的：thinking 是后台会话的思考档，不写是 medium。
 * @throws bots 段写得不对时抛错。
 */
export function apply(ctx: cordis.Context, config: { thinking?: Thinking }): void {
  //M 名单是外面进来的（config.yaml 顶层的 bots 段），在这里校验一次：
  //M   一张清单；整段不写就是一个叫“助手”的机器人。每项的 name 由 Bots.add 校验（非空、不重名）。
  const written = ctx.resources.raw['bots'] ?? [{ name: '助手' }];
  if (!Array.isArray(written)) {
    throw new Error('bots 要写成一张清单');
  }
  new Bots(ctx, { bots: written as BotConfig[], thinking: config.thinking ?? 'medium' });
}
