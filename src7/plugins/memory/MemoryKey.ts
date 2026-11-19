/**
 * 记忆归属键（按人分记忆第 1 步，用户 #182）：一条渠道消息算谁的记忆，只在这里算。
 *   私聊 person:<渠道>:<对面那个人的 ID>；群聊 group:<渠道>:<聊天号>，说话人另用 getSpeakerKey 记；
 *   网页、命令行、语音这些本机来源（chatType local）归本人 owner。
 * 渠道索引的 memory_key 列存它，送 Rust 时放进 customer 一维；统一检索的 person、group 参数就是它。
 * 召回怎么用这个键（谁能看谁的）不在这里定，见 docs/开发进度/按人分记忆_一页_20261118.md。
 */
import type * as channelProtocol from '../../Channels.ts';
import type { SessionMeta } from '../../Sessions.ts';
import * as utils from '../../utils/index.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import type { ChannelRow } from './ChannelIndex.ts';


/** 本人的键：本机来源都归它，也可以当 person 参数查。 */
export const OWNER_KEY = 'owner';


/** 本轮记忆权限。full 为 false 时必须有归属键才有权读取。 */
export interface MemoryAccess {
  full: boolean;
  key?: string;
  channel?: string;
  chat?: string;
  account?: string;
}


/** 算归属键要的几样。 */
export interface KeySource {
  /** 渠道名：feishu、wechat、http…… */
  channel: string;
  /** 聊天种类：p2p、group、local；补旧不知道是空串。 */
  chatType: string;
  /** 聊天号：飞书 chat_id、微信会话名。 */
  chat: string;
  /** 私聊里对面那个人的原始 ID：用户的话是发话人，机器人的回复是被回的那个人；不知道是空串。 */
  person: string;
}


/**
 * 一条消息的归属键。
 * @param source 渠道、聊天种类、聊天号、私聊对面的人。
 * @returns 私聊 person:<渠道>:<ID>，群聊 group:<渠道>:<聊天号>，本机 owner；
 *   聊天种类不明、私聊不知道对面是谁时是空串（这样的行照旧分区，等补写）。
 */
export function getMemoryKey(source: KeySource): string {
  //M 本机来源（网页、命令行、语音）只有本人在用。
  if (source.chatType === 'local') return OWNER_KEY;

  //G 渠道缺失时无法用原始 ID 区分消息归属。
  if (source.channel === '') return '';

  //M 群里说的话归这个群，群里的人共享。
  if (source.chatType === 'group' && source.chat !== '') return `group:${source.channel}:${source.chat}`;

  //G 不是私聊（补旧没记种类）或不知道对面是谁：不硬猜，留空等补写。
  if (source.chatType !== 'p2p' || source.person === '') return '';

  //M 私聊里的话归对面那个人。
  return getPersonKey(source.channel, source.person);
}


/** 从旧回话地址取明确的群号或私聊对象。未知来源保持空归属。 */
export function getOriginSource(channel: string, address: unknown): KeySource {
  //M 提取渠道持久化的聊天标识和对端用户标识。
  let chat = utils.getStringField(address, 'chatId') || utils.getStringField(address, 'chat');
  let chatType = utils.getStringField(address, 'chatType');
  let person = utils.getStringField(address, 'senderId') || utils.getStringField(address, 'openId');
  if (channel === 'wechat' && chatType === 'p2p') {
    person = chat;
  }
  if ((channel === 'http' || channel === 'web' || channel === 'cli') && chatType === '') {
    chatType = 'local';
  }

  //G 旧地址若写明是群，不能用其中最后一位发言人推断个人归属。
  if (workspaceModule.isGroup(address)) {
    chatType = 'group';
    const customer = utils.getStringField(address, 'customer');
    const prefix = 'feishu:group:';
    if (chat === '' && channel === 'feishu' && customer.startsWith(prefix)) {
      chat = customer.slice(prefix.length);
    }
  }
  return { channel, chat, chatType, person };
}


/** 索引已记录的会话时使用归属键，确保重新同步前台往来时保留补标。 */
export function getSessionMemoryKey(row: SessionMeta): string {
  const snapshot = row.frontTask?.sourceSnapshot ?? row.activeSourceSnapshot;
  if (snapshot !== undefined) {
    //M 有标准快照时沿用原消息归属，不用会话目前的地址覆盖。
    const source = getSnapshotSource(snapshot);
    return getMemoryKey(source);
  }
  const origin = row.frontTask?.origin;
  const channel = origin?.channel ?? row.channel ?? '';
  const address = origin?.address ?? row.address;
  //M 旧来源仅使用会话当时记下的渠道和地址。
  const source = getOriginSource(channel, address);
  return getMemoryKey(source);
}


