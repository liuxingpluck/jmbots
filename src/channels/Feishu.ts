/**
 * 飞书渠道（docs/10 6.14）：config.yaml 的 channels.feishu 是一个列表，一个应用一项、每项带 bot，一个应用建一个渠道（名字 feishu:<应用 ID>）。
 *   收：文字、图文、图片和附件（下载下来交给机器人循环，存进 message/，原话里写 @路径）
 *   发：文字；文字里的 @路径 一起发（图片发图片、别的发附件）
 *   审核卡片：同意执行 / 拒绝，点了交给待确认
 *   云文档：发、删（FeishuDoc.ts）
 *   发件箱：Claude 往运行时 integrations/feishu/outbox/ 放 .md，第一个开起来的飞书应用每 5 秒看一次，发给最近私聊的人，发完挪进 sent/
 * “最近私聊的人”记在 integrations/feishu/last_p2p_<应用 ID>.json，重启后照样知道发给谁。
 * 连接和收发照官方 SDK（FeishuSdk.ts），图片、附件、卡片走开放接口（FeishuMedia.ts）。
 */
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import * as channelModule from './Channel.ts';
import * as feishuDoc from './FeishuDoc.ts';
import * as media from './FeishuMedia.ts';
import * as feishuSdk from './FeishuSdk.ts';
import type * as approvalsModule from '../capabilities/Approvals.ts';
import * as progressModule from '../capabilities/Progress.ts';
import type * as depsModule from '../capabilities/Deps.ts';
import type * as filesModule from '../capabilities/Files.ts';


/** 飞书消息接收事件的必要字段。 */
export interface ReceiveEvent {
  /** 发送者。 */
  sender: { sender_id?: { open_id?: string } };
  /** 原始消息。 */
  message: {
    /** 消息 ID。 */
    message_id: string;
    /** 聊天 ID。 */
    chat_id: string;
    /** 聊天类型：p2p 单聊、group 群聊。 */
    chat_type: string;
    /** 消息类型。 */
    message_type: string;
    /** JSON 格式的消息内容。 */
    content: string;
    /** 被提及的成员占位符。 */
    mentions?: { key: string }[];
    /** 引用回复的那条消息的 ID。 */
    parent_id?: string;
  };
}


/** 消息里的资源，要用所属 message_id 下载。 */
export interface Resource {
  /** image_key 或 file_key。 */
  key: string;
  /** 图片还是文件。 */
  type: 'image' | 'file';
  /** 文件名。 */
  name: string;
  /** 资源属于哪条消息（合并转发、引用回复里的）；不写就是收到的这条。 */
  messageId?: string;
}


/** 开放接口取到的一条消息（合并转发时后面跟着它里面的每一条）。 */
export interface MessageItem {
  /** 消息 ID。 */
  message_id: string;
  /** 消息类型。 */
  msg_type: string;
  /** 发送时间，毫秒，写成字符串。 */
  create_time?: string;
  /** 合并转发里的消息：上一层那条的 ID。 */
  upper_message_id?: string;
  /** 内容。 */
  body?: { content?: string };
}


/** 换成本地格式的一条消息。 */
export interface FeishuMessage {
  /** 消息 ID（去重用）。 */
  messageId: string;
  /** 聊天 ID。 */
  chatId: string;
  /** 聊天类型。 */
  chatType: string;
  /** 发送者 open_id。 */
  openId: string;
  /** 消息类型。 */
  messageType: string;
  /** 取出来的文字。 */
  text: string;
  /** 图片、文件、语音、视频，以及图文里的资源。 */
  resources?: Resource[];
  /** 引用回复的那条消息的 ID。 */
  parentId?: string;
}


/** 发往聊天或用户。 */
export type FeishuTarget = { chatId: string } | { openId: string };


/** 发一条媒体或结构化消息要的东西。 */
export interface MediaRequest {
  /** image、file、audio、media，或 post、interactive。 */
  type: string;
  /** 本地文件路径（发文件类时用）。 */
  path?: string;
  /** 文件名；不写用路径里的名字。 */
  name?: string;
  /** 时长，毫秒（语音、视频）。 */
  duration?: number;
  /** 视频封面图路径。 */
  coverPath?: string;
  /** 结构化内容（富文本、卡片的 JSON）。 */
  content?: Record<string, unknown>;
}


/** 卡片按钮被点了。 */
export interface CardAction {
  /** 点按钮的人。 */
  openId: string;
  /** 卡片所在的消息 ID。 */
  messageId: string;
  /** 卡片所在的聊天 ID。 */
  chatId: string;
  /** 按钮上带的值（发卡片时写的）。 */
  value: Record<string, unknown>;
}


/** 传输层：连接、收发；测试可以换成替身。 */
export interface FeishuTransport {
  /** 连上并注册回调；第一次连不上时拒绝。 */
  listen(
    onEvent: (event: ReceiveEvent) => void,
    onCardAction?: (action: CardAction) => Promise<unknown>,
    onConnection?: (state: string, detail?: string) => void,
  ): Promise<void>;
  /** 发文字，返回消息 ID。 */
  sendText(to: FeishuTarget, text: string): Promise<string>;
  /** 回复（引用）一条消息，返回消息 ID。 */
  replyText?: (messageId: string, text: string) => Promise<string>;
  /** 发卡片，返回消息 ID。 */
  sendCard?: (to: FeishuTarget, card: Record<string, unknown>) => Promise<string>;
  /** 把发过的卡片换成新内容。 */
  updateCard?: (messageId: string, card: Record<string, unknown>) => Promise<void>;
  /** 上传素材并发消息。 */
  sendMedia?: (to: FeishuTarget, request: MediaRequest) => Promise<string>;
  /** 把消息里的资源下载到指定文件。 */
  downloadResource?: (messageId: string, resource: Resource, destination: string) => Promise<void>;
  /** 给一条消息加表情回应（如 Typing“敲键盘”），返回回应 ID。 */
  addReaction?: (messageId: string, emojiType: string) => Promise<string>;
  /** 撤掉一个表情回应。 */
  removeReaction?: (messageId: string, reactionId: string) => Promise<void>;
  /** 取一条消息的内容（合并转发时连它里面的每一条一起）。 */
  getMessageItems?: (messageId: string) => Promise<MessageItem[]>;
  /** 断开。 */
  close(): void;
}


