/**
 * 飞书渠道：飞书是 jmbots 外接的一个能力（用户 11-02 的定位），这个文件负责收消息、发消息，并接到引擎上。
 *
 * 分两层：
 *   适配层  createFeishu：传输层可以替换（测试用替身，正式用官方 SDK 的长连接），负责去重、把收到的消息交给处理函数、把回复发回去
 *   接线    startFeishu：收到的消息交给配置里的机器人（channels.feishu.bot，如周小灵）；同一个聊天接着最近的会话，
 *           隔了 session_idle_hours 小时（默认 6）就开新会话；会话里有命令在等确认时，这句话交给模型判断是同意还是拒绝
 *   发件箱  startOutbox：运行时目录 integrations\feishu\发件箱\ 里的 .md 文件由机器人发给最近私聊的人（Claude 在虚拟机里给用户发消息用）
 *   连接记录 长连接连上、断线、重连都记到 integrations\feishu\<机器人>\连接记录.md（用户 11-02：每个机器人一份）
 *   发出去的每条消息记成会话里的 sent 事件（带消息 ID）：用户引用回复某条消息时，引擎按它直接找回那个会话（Router.threadRoute）
 *
 * 官方 SDK 暂时借用 zbots/src/Feishu.ts（装在 zbots/node_modules）。TODO：把 SDK 装进根目录，去掉对 zbots 的依赖。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as zbotsFeishu from '../../zbots/src/Feishu.ts';
import * as utils from '../utils/Utils.ts';
import type * as engineModule from '../core/Engine.ts';
import type * as runtimeModule from '../core/Runtime.ts';
import type * as eventsModule from '../store/Events.ts';

/** 飞书文本消息接收事件的必要字段。 */
export interface ReceiveEvent {
  /** 发送者。 */
  sender: { sender_id?: { open_id?: string } };
  /** 原始消息。 */
  message: {
    /** 消息 ID。 */
    message_id: string;
    /** 会话 ID。 */
    chat_id: string;
    /** 会话类型。 */
    chat_type: string;
    /** 消息类型。 */
    message_type: string;
    /** JSON 格式消息内容。 */
    content: string;
    /** 被提及的成员占位符。 */
    mentions?: { key: string }[];
    /** 引用回复的那条消息的 ID。 */
    parent_id?: string;
  };
}

/** 交给处理函数的消息。 */
export interface FeishuMessage {
  /** 消息 ID，用于去重。 */
  messageId: string;
  /** 回复目标会话 ID。 */
  chatId: string;
  /** 会话类型。 */
  chatType: string;
  /** 发送者 open ID。 */
  openId: string;
  /** 消息类型。 */
  messageType: string;
  /** 提取后的文字。 */
  text: string;
  /** 用户引用回复的那条消息的 ID；不是引用回复时没有。 */
  parentId?: string;
}

/** 发往会话或用户的目标。 */
export type FeishuTarget = { chatId: string } | { openId: string };

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

/** 外部注入的传输层；listen 回调应立即返回，不等待处理结果。 */
export interface FeishuTransport {
  /**
   * 连接并注册入站事件回调；首次连接失败时拒绝。
   * @param onEvent 收到消息。
   * @param onCardAction 卡片按钮被点了；返回值作为回调的回应（如 toast）。
   */
  listen(
    onEvent: (event: ReceiveEvent) => void,
    onCardAction?: (action: CardAction) => Promise<unknown>,
    onConnection?: (state: string, detail?: string) => void,
  ): Promise<void>;
  /** 发卡片消息（interactive），返回消息 ID；测试替身可以不实现。 */
  sendCard?: (to: FeishuTarget, card: Record<string, unknown>) => Promise<string>;
  /** 把发过的卡片换成新内容。 */
  updateCard?: (messageId: string, card: Record<string, unknown>) => Promise<void>;
  /** 发文字消息并返回平台消息 ID。 */
  sendText(to: FeishuTarget, text: string): Promise<string>;
  /** 给一条消息加表情回应（如 Typing“敲键盘”），返回回应 ID；测试替身可以不实现。 */
  addReaction?: (messageId: string, emojiType: string) => Promise<string>;
  /** 撤掉一个表情回应。 */
  removeReaction?: (messageId: string, reactionId: string) => Promise<void>;
  /** 关闭连接。 */
  close(): void;
}

