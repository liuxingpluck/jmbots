/**
 * 飞书收：长连接推来的三种事件——收到消息、撤回消息、点卡片按钮（index.ts 的 Feishu.start 交给 SDK 分发器）。
 * 收到消息：按消息号去重（存表，重启也认得）→ 认出 @ 了哪些机器人、文字、谁在哪个群说的、投给哪些机器人
 * → 群里没 @ 也没登记只听的只落盘、记流水“丢了” → 记最近私聊的人、拼回话地址 → 挂表情、补引用转发、附件存进渠道目录
 * → 拼标准消息落盘、发 channel/message → 记去重、汇总认领结果写来往流水、没人接就撤表情。
 * 撤回：只认本人或原发信人，登记撤回（拦住还在处理的入站和在途回话），发 channel/recall。
 * 点卡片：拼回话地址（谁点的、哪一档），交给 cards/。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { SessionMeta } from '../../Sessions.ts';
import * as namesModule from '../../utils/Names.ts';
import * as textModule from '../../utils/Text.ts';
import * as protocol from '../../Channels.ts';
import * as api from './Api.ts';
import * as cards from './cards/Cards.ts';
import type { Contact } from './Contacts.ts';
import type { FeishuChatLogEntry } from './History.ts';
import { feishuCustomer, GUEST_DIR } from './index.ts';
import type { AppState, Feishu, FeishuAddress, FeishuApp, FeishuGroup, FeishuPerson, Toast } from './index.ts';
import * as media from './Media.ts';


/** 收到的消息事件里用到的几项（SDK 的 im.message.receive_v1，types/index.d.ts:319138）。 */
export interface ReceiveData {
  sender: { sender_id?: { open_id?: string }; sender_type: string };
  message: {
    message_id: string;
    parent_id?: string;
    root_id?: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: { key: string; id: { open_id?: string }; name: string }[];
  };
}


/** 飞书 im.message.recalled_v1 撤回消息事件的字段。 */
export interface RecallData {
  /** 事件唯一标识。 */
  event_id?: string;
  /** 飞书应用号。 */
  app_id?: string;
  /** 被撤回的原消息 ID。 */
  message_id?: string;
  /** 发生撤回的聊天 ID。 */
  chat_id?: string;
  /** 撤回毫秒时间戳字符串。 */
  recall_time?: string;
  /** 撤回者身份类型：message_owner 为原发消息人自撤，其余为群主/群管/企业管理员代撤。 */
  recall_type?: 'message_owner' | 'group_owner' | 'group_manager' | 'enterprise_manager';
  /** 可选操作者标识（带 open_id 时一并核验本人或原发信人）。 */
  operator_id?: { open_id?: string };
}


/** 一条收到的消息认出来的东西：handleInboundMessage 第 1 步（getFacts）算好，后面几步共用。 */
interface InboundFacts {
  /** 哪个应用收的。 */
  appId: string;
  /** 飞书的消息体。 */
  message: ReceiveData['message'];
  /** 是不是群聊（不是 p2p 的都算）。 */
  group: boolean;
  /** 标准 @ 清单：每个 @ 认出的机器人名（getMentions）。 */
  standardMentions: protocol.ChannelMention[];
  /** 换成的文字（带 @ 占位符）和要下载的资源（media.describe）。 */
  described: { text: string; resources: media.Resource[] };
  /** 去掉 @ 占位符的正文。 */
  body: string;
  /** 说话人 open_id；拿不到是 ''。 */
  openId: string;
  /** people 里登记的这个人；没登记是 undefined。 */
  person: FeishuPerson | undefined;
  /** groups 里登记的这个群；私聊、没登记是 undefined。 */
  registered: FeishuGroup | undefined;
  /** 群名：登记的优先，再飞书查到的；都没有是 ''。 */
  chatName: string;
  /** 说话人名字：登记的优先，再群成员里查到的；都没有是 ''。 */
  senderName: string;
  /** 标准消息、聊天日志里的发送人：open_id（拿不到是 unknown），有名字才带 name。 */
  sender: { id: string; name?: string };
  /** 没 @ 机器人：只听。 */
  listenOnly: boolean;
  /** 投给哪些机器人；空的是群里没 @ 也没登记只听，丢了（getTargets）。 */
  targetBots: string[];
  /** 每个机器人是只听还是要回、要不要判断（getTargets）。 */
  byBotRouting: Record<string, protocol.BotRoutingHint>;
  /** 标准消息号 ["feishu", 应用号, 消息号]。 */
  standardMessageId: string;
  /** 来往流水的这一行，outcome 收尾时补。 */
  contact: Omit<Contact, 'outcome'>;
}


/**
 * 一条消息最后怎么处理的，写进来往流水。
 * @param kind 接它的会话种类（FeishuInbound.takenBy）；没有会话接是 undefined。
 * @param listenOnly 是不是只听的话。
 * @returns 一个词。
 */
function getOutcome(kind: string | undefined, listenOnly: boolean): string {
  if (kind === 'relay') return '转外部助手';
  if (kind !== undefined) return '交给会话';
  if (listenOnly) return '只记';
  return '别的插件处理掉了';
}


/**
 * 回话地址里“这个人是哪一档”的几项：owner、role，builder、guest 再加 workspace。收消息、点卡片共用。
 * @param person 登记的人；没登记是 undefined，当 guest。
 * @param guestDir 没登记的 guest 用的目录（运行时目录 guests/_guest/）。
 * @returns 要并进地址的几项。
 */