/** 一张卡片。 */
export interface CardSpec {
  /** 标题。 */
  title: string;
  /** 标题栏颜色：blue、orange、grey、green、red…… */
  color: string;
  /** 正文，每段一个 Markdown。 */
  body: string[];
  /** 一排按钮。 */
  buttons?: { text: string; type?: 'primary' | 'danger' | 'default'; value: Record<string, unknown> }[];
  /** 最下面的灰色小字。 */
  note?: string;
}


/** 图片扩展名。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** 按飞书视频、语音消息发的扩展名（用户 11-06：“飞书应该也可以发视频的”）：mp4 发视频，聊天里能直接放；opus 发语音。 */
const MEDIA_EXTENSIONS: Record<string, 'media' | 'audio'> = { '.mp4': 'media', '.opus': 'audio' };

/** 没有专门写法的消息类型的中文名（后面跟原始内容）。 */
const TYPE_NAMES: Record<string, string> = {
  interactive: '卡片',
  hongbao: '红包',
  share_calendar_event: '日程',
  calendar: '日程邀请',
  general_calendar: '日程',
  system: '系统消息',
  video_chat: '视频会议',
  todo: '任务',
  vote: '投票',
};

/** 发件箱多久看一次，毫秒。 */
const OUTBOX_INTERVAL_MS = 5000;

/** 记住最近多少条消息 ID（去重）。 */
const SEEN_LIMIT = 500;

/** 发件箱只由第一个开起来的飞书应用管。 */
let outboxOwner: string | undefined;


/**
 * 把一条飞书消息的内容换成文字和要下载的资源。什么类型都不丢：认识的写成一句话，不认识的把原始内容写出来，模型和人都看得到。
 * @param messageType 消息类型。
 * @param raw 消息内容（JSON 字符串）。
 * @returns 文字和资源；纯图片消息的文字是空的（原话里只有 @路径）。
 */
function describeContent(messageType: string, raw: string): { text: string; resources: Resource[] } {
  /** 内容。 */
  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch {
    return { text: raw, resources: [] };
  }
  /** 第一层。 */
  const top = (content && typeof content === 'object' ? content : {}) as Record<string, unknown>;
  /** 资源。 */
  const resources: Resource[] = [];
  /**
   * 递归收资源。
   * @param value 某一层。
   */
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return;
    }
    /** 这一层。 */
    const item = value as Record<string, unknown>;
    if (typeof item.image_key === 'string') {
      resources.push({ key: item.image_key, type: 'image', name: 'image.png' });
    }
    if (typeof item.file_key === 'string') {
      /** 语音、视频的默认名。 */
      const names: Record<string, string> = { audio: 'audio.opus', media: 'video.mp4' };
      resources.push({ key: item.file_key, type: 'file', name: typeof item.file_name === 'string' ? item.file_name : (names[messageType] ?? 'attachment') });
    }
    for (const child of Object.values(item)) {
      if (typeof child === 'object') {
        collect(child);
      }
    }
  };
  //M 这几种的资源才下载得了（表情包、卡片里的飞书不让下载）。
  if (['post', 'image', 'file', 'audio', 'media'].includes(messageType)) {
    collect(content);
  }
  /**
   * 第一层的一个字段写成文字。
   * @param key 字段名。
   */
  const field = (key: string): string => (typeof top[key] === 'string' || typeof top[key] === 'number' ? String(top[key]) : '');
  /** 时长（毫秒）写成“N 秒”。 */
  const duration = typeof top.duration === 'number' ? ` ${Math.round(top.duration / 1000)} 秒` : '';
  /** 文字。 */
  let text: string;
  if (messageType === 'text') {
    text = typeof top.text === 'string' ? top.text : '';
  } else if (messageType === 'post') {
    text = typeof top.text === 'string' ? top.text : feishuSdk.postText(raw);
  } else if (messageType === 'image') {
    text = '';
  } else if (messageType === 'file') {
    text = `[文件] ${field('file_name')}`;
  } else if (messageType === 'audio') {
    text = `[语音${duration}]`;
  } else if (messageType === 'media') {
    text = `[视频${duration}] ${field('file_name')}`;
  } else if (messageType === 'sticker') {
    text = '[表情包]';
  } else if (messageType === 'location') {
    text = `[位置] ${field('name')}（经度 ${field('longitude')}，纬度 ${field('latitude')}）`;
  } else if (messageType === 'share_chat') {
    text = `[群名片] ${field('chat_id')}`;
  } else if (messageType === 'share_user') {
    text = `[个人名片] ${field('user_id')}`;
  } else if (messageType === 'merge_forward') {
    text = '[合并转发]';
  } else {
    text = `[${TYPE_NAMES[messageType] ?? messageType}]\n${utils.truncate(JSON.stringify(content, null, 2), 4000)}`;
  }
  return { text: text.trim(), resources: resources.filter((resource, index) => resources.findIndex((item) => item.key === resource.key) === index) };
}


/**
 * 把飞书事件换成本地格式。
 * @param event 飞书事件。
 * @returns 本地格式的消息。
 */
