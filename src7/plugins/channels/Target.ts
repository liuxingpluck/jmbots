/**
 * 渠道协议：跨渠道、跨聊天发话（目标描述、能不能跨、目标串怎么拆、候选聊天怎么认、认不出怎么说）。
 * 只放类型和无状态小函数；真正认聊天的是各渠道自己。
 */
import * as workspaceModule from '../../utils/Workspace.ts';
import type * as messageModule from './Message.ts';


/** 跨渠道或跨聊天发话时附带的目标描述（由目标渠道自行识别聊天）。 */
export interface ChannelReplyTarget {
  /** 规范化后的目标渠道名（feishu / wechat / http / cli）。 */
  channel: string;
  /** 调用方给出的原始聊天标识或名称（如群号、群名、本机等），由目标渠道自己认；带 address 时只作展示。 */
  chat: string;
  /**
   * 渠道自己的确切地址（会话记着的回话地址、relay 收件记下的地址、本人批准过的账号和聊天），形状归各渠道。
   * 给了就照它发，渠道不再按 chat 认聊天；只有 bots、relay、approval 这些已经拿着地址的插件填。
   */
  address?: Record<string, unknown>;
}


/** 渠道认跨渠道发话的目标聊天时，拆好的目标串（parseChatTarget 交回）。 */
export interface ChatTarget {
  /** trim 后的整串。 */
  exact: string;
  /** 去掉展示前缀（如“微信·”）的整串，按名字认聊天用；拆出“前缀:聊天”后要不要换成 chat 由渠道定。 */
  label: string;
  /** “前缀:聊天”写法冒号左边（trim 后）；不是这种写法是空串。前缀代表应用号、账号还是渠道名，由渠道自己认。 */
  prefix: string;
  /** “前缀:聊天”写法冒号右边（trim 后）；不是这种写法是空串。 */
  chat: string;
}


/** 一个候选聊天：渠道从自己的数据里拼出来，交给 findChatByIdOrName 认。 */
export interface ChatCandidate<T> {
  /** 能认出它的号（群号、聊天号、open_id 等）。 */
  ids: string[];
  /** 能认出它的名字（群名、人名）；空串不参与比对。 */
  names: string[];
  /** 认中后交回的东西（渠道自己的地址片段）。 */
  value: T;
}


/**
 * 统一判定当前来源快照是否拥有本人（owner）跨渠道、跨聊天发话的权限。
 * 外人（isOwnerTurn 判：地址含 guest / builder、owner: false，或渠道不是网页、命令行又没写 owner）一律拒绝；飞书 owner 放行；本机网页和命令行默认视为本人。
 * @param snapshot 不可变来源快照。
 * @returns 是本人返回 true，外人返回 false。
 */
export function canReplyAcrossChats(snapshot: messageModule.SourceSnapshot): boolean {
  //G 这一轮不是本人（地址标了 guest、builder、owner: false，或非网页、命令行的渠道没写 owner）一律禁止越界。
  if (!workspaceModule.isOwnerTurn(snapshot.channel, snapshot.origin.address)) return false;

  //G 群聊里本人说话也不跨：当前群聊调用不能切换到别的聊天（11-18 中控补）。
  if (snapshot.chatType === 'group') return false;

  //M 飞书等渠道已验证为 owner 档位时允许跨渠道、跨聊天发送。
  if (snapshot.role === 'owner') return true;

  //M 本机网页与命令行入口未标记为外人时默认视为本人操作。
  const isLocalChannel = snapshot.channel === 'http' || snapshot.channel === 'cli';
  if (isLocalChannel && snapshot.chatType === 'local' && snapshot.role !== 'builder') return true;

  return false;
}


/**
 * 拆跨渠道发话的目标串：trim、去掉网页展示的渠道前缀、拆出“前缀:聊天”。
 * @param raw 调用方给的原始聊天串。
 * @param labelPrefixes 渠道的展示前缀（如“飞书·群·”“微信·”），命中第一个就去掉。
 * @returns 拆好的目标串。
 */
export function parseChatTarget(raw: string, labelPrefixes: string[]): ChatTarget {
  const exact = raw.trim();

  //M 去掉网页展示名前面带的渠道前缀，剩下的按名字认。
  let label = exact;
  const labelPrefix = labelPrefixes.find((one) => exact.startsWith(one));
  if (labelPrefix !== undefined) {
    label = exact.slice(labelPrefix.length);
  }

  //M “前缀:聊天”写法：冒号不在开头、两边去空白后都不空才算。
  const plain = { exact, label, prefix: '', chat: '' };
  const sep = exact.indexOf(':');
  if (sep <= 0) return plain;

  const prefix = exact.slice(0, sep).trim();
  const chat = exact.slice(sep + 1).trim();
  if (prefix === '' || chat === '') return plain;

  return { exact, label, prefix, chat };
}


/**
 * 在候选清单里认聊天：按先后看，号对上、或名字（不空）对上的第一个就是。
 * 候选可以边认边拼（生成器）：认到就停，排在后面的来源不再读。
 * @param candidates 渠道拼出的候选，排在前面的优先。
 * @param id 要找的号。
 * @param name 要找的名字。
 * @returns 认中的那个候选带的 value；都没对上是 undefined。
 */
export function findChatByIdOrName<T>(candidates: Iterable<ChatCandidate<T>>, id: string, name: string): T | undefined {
  for (const candidate of candidates) {
    //M 号对上就是它。
    if (candidate.ids.includes(id)) return candidate.value;

    //M 名字对上也算；空名字不算，免得空串认错。
    const sameName = candidate.names.some((one) => one !== '' && one === name);
    if (sameName) return candidate.value;
  }
  return undefined;
}


/**
 * 认不出目标聊天时的原因文字（registerTextReply 和自己认聊天的飞书共用）。
 * @param chat 调用方给的原始聊天串。
 * @returns “chat_not_found：没有叫 X 的聊天”，X 是 trim 后的串，空串写成（空）。
 */
export function getChatNotFoundMessage(chat: string): string {
  let label = chat.trim();
  if (label === '') {
    label = '（空）';
  }
  return `chat_not_found：没有叫 ${label} 的聊天`;
}