function roleFields(
  person: FeishuPerson | undefined,
  guestDir: string,
): Pick<FeishuAddress, 'owner' | 'role' | 'workspace'> {
  const role = person?.role ?? 'guest';
  const fields: Pick<FeishuAddress, 'owner' | 'role' | 'workspace'> = { owner: role === 'owner', role };
  if (person?.role === 'builder') fields.workspace = person.dir;
  //M guest 也不读机器人的工作区（里面有用户的收件、截图）：登记了用他的目录，没登记的用 guests/_guest/；guest 只有只读工具。
  if (role === 'guest') fields.workspace = person?.dir || guestDir;
  return fields;
}


/** 飞书收：Feishu 构造时建一个，挂在 feishu.inbound 上；Feishu.start 把 SDK 的三种事件交给它。 */
export class FeishuInbound {
  /** 渠道名。 */
  readonly name = 'feishu';

  /** 正在处理中的入站消息号（防并发重推穿透），保存+广播后写入 feishu_seen。 */
  private readonly inFlight = new Set<string>();

  /** 已收到撤回通知的原消息键 `${appId}:${nativeId}` 集合，拦截尚在下载附件的入站或刚撤回时的在途回话（Reply.ts 也读）。 */
  readonly recalledNativeIds = new Set<string>();

  /**
   * 不登记事件：SDK 的事件由 Feishu.start 交过来。
   * @param ctx 飞书插件的 Cordis 上下文：数据库、运行时目录、会话表，发 channel/message、channel/recall、trace。
   * @param feishu 飞书渠道：应用、配置、查群名、聊天日志、来往流水，出错时发一句、撤表情。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly feishu: Feishu,
  ) {}

  /**
   * 收到一条消息：去重、记最近私聊的人、挂表情、换成文字、下载附件、交给机器人。
   * @param appId 哪个应用收的。
   * @param data 飞书的消息事件。
   * 副作用：写表；下载文件进工作区；推给机器人；出错给这个聊天发一句。
   */
  async onMessage(appId: string, data: ReceiveData): Promise<void> {
    let messageId = '（未知）';
    let ownsSlot = false;
    try {
      //M 按事件所属应用 ID 查找应用实例，找不到直接忽略。
      const app = this.feishu.apps.get(appId);
      if (app === undefined) return;

      messageId = data.message.message_id;
      const db = this.ctx.resources.db;
      const sql = "SELECT 1 FROM feishu_seen WHERE message_id = ? AND kind = 'in'";

      //G 重推或正在处理中：只有落盘并完成分派以后才写 feishu_seen。
      const seenRow = db.query(sql).get(messageId);
      if (seenRow !== null || this.inFlight.has(messageId)) {
        const vars = { appId: appId, messageId: messageId };
        //M 保留重复投递的去重流水。
        this.ctx.emit('trace', 'Feishu.onMessage', 'trace.feishu.duplicateMessage', 'SELECT feishu_seen', vars);
        return;
      }

      //M 只让这一份入站占住消息号，再交给解析、存盘和分发管线。
      this.inFlight.add(messageId);
      ownsSlot = true;
      await this.handleInboundMessage(appId, app, data);
    } catch (error) {
      //G SDK 回调不等这个 Promise。去重、解析和前置落盘失败也要有消息号与原因。
      const reason = textModule.getErrorMessage(error);
      this.logFailedMessage(messageId, reason);
    } finally {
      if (ownsSlot) {
        //M 只有占到消息号的这份入站可以释放它，让失败的消息后续能重投。
        this.inFlight.delete(messageId);
      }
    }
  }

  /** 记录任一入站阶段的失败，沿用原有消息日志格式。 */
  private logFailedMessage(messageId: string, reason: string): void {
    //M 日志带本机时间，便于按消息号和时间找入站失败。
    const logTime = textModule.formatLocalTime(Date.now(), 'date');
    //M 记录消息号和失败原因供排查。
    console.error(`${logTime} 飞书：消息 ${messageId} 没处理成：${reason}`);
  }