export function toMessage(event: ReceiveEvent): FeishuMessage {
  /** 文字和资源。 */
  const { text, resources } = describeContent(event.message.message_type, event.message.content);
  /** 文字，去掉 @ 的占位符。 */
  let body = text;
  for (const mention of event.message.mentions ?? []) {
    if (mention.key) {
      body = body.replaceAll(mention.key, '');
    }
  }
  return {
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    chatType: event.message.chat_type,
    openId: event.sender.sender_id?.open_id ?? '',
    messageType: event.message.message_type,
    text: body.trim(),
    ...(resources.length ? { resources } : {}),
    ...(event.message.parent_id ? { parentId: event.message.parent_id } : {}),
  };
}


/**
 * 用官方 SDK 的传输层：收消息、发文字走 FeishuSdk（长连接、lark.Client），卡片、表情、取消息走开放接口（FeishuOpenApi）；
 * 媒体那一半（sendMedia、downloadResource）继承自 FeishuMedia.ts 的 MediaTransport。只在 listen、发消息时才联网。
 * 建它的地方：FeishuChannel 的构造函数（没给传输层时）。
 */
export class SdkTransport extends media.MediaTransport implements FeishuTransport {
  /** SDK 客户端：收消息（长连接）、发文字、回复。 */
  private readonly client: feishuSdk.FeishuSdk;

  /**
   * @param appId 应用 ID。
   * @param appSecret 应用密钥。
   * @param bot 对应的机器人。
   */
  constructor(appId: string, appSecret: string, bot: string) {
    super(new media.FeishuOpenApi(appId, appSecret));
    this.client = new feishuSdk.FeishuSdk({ enabled: true, app_id: appId, app_secret: appSecret, bot });
  }

  /**
   * 发卡片。
   * @param to 发给谁。
   * @param card 卡片 JSON（buildCard 拼的）。
   * @returns 消息 ID；飞书没给时是空字符串。
   */
  async sendCard(to: FeishuTarget, card: Record<string, unknown>): Promise<string> {
    /** 按聊天发还是按 open_id 发。 */
    const target = 'chatId' in to ? { id: to.chatId, type: 'chat_id' } : { id: to.openId, type: 'open_id' };
    /** 返回的数据。 */
    const data = await this.api.json('POST', `/im/v1/messages?receive_id_type=${target.type}`, {
      receive_id: target.id,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });
    return typeof data.message_id === 'string' ? data.message_id : '';
  }

  /**
   * 把发过的卡片换成新内容。
   * @param messageId 卡片的消息 ID。
   * @param card 新的卡片 JSON。
   */
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.api.json('PATCH', `/im/v1/messages/${messageId}`, { content: JSON.stringify(card) });
  }

  /**
   * 给一条消息加表情回应（如 Typing“敲键盘”）。
   * @param messageId 消息 ID。
   * @param emojiType 表情种类。
   * @returns 回应 ID；飞书没给时是空字符串。
   */
  async addReaction(messageId: string, emojiType: string): Promise<string> {
    /** 返回的数据。 */
    const data = await this.api.json('POST', `/im/v1/messages/${messageId}/reactions`, { reaction_type: { emoji_type: emojiType } });
    return typeof data.reaction_id === 'string' ? data.reaction_id : '';
  }

  /**
   * 撤掉一个表情回应。
   * @param messageId 消息 ID。
   * @param reactionId 回应 ID。
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.api.json('DELETE', `/im/v1/messages/${messageId}/reactions/${reactionId}`);
  }

  /**
   * 取一条消息的内容（合并转发时连它里面的每一条一起）。
   * @param messageId 消息 ID。
   * @returns 消息们。
   */
  async getMessageItems(messageId: string): Promise<MessageItem[]> {
    /** 返回的数据。 */
    const data = await this.api.json('GET', `/im/v1/messages/${messageId}`);
    return Array.isArray(data.items) ? (data.items as MessageItem[]) : [];
  }

  /**
   * 连上长连接、注册回调：收到消息换成事件的样子交给 onEvent；卡片回调取出点的人、消息、聊天和按钮的值。
   * @param onEvent 收到一条消息。
   * @param onCardAction 卡片按钮被点了。
   * @param onConnection 长连接状态变了。
   * @returns 第一次连上后返回。
   */
  listen(
    onEvent: (event: ReceiveEvent) => void,
    onCardAction?: (action: CardAction) => Promise<unknown>,
    onConnection?: (state: string, detail?: string) => void,
  ): Promise<void> {
    /** 卡片回调：字段在 context 里或在外面，两种都认。 */
    const cardHandler = onCardAction
      ? (data: unknown) => {
          /** 回调内容。 */
          const raw = (data ?? {}) as {
            /** 新版回调的操作者。 */
            operator?: {
              /** 飞书用户标识。 */
              open_id?: string;
            };
            /** 旧版回调的操作者标识。 */
            open_id?: string;
            /** 旧版回调的消息标识。 */
            open_message_id?: string;
            /** 旧版回调的聊天标识。 */
            open_chat_id?: string;
            /** 新版回调的消息上下文。 */
            context?: {
              /** 卡片消息标识。 */
              open_message_id?: string;
              /** 卡片所在聊天标识。 */
              open_chat_id?: string;
            };
            /** 用户点击的按钮。 */
            action?: {
              /** 按钮携带的对象或 JSON 字符串。 */
              value?: unknown;
            };
          };
          /** 按钮的值；有的版本是 JSON 字符串。 */
          let value = raw.action?.value;
          if (typeof value === 'string') {
            value = JSON.parse(value) as unknown;
          }
          /** 统一后的卡片动作交给 FeishuChannel.onCardAction。 */
          const action: CardAction = {
            openId: raw.operator?.open_id ?? raw.open_id ?? '',
            messageId: raw.context?.open_message_id ?? raw.open_message_id ?? '',
            chatId: raw.context?.open_chat_id ?? raw.open_chat_id ?? '',
            value: (value && typeof value === 'object' ? value : {}) as Record<string, unknown>,
          };
          return onCardAction(action);
        }
      : undefined;
    return this.client.listen(
      (message) => {
        /** SDK 事件转回渠道统一的消息格式。 */
        const content = message.rawContent ?? JSON.stringify({ text: message.text });
        const event = {
          sender: { sender_id: { open_id: message.openId } },
          message: {
            message_id: message.messageId,
            chat_id: message.chatId,
            chat_type: message.chatType,
            message_type: message.messageType,
            content,
            ...(message.parentId ? { parent_id: message.parentId } : {}),
          },
        };

        onEvent(event);
        return Promise.resolve();
      },
      cardHandler,
      onConnection,
    );
  }

  /**
   * 发文字。
   * @param to 发给谁。
   * @param text 文字。
   * @returns 消息 ID。
   */
  sendText(to: FeishuTarget, text: string): Promise<string> {
    return this.client.sendText(to, text);
  }

  /**
   * 回复（引用）一条消息。
   * @param messageId 被回复的那条。
   * @param text 文字。
   * @returns 新消息的 ID。
   */
  replyText(messageId: string, text: string): Promise<string> {
    return this.client.replyText(messageId, text);
  }

  /** 断开长连接。 */
  close(): void {
    this.client.close();
  }
}


