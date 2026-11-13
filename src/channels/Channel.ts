/**
 * 渠道接口和登记表（docs/10 6.14）：每种渠道在自己文件里实现 Channel 并登记，入口照 config.yaml 把开着的建出来；
 * 核心里不出现任何一家渠道的名字。飞书一个应用建一个渠道，每个渠道知道自己对应哪个机器人。
 */
import * as utils from '../utils/Utils.ts';
import * as checks from '../utils/Checks.ts';
import type * as approvalsModule from '../capabilities/Approvals.ts';
import type * as progressModule from '../capabilities/Progress.ts';
import type * as depsModule from '../capabilities/Deps.ts';
import type * as botLoop from '../bots/BotLoop.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 一个渠道。 */
export interface Channel {
  /** 渠道名：http，或 feishu:<应用 ID>。 */
  name: string;
  /** 对应哪个机器人（飞书应用才有）。 */
  bot?: string;
  /** 开始收消息，收到就调 receive；返回停下的函数。副作用：真的开始监听（端口、长连接）。 */
  start(receive: (input: botLoop.IncomingInput) => Promise<unknown>): Promise<() => Promise<void>>;
  /** 发文字，文字里的 @路径 一起发（飞书：图片发图片、别的发附件；HTTP 只记录）。副作用：真的发到外面。 */
  send(address: Record<string, unknown>, text: string): Promise<void>;
  /** 撤掉这条消息上的“正在输入”。副作用：真的发到外面。 */
  stopTyping?(address: Record<string, unknown>): Promise<void>;
  /** 发审核卡片；地址是空的时发给最近私聊的人。返回发出去没有。 */
  sendApproval?(address: Record<string, unknown>, pending: approvalsModule.PendingApproval): Promise<boolean>;
  /** 发飞书云文档，编辑权限给这个地址的发送人（空地址给最近私聊的人）；返回链接说明。 */
  publishDoc?(address: Record<string, unknown>, request: depsModule.DocRequest): Promise<string>;
  /** 把机器人自己发的云文档放进回收站；返回结果说明。 */
  deleteDoc?(ids: string[]): Promise<string>;
  /** 现在连着没有（飞书长连接）；HTTP 这种一直在的不用写。 */
  status?(): { connected: boolean; detail: string };
  /** 发进度卡片，返回卡片的号（飞书 message_id）。 */
  sendProgress?(address: Record<string, unknown>, view: progressModule.ProgressView): Promise<string>;
  /** 原地改进度卡片。 */
  updateProgress?(handle: string, view: progressModule.ProgressView): Promise<void>;
}


/**
 * 建渠道时交给登记表上建渠道函数的（入口 src/entries/App.ts 建的，经 ChannelHub.start 交下来）。
 * 只放渠道真用到的；HTTP 渠道不走登记表，它要的在 src/channels/Http.ts 的 HttpParts。
 */
export interface ChannelParts {
  /** 资源：运行时目录（飞书记最近私聊的人、发件箱）、配置里开了哪些渠道。 */
  resources: resourcesModule.Resources;
  /** 待确认：审核卡片上点了同意、拒绝；别处决定了就更新卡片。 */
  approvals: approvalsModule.Approvals;
  /** 进度卡片：卡片上“最多几分钟”“终止”按钮；测试里可以不给。 */
  progress?: progressModule.Progress;
}


/** 统一渠道入口已经检查过机器人字段的设置。 */
export type ChannelSettings = Record<string, unknown> & {
  /** 非空且属于启用名单的机器人名。 */
  bot: string;
};


/** 登记表：渠道种类（config.yaml 的 channels 下的键，如 feishu）→ 建渠道的函数。 */
const builders = new Map<string, (settings: ChannelSettings, parts: ChannelParts) => Channel>();


/**
 * 登记一种渠道怎么建。
 * @param name 渠道种类，要和 config.yaml 的 channels 下的键一致。
 * @param build 建渠道的函数：参数是这一份设置（带 bot）和渠道要用的对象（ChannelParts）。
 * @returns 无。
 * @throws 同名登记两次时抛错。
 * 副作用：写进登记表。
 */
export function registerChannel(
  name: string,
  build: (settings: ChannelSettings, parts: ChannelParts) => Channel,
): void {
  if (builders.has(name)) {
    throw new Error(`渠道 ${name} 已经登记过了`);
  }
  builders.set(name, build);
}


/**
 * 按登记表建一个渠道（运行时新建机器人时加飞书应用，docs/界面/01_界面设计.md 6.2）。
 * @param kind 渠道种类，如 feishu。
 * @param settings 这一份设置（带 bot）。
 * @param parts 渠道要用的对象。
 * @returns 建好的渠道（还没开）。
 * @throws 没登记过这种渠道、设置不对时抛错。
 */
export function buildChannel(
  kind: string,
  settings: Record<string, unknown>,
  parts: ChannelParts,
): Channel {
  /** 建渠道的函数。 */
  const build = builders.get(kind);
  if (!build) {
    throw new Error(`代码里没有渠道 ${kind}`);
  }
  /** 外部配置在统一入口检查一次，构造器只接收明确字段。 */
  const checkedSettings = readChannelSettings(kind, settings, parts);
  return build(checkedSettings, parts);
}


/**
 * 外部配置进入渠道的统一入口：检查机器人字段和启用状态。
 * @param kind 渠道类型，只用于错误定位。
 * @param settings 原始渠道配置，可能来自配置文件或新增渠道请求。
 * @param parts 资源及渠道依赖。
 * @returns 已确定机器人字段的新对象，不修改输入。
 * @throws 机器人字段缺失、为空或未启用时抛错。
 */
export function readChannelSettings(
  kind: string,
  settings: Record<string, unknown>,
  parts: ChannelParts,
): ChannelSettings {
  /** 非空机器人名，只在渠道入口检查。 */
  const bot = checks.requireString(settings.bot, `channels.${kind}.bot`);
  parts.resources.getBot(bot);
  return {
    ...settings,
    bot,
  };
}


/**
 * 照配置把开着的渠道建出来（不含 HTTP，HTTP 由 index.ts 自己建）；飞书一个应用建一个。
 * @param parts 渠道要用的对象。
 * @returns 建好的渠道。
 * 副作用：调用各渠道的建渠道函数（可能建客户端）。
 */
export function buildChannels(parts: ChannelParts): Channel[] {
  /** 建好的渠道。 */
  const channels: Channel[] = [];
  for (const { name, settings } of parts.resources.listChannels()) {
    /** 建渠道的函数。 */
    const build = builders.get(name);
    //G 配置里写了代码不认识的渠道（旧配置里的、写错的）：打一行日志跳过，不挡别的渠道。
    if (!build) {
      console.error(`config.yaml 里开了渠道 ${name}，但代码里没有这种渠道，跳过`);
      continue;
    }
    try {
      channels.push(buildChannel(name, settings, parts));
    } catch (error) {
      console.error(`渠道 ${name} 没开起来：${utils.errorText(error)}`);
    }
  }
  return channels;
}