  /**
   * 处理已确认非重推的飞书入站消息：解析 @ 提及与群配置 → 下载附件进渠道目录 → 写原始消息日志 →
   * 发统一事件 channel/message（支持单账号多机器人各自认领）→ 最后落盘 feishu_seen、流水并清理无回话表情。
   * 前三步失败交给 onMessage 记日志。从挂表情起出错时还能记来往流水并回告原聊天。
   * @param appId 应用号。
   * @param app 应用运行时状态。
   * @param data 飞书消息事件。
   */
  private async handleInboundMessage(appId: string, app: AppState, data: ReceiveData): Promise<void> {
    const message = data.message;

    //M 1. 认出 @ 了哪些机器人、文字、谁在哪个群说的、投给哪些机器人。
    const facts = await this.getFacts(appId, app, data);

    //G 2. 群里没 @ 任何目标机器人且未登记只听：存 raw 日志、记 seen、记流水“丢了”后返回。
    if (facts.targetBots.length === 0) {
      this.keepDropped(facts);
      return;
    }

    //M 3. 私聊的记成这个应用最近私聊的人，再拼回话地址。
    this.rememberPrivate(facts);
    const address = this.getAddress(facts);

    const vars = {
      appId: appId,
      bot: facts.targetBots.join('、'),
      type: message.message_type,
      chat: message.chat_type,
      listenOnly: facts.listenOnly,
    };
    const summary = 'trace.feishu.receiveMessage';
    this.ctx.emit('trace', 'Feishu.onMessage', summary, 'ctx.serial("channel/message", msg)', vars);

    try {
      //M 4. 挂“敲键盘”表情，告诉用户收到了；仅在需要回复且非只听时挂。
      if (!facts.listenOnly) {
        await this.addTyping(app, message.message_id, address);
      }

      //M 5. 若本条属于引用回复或合并转发消息，补充拉取上下文原文及其附带资源列表；附件下载进渠道目录。
      const more = await media.related(this.feishu, appId, {
        messageId: message.message_id,
        parentId: message.parent_id || message.root_id,
        type: message.message_type,
      });
      const resources = [...facts.described.resources, ...more.resources];
      //M 引用和转发里的附件也归这次入站，连原消息的附件一起下载。
      const saved = await this.saveAttachments(facts, resources);

      //M 6. 拼成标准消息，先持久化渠道原始记录。
      const channelMessage = this.getChannelMessage(facts, address, more, saved);
      this.saveChatEntry(facts, channelMessage);

      //M 7. 发出 channel/message；短分派完成后才记 feishu_seen 去重，再汇总认领结果写流水。
      await this.deliver(facts, address, channelMessage);
    } catch (error) {
      //M 捕获入站异常后登记失败流水与控制台报错，并尝试向发信方回传简明失败原因。
      const said = textModule.getErrorMessage(error);
      this.feishu.contacts.log(facts.contact, `没处理成：${said}`);
      this.logFailedMessage(message.message_id, said);
      try {
        //M 向原聊天发回兜底失败提示并清理可能残余的“敲键盘”表情。
        await this.feishu.sendText(address, `这条消息没处理成：${said}`);
        await this.feishu.untype(address);
      } catch (again) {
        //M 连兜底错误通知也发送失败时取时间前缀记录二次日志。
        const againTime = textModule.formatLocalTime(Date.now(), 'date');
        console.error(`${againTime} 飞书：“没处理成”也没发出去：${textModule.getErrorMessage(again)}`);
      }
    }
  }

  /**
   * 第 1 步：认出这条消息的各项——@ 了哪些机器人、文字、谁在哪个群说的、来往流水的一行、投给哪些机器人。
   * @param appId 应用号。
   * @param app 应用运行时状态。
   * @param data 飞书消息事件。
   * @returns 后面几步共用的 InboundFacts。
   * 副作用：群名、人名没登记时去飞书查（Feishu.chatNames，查过的记一阵）。
   */
  private async getFacts(appId: string, app: AppState, data: ReceiveData): Promise<InboundFacts> {
    const message = data.message;
    const group = message.chat_type !== 'p2p';

    //M 认机器人：每个 @ 认出的机器人名，算不算 @ 了本应用。
    const mentioned = this.getMentions(app, data);

    //M 换成文字，去掉 @ 占位符（rawText 保留带占位符的平台可读全文，丢掉也要记流水）。
    const described = media.describe(message.message_type, message.content);
    let body = described.text;
    for (const mention of message.mentions ?? []) {
      body = body.replaceAll(mention.key, '');
    }

    //M 认人、认群：config 里登记的名字优先；群名、人名没登记的，群里再去飞书查。
    const openId = data.sender.sender_id?.open_id ?? '';
    const person = this.feishu.config.people.get(openId);
    let registered: FeishuGroup | undefined;
    if (group) {
      registered = this.feishu.config.groups.get(message.chat_id);
    }
    let chatName = registered?.name ?? '';
    let senderName = person?.name ?? '';
    if (group && (chatName === '' || senderName === '')) {
      const names = await this.feishu.chatNames(app, message.chat_id);
      chatName = chatName || names.name;
      senderName = senderName || (names.members.get(openId) ?? '');
    }
    const sender: { id: string; name?: string } = { id: openId || 'unknown' };
    if (senderName !== '') {
      sender.name = senderName;
    }

    const contact: Omit<Contact, 'outcome'> = {
      //M 取格式化日期时间戳作为联系人流水记录时间，后文裁剪正文前 80 字。
      at: textModule.formatLocalTime(Date.now(), 'date'),
      app: appId,
      chatType: message.chat_type,
      chatId: message.chat_id,
      chatName,
      openId,
      sender: senderName,
      atMe: mentioned.atMe,
      //M 截断消息文本保留摘要片段写入流水表，避免超长对话刷爆日志。
      text: textModule.clipText(body.trim(), 80),
    };

    //M 定投给谁：私聊投给全部允许的机器人；群里 @ 到的要回，登记了只听的群其余的只听。
    const targets = this.getTargets(app, group, registered, mentioned.standardMentions, mentioned.atMe);

    return {
      appId,
      message,
      group,
      standardMentions: mentioned.standardMentions,
      described,
      body,
      openId,
      person,
      registered,
      chatName,
      senderName,
      sender,
      listenOnly: !mentioned.atMe,
      targetBots: targets.targetBots,
      byBotRouting: targets.byBotRouting,
      standardMessageId: JSON.stringify([this.name, appId, message.message_id]),
      contact,
    };
  }