/** 对外的消息适配器。 */
export interface Feishu {
  /** 开始监听；同一实例不能重复监听。 */
  listen(): Promise<void>;
  /** 主动发送文字消息。 */
  sendText(to: FeishuTarget, text: string): Promise<string>;
  /** 关闭监听。 */
  close(): void;
}

/**
 * 将飞书事件转换为本地消息；无效的文本 JSON 会抛错。
 * 图文消息（post）在 zbots 的 SDK 那层已经取出文字、包成 { text }，这里和文字消息一样读。
 */
export function toMessage(event: ReceiveEvent): FeishuMessage {
  let text = '';
  if (event.message.message_type === 'text' || event.message.message_type === 'post') {
    const content: unknown = JSON.parse(event.message.content);
    if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
      text = content.text;
    }
    for (const mention of event.message.mentions ?? []) {
      if (mention.key) {
        text = text.replaceAll(mention.key, '');
      }
    }
  }
  return {
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    chatType: event.message.chat_type,
    openId: event.sender.sender_id?.open_id ?? '',
    messageType: event.message.message_type,
    text: text.trim(),
    ...(event.message.parent_id ? { parentId: event.message.parent_id } : {}),
  };
}

/** 飞书开放接口地址。 */
const OPEN_API = 'https://open.feishu.cn/open-apis';


/**
 * 飞书开放接口的最小客户端：自己取应用访问令牌（tenant_access_token），过期前 5 分钟换新的。
 * @param appId 应用 ID。
 * @param appSecret 应用密钥。
 * @returns (方法, 路径, 请求体) → 返回体里的 data；code 不是 0 时抛错。
 */
