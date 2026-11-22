/**
 * relay 入站收话分流、助手前缀匹配、说话人身份提取与 webhook 载荷组装。
 * 将原 index.ts 中交叉判断的收话逻辑拆成三条扁平直路，行为 100% 等价。
 */
import * as utils from '../../utils/index.ts';
import type { ChatKind, Helper, InboxItem, OwnerP2pDirectRule, RelayMode, Speaker } from './index.ts';


/**
 * 话开头连续的附件标记、引用未取到提示、@提及和空白（prefixed 认前缀前跳过）。
 * 涵盖 [图片]/[表情包]/[文件]/[语音…]/[视频…]/[引用的消息没取到…]、@"绝对路径"/@绝对路径，以及群聊前导的 @名字 空白。
 */
const ATTACHMENT_MARKS = new RegExp(
  '^(?:\\s|\\[(?:图片|表情包|文件|语音[^\\]]*|视频[^\\]]*|引用的消息没取到[^\\]]*)\\]'
    + '|@"[^"]*"|@(?:[A-Za-z]:[\\\\/]|\\/)\\S*|@\\S+\\s+)*',
  'u',
);


/**
 * 按客户号认聊天种类：飞书群的客户号是 feishu:group:<chat_id>，别的都算私聊。
 * @param customer 会话或回话地址里的客户号；没有给 ''。
 * @returns group 或 p2p。
 */
export function getChat(customer: string): ChatKind {
  if (customer.startsWith('feishu:group:')) return 'group';

  return 'p2p';
}


/**
 * 从渠道回话地址提取说话人身份与群聊显示信息。
 * @param address 渠道回话地址。
 * @returns 说话人结构。
 */
export function getSpeaker(address: unknown): Speaker {
  const openId = utils.getStringField(address, 'openId');
  const chat = getChat(utils.getStringField(address, 'customer'));
  const sender = utils.getStringField(address, 'senderName') || openId.slice(-6);
  const groupName = utils.getStringField(address, 'chatName') || utils.getStringField(address, 'chatId');
  let chatName = '';
  if (chat === 'group') {
    chatName = groupName;
  }
  return {
    owner: utils.getField(address, 'owner') === true,
    role: utils.getStringField(address, 'role'),
    workspace: utils.getStringField(address, 'workspace'),
    sender,
    chat,
    chatName,
  };
}


/**
 * 跳过前导附件标记、@提及和配对【回复的消息：…】引用块后，返回用于前缀匹配的纯正文副本。
 * @param text 用户原话。
 * @returns 剥离前导噪声后的文本。
 */
export function stripLeadingNoise(text: string): string {
  let said = text.replace(ATTACHMENT_MARKS, '');
  if (!said.startsWith('【回复的消息：') && !said.startsWith('【回复的消息未取到】')) {
    return said;
  }

  let depth = 0;
  for (let index = 0; index < said.length; index += 1) {
    const mark = said[index];
    if (mark === '【') {
      depth += 1;
    }
    if (mark === '】') {
      depth -= 1;
    }
    if (depth !== 0) continue;

    return said.slice(index + 1).replace(ATTACHMENT_MARKS, '');
  }
  return said;
}


/**
 * 判断正文是否命中单个助手前缀（中文结尾前缀免空格分词，英文前缀要求词边界）。
 */
function matchesSinglePrefix(said: string, prefix: string): boolean {
  const head = prefix.trim();
  if (said.slice(0, head.length).toLowerCase() !== head.toLowerCase()) return false;
  if (/\p{Script=Han}$/u.test(head)) return true;

  const next = said.charAt(head.length);
  return next === '' || /\p{Script=Han}/u.test(next) || !/[\p{L}\p{N}_]/u.test(next);
}


/**
 * 按配置顺序选出第一个前缀命中的外部助手。
 * @param helpers 已校验的助手清单。
 * @param text 用户原话。
 * @returns 命中的助手；未命中返回 undefined。
 */
export function matchHelperPrefix(helpers: readonly Helper[], text: string): Helper | undefined {
  const said = stripLeadingNoise(text);
  return helpers.find((helper) => helper.prefixes.some((p) => matchesSinglePrefix(said, p)));
}


/**
 * 判定是否命中“仅本人私聊指定机器人免前缀直通”（owner_p2p_direct）严格安全守卫：
 * 1. 目标机器人 bot 命中 owner_p2p_direct 规则；
 * 2. getChat(customer) === 'p2p' 且 address.chatType !== 'group'（严禁任何群聊触发）；
 * 3. address.owner === true（严禁任何外人/访客私聊触发）；
 * 4. address.listenOnly !== true（只听消息绝不触发）。
 */
