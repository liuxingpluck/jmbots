/**
 * 飞书渠道：用飞书官方 SDK（@larksuiteoapi/node-sdk）的长连接收消息，不需要公网地址；用开放接口发消息。
 *
 * 飞书开放平台那边要先做好（每个机器人一次）：开“机器人”能力；权限加 im:message（发消息）、
 * im:message.p2p_msg:readonly（收私聊）、im:message.group_at_msg:readonly（收群里 @ 它的消息）；
 * 事件订阅选“使用长连接接收事件”，加事件 im.message.receive_v1；然后发布版本。
 *
 * 飞书要求 3 秒内确认收到事件，否则会重推。所以收到消息后先确认、再在后台处理，并按消息 ID 去重。
 */
import * as lark from '@larksuiteoapi/node-sdk';


/** 飞书渠道的设置（config.yaml 的 channels.feishu）。 */
export interface FeishuConfig {
  /** 开不开这个渠道。 */
  enabled: boolean;

  /** 飞书应用的 App ID。 */
  app_id: string;

  /** 飞书应用的 App Secret。 */
  app_secret: string;

  /** 这个渠道的消息交给哪个 bot。 */
  bot: string;

  /** DSH 会话 ID：周小灵调用 ask_dsh 时把任务转给这个会话；不写就只返回未配置提示。 */
  dsh_session?: string;
}


/** 收到的一条飞书消息，换成 zbots 自己的格式。 */
export interface FeishuMessage {
  /** 消息 ID，回复和去重用。 */
  messageId: string;

  /** 会话 ID：私聊、群聊都有；往这个会话发消息用它。 */
  chatId: string;

  /** p2p 是私聊，group 是群聊。 */
  chatType: string;

  /** 发消息的人在这个飞书应用下的 open_id（不同应用的 open_id 不一样）。 */
  openId: string;

  /** 消息类型：text、post、image 等。 */
  messageType: string;

  /** 文字内容，去掉了群里 @ 机器人的占位符；不是文字消息时是空字符串。 */
  text: string;

  /** 原始 JSON 内容，主渠道据此提取图片、文件等资源 key。 */
  rawContent?: string;

  /** 用户引用回复的那条消息的 ID（parent_id）；不是引用回复时没有。jmbots 11-02 加的。 */
  parentId?: string;
}


/** 收到飞书消息时的事件数据（SDK 定义的 im.message.receive_v1，这里只列用到的字段）。 */
interface ReceiveEvent {
  /** 发消息的人。 */
  sender: { sender_id?: { open_id?: string } };

  /** 消息本身；content 是 JSON 字符串，文字消息是 {"text":"……"}。 */
  message: { message_id: string; chat_id: string; chat_type: string; message_type: string; content: string; mentions?: { key: string }[]; parent_id?: string };
}


/** 连上飞书后拿到的东西。 */
export interface Feishu {
  /**
   * 发一条文字消息。
   * @param to 发给谁：{ openId } 是私聊某人，{ chatId } 是某个会话（私聊或群）。
   * @param text 文字。
   * @returns 飞书给这条消息的 ID。
   * @throws 飞书返回错误码时抛错，带上错误码和说明。
   */
  sendText(to: { openId: string } | { chatId: string }, text: string): Promise<string>;

  /**
   * 列出应用“可用范围”里的人（open_id）。还没人给机器人发过消息时，用它找到要通知的人。
   * @throws 应用没有通讯录权限（如 contact:contact.base:readonly）时，飞书返回错误码，这里抛错。
   */
  listScopeUsers(): Promise<string[]>;