/** 标准来源快照中的发言人、群号和渠道。 */
function getSnapshotSource(snapshot: channelProtocol.SourceSnapshot): KeySource {
  return {
    channel: snapshot.channel,
    chatType: snapshot.chatType,
    chat: snapshot.chatId ?? '',
    person: snapshot.senderId ?? '',
  };
}


/** 本人的私人记忆可进入非群聊和明确登记的受信群。 */
function canReadAll(owner: boolean, address: unknown, chatType: string): boolean {
  //G 以本轮身份和渠道设置为准；来源标为群时仍须有明确的 trusted 字段。
  if (!owner || !workspaceModule.isPrivateMemoryAllowed(address)) return false;

  if (chatType !== 'group') return true;

  //G 普通群的地址可能没写聊天类型，仍要求受信标记是明确的布尔真值。
  return utils.getField(address, 'trusted') === true;
}


/** 按可信的本轮来源决定能查谁。受信群仅本人放行其他分区。 */
export function getMemoryAccess(row: SessionMeta): MemoryAccess {
  const snapshot = row.frontTask?.sourceSnapshot ?? row.activeSourceSnapshot;
  if (snapshot !== undefined) {
    //M 后台沿用派活时的快照，前台沿用本轮渠道快照。
    const source = getSnapshotSource(snapshot);
    //G 渠道档位决定本人身份，受信群的标记从同一份来源快照里取。
    const owner = snapshot.role === 'owner';
    const address = snapshot.origin.address;
    const full = canReadAll(owner, address, source.chatType);
    const scope = { full, channel: snapshot.channel, chat: snapshot.chatId, account: snapshot.accountId };
    if (full) return scope;

    //G 未授予本人权限的本机快照也不能读取 owner 记忆。
    if (snapshot.chatType === 'local') return scope;

    //M 派生可信的个人或群键供当前模型请求使用。
    const key = getMemoryKey(source);
    return { ...scope, key: key || undefined };
  }

  //M 老会话用于比较的来源仍取其快照地址，内部会话沿用原有本人权限。
  const origin = row.frontTask?.origin;
  const channel = origin?.channel ?? row.channel ?? '';
  const address = origin?.address ?? row.address;
  const source = getOriginSource(channel, address);
  const role = workspaceModule.getSpeakerRole(address);
  const internal = channel === '' || source.chatType === 'local';
  //G 缺少角色只在内部非群聊沿用本人的旧默认。群聊必须明确识别出本人。
  const localOwner = role === '' && internal && source.chatType !== 'group';
  const owner = role === 'owner' || localOwner;
  const full = canReadAll(owner, address, source.chatType);
  if (full) return { full };

  if (source.chatType === 'local') return { full };

  //M 老来源只能按明确的归属和渠道帐号继续读取。
  const key = getMemoryKey(source);
  const account = utils.getStringField(address, 'accountId') || utils.getStringField(address, 'appId');
  return { full, key: key || undefined, channel: channel || undefined, chat: source.chat || undefined, account };
}


/**
 * 说话人键：群里的段落归群，靠它留住是谁说的。
 * @param row 渠道索引的一行。
 * @returns 机器人 bot:<名字>，本机 owner，别人 person:<渠道>:<发话人 ID>。
 */
export function getSpeakerKey(row: ChannelRow): string {
  if (row.direction === 'bot') {
    //M 实时回复有机器人名，早期归档可能只存了渠道发言人 ID。
    const speaker = row.bot || row.senderId;
    if (speaker === '') return '';

    return `bot:${speaker}`;
  }

  if (row.chatType === 'local') return OWNER_KEY;

  //G 没记下发言人时保留空值，避免生成一个可误用于身份匹配的键。
  if (row.senderId === '' || row.channel === '') return '';

  //M 人说的话：和私聊归属键同一种写法，以后能按人认出他在群里说过什么。
  return getPersonKey(row.channel, row.senderId);
}


/**
 * 查询入口用：person、group 参数是不是这里算出来的那种键。
 * @param kind person 或 group。
 * @param value 参数值（已去掉两头空白）。
 */
export function isMemoryKey(kind: 'person' | 'group', value: string): boolean {
  //M 本人的键只当 person 用。
  if (kind === 'person' && value === OWNER_KEY) return true;

  //M 别的都要以 person: 或 group: 开头。
  const prefix = `${kind}:`;
  if (!value.startsWith(prefix)) return false;

  //M 前缀后面是 <渠道>:<ID 或聊天号>，渠道名里没有冒号，ID 和聊天号不能是空的。
  const rest = value.slice(prefix.length);
  return /^[^:]+:.+$/u.test(rest);
}


/** 一个人的键：person:<渠道>:<原始 ID>。 */
function getPersonKey(channel: string, id: string): string {
  return `person:${channel}:${id}`;
}
