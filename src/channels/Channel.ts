/**
 * 渠道的统一接口和登记表：核心只认 Channel 这一套函数，不认识任何一家渠道。
 *
 * 以前入口直接建具体渠道的客户端，引擎选项上挂着这家渠道专用的好几个口子；再来一家
 * 就得再加一组口子。所以要有登记表：每个渠道在自己文件里实现 Channel 并登记，入口只照
 * config.yaml 里开了的渠道名，从登记表里把渠道建出来。这样核心里不出现任何具体渠道的名字。
 *
 * 这一版只有接口和登记表，先不接线：入口怎么用、事件循环怎么按渠道拆，之后再做。
 */
import type * as resourcesModule from '../resources/Resources.ts';


/** 渠道能接的一句话。 */
export interface Incoming {
  /** 渠道名，和 Channel.name() 的返回值一致。 */
  channel: string;

  /** 来源 ID：渠道里那个说话对象的标识，比如某个聊天里的用户 open_id。 */
  sourceId: string;

  /** 正文。 */
  text: string;

  /** 引用回复的消息 ID；不是引用回复时没有。 */
  replyTo?: string;
}


/** 可选能力名：'选项' 是会发选项让用户挑；'文档' 是会发文档、删文档。 */
/** 发一条媒体/富文本消息要的东西；形状对任何渠道都通用，具体怎么发由各渠道自己实现。 */
export interface MediaRequest {
  /** 发什么：图片、文件、语音、视频，或结构化内容。 */
  type: string;

  /** 本地文件路径（发文件类时用）。 */
  path?: string;

  /** 文件名；不写就用路径里的名字。 */
  name?: string;

  /** 时长，毫秒（语音、视频用）。 */
  duration?: number;

  /** 封面图路径（视频用）。 */
  coverPath?: string;

  /** 结构化内容（富文本、卡片这类，各渠道自己的 JSON 结构）。 */
  content?: Record<string, unknown>;
}


/** 发布一篇文档要的东西。 */
export interface DocRequest {
  /** 文档标题。 */
  title: string;

  /** Markdown 正文（已读出的文本）。 */
  markdown: string;

  /** 放在最前面的图片，按给的顺序；没有就是空数组。 */
  images: string[];
}


export type ChannelAbility = '选项' | '文档';


/**
 * 一个渠道：核心只认这一套，不认识外面是哪一家。
 * 必有的是名字、收消息、发消息、声明能力；选项、发文档、删文档按需实现。
 */
export interface Channel {
  /** 渠道名，登记用，如 '飞书'、'http'。 */
  name(): string;

  /** 开始收消息，返回停止函数；副作用：真的开始监听（长连接、端口等），可能要联网。 */
  start(onMessage: (incoming: Incoming) => void): Promise<() => void>;

  /** 把一句话发出去，返回消息 ID；副作用：真的发到外面。 */
  send(sourceId: string, text: string): Promise<string>;

  /** 支不支持某项可选能力；can('文档') 为 true 时才有 publishDoc 和 deleteDoc。 */
  can(ability: ChannelAbility): boolean;

  /** 可选：把问题和选项发给用户，返回消息 ID；用户点选项或回一句话都行，副作用：真的发到外面。 */
  ask?(sourceId: string, question: string, choices: string[]): Promise<string>;

  /** 可选：把一篇结果发成文档，返回文档 ID 或链接；副作用：真的发到外面。 */
  publishDoc?(title: string, markdown: string): Promise<string>;

  /** 可选：删文档，返回结果说明；副作用：真的删外面的文档。 */
  deleteDoc?(documentIds: string[]): Promise<string>;
}


/** 登记表：渠道名 → 建渠道的函数。入口按 config.yaml 里开了的名字来查。 */
const builders = new Map<string, (settings: Record<string, unknown>) => Channel>();


/**
 * 登记一种渠道怎么建。
 * @param name 渠道名，要和 config.yaml 的 channels 下的键一致。
 * @param build 建渠道的函数；参数是这个渠道的设置（config.yaml 里 channels.<名字> 那一项）。
 * 副作用：写进登记表。同名重复登记报错，免得两处代码抢一个名字。
 */
export function registerChannel(name: string, build: (settings: Record<string, unknown>) => Channel): void {
  //G 同一个名字登记两次，多半是代码写错了，早点报出来。
  if (builders.has(name)) {
    throw new Error(`渠道 ${name} 已经登记过了`);
  }
  builders.set(name, build);
}


/**
 * 照 config.yaml 里开了的渠道，把对应的渠道建出来。
 * @param resources 资源。
 * @param names 要建的渠道名，目前由入口从 config.yaml 传进来。
 * @returns 建好的渠道，顺序和 names 一致；没开、没配的跳过。
 * @throws config.yaml 里开了某个渠道，但代码里没登记它时抛错，错误里带渠道名。
 * 副作用：调用每个渠道的建渠道函数（可能联网、建客户端）。
 */
export function buildChannels(resources: resourcesModule.Resources, names: string[]): Channel[] {
  /** 建好的渠道。 */
  const channels: Channel[] = [];
  //M Resources 还没有 listChannels()，先让入口把开了的渠道名传进来；等 Resources 加了 listChannels 再去掉这个参数。
  for (const name of names) {
    /** 这个渠道的设置。 */
    const settings = resources.getChannel(name);
    //G 配置里没有这个渠道，或者没写 enabled: true，就不建。
    if (settings === undefined || settings.enabled !== true) {
      continue;
    }
    /** 登记过的建渠道函数。 */
    const build = builders.get(name);
    //G 配置里开了、代码里却没登记：报清楚，不许悄悄跳过。
    if (build === undefined) {
      throw new Error(`config.yaml 里开了渠道 ${name}，但代码里没有登记它`);
    }
    channels.push(build(settings));
  }
  return channels;
}


/**
 * 清空登记表。
 * 只给测试用：每个用例开始前清一下，互不影响。正式代码里不要调。
 * 副作用：登记过的渠道全没了。
 */
export function clearChannels(): void {
  builders.clear();
}