  /**
   * 开始用长连接收消息，每收到一条（同一条只算一次）就在后台调一次 onMessage。
   * @param onMessage 处理一条消息；它抛的错会被接住并打印，不会断开长连接。
   * @param onCardAction 卡片按钮被点了（card.action.trigger 回调，原样给出）；返回值作为回调的回应（如 toast）。
   *   要在飞书开发者后台把“回调订阅方式”设成长连接、加上 card.action.trigger 才收得到。jmbots 11-02 加的。
   * @param onConnection 长连接状态变了：连上、断线重连中、重连上、出错（jmbots 11-02 加的，记连接记录用）。
   * @returns 长连接第一次连上后返回；之后断线由 SDK 自动重连。
   * @throws 第一次连接重试完还连不上时抛错（App ID、App Secret 不对，或没开长连接）。
   */
  listen(
    onMessage: (message: FeishuMessage) => Promise<void>,
    onCardAction?: (data: unknown) => Promise<unknown>,
    onConnection?: (state: '已连上' | '断线重连中' | '已重连' | '出错', detail?: string) => void,
  ): Promise<void>;

  /** 断开长连接。 */
  close(): void;
}


/**
 * 飞书开放接口出错时，SDK（axios）抛的错里带着飞书的回应；取出错误码和说明，换成看得懂的报错。
 * @param action 在做什么，如“发消息”。
 * @param error SDK 抛的错。
 */
function feishuError(action: string, error: unknown): Error {
  /** 飞书的回应：错误码和说明在 response.data。 */
  const data = (error as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
  if (!data) {
    return new Error(`飞书${action}失败：${String(error)}`);
  }
  return new Error(`飞书${action}失败：错误码 ${data.code ?? '未知'}，${data.msg ?? ''}`);
}


/**
 * 取出图文消息（post）里的文字：标题一行，每段一行；文字、链接、@ 照写，图片写成 [图片]，表情、代码块等其他元素尽量取文字。
 * 收到的 post 内容有两种写法：{ title, content } 或按语言包一层 { zh_cn: { title, content } }。
 * @param raw 消息的 content（JSON 字符串）。
 */
function postText(raw: string): string {
  /** 解析后的内容。 */
  let post = JSON.parse(raw) as { title?: string; content?: unknown[][] } & Record<string, unknown>;
  if (!Array.isArray(post.content)) {
    /** 按语言包的第一份。 */
    const first = Object.values(post).find((value) => value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content));
    post = (first ?? {}) as typeof post;
  }
  /** 各行。 */
  const lines = post.title ? [post.title] : [];
  for (const paragraph of post.content ?? []) {
    lines.push(
      (Array.isArray(paragraph) ? paragraph : [])
        .map((item) => {
          /** 一个元素。 */
          const element = (item ?? {}) as { tag?: string; text?: string; href?: string; user_name?: string };
          if (element.tag === 'img' || element.tag === 'media') {
            return '[图片]';
          }
          if (element.tag === 'at') {
            return element.user_name ? `@${element.user_name}` : '';
          }
          return element.text ?? element.href ?? '';
        })
        .join(''),
    );
  }
  return lines.join('\n');
}


/**
 * 把收到的事件换成 zbots 的消息格式：取出文字，去掉群里 @ 的占位符（如 @_user_1）。
 * @param event 飞书推来的 im.message.receive_v1 事件数据。
 */
export function toMessage(event: ReceiveEvent): FeishuMessage {
  /** 文字消息的正文；图文消息（post）取出里面的文字，图片写成 [图片]；其他类型留空。 */
  let text = '';
  if (event.message.message_type === 'text') {
    text = (JSON.parse(event.message.content) as { text?: string }).text ?? '';
  } else if (event.message.message_type === 'post') {
    text = postText(event.message.content);
  }
  for (const mention of event.message.mentions ?? []) {
    text = text.replaceAll(mention.key, '');
  }
  return {
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    chatType: event.message.chat_type,
    openId: event.sender.sender_id?.open_id ?? '',
    messageType: event.message.message_type,
    text: text.trim(),
    ...(event.message.message_type !== 'text' ? { rawContent: event.message.content } : {}),
    ...(event.message.parent_id ? { parentId: event.message.parent_id } : {}),
  };
}