function createOpenApi(appId: string, appSecret: string): (method: string, apiPath: string, body?: unknown) => Promise<Record<string, unknown>> {
  /** 缓存的令牌和过期时间。 */
  let cached: { token: string; expiresAt: number } | undefined;

  /** 取令牌：缓存还有效就用缓存。 */
  async function token(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt) {
      return cached.token;
    }
    /** 返回体。 */
    const result = (await (
      await fetch(`${OPEN_API}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      })
    ).json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (result.code !== 0 || !result.tenant_access_token) {
      throw new Error(`飞书令牌没取到：${result.msg ?? String(result.code)}`);
    }
    cached = { token: result.tenant_access_token, expiresAt: Date.now() + ((result.expire ?? 7200) - 300) * 1000 };
    return cached.token;
  }

  return async (method, apiPath, body) => {
    /** 返回体。 */
    const result = (await (
      await fetch(`${OPEN_API}${apiPath}`, {
        method,
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    ).json()) as { code?: number; msg?: string; data?: Record<string, unknown> };
    if (result.code !== 0) {
      throw new Error(`飞书接口 ${method} ${apiPath} 出错：${result.msg ?? String(result.code)}（code ${String(result.code)}）`);
    }
    return result.data ?? {};
  };
}


/**
 * 复用 zbots 官方 SDK 连接；只在调用 listen 或 sendText 时实际联网。
 * @param config 调用方提供的飞书配置；不读取任何配置文件。
 * @returns 可交给 createFeishu 的真实传输层。
 */
export function createSdkTransport(config: zbotsFeishu.FeishuConfig): FeishuTransport {
  const client = zbotsFeishu.createFeishu(config);
  /** 调开放接口（表情回应）的小客户端：SDK 在 zbots 里，这里直接发 HTTP 请求。 */
  const api = createOpenApi(config.app_id, config.app_secret);
  return {
    async addReaction(messageId, emojiType) {
      /** 返回的数据。 */
      const data = await api('POST', `/im/v1/messages/${messageId}/reactions`, { reaction_type: { emoji_type: emojiType } });
      return typeof data.reaction_id === 'string' ? data.reaction_id : '';
    },
    async removeReaction(messageId, reactionId) {
      await api('DELETE', `/im/v1/messages/${messageId}/reactions/${reactionId}`);
    },
    async sendCard(to, card) {
      /** 按会话 ID 发还是按 open_id 发。 */
      const target = 'chatId' in to ? { id: to.chatId, type: 'chat_id' } : { id: to.openId, type: 'open_id' };
      /** 返回的数据。 */
      const data = await api('POST', `/im/v1/messages?receive_id_type=${target.type}`, {
        receive_id: target.id,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      });
      return typeof data.message_id === 'string' ? data.message_id : '';
    },
    async updateCard(messageId, card) {
      await api('PATCH', `/im/v1/messages/${messageId}`, { content: JSON.stringify(card) });
    },
    listen(onEvent, onCardAction, onConnection) {
      /** 卡片按钮回调：取出点的人、消息、聊天和按钮的值（两种写法：字段在 context 里或直接在外面）。 */
      const cardHandler = onCardAction
        ? (data: unknown) => {
            /** 回调内容。 */
            const raw = (data ?? {}) as {
              operator?: { open_id?: string };
              open_id?: string;
              open_message_id?: string;
              open_chat_id?: string;
              context?: { open_message_id?: string; open_chat_id?: string };
              action?: { value?: unknown };
            };
            /** 按钮的值；有的版本是 JSON 字符串。 */
            let value = raw.action?.value;
            if (typeof value === 'string') {
              value = JSON.parse(value) as unknown;
            }
            return onCardAction({
              openId: raw.operator?.open_id ?? raw.open_id ?? '',
              messageId: raw.context?.open_message_id ?? raw.open_message_id ?? '',
              chatId: raw.context?.open_chat_id ?? raw.open_chat_id ?? '',
              value: (value && typeof value === 'object' ? value : {}) as Record<string, unknown>,
            });
          }
        : undefined;
      return client.listen((message) => {
        onEvent({
          sender: { sender_id: { open_id: message.openId } },
          message: {
            message_id: message.messageId,
            chat_id: message.chatId,
            chat_type: message.chatType,
            message_type: message.messageType,
            content: JSON.stringify({ text: message.text }),
            ...(message.parentId ? { parent_id: message.parentId } : {}),
          },
        });
        return Promise.resolve();
      }, cardHandler, onConnection);
    },
    sendText(to, text) {
      return client.sendText(to, text);
    },
    close() {
      client.close();
    },
  };
}

/**
 * 创建可注入传输层的适配器。入站文本交 handler，返回非空回复时发回原会话。
 * @param transport 由调用方提供的连接及发送实现。
 * @param handler 消息处理函数，返回空值表示不回复。
 * @param onError 后台处理失败回调；默认打印错误，不影响监听。
 * @param onCardAction 卡片按钮被点了（原样交给传输层）。
 * @param onConnection 长连接状态变了（原样交给传输层）。
 * @returns 支持监听、主动发送和关闭的适配器。
 */
export function createFeishu(
  transport: FeishuTransport,
  handler: (message: FeishuMessage) => Promise<string | void>,
  onError: (error: unknown) => void = (error) => { console.error('飞书消息处理失败', error); },
  onCardAction?: (action: CardAction) => Promise<unknown>,
  onConnection?: (state: string, detail?: string) => void,
): Feishu {
  const seen = new Set<string>();
  let listening = false;
  let closed = false;
  return {
    async listen() {
      if (listening || closed) {
        throw new Error('飞书适配器已监听或已关闭');
      }
      listening = true;
      try {
        await transport.listen((event) => {
          // M：立即返回以便传输层确认事件，后台处理和发送不阻塞确认。
          void Promise.resolve().then(async () => {
            if (closed) {
              return;
            }
            const message = toMessage(event);
            if (!message.messageId || !message.chatId || seen.has(message.messageId)) {
              return;
            }
            // G：取不出文字的消息（单张图片、文件、语音等）回一句，不再一声不响地丢掉。
            if (!message.text) {
              seen.add(message.messageId);
              await transport.sendText({ chatId: message.chatId }, '这类消息我还看不了，请发文字（图文消息里的文字我能看到，图片暂时看不到）。');
              return;
            }
            // G：有界去重只覆盖本进程最近 500 条，并非持久化投递保证。
            seen.add(message.messageId);
            if (seen.size > 500) {
              seen.delete(seen.values().next().value ?? '');
            }
            // M：先给这条消息加“敲键盘”表情，表示正在处理；回复发出后撤掉。加不上（没权限等）只记一句，不影响回复。
            const reactionId = await transport.addReaction?.(message.messageId, 'Typing').catch((error: unknown) => {
              console.error(`飞书“正在处理”表情没加上：${error instanceof Error ? error.message : String(error)}`);
              return undefined;
            });
            try {
              const reply = await handler(message);
              if (reply && !closed) {
                await transport.sendText({ chatId: message.chatId }, reply);
              }
            } finally {
              if (reactionId) {
                await transport.removeReaction?.(message.messageId, reactionId).catch((error: unknown) => {
                  console.error(`飞书“正在处理”表情没撤掉：${error instanceof Error ? error.message : String(error)}`);
                });
              }
            }
          }).catch((error: unknown) => {
            try {
              onError(error);
            } catch (reportError) {
              console.error('飞书错误回调失败', reportError);
            }
          });
        }, onCardAction, onConnection);
      } catch (error) {
        listening = false;
        throw error;
      }
    },
    sendText(to, text) {
      return transport.sendText(to, text);
    },
    close() {
      if (!closed) {
        closed = true;
        transport.close();
      }
    },
  };
}


/** config.yaml 的 channels.feishu。 */
export interface FeishuSettings {
  /** 开不开。 */
  enabled?: boolean;
  /** 飞书应用的 App ID。 */
  app_id?: string;
  /** 飞书应用的 App Secret。 */
  app_secret?: string;
  /** 消息交给哪个机器人。 */
  bot?: string;
  /** 同一个聊天隔多少小时没说话就开新会话，默认 6。 */
  session_idle_hours?: number;
}


/** 检查过、可以用的飞书设置。 */
export interface ReadySettings {
  /** 飞书应用的 App ID。 */
  app_id: string;
  /** 飞书应用的 App Secret。 */
  app_secret: string;
  /** 消息交给哪个机器人。 */
  bot: string;
  /** 同一个聊天隔多少小时没说话就开新会话。 */
  session_idle_hours?: number;
}


/**
 * 读飞书设置：没开、没填 app_id 和 app_secret 时返回 undefined（不启用飞书）。
 * 没写 bot 时交给第一个机器人；一个机器人都没有也不启用。
 * @param runtime 运行时。
 */
export function readSettings(runtime: runtimeModule.Runtime): ReadySettings | undefined {
  /** channels.feishu。 */
  const settings = ((runtime.config.channels ?? {}) as { feishu?: FeishuSettings }).feishu;
  //G 没开或没填应用的 ID 和密钥。
  if (!settings?.enabled || !settings.app_id || !settings.app_secret) {
    return undefined;
  }
  /** 飞书来的消息交给哪个机器人。 */
  const bot = settings.bot || runtime.bots[0]?.name;
  if (!bot) {
    return undefined;
  }
  return { app_id: settings.app_id, app_secret: settings.app_secret, bot, session_idle_hours: settings.session_idle_hours };
}


/**
 * 给 AI 用的“发飞书”函数：会话来自飞书就发回那个聊天，否则发给最近私聊过机器人的人。
 * @param transport 传输层。
 * @param store 数据库（查会话来源）。
 * @returns (会话 ID, 文字) → 飞书消息 ID。
 */
export function createSender(transport: FeishuTransport, store: eventsModule.EventStore): (sessionId: string, text: string) => Promise<string> {
  return async (sessionId, text) => {
    /** 飞书给的消息 ID。 */
    const messageId = await transport.sendText({ chatId: chatOf(store, sessionId) }, text);
    //M 记成会话里的 sent 事件：用户引用回复这条消息时按它找回会话。
    /** 会话最近一次执行（sent 事件挂在它下面）。 */
    const execution = sessionId ? store.listEvents(sessionId, 'execution').at(-1) : undefined;
    if (execution && messageId) {
      store.recordEvent({ sessionId, parentId: execution.id, type: 'sent', payload: { channel: '飞书', messageId } });
    }
    return messageId;
  };
}


/**
 * 一个会话的消息该发到哪个飞书聊天：会话来自飞书就是那个聊天，否则是最近私聊过机器人的人。
 * @param store 数据库（查会话来源）。
 * @param sessionId 会话 ID；空字符串表示直接找最近私聊的人。
 * @returns 聊天 ID。
 * @throws 还没人在飞书里和机器人聊过时抛错。
 */
function chatOf(store: eventsModule.EventStore, sessionId: string): string {
  /** 会话来源，如“飞书私聊 oc_xxx”。 */
  let source = sessionId ? (store.getSession(sessionId)?.source ?? '') : '';
  if (!source.startsWith('飞书')) {
    //M 不是飞书来的会话：找最近一个飞书私聊。
    source = store.listSessions({ limit: 200 }).find((session) => session.source.startsWith('飞书私聊'))?.source ?? '';
  }
  /** 聊天 ID：来源的最后一段。 */
  const chatId = source.split(' ').at(-1);
  if (!chatId || !source.startsWith('飞书')) {
    throw new Error('还没有人在飞书里和机器人聊过，不知道发给谁');
  }
  return chatId;
}


/**
 * 待确认命令的飞书卡片：命令、目录、会话、审核概率，加“放行”“拒绝”两个按钮；决定过以后换成不带按钮的结果。
 * @param request 确认请求。
 * @param result 已经决定了时的结果说明，如“已放行（飞书卡片按钮）”；没决定时不写。
 */
function approvalCard(request: engineModule.ApprovalRequest, result?: string): Record<string, unknown> {
  /** 正文。 */
  const body = [
    `**命令**\n\`\`\`\n${utils.truncate(request.command, 1500)}\n\`\`\``,
    `**目录** ${request.workDir}`,
    `**会话** ${request.sessionTitle}（${request.sessionId}，来自 ${request.source}）`,
    request.probability === undefined ? '**审核** 没问决策模型' : `**审核** 决策模型给的安全概率 ${request.probability.toFixed(2)}，低于放行线`,
  ].join('\n');
  /** 卡片元素。 */
  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: body }];
  if (result) {
    elements.push({ tag: 'markdown', content: `**结果** ${result}` });
  } else {
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '放行' }, type: 'primary', value: { approval_id: request.approvalId, decision: 'approved' } },
        { tag: 'button', text: { tag: 'plain_text', content: '拒绝' }, type: 'danger', value: { approval_id: request.approvalId, decision: 'rejected' } },
      ],
    });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '也可以直接回一句话，比如“那个命令可以执行”。' }] });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: result ? 'grey' : 'orange', title: { tag: 'plain_text', content: `待确认 ${request.approvalId}：要执行一条命令` } },
    elements,
  };
}