  /**
   * 认机器人：把飞书的 @ 清单换成标准 @（每个 @ 认出的机器人名），算这条算不算 @ 了本应用。私聊算 @ 了。
   * @param app 应用运行时状态：默认机器人、机器人自己的 open_id。
   * @param data 飞书消息事件。
   * @returns 标准 @ 清单和 atMe。
   */
  private getMentions(
    app: AppState,
    data: ReceiveData,
  ): { standardMentions: protocol.ChannelMention[]; atMe: boolean } {
    //M 取出该飞书账号配置允许投递的机器人名单，供群 @ 识别与路由拆解。
    const allowedBots = this.getAllowedBots(app.config);
    const mentions = data.message.mentions ?? [];
    const group = data.message.chat_type !== 'p2p';
    const self = app.botOpenId;

    //M @ 映射：已知本应用 botOpenId 时精确匹配，缺省时若群里有人被 @ 则按默认机器人命中（仅在当前应用允许名单里选）。
    const standardMentions: protocol.ChannelMention[] = mentions.map((item) => {
      const id = item.id.open_id ?? '';
      const botNames: string[] = [];
      if (self !== undefined && id === self) {
        botNames.push(app.config.bot);
      }
      if (self === undefined && id !== '') {
        botNames.push(app.config.bot);
      }
      let name = '';
      if (item.name !== undefined) {
        name = item.name;
      }
      //M 群内 @ 名称若与允许列表中的机器人名吻合，也记作命中该机器人。
      const matched = allowedBots.find((botName) => botName === name);
      if (matched !== undefined && !botNames.includes(matched)) {
        botNames.push(matched);
      }
      const out: protocol.ChannelMention = { id, botNames };
      if (item.key !== undefined && item.key !== '') out.token = item.key;
      if (item.name !== undefined && item.name !== '') out.name = item.name;
      return out;
    });

    let atMe = !group;
    if (group && self === undefined) {
      atMe = mentions.length > 0;
    }
    if (group && self !== undefined) {
      atMe = mentions.some((item) => item.id.open_id === self);
    }
    return { standardMentions, atMe };
  }

  /**
   * 定投给谁：私聊投给本应用允许的全部机器人；群里 @ 到的（或 @ 了本应用时的默认机器人）要回，
   * 登记了 listen: all / judge 的群其余机器人只听（judge 的要判断）。
   * @param app 应用运行时状态。
   * @param group 是不是群聊。
   * @param registered groups 里登记的这个群。
   * @param standardMentions 标准 @ 清单。
   * @param atMe 算不算 @ 了本应用。
   * @returns 投给哪些机器人、每个机器人的路由；群里谁都没投是空的。
   */
  private getTargets(
    app: AppState,
    group: boolean,
    registered: FeishuGroup | undefined,
    standardMentions: protocol.ChannelMention[],
    atMe: boolean,
  ): { targetBots: string[]; byBotRouting: Record<string, protocol.BotRoutingHint> } {
    //G 群里的提及和监听设置只在当前飞书应用允许的机器人中匹配。
    const allowedBots = this.getAllowedBots(app.config);
    let targetBots: string[] = [];
    const byBotRouting: Record<string, protocol.BotRoutingHint> = {};
    if (!group) {
      targetBots = [...allowedBots];
      for (const botName of targetBots) {
        byBotRouting[botName] = { listenOnly: false };
      }
    }
    if (group) {
      const canListenAll = registered?.listen === 'all' || registered?.listen === 'judge';
      for (const botName of allowedBots) {
        const mentionedBot = standardMentions.some((m) => m.botNames.includes(botName));
        const activeForBot = mentionedBot || (atMe && botName === app.config.bot);
        if (activeForBot) {
          //M 被点名的机器人进入要回复的分派。
          targetBots.push(botName);
          byBotRouting[botName] = { listenOnly: false };
          continue;
        }
        if (canListenAll) {
          //M 群已登记全量监听时，没被点名的机器人也能记背景或判断是否接话。
          targetBots.push(botName);
          byBotRouting[botName] = { listenOnly: true, judge: registered?.listen === 'judge' };
        }
      }
    }
    return { targetBots, byBotRouting };
  }

  /**
   * 第 2 步：群里没 @ 任何目标机器人且没登记只听的——存原始聊天日志、记去重、记流水“丢了”，不交给机器人。
   * @param facts 第 1 步认出的。
   */
  private keepDropped(facts: InboundFacts): void {
    const message = facts.message;
    const droppedEntry: FeishuChatLogEntry = {
      messageId: facts.standardMessageId,
      nativeId: message.message_id,
      appId: facts.appId,
      chatId: message.chat_id,
      direction: 'user',
      createdAt: Date.now(),
      sender: facts.sender,
      text: facts.body.trim() || '[空消息]',
      mentions: facts.standardMentions,
      attachments: [],
    };
    //M 未触发回复或监听的群聊消息仍需落盘原始聊天历史、登记已见防重投并记为“丢了”。
    this.feishu.history.appendChatLog(facts.appId, message.chat_id, droppedEntry);
    this.markSeen(facts.appId, message.message_id);
    //M 追加一条“丢了”来往流水供核对群过滤情况。
    this.feishu.contacts.log(facts.contact, '丢了');
    const vars = { appId: facts.appId, chat: message.chat_id };
    this.ctx.emit('trace', 'Feishu.onMessage', 'trace.feishu.skipGroupReply', 'atMe === false', vars);
  }

  /**
   * 第 3 步前半：私聊的记成这个应用最近私聊的人（feishu_p2p）；群聊、拿不到 open_id 的不记。
   * @param facts 第 1 步认出的。
   */
  private rememberPrivate(facts: InboundFacts): void {
    const message = facts.message;
    if (message.chat_type !== 'p2p' || facts.openId === '') return;

    const sql = 'INSERT INTO feishu_p2p (app_id, chat_id, open_id, message_id, at) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT(app_id) DO UPDATE SET chat_id = excluded.chat_id, open_id = excluded.open_id,'
      + ' message_id = excluded.message_id, at = excluded.at';
    //M 更新该应用最近私聊联系人映射，供发件箱、定时提醒与跨渠道云文档授权复用。
    this.ctx.resources.db.query(sql).run(facts.appId, message.chat_id, facts.openId, message.message_id, Date.now());
  }