/**
 * 用 App ID 和 App Secret 连上飞书：建发消息用的客户端，和收消息用的长连接（调 listen 才真正连）。
 * @param config 飞书渠道的设置。
 */
export function createFeishu(config: FeishuConfig): Feishu {
  /** 调开放接口的客户端；访问令牌由 SDK 自己取、自己续。 */
  const client = new lark.Client({ appId: config.app_id, appSecret: config.app_secret });
  /** 收消息的长连接客户端；调 listen 时才建。 */
  let wsClient: lark.WSClient | undefined;
  /** 最近处理过的消息 ID：飞书没及时收到确认会重推同一条，用它去重；只留最近 500 条。 */
  const seen = new Set<string>();

  return {
    async sendText(to, text) {
      /** 按 open_id 发还是按会话 ID 发。 */
      const target = 'openId' in to ? { id: to.openId, type: 'open_id' as const } : { id: to.chatId, type: 'chat_id' as const };
      const result = await client.im.message
        .create({
          params: { receive_id_type: target.type },
          data: { receive_id: target.id, msg_type: 'text', content: JSON.stringify({ text }) },
        })
        .catch((error: unknown) => {
          throw feishuError('发消息', error);
        });
      if (result.code !== 0) {
        throw new Error(`飞书发消息失败：错误码 ${result.code ?? '未知'}，${result.msg ?? ''}`);
      }
      return result.data?.message_id ?? '';
    },

    async listScopeUsers() {
      const result = await client.contact.scope.list({ params: { user_id_type: 'open_id' } }).catch((error: unknown) => {
        throw feishuError('查可用范围', error);
      });
      if (result.code !== 0) {
        throw new Error(`飞书查可用范围失败：错误码 ${result.code ?? '未知'}，${result.msg ?? ''}`);
      }
      return result.data?.user_ids ?? [];
    },

    async listen(onMessage, onCardAction, onConnection) {
      /** 事件分发：只接收消息这一种事件。 */
      const dispatcher = new lark.EventDispatcher({}).register({
        // 已读、表情回应的事件用不上，登记空处理，免得日志里一直报“no handle”。
        'im.message.message_read_v1': () => undefined,
        'im.message.reaction.created_v1': () => undefined,
        'im.message.reaction.deleted_v1': () => undefined,
        'card.action.trigger': async (data: unknown) => {
          try {
            return await onCardAction?.(data);
          } catch (error) {
            console.error('处理飞书卡片按钮出错：', error);
            return undefined;
          }
        },
        'im.message.receive_v1': (event) => {
          /** 换成 zbots 格式的消息。 */
          const message = toMessage(event);
          if (seen.has(message.messageId)) {
            return;
          }
          seen.add(message.messageId);
          if (seen.size > 500) {
            seen.delete(seen.values().next().value ?? '');
          }
          // 先确认收到（这个函数马上返回），处理放到后台。
          void onMessage(message).catch((error: unknown) => {
            console.error(`处理飞书消息 ${message.messageId} 出错：`, error);
          });
        },
      });
      // 等第一次连上（onReady）再返回；第一次就连不上（onError）时报错。握手最多等 20 秒，免得卡在代理上。
      await new Promise<void>((resolve, reject) => {
        wsClient = new lark.WSClient({
          appId: config.app_id,
          appSecret: config.app_secret,
          loggerLevel: lark.LoggerLevel.warn,
          handshakeTimeoutMs: 20_000,
          onReady: () => {
            onConnection?.('已连上');
            resolve();
          },
          onReconnecting: () => onConnection?.('断线重连中'),
          onReconnected: () => onConnection?.('已重连'),
          onError: (error) => {
            onConnection?.('出错', error.message);
            reject(new Error(`飞书长连接连不上：${error.message}`));
          },
        });
        wsClient.start({ eventDispatcher: dispatcher }).catch(reject);
      });
    },

    close() {
      wsClient?.close();
    },
  };
}