/** 接飞书要给的东西。 */
export interface StartFeishuOptions {
  /** 传输层。 */
  transport: FeishuTransport;
  /** 设置。 */
  settings: ReadySettings;
  /** 数据库。 */
  store: eventsModule.EventStore;
  /** 引擎。 */
  engine: engineModule.Engine;
  /** 运行时（写 integrations\feishu\<机器人>\连接记录.md）。 */
  runtime: runtimeModule.Runtime;
}


/**
 * 往 integrations\feishu\<机器人>\连接记录.md 记一行：长连接什么时候连上、断线、重连、出错。
 * @param runtime 运行时。
 * @param bot 机器人名字。
 * @param state 状态。
 * @param detail 补充说明（出错原因）。
 */
async function logConnection(runtime: runtimeModule.Runtime, bot: string, state: string, detail?: string): Promise<void> {
  /** 这个机器人的文件夹。 */
  const dir = path.join(runtime.dir, 'integrations', 'feishu', bot);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, '连接记录.md'), `- ${utils.formatTime()} ${state}${detail ? `：${detail}` : ''}（进程 ${process.pid}）\n`);
}


/**
 * 开始收飞书消息。核心不知道飞书，这里把三件事接起来：
 *   1. 收到一句话交给引擎分派（Engine.handleMessage：接着哪个会话、开新的、放行哪条命令），处理期间挂“敲键盘”表情；
 *   2. 来自飞书的会话每次执行结束，把回复发回那个聊天（engine.onFinished）；
 *   3. 有命令要确认时发一张带“放行”“拒绝”按钮的卡片（engine.onApproval），点了就调 engine.decide。
 *      卡片发到会话所在的聊天；会话不是飞书来的（网页、命令行），发给最近私聊过机器人的人。
 * 用户 11-02：“触发审核的事情应该飞书也生成卡片之类我去点击通过……核心框架应当是不知道飞书相关的”。
 * @param options 传输层、设置、数据库、引擎。
 * @returns 适配器（可以 close）。
 * @throws 第一次连接失败时抛错。
 */