/**
 * 拼飞书卡片（interactive）。
 * @param spec 标题、颜色、正文、按钮、脚注。
 * @returns 卡片 JSON。
 */
export function buildCard(spec: CardSpec): Record<string, unknown> {
  /** 元素。 */
  const elements: Record<string, unknown>[] = spec.body.map((content) => ({ tag: 'markdown', content }));
  if (spec.buttons?.length) {
    /** 每个按钮独立组装，方便核对回传的 value。 */
    const actions = spec.buttons.map((button) => ({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: button.text,
      },
      type: button.type ?? 'default',
      value: button.value,
    }));
    elements.push({
      tag: 'action',
      actions,
    });
  }
  if (spec.note) {
    elements.push({
      tag: 'note',
      elements: [{
        tag: 'plain_text',
        content: spec.note,
      }],
    });
  }
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: spec.color,
      title: {
        tag: 'plain_text',
        content: spec.title,
      },
    },
    elements,
  };
}


/**
 * 审核卡片：命令、目录、做什么、风险、建议，两个按钮；决定过以后换成不带按钮、写明结果的样子。
 * @param pending 待确认。
 * @param result 结果说明；还没决定时不写。
 */
function approvalCard(
  pending: approvalsModule.PendingApproval,
  result?: string,
): Record<string, unknown> {
  /** 正文。 */
  const body = [
    `**${pending.title ? '内容' : '命令'}**\n\`\`\`\n${utils.truncate(pending.command, 1500)}\n\`\`\``,
    ...(pending.workDir ? [`**目录** ${pending.workDir}`] : []),
    `**它做什么** ${pending.review.what}`,
    `**风险** ${pending.review.risk}`,
    `**建议** ${pending.review.advice}`,
    ...(pending.sessionId ? [`**机器人 / 会话** ${pending.bot} / ${pending.sessionId}`] : []),
  ];
  /** 标题。 */
  const title = `待确认 #${pending.id}：${pending.title ?? '要执行一条命令'}`;
  if (result) {
    const spec: CardSpec = {
      title,
      color: 'grey',
      body: [...body, `**结果** ${result}`],
    };

    return buildCard(spec);
  }
  const spec: CardSpec = {
    title,
    color: 'orange',
    body,
    buttons: [
      {
        text: '同意执行',
        type: 'primary',
        value: {
          kind: 'approval',
          approval_id: pending.id,
          approve: true,
        },
      },
      {
        text: '拒绝',
        type: 'danger',
        value: {
          kind: 'approval',
          approval_id: pending.id,
          approve: false,
        },
      },
    ],
    note: `点按钮，或者直接回“同意 ${pending.id}”“拒绝 ${pending.id}”。说“再发一次审核卡片”能再看一遍。`,
  };

  return buildCard(spec);
}


/**
 * 进度卡片：那句话、现在在做什么、用了多久；结束后写结果和各段耗时。还在做时有限时和终止按钮（用户 11-06 拍板）。
 * @param view 卡片看到的东西。
 */
