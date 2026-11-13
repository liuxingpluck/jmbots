/**
 * 按配置开渠道（docs/10 6.14）：HTTP 总是开（监听 0.0.0.0），再加 config.yaml 里开着的（飞书一个应用一个）。
 * 收到话交给 机器人循环.receive；ChannelHub 自己实现“往渠道发东西”的 Outlet：入口 src/entries/App.ts 最先建它，
 * 要发东西的对象（会话、审核、进度卡片……）构造时就拿着它；开渠道（start）时才交进收话要用的对象。
 * 消息是 HTTP 来的、却要发审核卡片或云文档时，找这个机器人的飞书应用代发（发给最近私聊的人）。
 */
import * as utils from '../utils/Utils.ts';
import * as channelModule from './Channel.ts';
import * as http from './Http.ts';
import './Feishu.ts';
import type * as approvalsModule from '../capabilities/Approvals.ts';
import type * as progressModule from '../capabilities/Progress.ts';
import type * as depsModule from '../capabilities/Deps.ts';


/** 开渠道时交给渠道中心的（入口 src/entries/App.ts 建好）。 */
export interface HubParts {
  /** HTTP 渠道要用的对象（src/channels/Http.ts 的 HttpParts），收话也走它的 botLoop.receive。 */
  http: http.HttpParts;
  /** 建登记表上的渠道（飞书）时交给它们的对象（src/channels/Channel.ts 的 ChannelParts）。 */
  channels: channelModule.ChannelParts;
}


/**
 * 渠道中心：开所有渠道，同时是往渠道发东西的出口（实现 Outlet）。
 * 入口最先建它（只要端口和是否试运行），要发东西的对象构造时就拿着它；渠道开起来以前发东西会报“渠道没开”。
 * 渠道表和各渠道的停下函数是私有字段；出口的方法都是按渠道名找到渠道再转给它。
 * 方法都是拿着对象调（out.send(...)），没有单独拿出来传的，this 不会丢。
 */
export class ChannelHub implements depsModule.Outlet {
  /** 开着的渠道（启动时放 HTTP 和配置里的，运行时 addChannel 还会加）。 */
  private readonly channels: channelModule.Channel[] = [];

  /** 各渠道的停下函数。 */
  private readonly stops: (() => Promise<void>)[] = [];

  /** 开渠道时交进来的（start 以前是 undefined）。 */
  private parts?: HubParts;

  /**
   * 建渠道中心（还没开渠道，开用 start）。
   * @param options port 端口；candidate 试运行只开 HTTP。
   */
  constructor(private readonly options: { port: number; candidate: boolean }) {}

  /**
   * 开所有渠道：HTTP 总是开，试运行以外再开配置里的。
   * @param parts HTTP 要用的对象、建飞书要的依赖（入口 src/entries/App.ts 建好）。
   * @returns 无。HTTP 起不来时抛错；别的渠道起不来只打一行日志。
   * 副作用：监听端口、连飞书。
   */
  async start(parts: HubParts): Promise<void> {
    this.parts = parts;
    //M 建渠道：HTTP 在前，配置里开着的在后。
    this.channels.push(
      new http.HttpChannel(parts.http, this.options.port),
      ...(this.options.candidate ? [] : channelModule.buildChannels(parts.channels)),
    );
    //M 一个个开，停下函数收起来；收到话交给机器人循环。
    for (const channel of this.channels) {
      try {
        this.stops.push(await channel.start((input) => parts.http.botLoop.receive(input)));
      } catch (error) {
        //G HTTP 起不来就整个起不来；飞书连不上只打一行，不挡别的渠道。
        if (channel.name === 'http') {
          throw error;
        }
        console.error(
          `${utils.formatTime()} 渠道 ${channel.name} 没开起来：${utils.errorText(error)}`,
        );
      }
    }
  }

  /**
   * 停下所有渠道（一个停不下来不挡别的）。
   * 副作用：关端口、断飞书。
   */
  async stop(): Promise<void> {
    for (const stop of this.stops) {
      await stop().catch(() => undefined);
    }
  }

  /** 各渠道连着没有（界面左下角的小圆点用）。只列有 status 的渠道。 */
  channelStatus(): { name: string; bot?: string; connected: boolean; detail: string }[] {
    return this.channels.flatMap((channel) =>
      channel.status ? [{ name: channel.name, bot: channel.bot, ...channel.status() }] : [],
    );
  }

  /**
   * 运行时加一个渠道（网页新建机器人时绑飞书应用）：照登记表建、连上、加进路由。
   * @param kind 渠道种类。
   * @param settings 这一份设置（带 bot）。
   * @throws 连不上时抛错（渠道照样加进去，状态里看得到）。
   */
  async addChannel(kind: string, settings: Record<string, unknown>): Promise<void> {
    /** 开渠道时交进来的。 */
    const parts = this.parts;
    if (!parts) {
      throw new Error('渠道中心还没开（start），不能加渠道');
    }
    //M 先加进路由，连不上状态里也看得到（和启动时一样）。
    /** 新渠道。 */
    const channel = channelModule.buildChannel(kind, settings, parts.channels);
    this.channels.push(channel);
    this.stops.push(await channel.start((input) => parts.http.botLoop.receive(input)));
  }