export async function startFeishu(options: StartFeishuOptions): Promise<Feishu> {
  const { transport, settings, store, engine, runtime } = options;
  /** 发回某个会话所在聊天。 */
  const send = createSender(transport, store);

  //M 2. 执行结束：飞书来的会话把回复发回去（等确认的由卡片负责，不发文字）。
  engine.onFinished((finished) => {
    /** 会话。 */
    const session = store.getSession(finished.sessionId);
    // 分派对话的回答是给程序读的 JSON，不发给用户。
    if (finished.ending === 'paused' || !session?.source.startsWith('飞书') || session.kind === 'route') {
      return;
    }
    // 同一个聊天最近还有别的会话在动，就在回复前标上是哪件事，免得混。
    /** 同一聊天最近 10 分钟动过的其他会话。 */
    const others = store.listSessions({ source: session.source, kind: 'task', limit: 5 }).filter((item) => item.id !== session.id && Date.now() - item.updatedAt < 600_000);
    /** 要发的话。 */
    const text = others.length > 0 ? `【${session.title}】\n${finished.reply}` : finished.reply;
    void send(session.id, text)
      .then(() => console.log(`${utils.formatTime()} 已回复（会话 ${session.id}，${finished.ending}）`))
      .catch((error: unknown) => console.error(`${utils.formatTime()} 飞书回复没发出去（会话 ${session.id}）：${utils.errorText(error)}`));
  });

  //M 2.1 看门狗：执行很久没进展，提醒用户（会话不是飞书来的，发给最近私聊的人）。
  engine.onStuck((stuck) => {
    void send(stuck.sessionId, `【${stuck.sessionTitle}】已经 ${stuck.minutes} 分钟没有新进展了，还在跑。要停的话告诉我。`).catch((error: unknown) =>
      console.error(`${utils.formatTime()} 看门狗提醒没发出去（会话 ${stuck.sessionId}）：${utils.errorText(error)}`),
    );
  });

  //M 3. 要确认：发卡片。
  engine.onApproval((request) => {
    void Promise.resolve()
      .then(async () => {
        if (!transport.sendCard) {
          await send(request.sessionId, `待确认 ${request.approvalId}：要执行命令\n${request.command}\n目录：${request.workDir}\n回一句话告诉我放不放行。`);
          return;
        }
        await transport.sendCard({ chatId: chatOf(store, request.sessionId) }, approvalCard(request));
        console.log(`${utils.formatTime()} 已发确认卡片（待确认 ${request.approvalId}）`);
      })
      .catch((error: unknown) => console.error(`${utils.formatTime()} 确认卡片没发出去（待确认 ${request.approvalId}）：${utils.errorText(error)}`));
  });

  /**
   * 卡片按钮被点了：放行或拒绝，再把卡片换成结果。
   * @param action 点了哪张卡片的哪个按钮。
   * @returns 给飞书的回应（toast 提示）。
   */
  async function onCardAction(action: CardAction): Promise<unknown> {
    /** 待确认 ID。 */
    const approvalId = Number(action.value.approval_id);
    /** 放行还是拒绝。 */
    const decision = action.value.decision;
    //G 不是我们的确认按钮。
    if (!approvalId || (decision !== 'approved' && decision !== 'rejected')) {
      return undefined;
    }
    /** 结果说明。 */
    let result: string;
    try {
      engine.decide(approvalId, decision, undefined, '飞书卡片按钮');
      result = `${decision === 'approved' ? '已放行' : '已拒绝'}（飞书卡片按钮，${utils.formatTime()}）`;
    } catch (error) {
      result = utils.errorText(error);
    }
    //M 卡片换成结果（换不了不要紧）。
    /** 待确认。 */
    const approval = store.getApproval(approvalId);
    /** 会话。 */
    const session = approval ? store.getSession(approval.sessionId) : undefined;
    if (approval && session && action.messageId && transport.updateCard) {
      /** 卡片内容。 */
      const card = approvalCard(
        { approvalId, sessionId: session.id, sessionTitle: session.title, source: session.source, command: approval.command, workDir: approval.workDir },
        approval.status === 'pending' ? result : `${approval.status === 'approved' ? '已放行' : '已拒绝'}${approval.note ? `：${approval.note}` : ''}`,
      );
      await transport.updateCard(action.messageId, card).catch((error: unknown) => {
        console.error(`${utils.formatTime()} 确认卡片没换成结果：${utils.errorText(error)}`);
      });
    }
    return { toast: { type: 'info', content: result } };
  }

  //M 1. 收消息：分派，等它引出的执行都做完（这期间挂着“敲键盘”表情）；回复由上面的 onFinished 发。
  const adapter = createFeishu(
    transport,
    async (message) => {
      /** 来源。 */
      const source = `${message.chatType === 'p2p' ? '飞书私聊' : '飞书群'} ${message.chatId}`;
      console.log(`${utils.formatTime()} 收到飞书消息（${source}）：${message.text}`);
      try {
        /** 分派结果：引出的执行对话、要直接问用户的话。 */
        const handled = await engine.handleMessage({ text: message.text, source, bot: settings.bot, idleHours: settings.session_idle_hours ?? 6, replyTo: message.parentId });
        for (const reply of handled.replies) {
          await transport.sendText({ chatId: message.chatId }, reply);
        }
        await Promise.all(handled.sessionIds.map((sessionId) => engine.waitIdle(sessionId)));
        return undefined;
      } catch (error) {
        return `出错了：${utils.errorText(error)}`;
      }
    },
    undefined,
    onCardAction,
    (state, detail) => {
      void logConnection(runtime, settings.bot, state, detail).catch((error: unknown) => console.error(`${utils.formatTime()} 飞书连接记录没写成：${utils.errorText(error)}`));
    },
  );
  await adapter.listen();
  console.log(`${utils.formatTime()} 飞书长连接已连上，消息交给机器人 ${settings.bot}。`);
  return adapter;
}