export function matchOwnerP2pDirectHelper(
  bot: string,
  address: unknown,
  helpers: readonly Helper[],
  ownerP2pDirect: readonly OwnerP2pDirectRule[] = [],
): Helper | undefined {
  if (bot === '' || ownerP2pDirect.length === 0) return undefined;

  const rule = ownerP2pDirect.find((item) => item.bot === bot);
  if (rule === undefined) return undefined;
  if (utils.getField(address, 'listenOnly') === true) return undefined;
  if (utils.getField(address, 'owner') !== true) return undefined;
  if (utils.getStringField(address, 'chatType') === 'group') return undefined;

  const customer = utils.getStringField(address, 'customer');
  if (getChat(customer) !== 'p2p') return undefined;

  return helpers.find((helper) => helper.name === rule.helper);
}


/**
 * 入站收话三条扁平分流规则（消除原交叉嵌套条件，行为 100% 等价）：
 * 1. 群攒批转交（address.relayHelper 非空）：直接进 relay 会话；
 * 2. 非只听状态下的 direct 机器人：整句进该客户的前台会话（由 direct 前台拦截直转）；
 * 3. 只听消息或非 direct 机器人：命中助手前缀，或命中 owner_p2p_direct 严格五重守卫时进 relay 会话，否则放行给后续插件。
 * @param botMode 该机器人的 relay 模式。
 * @param address 入站消息回话地址。
 * @param text 入站消息正文。
 * @param helpers 外部助手清单。
 * @param bot 目标机器人名（用于匹配 owner_p2p_direct）。
 * @param ownerP2pDirect 仅本人私聊指定机器人免前缀直通规则。
 * @returns 目标会话种类（front / relay）；不截走返回 undefined。
 */
export function pickReceiveSessionKind(
  botMode: RelayMode | undefined,
  address: unknown,
  text: string,
  helpers: readonly Helper[],
  bot = '',
  ownerP2pDirect: readonly OwnerP2pDirectRule[] = [],
): 'front' | 'relay' | undefined {
  //M 第 1 条路：群攒批指定了外部助手（judge_helper → relayHelper），直接进 relay 会话。
  const relayHelper = utils.getStringField(address, 'relayHelper').trim();
  if (relayHelper !== '') return 'relay';

  //M 第 2 条路：非只听的 direct 机器人，全部进该客户的 front 会话。
  const listenOnly = utils.getField(address, 'listenOnly') === true;
  if (!listenOnly && botMode === 'direct') return 'front';

  //M 第 3 条路：命中助手前缀，或命中“仅本人私聊指定机器人免前缀直通”，进 relay 会话。
  if (matchHelperPrefix(helpers, text) !== undefined) return 'relay';
  if (matchOwnerP2pDirectHelper(bot, address, helpers, ownerP2pDirect) !== undefined) return 'relay';

  return undefined;
}


/**
 * 生成供 relay_send 工具描述与 model 会话系统提示词共用的转话边界说明。
 */
export function formatWhenToRelay(helpers: [Helper, ...Helper[]]): string {
  const helper = helpers[0].title;
  const heads = [...new Set(helpers.flatMap((one) => one.prefixes.map((prefix) => prefix.trim())))];
  let skip = '';
  if (heads.length > 0) {
    skip = `以 ${heads.join('、')} 开头的话已经直接转给外部助手了，不用再转。`;
  }
  return `只有对方明确要外部助手（点名 ${helper}、或用了助手前缀），或者必须动项目代码时，才用 relay_send 把要点转给外部助手 ${helper}；`
    + `一般技术解释、资料查询、定方案、闲聊、打招呼都自己答，自己答不够就交办自己的后台会话，不转。${skip}`;
}


/**
 * 把配置里的 webhook_header 解析为 HTTP 请求头字典。
 */
export function webhookAuthHeaders(header: string): Record<string, string> {
  const raw = header.trim();
  if (raw === '') return {};

  const match = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*([\s\S]*)$/u.exec(raw);
  if (match === null || match[1] === undefined) return { Authorization: raw };

  const name = match[1];
  const value = (match[2] ?? '').trim();
  if (name.toLowerCase() === 'authorization') return { Authorization: value };

  return { [name]: value };
}


/**
 * 构造推送给外部助手 webhook 的 JSON 载荷。
 */
export function buildWebhookBody(item: InboxItem, address: unknown): Record<string, unknown> {
  const text = item.text;
  const quoted = /^【回复的消息：([\s\S]*?)】\n?/u.exec(text);
  let bodyText = text;
  if (quoted !== null) {
    bodyText = text.slice(quoted[0].length);
  }
  const chatId = utils.getStringField(address, 'chatId') || utils.getStringField(address, 'chat');
  return {
    id: item.id,
    bot: item.bot,
    channel: item.channel,
    chat: chatId,
    chat_type: item.chat,
    chat_name: item.chatName,
    sender_open_id: utils.getStringField(address, 'openId'),
    sender: item.sender,
    message_id: utils.getStringField(address, 'messageId'),
    owner: item.owner,
    role: item.role,
    workspace: item.workspace,
    text: bodyText,
    files: item.files,
    reply_to: quoted?.[1] ?? null,
    time: item.at,
  };
}
