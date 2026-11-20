/**
 * 外置微信独立进程自包含的 programs v1 协议常量、消息契约与定长密钥比对工具。
 * 与主站 `programs` 协议严格对齐，零跨目录引用 `src7/`。
 */
import * as crypto from 'node:crypto';


/** 当前实现的进程插件协议版本号。 */
export const PROTOCOL_VERSION = 1;

/** 宿主通过子进程环境变量下发的一次性通信密钥名。 */
export const KEY_ENV = 'JMBOTS_PROGRAM_KEY';

/** 宿主通过子进程环境变量下发的渠道回调地址前缀名。 */
export const CALLBACK_ENV = 'JMBOTS_CALLBACK_URL';

/** 双向 HTTP 渠道调用携带一次性密钥的请求头名。 */
export const KEY_HEADER = 'x-jmbots-key';


/** 渠道入站或历史消息附带的附件摘要（原件保留在外置插件本地）。 */
export interface AttachmentNote {
  /** 给人看的附件类型或名称（如“图片”“语音”）。 */
  name: string;
  /** 可选 MIME 类型。 */
  mime?: string;
  /** 可选字节大小。 */
  size?: number;
}

/** 外置程序推送给主站 `/channel/message` 的标准入站消息。 */
export interface InboundMessage {
  /** 已登记给本程序的渠道名。 */
  channel: string;
  /** 微信平台账号标识。 */
  account: string;
  /** 微信会话标识（原始 username）。 */
  chat: string;
  /** 会话显示名。 */
  chatName: string;
  /** 私聊或群聊类别。 */
  chatType: 'p2p' | 'group';
  /** 同一账号下稳定可重放的来源消息号。 */
  nativeId: string;
  /** 发送者标识与可选群昵称。 */
  sender: { id: string; name?: string };
  /** 可读文本正文或非文字类型摘要。 */
  text: string;
  /** 附件摘要列表。 */
  attachments: AttachmentNote[];
  /** 消息毫秒级 Unix 时间戳。 */
  createdAt: number;
  /** 群聊中是否提及了本账号。 */
  mentioned: boolean;
}

/** 主站对入站消息返回的确认回执。 */
export interface InboundReceipt {
  /** accepted 或 duplicate 时为 true。 */
  ok: boolean;
  /** 入站处理状态。 */
  status: 'accepted' | 'duplicate' | 'rejected';
  /** 主站生成的标准消息号。 */
  messageId?: string;
  /** 拒收或无人认领说明。 */
  reason?: string;
}

/** 主站调用 `/jmbots/v1/channel/reply` 的回执状态枚举。 */
export type ReplyCallStatus = 'sent' | 'draft' | 'failed' | 'uncertain';


/**
 * 使用定长安全比较验证请求头携带的密钥是否与本次宿主密钥完全一致。
 * @param expected 本进程启动时收到的宿主密钥。
 * @param given HTTP 请求头传入的待核验值。
 */
export function isSameKey(expected: string | undefined, given: unknown): boolean {
  if (expected === undefined || typeof given !== 'string') return false;

  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(given, 'utf8');
  if (left.byteLength !== right.byteLength) return false;

  //M 长度相等后再走 timingSafeEqual，杜绝时序侧信道。
  return crypto.timingSafeEqual(left, right);
}