/** 飞书发件箱的文件夹（在运行时目录下；用户 11-02 定：外接的东西都放 integrations）。 */
export const OUTBOX_DIR = path.join('integrations', 'feishu', '发件箱');


/**
 * 飞书发件箱：别的程序（比如在虚拟机里、不能直接调接口的 Claude）往运行时目录的 飞书发件箱\ 放一个 .md 文件，
 * 这里每 5 秒看一次，把文件内容通过飞书发给最近私聊过机器人的人，发完挪进 飞书发件箱\已发\。
 * 写文件的一方要先写成别的扩展名（如 .tmp）再改名成 .md，免得发出半截。发送失败的文件留在原处，下一轮再试。
 * @param runtime 运行时（找发件箱目录）。
 * @param send 发消息的函数（createSender 建的）；会话 ID 传空字符串，表示发给最近私聊的人。
 * @returns 停止的函数。
 */
export function startOutbox(runtime: runtimeModule.Runtime, send: (sessionId: string, text: string) => Promise<string>): () => void {
  /** 发件箱目录。 */
  const dir = path.join(runtime.dir, OUTBOX_DIR);
  /** 已发的放这里。 */
  const sentDir = path.join(dir, '已发');
  /** 上一轮还没做完时跳过这一轮，免得同一个文件发两次。 */
  let busy = false;

  /** 看一轮：按文件名顺序发。 */
  async function check(): Promise<void> {
    //G 上一轮还没做完。
    if (busy) {
      return;
    }
    busy = true;
    try {
      await fs.mkdir(sentDir, { recursive: true });
      /** 要发的文件。 */
      const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.md')).sort();
      for (const name of files) {
        /** 内容。 */
        const text = (await fs.readFile(path.join(dir, name), 'utf8')).trim();
        if (text) {
          await send('', text);
        }
        await fs.rename(path.join(dir, name), path.join(sentDir, name));
        console.log(`${utils.formatTime()} 飞书发件箱：已发出 ${name}`);
      }
    } catch (error) {
      console.error(`${utils.formatTime()} 飞书发件箱：发送失败，下一轮再试：${utils.errorText(error)}`);
    } finally {
      busy = false;
    }
  }

  /** 定时器。 */
  const timer = setInterval(() => void check(), 5000);
  return () => clearInterval(timer);
}