  /**
   * 发文字到指定渠道。
   * @param name 渠道名。
   * @param address 回复地址。
   * @param text 文字。
   * @throws 渠道没开时抛错。
   */
  async send(name: string, address: Record<string, unknown>, text: string): Promise<void> {
    /** 渠道。 */
    const channel = this.route(name);
    if (!channel) {
      throw new Error(`渠道 ${name} 没开`);
    }
    await channel.send(address, text);
  }

  /**
   * 撤掉这条消息上的“正在输入”；渠道没有这回事就什么也不做。
   * @param name 渠道名。
   * @param address 回复地址。
   */
  async stopTyping(name: string, address: Record<string, unknown>): Promise<void> {
    await this.route(name)?.stopTyping?.(address);
  }

  /**
   * 发审核卡片：消息来的渠道加上这个机器人别的渠道（onlyHere 时只发消息来的那个）。
   * @param name 消息来的渠道。
   * @param address 回复地址。
   * @param pending 待确认。
   * @param onlyHere 只发这个渠道。
   * @returns 发出去的渠道名；一个发不出去不挡别的。
   */
  async sendApproval(
    name: string,
    address: Record<string, unknown>,
    pending: approvalsModule.PendingApproval,
    onlyHere?: boolean,
  ): Promise<string[]> {
    /** 消息来的渠道。 */
    const own = this.route(name);
    /** 要发的渠道：消息来的那个，加上这个机器人别的渠道。 */
    const targets = onlyHere
      ? [own]
      : [...new Set([own, ...this.channels.filter((channel) => channel.bot === pending.bot)])];
    /** 每个渠道发出去没有；一个发不出去不挡别的。 */
    const sent = await Promise.all(
      targets.map(async (channel) => {
        try {
          /** 发卡片的地址：消息来的渠道用回复地址，别的发给最近私聊的人。 */
          const target = channel === own ? address : {};
          return (await channel?.sendApproval?.(target, pending)) ? channel?.name : undefined;
        } catch (error) {
          console.error(
            `${utils.formatTime()} 渠道 ${channel?.name ?? name} 的审核卡片没发出去：${utils.errorText(error)}`,
          );
          return undefined;
        }
      }),
    );
    return sent.filter((item): item is string => item !== undefined);
  }

  /**
   * 发进度卡片。
   * @param name 渠道名。
   * @param address 回复地址。
   * @param view 进度。
   * @returns 渠道里那张卡片的号；渠道画不了卡片时 undefined。
   */
  async sendProgress(
    name: string,
    address: Record<string, unknown>,
    view: progressModule.ProgressView,
  ): Promise<string | undefined> {
    /** 渠道。 */
    const channel = this.route(name);
    return channel?.sendProgress ? channel.sendProgress(address, view) : undefined;
  }

  /**
   * 原地改进度卡片。
   * @param name 渠道名。
   * @param handle 卡片号。
   * @param view 进度。
   */
  async updateProgress(
    name: string,
    handle: string,
    view: progressModule.ProgressView,
  ): Promise<void> {
    await this.route(name)?.updateProgress?.(handle, view);
  }

  /**
   * 发飞书云文档（消息来的渠道不支持就找这个机器人的第一个飞书应用）。
   * @param name 消息来的渠道。
   * @param address 回复地址。
   * @param request 文档请求。
   * @returns 链接说明。
   * @throws 没开飞书时抛错。
   */
  async publishDoc(
    name: string,
    address: Record<string, unknown>,
    request: depsModule.DocRequest,
  ): Promise<string> {
    /** 渠道。 */
    const channel = this.capable(name, request.bot, 'publishDoc');
    if (!channel?.publishDoc) {
      throw new Error('没开飞书，发不了云文档');
    }
    return channel.publishDoc(channel.name === name ? address : {}, request);
  }

  /**
   * 把机器人自己发的云文档放进回收站。
   * @param name 消息来的渠道。
   * @param bot 机器人。
   * @param ids 文档号。
   * @returns 结果说明。
   * @throws 没开飞书时抛错。
   */
  async deleteDoc(name: string, bot: string, ids: string[]): Promise<string> {
    /** 渠道。 */
    const channel = this.capable(name, bot, 'deleteDoc');
    if (!channel?.deleteDoc) {
      throw new Error('没开飞书，删不了云文档');
    }
    return channel.deleteDoc(ids);
  }

  /**
   * 按渠道名找渠道。
   * @param name 渠道名。
   * @returns 渠道；没有时 undefined。
   */
  private route(name: string): channelModule.Channel | undefined {
    return this.channels.find((channel) => channel.name === name);
  }

  /**
   * 能发卡片、云文档的渠道：消息来的那个渠道支持就用它；不支持（HTTP）就用这个机器人的第一个飞书应用。
   * @param name 消息来的渠道。
   * @param bot 机器人。
   * @param can 要的能力。
   * @returns 渠道（换了渠道时回复地址要用空的：发给最近私聊的人）。
   */
  private capable(
    name: string,
    bot: string,
    can: 'sendApproval' | 'publishDoc' | 'deleteDoc',
  ): channelModule.Channel | undefined {
    /** 消息来的渠道。 */
    const own = this.route(name);
    if (own?.[can] !== undefined) {
      return own;
    }
    return this.channels.find((channel) => channel.bot === bot && channel[can] !== undefined);
  }
}