  /**
   * 第 3 步后半：拼回话地址——客户号、说话人是哪一档、群名、人名、只听、判断、转发方式、受不受信。
   * @param facts 第 1 步认出的。
   * @returns 回话地址（会话的 row.address、标准消息的 origin.address 都从它来）。
   */
  private getAddress(facts: InboundFacts): FeishuAddress {
    const message = facts.message;
    const registered = facts.registered;
    const listenOnly = facts.listenOnly;
    const address: FeishuAddress = {
      appId: facts.appId,
      chatId: message.chat_id,
      messageId: message.message_id,
      openId: facts.openId,
      chatType: message.chat_type,
      //M 按会话类型计算统一客户键，供前台与记忆插件区分私聊与群聊上下文。
      customer: feishuCustomer(message.chat_type, message.chat_id, facts.openId),
      //M 根据配置填充说话人的身份角色与限定工作目录（owner 不写 workspace）。
      ...roleFields(facts.person, this.ctx.resources.ensureRuntimeDir('guests', GUEST_DIR)),
    };
    if (facts.chatName !== '') address.chatName = facts.chatName;
    if (facts.senderName !== '') address.senderName = facts.senderName;
    if (listenOnly) address.listenOnly = true;
    if (listenOnly && registered?.listen === 'judge') address.judge = true;
    if (listenOnly && registered?.listen === 'judge' && registered.judgeThreshold !== undefined) {
      address.judgeThreshold = registered.judgeThreshold;
    }
    if (registered !== undefined) address.relay = registered.relay;
    if (registered !== undefined) address.trusted = registered.trusted;
    return address;
  }