function progressCard(view: progressModule.ProgressView): Record<string, unknown> {
  /** 阶段 → 图标和颜色。 */
  const looks: Record<progressModule.ProgressStage, [string, string]> = {
    dispatching: ['⏳', 'blue'],
    held: ['⏸', 'orange'],
    running: ['⏳', 'blue'],
    merged: ['↪', 'grey'],
    done: ['✅', 'green'],
    error: ['⚠', 'red'],
    interrupted: ['⛔', 'grey'],
    limit: ['⚠', 'orange'],
    timeout: ['⏱', 'orange'],
    stopped: ['⛔', 'grey'],
    flagged: ['⚠', 'red'],
    handed: ['↪', 'blue'],
  };
  /** 图标和颜色。 */
  const [icon, color] = looks[view.stage];
  /** 结束了没有。 */
  const ended = view.endedAt !== undefined;
  /** 正文。 */
  /** 限时那一段：最多几分钟、延长过几次；不限时就不写。 */
  let limit = '';
  if (view.limitMinutes) {
    limit = ` · 限时 ${view.limitMinutes} 分钟`;
    if (view.extended) {
      limit += `（延长过 ${view.extended} 次）`;
    }
  }
  const body = [
    `**${icon} ${view.action}** · ${progressModule.formatDuration((view.endedAt ?? Date.now()) - view.startedAt)}${limit}`,
    ...(view.sessionTitle ? [`会话：${view.sessionTitle}${view.model ? `（${view.model}）` : ''}`] : []),
    ...(view.result ? [`**结果** ${view.result}`] : []),
    ...(ended || view.timings.steps > 0 ? [`**耗时** ${progressModule.describeTimings(view)}`] : []),
  ];
  /** 标题。 */
  const title = `${view.bot}：${view.text}`;
  if (ended) {
    return buildCard({ title, color, body });
  }
  return buildCard({
    title,
    color,
    body,
    buttons: [
      ...progressModule.LIMIT_CHOICES.map((minutes) => ({
        text: `最多 ${minutes} 分钟`,
        type: 'default' as const,
        value: {
          kind: 'progress',
          card_id: view.id,
          action: 'limit',
          minutes,
        },
      })),
      {
        text: '不限时',
        type: 'default' as const,
        value: {
          kind: 'progress',
          card_id: view.id,
          action: 'limit',
          minutes: 0,
        },
      },
      {
        text: '终止',
        type: 'danger' as const,
        value: {
          kind: 'progress',
          card_id: view.id,
          action: 'stop',
        },
      },
    ],
  });
}


/**
 * 一个飞书应用的渠道：长连接收消息和卡片按钮，发文字、文件、审核卡片、进度卡片、云文档；第一个开起来的应用顺带看发件箱。
 * 建它的地方：渠道登记表（文件末尾 registerChannel），由 src/channels/index.ts 的 ChannelHub 按配置建；测试也经 createFeishuChannel 走同一配置入口。
 * 状态都是字段（连接状态、最近私聊的人、收过的消息、发过的卡片），调试时点开 this 就看得到。
 */
export class FeishuChannel implements channelModule.Channel {
  /** 渠道名：feishu:<应用 ID>。 */
  readonly name: string;
  /** 对应的机器人。 */
  readonly bot: string;
  /** 应用 ID。 */
  private readonly appId: string;
  /** 应用密钥。 */
  private readonly appSecret: string;
  /** 传输层：官方 SDK（SdkTransport），测试换成假的。 */
  private readonly link: FeishuTransport;
  /** 长连接现在的状态（界面左下角的小圆点用）。 */
  private connection = { state: '还没连', at: Date.now() };
  /** 云文档（只在用到时建）。 */
  private publisher: feishuDoc.DocPublisher | undefined;
  /** 最近私聊的人记在哪：integrations/feishu/last_p2p_<应用 ID>.json，重启后照样知道发给谁。 */
  private readonly lastFile: string;
  /** 最近私聊的聊天。 */
  private lastPrivate: { chatId: string; openId: string } | undefined;
  /** 收过的消息 ID（去重，最多记 SEEN_LIMIT 条）。 */
  private readonly seen: string[] = [];
  /** 待确认号 → 卡片的消息 ID（决定后更新卡片）。 */
  private readonly cards = new Map<number, string[]>();

  /**
   * @param settings 入口已经校验的 app_id、app_secret、bot。
   * @param parts 渠道要用的对象（src/channels/Channel.ts 的 ChannelParts，入口 src/entries/App.ts 建的）：
   *   resources 找运行时目录，approvals 处理审核卡片的按钮，progress 处理进度卡片的按钮。
   * @param transport 传输层；不给就用官方 SDK（测试可以换）。
   * 副作用：读最近私聊的人；登记“待确认决定了就更新卡片”。
   */
  constructor(
    settings: checks.FeishuSettings,
    private readonly parts: channelModule.ChannelParts,
    transport?: FeishuTransport,
  ) {
    this.appId = settings.app_id;
    this.appSecret = settings.app_secret;
    this.bot = settings.bot;
    this.name = `feishu:${this.appId}`;
    this.link = transport ?? new SdkTransport(this.appId, this.appSecret, this.bot);
    this.lastFile = path.join(parts.resources.dir, 'integrations', 'feishu', `last_p2p_${this.appId}.json`);
    try {
      this.lastPrivate = JSON.parse(fsSync.readFileSync(this.lastFile, 'utf8')) as { chatId: string; openId: string };
    } catch {
      //G 还没人私聊过：发的时候再说。
      this.lastPrivate = undefined;
    }
    //M 不管在哪决定的（这张卡片、网页、打字），发出去的卡片都换成写明结果的样子。
    parts.approvals.onDecided((pending, decision) => {
      /** 这条待确认发过的卡片（可能再发过几次）。 */
      const sent = this.cards.get(pending.id) ?? [];
      this.cards.delete(pending.id);
      /** 结果。 */
      const result = `${decision.approve ? '已同意执行' : '已拒绝'}（${decision.by.split(' ')[0] ?? ''}，${utils.formatTime()}）`;
      for (const messageId of sent) {
        void this.link.updateCard?.(messageId, approvalCard(pending, result)).catch(() => undefined);
      }
    });
  }

  /** 连着没有（界面左下角的小圆点用）。 */
  status(): { connected: boolean; detail: string } {
    return {
      connected: this.connection.state === '已连上' || this.connection.state === '已重连',
      detail: `${this.connection.state}（${utils.formatTime(this.connection.at)}）`,
    };
  }

  /**
   * 连上飞书，开始收消息和卡片按钮；第一个开起来的应用顺带看发件箱。
   * @param receive 机器人循环.receive（src/bots/BotLoop.ts）。
   * @returns 停下的函数。
   */
  async start(receive: Parameters<channelModule.Channel['start']>[0]): Promise<() => Promise<void>> {
    await this.link.listen(
      (event) => {
        void this.onMessage(event, receive).catch((error: unknown) => {
          console.error(`${utils.formatTime()} 飞书 ${this.appId}：处理消息出错：${utils.errorText(error)}`);
        });
      },
      (action) => this.onCardAction(action),
      (state, detail) => {
        this.connection = { state: `${state}${detail ? ` ${detail}` : ''}`, at: Date.now() };
        console.log(`${utils.formatTime()} 飞书 ${this.appId}（${this.bot}）：${this.connection.state}`);
      },
    );
    this.connection = { state: '已连上', at: Date.now() };
    console.log(`${utils.formatTime()} 飞书 ${this.appId} 已连上，对应机器人 ${this.bot}`);
    /** 停发件箱。 */
    let stopOutbox: (() => void) | undefined;
    if (outboxOwner === undefined) {
      outboxOwner = this.name;
      stopOutbox = this.watchOutbox();
    }
    return () => {
      stopOutbox?.();
      if (outboxOwner === this.name) {
        outboxOwner = undefined;
      }
      this.link.close();
      return Promise.resolve();
    };
  }