  /**
   * 第 4 步：挂“敲键盘”表情，告诉用户收到了；表情号记在地址上，回话时撤。挂不上只打日志，不挡后面。
   * @param app 应用运行时状态（SDK 客户端）。
   * @param messageId 飞书消息号。
   * @param address 回话地址：挂上了写 typingReaction。
   */
  private async addTyping(app: AppState, messageId: string, address: FeishuAddress): Promise<void> {
    try {
      //M 先给当前这条消息挂表情，让用户看到机器人已收到。
      const reaction = await api.call('挂表情', () => app.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'Typing' } },
      }));
      const reactionId = reaction.data?.reaction_id;
      if (reactionId !== undefined && reactionId !== '') address.typingReaction = reactionId;
    } catch (error) {
      //M 取格式化日期前缀记录挂“敲键盘”表情失败日志，不阻断主流程。
      const logTime = textModule.formatLocalTime(Date.now(), 'date');
      console.error(`${logTime} 飞书：表情没挂上：${textModule.getErrorMessage(error)}`);
    }
  }

  /**
   * 第 5 步后半：附件一个个下载，存进飞书自己的渠道目录（channels/feishu/attachments/<应用>/<日期>/）。
   * 不直接写入单一机器人私有工作区；认领后再由每个机器人按授权工作区物化。
   * 单个下载失败记成不可用、原因附进正文，不挡整条消息。
   * @param facts 第 1 步认出的。
   * @param resources 这条本身的资源，加上引用、转发里的资源。
   * @returns 标准附件清单；没下载下来的每个一句原因。
   */
  private async saveAttachments(
    facts: InboundFacts,
    resources: media.Resource[],
  ): Promise<{ attachments: protocol.ChannelAttachment[]; failed: string[] }> {
    const message = facts.message;
    const attachments: protocol.ChannelAttachment[] = [];
    const failed: string[] = [];
    //M 分应用和落盘日期保存原附件，等各机器人认领后再复制到自己的目录。
    const appDir = namesModule.getSafeName(facts.appId, Infinity);
    const day = new Date().toLocaleDateString('sv-SE');
    const attachDir = this.ctx.resources.ensureRuntimeDir('channels', 'feishu', 'attachments', appDir, day);
    for (const [idx, resource] of resources.entries()) {
      const attachId = `${message.message_id}:${String(idx)}`;
      try {
        //M 引用或转发里的资源按它自己的消息号下载。
        const sourceMessageId = resource.messageId ?? message.message_id;
        const content = await media.download(this.feishu, facts.appId, sourceMessageId, resource);
        const originalName = path.win32.basename(resource.name);
        const safe = namesModule.getSafeName(originalName, Infinity);
        const prefix = namesModule.getSafeName(message.message_id, 60);
        const filePath = path.join(attachDir, `${prefix}_${String(idx)}_${safe}`);
        fs.writeFileSync(filePath, content);
        //M 文件已落盘才登记为可用，认领时通过此引用找到原件。
        attachments.push({
          id: attachId,
          name: resource.name,
          size: content.length,
          sourceRef: filePath,
          state: 'available',
        });
      } catch (error) {
        //M 单个附件下载失败时记为不可用并把报错附进正文，不阻塞整条消息处理。
        const reason = textModule.getErrorMessage(error);
        failed.push(`[${resource.name} 没下载下来：${reason}]`);
        attachments.push({
          id: attachId,
          name: resource.name,
          sourceRef: '',
          state: 'unavailable',
          reason,
        });
      }
    }
    return { attachments, failed };
  }

  /**
   * 第 6 步前半：拼标准消息 channel/message——正文（引用、正文、转发、没下载下来的附件）、引用的哪条、角色、可见范围、路由。
   * @param facts 第 1 步认出的。
   * @param address 回话地址：克隆一份放进 origin。
   * @param more 引用、合并转发补回来的原文。
   * @param saved 第 5 步存好的附件和失败原因。
   * @returns 标准消息。
   */
  private getChannelMessage(
    facts: InboundFacts,
    address: FeishuAddress,
    more: media.Related,
    saved: { attachments: protocol.ChannelAttachment[]; failed: string[] },
  ): protocol.ChannelMessage {
    const message = facts.message;
    const appId = facts.appId;
    const parts = [more.quote, facts.body.trim(), more.forwarded, saved.failed.join('\n')];
    //M 合并引用、原话和附件错误，统一用占位文字表示空消息。
    const text = parts.filter((part) => part !== '').join('\n') || '[空消息]';
    const receivedAt = Date.now();
    let replyTo: protocol.ChannelReplyTo | null = null;
    const rawParent = message.parent_id || message.root_id;
    if (rawParent !== undefined && rawParent !== '') {
      replyTo = {
        nativeId: rawParent,
        messageId: JSON.stringify([this.name, appId, rawParent]),
      };
    }

    let chatType: protocol.ChannelChatType = 'group';
    if (message.chat_type === 'p2p') {
      chatType = 'p2p';
    }
    if (message.chat_type !== 'p2p' && message.chat_type !== 'group') {
      chatType = 'group';
    }

    const role: protocol.ChannelRole = address.role ?? 'guest';
    const trusted = !facts.group || address.trusted === true;
    const scope = `${this.name}:${appId}:${message.chat_id}`;
    const routing: protocol.ChannelRouting = { listenOnly: facts.listenOnly, byBot: facts.byBotRouting };
    if (address.judge === true) {
      routing.judge = true;
    }
    return {
      v: 1,
      messageId: facts.standardMessageId,
      nativeId: message.message_id,
      channel: this.name,
      accountId: appId,
      chatId: message.chat_id,
      chatType,
      sender: facts.sender,
      role,
      targetBots: facts.targetBots,
      mentions: facts.standardMentions,
      rawText: facts.described.text,
      text,
      attachments: saved.attachments,
      createdAt: receivedAt,
      receivedAt,
      timeSource: 'received',
      replyTo,
      origin: {
        channel: this.name,
        address: structuredClone(address) as unknown as Record<string, unknown>,
      },
      visibility: {
        scope,
        trusted,
        publicSourceIds: [],
      },
      routing,
    };
  }

  /**
   * 第 6 步后半：标准消息写进聊天日志（附件只留元数据，不带本地路径），供后续历史查询及审计使用。
   * @param facts 第 1 步认出的。
   * @param channelMessage 第 6 步拼好的标准消息。
   */
  private saveChatEntry(facts: InboundFacts, channelMessage: protocol.ChannelMessage): void {
    const message = facts.message;
    const chatEntry: FeishuChatLogEntry = {
      messageId: facts.standardMessageId,
      nativeId: message.message_id,
      appId: facts.appId,
      chatId: message.chat_id,
      direction: 'user',
      createdAt: channelMessage.createdAt,
      sender: channelMessage.sender,
      text: channelMessage.text,
      mentions: facts.standardMentions,
      attachments: channelMessage.attachments.map((item) => {
        const clean: FeishuChatLogEntry['attachments'][number] = {
          id: item.id,
          name: item.name,
          state: item.state,
        };
        if (item.mime !== undefined) clean.mime = item.mime;
        if (item.size !== undefined) clean.size = item.size;
        return clean;
      }),
    };
    //M 将入站消息标准化条目写入本地渠道聊天日志，供后续历史查询及审计使用。
    this.feishu.history.appendChatLog(facts.appId, message.chat_id, chatEntry);
  }

  /**
   * 第 7 步：发 channel/message 交给机器人认领 → 记去重 → 汇总认领结果写来往流水 → 没会话接就撤“敲键盘”表情。
   * 处理期间原消息已被撤回的：只记去重和流水“已撤回”，不发事件。
   * @param facts 第 1 步认出的。
   * @param address 回话地址（撤表情用；前台判断的结果 judged 也看它）。
   * @param channelMessage 第 6 步拼好的标准消息。
   */
  private async deliver(
    facts: InboundFacts,
    address: FeishuAddress,
    channelMessage: protocol.ChannelMessage,
  ): Promise<void> {
    const appId = facts.appId;
    const messageId = facts.message.message_id;

    //G 处理入站期间原消息已被撤回 → 补记去重与流水后立即退出，不再发 channel/message 拉起会话。
    if (this.recalledNativeIds.has(`${appId}:${messageId}`)) {
      this.markSeen(appId, messageId);
      this.feishu.contacts.log(facts.contact, '已撤回');
      return;
    }

    const control: protocol.ChannelMessageControl = { claims: [] };
    await this.ctx.serial('channel/message', channelMessage, control);

    //M 确认原消息存盘且同步分发流程完成后才写 feishu_seen，防止崩溃丢消息。
    this.markSeen(appId, messageId);

    //M 根据各插件填回的认领声明汇总本条消息的最终流向并写入来往流水。
    const outcome = this.resolveOutcome(control, facts.listenOnly, messageId, address.judged);
    this.feishu.contacts.log(facts.contact, outcome);

    //M 若无机器人认领会话（或被审批插件直接截断），立即撤掉之前挂上的“敲键盘”表情。
    const hasSessionClaim = control.claims.some((c) => c.status === 'claimed' || c.status === 'relay');
    if (address.typingReaction !== undefined
      && (control.approvalHandled === true
        || (!hasSessionClaim && this.takenBy(messageId) === undefined))) {
      //M 调用撤回接口移除“正在输入”表情反馈。
      await this.feishu.untype(address);
    }
  }

  /**
   * 记下这条消息收过了（feishu_seen，kind 是 in）：飞书重推时 onMessage 认得。丢了、已撤回、交给机器人以后各调一次。
   * @param appId 应用号。
   * @param messageId 飞书消息号。
   */
  private markSeen(appId: string, messageId: string): void {
    const sql = 'INSERT OR IGNORE INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)';
    //M 分派完成后记住消息号与时间，后续重推可以跳过。
    this.ctx.resources.db.query(sql).run(messageId, appId, 'in', Date.now());
  }

  /**
   * 汇总一条飞书消息在 channel/message 后的流水结果文案。
   * @param control 协调结果。
   * @param listenOnly 原默认是否只听。
   * @param nativeId 飞书原生消息号（兼容未迁移路径）。
   * @param legacyJudged 旧字段 judged。
   */
  private resolveOutcome(
    control: protocol.ChannelMessageControl,
    listenOnly: boolean,
    nativeId: string,
    legacyJudged?: string,
  ): string {
    if (control.approvalHandled === true) return '别的插件处理掉了';

    //M 先查看是否有决定型或转发型插件在认领列表里给出了自定义结果说明。
    const judgedClaim = control.claims.find((c) => c.judged !== undefined);
    if (judgedClaim?.judged !== undefined) return judgedClaim.judged;

    if (legacyJudged !== undefined) return legacyJudged;

    //M 若认领表中标记为转给外部助手，则记为转外部助手。
    const relayClaim = control.claims.find((c) => c.status === 'relay');
    if (relayClaim !== undefined) return '转外部助手';

    //M 若已被某个会话正式认领或去重归并，则记为交给会话。
    const sessionClaim = control.claims.find((c) => c.status === 'claimed' || c.status === 'duplicate');
    if (sessionClaim !== undefined) return '交给会话';

    //M 若仅以旁听背景形式记录下来，则记为只记。
    const listenClaim = control.claims.find((c) => c.status === 'listen');
    if (listenClaim !== undefined) return '只记';

    //M 若被拦截性插件直接消化处理，则记为别的插件处理掉了。
    const handledClaim = control.claims.find((c) => c.status === 'handled');
    if (handledClaim !== undefined) return '别的插件处理掉了';

    //M 全无声明时回退按本地会话表认领记录归类最终流水状态。
    const kind = this.takenBy(nativeId);
    return getOutcome(kind, listenOnly);
  }

  /**
   * 一个飞书应用配置允许的目标机器人名单（去重保序，缺省 [config.bot]）。
   * @param app 应用配置。
   */
  private getAllowedBots(app: FeishuApp): string[] {
    const list = [app.bot, ...(app.bots ?? [])];
    return [...new Set(list)];
  }

  /**
   * 这条消息是哪种会话接的：回话地址是它的那场飞书会话。
   * @param messageId 飞书消息号。
   * @returns 会话种类（front、relay……）；没有会话接（只记了、被别的插件处理掉了）是 undefined。
   */
  private takenBy(messageId: string): string | undefined {
    //M Sessions.find 每一项用 json_extract(meta, '$.项') 比，所以 address.messageId 这种嵌套的也能找。
    const where = { channel: 'feishu', 'address.messageId': messageId } as unknown as Partial<SessionMeta>;
    return this.ctx.sessions.find(where)[0]?.kind;
  }

  /**
   * 登记已收到撤回通知的平台原消息键 `${appId}:${nativeId}`（最多保留 500 条）。
   * @param appId 飞书应用号。
   * @param nativeId 飞书原生消息号。
   */
  private rememberRecalledNative(appId: string, nativeId: string): void {
    //M 将平台原消息键写入已撤回集合，超过容量上限时淘汰最早登记的一条。
    this.recalledNativeIds.add(`${appId}:${nativeId}`);
    if (this.recalledNativeIds.size <= 500) return;

    const oldest = this.recalledNativeIds.values().next().value;
    if (oldest !== undefined) {
      this.recalledNativeIds.delete(oldest);
    }
  }

  /**
   * 收到飞书 im.message.recalled_v1 撤回事件：只认本人或原发消息人撤回，通知 bots 停掉对应正在跑或排队的任务。
   * @param appId 哪个飞书应用收到撤回事件。
   * @param data 飞书撤回事件载荷。
   */
  async onRecall(appId: string, data: RecallData): Promise<void> {
    //G 忽略未知应用或缺少消息/聊天标识的残缺事件。
    if (!this.feishu.apps.has(appId)) return;

    const nativeId = data.message_id ?? '';
    const chatId = data.chat_id ?? '';
    if (nativeId === '' || chatId === '') return;

    //M 按与 channel/message 完全一致的口径算出标准消息号，并读取本地聊天日志查出原发送人。
    const standardMessageId = protocol.makeChannelMessageId(this.name, appId, nativeId);
    const chatLog = this.feishu.history.readChatLog(appId, chatId);
    const logged = chatLog.find((entry) => entry.messageId === standardMessageId);

    //G 机器人自己撤回的出站消息不触发停任务。
    if (logged?.direction === 'bot') return;

    //M 若事件携带操作者 open_id，核对是否本人（owner）或该条原发消息人。
    const operatorId = data.operator_id?.open_id ?? '';
    let recalledId = '';
    let isOwner = false;
    let kind: 'sender' | 'owner' = 'sender';
    if (operatorId !== '') {
      //M 查询操作者在 people 配置里的身份档位并对照原消息发送者。
      const operatorOwner = this.feishu.config.people.get(operatorId)?.role === 'owner';
      let operatorIsSender = data.recall_type === 'message_owner';
      if (logged !== undefined) {
        operatorIsSender = logged.sender.id === operatorId;
      }
      if (!operatorOwner && !operatorIsSender) return;

      recalledId = operatorId;
      isOwner = operatorOwner;
      if (operatorOwner) {
        kind = 'owner';
      }
    }

    //M 标准飞书撤回事件未带操作者时，仅放行原发信人本人自撤（message_owner），群管代撤无法确认是否本人一律忽略。
    if (operatorId === '') {
      if (data.recall_type !== 'message_owner') return;

      //M 查出原发信人 ID 并校验其是否在 people 里登记为本人（owner）。
      recalledId = logged?.sender.id ?? '';
      isOwner = recalledId !== '' && this.feishu.config.people.get(recalledId)?.role === 'owner';
      if (isOwner) {
        kind = 'owner';
      }
    }

    //M 先登记撤回消息号以拦截附件下载中的入站和在途回话，再发 channel/recall 让 bots 立即停跑与清队列。
    this.rememberRecalledNative(appId, nativeId);
    const vars = { appId: appId, chat: chatId, originalMessageId: nativeId, recalledBy: recalledId || 'message_owner', owner: isOwner };
    this.ctx.emit('trace', 'Feishu.onRecall', 'trace.feishu.recallMessage', "ctx.serial('channel/recall', event)", vars);
    await this.ctx.serial('channel/recall', {
      channel: this.name,
      accountId: appId,
      chatId,
      messageId: standardMessageId,
      nativeId,
      recalledBy: { id: recalledId, kind, isOwner },
    });
  }

  /**
   * 点卡片按钮：认出是哪张卡片、谁点的、按钮值，交给 cards/ 处理，回给飞书一个小提示。
   * @param appId 哪个应用收的。
   * @param data 飞书的 card.action.trigger 事件（新版回调）；旧版字段也认。
   * @returns { toast }：SDK 把它当回调的回应带回飞书。
   */
  async onCard(appId: string, data: unknown): Promise<{ toast: Toast }> {
    const event = (data ?? {}) as {
      operator?: { open_id?: string };
      context?: { open_message_id?: string; open_chat_id?: string };
      action?: { value?: unknown };
      open_id?: string;
      open_message_id?: string;
      open_chat_id?: string;
    };
    const openId = event.operator?.open_id ?? event.open_id ?? '';
    const cardId = event.context?.open_message_id ?? event.open_message_id ?? '';
    const chatId = event.context?.open_chat_id ?? event.open_chat_id ?? '';

    //M 按钮值：对象直接用；字符串先当 JSON 解析。
    let value = event.action?.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        value = {};
      }
    }
    //M 结合 feishu_p2p 表反查点击来源是否为私聊并构建标准回话地址结构。
    const p2pSql = 'SELECT 1 FROM feishu_p2p WHERE app_id = ? AND chat_id = ?';
    const p2p = chatId !== '' && this.ctx.resources.db.query(p2pSql).get(appId, chatId) !== null;
    let chatType = '';
    if (chatId !== '') {
      chatType = 'group';
    }
    if (p2p) {
      chatType = 'p2p';
    }
    let customerChatType = '';
    if (p2p) {
      customerChatType = 'p2p';
    }
    //M 按聊天类型与私聊反查结果生成标准客户标识（群与私聊保持隔离）。
    const customer = feishuCustomer(customerChatType, chatId, openId, p2p);
    const address: FeishuAddress = { appId, chatId, messageId: cardId, openId, chatType, customer };
    //M 点卡片的人是哪一档：和收消息一样只看 people。
    const guestDir = this.ctx.resources.ensureRuntimeDir('guests', GUEST_DIR);
    //M 提取人员档位字段（owner / role / workspace）写入回话地址。
    const fields = roleFields(this.feishu.config.people.get(openId), guestDir);
    Object.assign(address, fields);
    //M 群受不受信：和收消息一样按群号查 groups。
    if (!p2p) {
      const registered = this.feishu.config.groups.get(chatId);
      if (registered !== undefined) {
        address.trusted = registered.trusted;
      }
    }


    //T 跟踪：点了卡片按钮。
    const vars = { appId: appId, cardId: cardId, button: JSON.stringify(value ?? {}) };
    this.ctx.emit('trace', 'Feishu.onCard', 'trace.feishu.cardAction', 'cards.onAction(...)', vars);
    try {
      const action = (value ?? {}) as Record<string, unknown>;

      //M 转交卡片操作，等待进度事件或审批结果生成提示。
      const toast = await cards.onAction(this.feishu, this.ctx, address, cardId, action);
      return { toast: toast ?? { type: 'info', content: '这个按钮没有用了' } };
    } catch (error) {
      return { toast: { type: 'error', content: `没处理成：${textModule.getErrorMessage(error)}` } };
    }
  }
}