  /**
   * 发文字和 @路径：文字里的 @路径 换成文件名，文字发完再一个个发文件（图片发图片、mp4 发视频、opus 发语音、别的发附件；视频、语音发不成退回发附件）。
   * @param address 回复地址。
   * @param text 文字。
   */
  async send(address: Record<string, unknown>, text: string): Promise<void> {
    /** 发给谁。 */
    const target = this.targetOf(address);
    /** 文字里的 @路径（存在的绝对路径才算）。 */
    const files: { token: string; file: string }[] = [];
    for (const match of text.matchAll(/@"([^"]+)"|@([^\s"]+)/g)) {
      /** 路径。 */
      const file = match[1] ?? match[2] ?? '';
      if (path.isAbsolute(file) && fsSync.existsSync(file) && fsSync.statSync(file).isFile()) {
        files.push({ token: match[0], file });
      }
    }
    /** 发出去的文字。 */
    let body = text;
    for (const item of files) {
      body = body.replace(item.token, `「${path.basename(item.file)}」`);
    }
    if (body.trim()) {
      //M 地址里写了 quote：回复用户那条消息（引用着它），用户一看就知道说的是哪句。
      if (address.quote === true && typeof address.messageId === 'string' && this.link.replyText) {
        await this.link.replyText(address.messageId, body);
      } else {
        await this.link.sendText(target, body);
      }
    }
    for (const item of files) {
      /** 扩展名。 */
      const ext = path.extname(item.file).toLowerCase();
      /** 视频、语音的消息种类；不是这两种就是 undefined。 */
      const media = MEDIA_EXTENSIONS[ext];
      if (!media) {
        await this.link.sendMedia?.(target, { type: IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file', path: item.file });
        continue;
      }
      try {
        await this.link.sendMedia?.(target, { type: media, path: item.file });
      } catch (error) {
        //G 视频、语音消息发不成（飞书不认这个编码之类），退回按附件发，文件总要送到；附件也发不成照旧报错。原因记进日志，别悄悄退回。
        console.error(`${utils.formatTime()} 飞书：${path.basename(item.file)} 按${media === 'media' ? '视频' : '语音'}消息没发成，改按附件发：${utils.errorText(error)}`);
        await this.link.sendMedia?.(target, { type: 'file', path: item.file });
      }
    }
  }

  /**
   * 撤掉这条消息上的“正在输入”（收消息时挂的敲键盘表情）。
   * @param address 回复地址（里面记着 typingReaction）。
   */
  async stopTyping(address: Record<string, unknown>): Promise<void> {
    if (typeof address.messageId === 'string' && typeof address.typingReaction === 'string') {
      await this.link.removeReaction?.(address.messageId, address.typingReaction);
    }
  }

  /**
   * 发审核卡片，记下卡片的消息 ID（决定后更新它）。
   * @param address 回复地址。
   * @param pending 待确认。
   * @returns 发出去了没有（传输层发不了卡片时是 false）。
   */
  async sendApproval(address: Record<string, unknown>, pending: approvalsModule.PendingApproval): Promise<boolean> {
    if (!this.link.sendCard) {
      return false;
    }
    /** 卡片的消息 ID。 */
    const messageId = await this.link.sendCard(this.targetOf(address), approvalCard(pending));
    this.cards.set(pending.id, [...(this.cards.get(pending.id) ?? []), messageId]);
    return true;
  }

  /**
   * 发进度卡片。
   * @param address 回复地址。
   * @param view 卡片上画什么。
   * @returns 卡片的消息 ID；发不了卡片时是空字符串。
   */
  async sendProgress(address: Record<string, unknown>, view: progressModule.ProgressView): Promise<string> {
    if (!this.link.sendCard) {
      return '';
    }
    return this.link.sendCard(this.targetOf(address), progressCard(view));
  }

  /**
   * 原地改进度卡片。
   * @param handle 卡片的消息 ID。
   * @param view 卡片上画什么。
   */
  async updateProgress(handle: string, view: progressModule.ProgressView): Promise<void> {
    await this.link.updateCard?.(handle, progressCard(view));
  }

  /**
   * 发飞书云文档，编辑权限给聊天里的用户。
   * @param address 回复地址。
   * @param request 标题、Markdown 正文、图片。
   * @returns 链接说明。
   * @throws 找不到聊天时抛错。
   */
  async publishDoc(address: Record<string, unknown>, request: depsModule.DocRequest): Promise<string> {
    /** 聊天。 */
    const target = this.targetOf(address);
    if (!('chatId' in target)) {
      throw new Error('找不到聊天');
    }
    /** 文档正文和目标发布器。 */
    const publishArgs = {
      title: request.title,
      markdown: request.markdown,
      images: request.images,
    };
    const publisher = this.docPublisher();

    /** 发布结果。 */
    const result = await publisher.publish(publishArgs, target.chatId);
    /** 权限说明。 */
    const permission = result.grantedTo ? '可编辑权限已给聊天里的用户' : (result.note ?? '');
    return `已发布飞书文档《${request.title}》：${result.url}${permission ? `（${permission}）` : ''}`;
  }

  /**
   * 把机器人自己发的云文档放进回收站。
   * @param ids 文档 ID。
   * @returns 结果说明。
   */
  async deleteDoc(ids: string[]): Promise<string> {
    return feishuDoc.removeDocs(this.docPublisher(), ids);
  }

  /** 云文档的发布器：第一次用到时才建。 */
  private docPublisher(): feishuDoc.DocPublisher {
    this.publisher ??= new feishuDoc.FeishuDocPublisher(new media.FeishuOpenApi(this.appId, this.appSecret));
    return this.publisher;
  }

  /**
   * 发给谁：地址里有聊天就发那个聊天，没有就发给最近私聊的人。
   * @param address 回复地址。
   * @throws 都没有时抛错。
   */
  private targetOf(address: Record<string, unknown>): FeishuTarget {
    if (typeof address.chatId === 'string' && address.chatId) {
      return { chatId: address.chatId };
    }
    if (this.lastPrivate) {
      return { chatId: this.lastPrivate.chatId };
    }
    throw new Error(`飞书应用 ${this.appId} 还没有人私聊过，不知道发给谁`);
  }

  /**
   * 取事件里没有的内容：引用回复的那条、合并转发里的每一条。取不到就写明原因，不挡这条消息。
   * @param message 收到的消息。
   * @returns 引用的文字、合并转发的文字、它们带的资源。
   */
  private async fetchRelated(message: FeishuMessage): Promise<{
    /** 引用消息的文字。 */
    quote: string;
    /** 合并转发的文字。 */
    forwarded: string;
    /** 引用和转发中附带的资源。 */
    resources: Resource[];
  }> {
    /** 结果。 */
    const related = { quote: '', forwarded: '', resources: [] as Resource[] };
    /**
     * 换成文字，顺手把资源记下来。
     * @param item 一条消息。
     * @returns 文字；纯图片写成 [图片]。
     */
    const read = (item: MessageItem): string => {
      /** 文字和资源。 */
      const described = describeContent(item.msg_type, item.body?.content ?? '{}');
      related.resources.push(...described.resources.map((resource) => ({ ...resource, messageId: item.message_id })));
      return described.text || '[图片]';
    };
    if (!this.link.getMessageItems) {
      return related;
    }
    if (message.parentId) {
      try {
        /** 被引用的那条。 */
        const [item] = await this.link.getMessageItems(message.parentId);
        related.quote = item ? `[引用] ${read(item)}` : '';
      } catch (error) {
        related.quote = `[引用的消息没取到：${utils.errorText(error)}]`;
      }
    }
    if (message.messageType === 'merge_forward') {
      try {
        /** 合并转发里的每一条（第一条是合并转发本身）。 */
        const messages = await this.link.getMessageItems(message.messageId);
        const items = messages.filter((item) => item.upper_message_id);
        const lines = items.map((item, index) => {
          const timestamp = Number(item.create_time);
          const time = item.create_time ? `${utils.formatTime(timestamp)} ` : '';
          const text = read(item);
          return `${index + 1}. ${time}${text}`;
        });
        related.forwarded = lines.join('\n');
      } catch (error) {
        related.forwarded = `[合并转发的内容没取到：${utils.errorText(error)}]`;
      }
    }
    return related;
  }

  /**
   * 收消息：去重、记下最近私聊、下载图片和附件，交给机器人循环。
   * @param event 飞书事件。
   * @param receive src/bots/BotLoop.ts 的 BotLoop.receive，由渠道启动入口传入。
   */
  private async onMessage(
    event: ReceiveEvent,
    receive: Parameters<channelModule.Channel['start']>[0],
  ): Promise<void> {
    /** 本地格式。 */
    const message = toMessage(event);
    if (this.seen.includes(message.messageId)) {
      return;
    }
    this.seen.push(message.messageId);
    if (this.seen.length > SEEN_LIMIT) {
      this.seen.shift();
    }
    if (message.chatType === 'p2p' && message.openId) {
      this.lastPrivate = { chatId: message.chatId, openId: message.openId };
      await fs.mkdir(path.dirname(this.lastFile), { recursive: true });
      await fs.writeFile(this.lastFile, JSON.stringify(this.lastPrivate));
    }
    //M 用户那条消息上先挂“敲键盘”，这次运行结束时撤（回应 ID 记在回复地址里，重启后也撤得掉）。挂不上不挡正事。
    /** 表情回应的 ID。 */
    const typingReaction = await this.link.addReaction?.(message.messageId, 'Typing').catch((error: unknown) => {
      console.error(`${utils.formatTime()} 飞书 ${this.appId}：“正在输入”没挂上：${utils.errorText(error)}`);
      return undefined;
    });
    /** 引用的那条、合并转发里的每一条。 */
    const related = await this.fetchRelated(message);
    //M 下载图片和附件：先放 data/tmp（不放 C 盘），读出来交给文件库存进这条消息的文件夹。没下载下来的写进原话，不悄悄丢。
    /** 附件。 */
    const images: filesModule.IncomingImage[] = [];
    /** 没下载下来的说明。 */
    const notes: string[] = [];
    for (const resource of [...related.resources, ...(message.resources ?? [])]) {
      if (!this.link.downloadResource) {
        notes.push(`[${resource.name} 没下载：这个渠道下载不了附件]`);
        continue;
      }
      /** 临时文件。 */
      const temp = path.join(this.parts.resources.dir, 'data', 'tmp', `${message.messageId}_${resource.key.slice(-12)}`);
      await fs.mkdir(path.dirname(temp), { recursive: true });
      try {
        await this.link.downloadResource(resource.messageId ?? message.messageId, resource, temp);
        images.push({ name: resource.name, data: await fs.readFile(temp) });
      } catch (error) {
        console.error(`${utils.formatTime()} 飞书 ${this.appId}：附件 ${resource.name} 没下载下来：${utils.errorText(error)}`);
        notes.push(`[${resource.name} 没下载下来：${utils.errorText(error)}]`);
      } finally {
        await fs.rm(temp, { force: true });
      }
    }
    /** 原话。 */
    const text = [related.quote, message.text, related.forwarded, ...notes].filter(Boolean).join('\n') || (images.length > 0 ? '' : '[空消息]');
    /** 回复地址：聊天、这条消息、谁发的；挂上了“正在输入”就把回应 ID 也记上。 */
    const address = {
      chatId: message.chatId,
      messageId: message.messageId,
      openId: message.openId,
      chatType: message.chatType,
      ...(typingReaction ? { typingReaction } : {}),
    };
    /** 交给收件入口的完整参数。 */
    const receiveArgs = {
      bot: this.bot,
      channel: this.name,
      source: `${this.appId}|${message.chatId}|${message.openId}`,
      address,
      text,
      images,
    };

    await receive(receiveArgs);
  }

  /**
   * 卡片上点了按钮：进度卡片交给进度登记表，审核卡片交给待确认。
   * @param action 点了什么。
   * @returns 给飞书的回应（toast）。
   */
  private onCardAction(action: CardAction): Promise<unknown> {
    if (action.value.kind === 'progress' && this.parts.progress) {
      /** 飞书按钮中的进度操作参数。 */
      const cardId = Number(action.value.card_id);
      const operation = action.value.action === 'stop' ? 'stop' : 'limit';
      const minutes = Number(action.value.minutes) || undefined;

      /** 回给用户的话。 */
      const text = this.parts.progress.act(cardId, operation, minutes);
      return Promise.resolve({ toast: { type: 'info', content: text } });
    }
    if (action.value.kind !== 'approval') {
      return Promise.resolve({ toast: { type: 'info', content: '这个按钮没有用了' } });
    }
    /** 号。 */
    const id = Number(action.value.approval_id);
    /** 同意吗。 */
    const approve = action.value.approve === true;
    //G 卡片更新交给构造函数里登记的 onDecided：网页、文字先决定时也要更新。
    if (!this.parts.approvals.decide(id, approve, `飞书卡片 ${action.openId}`)) {
      return Promise.resolve({ toast: { type: 'info', content: `待确认 #${id} 已经处理过了，或者程序重启后失效了` } });
    }
    return Promise.resolve({ toast: { type: 'success', content: approve ? '已同意执行' : '已拒绝' } });
  }

  /**
   * 发件箱：每 5 秒看一次 integrations/feishu/outbox/，把 .md 发给最近私聊的人，发完挪进 sent/；发不出去的留着下一轮再试。
   * @returns 停下的函数。
   */
  private watchOutbox(): () => void {
    /** 发件箱。 */
    const dir = path.join(this.parts.resources.dir, 'integrations', 'feishu', 'outbox');
    /** 发过的。 */
    const sentDir = path.join(this.parts.resources.dir, 'integrations', 'feishu', 'sent');
    /** 上一轮还没做完。 */
    let busy = false;
    /** 定时器。 */
    const timer = setInterval(() => {
      if (busy) {
        return;
      }
      busy = true;
      void (async () => {
        try {
          await fs.mkdir(sentDir, { recursive: true });
          /** 按文件名顺序发送现有 Markdown 消息。 */
          const entries = await fs.readdir(dir).catch(() => [] as string[]);
          const files = entries.filter((item) => item.endsWith('.md')).sort();
          for (const file of files) {
            /** 内容。 */
            const text = (await fs.readFile(path.join(dir, file), 'utf8')).trim();
            if (text) {
              await this.send({}, text);
            }
            await fs.rename(path.join(dir, file), path.join(sentDir, file));
            console.log(`${utils.formatTime()} 飞书发件箱：已发出 ${file}`);
          }
        } catch (error) {
          console.error(`${utils.formatTime()} 飞书发件箱：发送失败，下一轮再试：${utils.errorText(error)}`);
        } finally {
          busy = false;
        }
      })();
    }, OUTBOX_INTERVAL_MS);
    return () => clearInterval(timer);
  }
}


/**
 * 独立创建飞书渠道的外部入口，测试替换传输层时也使用此函数。
 * @param settings 原始配置。
 * @param parts 已准备好的渠道依赖。
 * @param transport 测试传输层；省略时使用官方 SDK。
 * @returns 已创建但未连接的渠道。
 */
export function createFeishuChannel(
  settings: Record<string, unknown>,
  parts: channelModule.ChannelParts,
  transport?: FeishuTransport,
): FeishuChannel {
  /** 通用字段与启用状态在渠道入口检查一次。 */
  const channelSettings = channelModule.readChannelSettings('feishu', settings, parts);
  /** 飞书专有字段在供应商入口检查一次。 */
  const feishuSettings = checks.readFeishuSettings(channelSettings);
  return new FeishuChannel(feishuSettings, parts, transport);
}


channelModule.registerChannel('feishu', (settings, parts) => {
  /** 通用渠道入口已检查 bot，这里只读取飞书专有字段。 */
  const feishuSettings = checks.readFeishuSettings(settings);
  return new FeishuChannel(feishuSettings, parts);
});
