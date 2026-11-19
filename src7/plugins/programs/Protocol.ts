/** 读取外部程序的启动通知和生命周期接口，校验跨进程回执；渠道回调的常量和格式两边共用（外置程序直接 import）。 */
import * as crypto from 'node:crypto';
import type * as readline from 'node:readline';
import type { ProgramSpec } from './Spec.ts';

/** 当前支持的程序管理协议版本。 */
const PROTOCOL = 1;

/** 子进程环境里的一次性密钥：每次拉起都换，进程退出就作废。 */
export const KEY_ENV = 'JMBOTS_PROGRAM_KEY';
/** 子进程环境里的回调前缀（如 http://127.0.0.1:30086/api/programs/wechat），只给登记了渠道的程序。 */
export const CALLBACK_ENV = 'JMBOTS_CALLBACK_URL';
/** 两个方向的渠道调用都用这个请求头带密钥。 */
export const KEY_HEADER = 'x-jmbots-key';

/** 附件摘要：原件留在外部程序里，主程序只拿名字和类型。 */
export interface AttachmentNote {
  /** 给人看的名字（文件名或“图片”这类）。 */
  name: string;
  /** MIME 类型，知道才写。 */
  mime?: string;
  /** 字节数，知道才写。 */
  size?: number;
}

/** 程序交给主程序的一条渠道消息：POST <回调前缀>/channel/message。 */
export interface InboundMessage {
  /** 渠道名，只能是 config 给这个程序登记的。 */
  channel: string;
  /** 平台账号。 */
  account: string;
  /** 聊天号。 */
  chat: string;
  /** 聊天显示名，没有写空串。 */
  chatName: string;
  /** 私聊或群聊。 */
  chatType: 'p2p' | 'group';
  /** 来源消息号，同一渠道同一账号里唯一，重发要同一个。 */
  nativeId: string;
  /** 发信人。 */
  sender: { id: string; name?: string };
  /** 正文（非文字消息写成“[图片]”这类）。 */
  text: string;
  /** 附件摘要，没有是空列表。 */
  attachments: AttachmentNote[];
  /** 平台上的发出时刻，Unix 毫秒；不知道写 0。 */
  createdAt: number;
  /** 群里是不是 @ 了自己。 */
  mentioned: boolean;
}

/** 入站回执：accepted 已收并发给机器人，duplicate 收过了，rejected 没收（看 reason）。 */
export interface InboundReceipt {
  /** accepted、duplicate 为 true。 */
  ok: boolean;
  /** 结论。 */
  status: 'accepted' | 'duplicate' | 'rejected';
  /** 主程序里的标准消息号（收下时有）。 */
  messageId?: string;
  /** 拒收原因，或已收但没有机器人认领的说明。 */
  reason?: string;
}

/** 主程序请程序回一条话：POST <程序>/jmbots/v1/channel/reply。 */
export interface ReplyCall {
  /** 请求号：同一条回复重试时不变，程序按它去重。 */
  requestId: string;
  /** 渠道名。 */
  channel: string;
  /** 平台账号；跨聊天发话时为空串，由程序按聊天号或名字自己认。 */
  account: string;
  /** 聊天号（跨聊天时可能是名字）。 */
  chat: string;
  /** 聊天显示名，不知道是空串。 */
  chatName: string;
  /** 正文。 */
  text: string;
  /** 哪个机器人说的。 */
  bot: string;
  /** progress 中途的话，final 最后的答复。 */
  kind: 'progress' | 'final';
}

/** 程序回复接口的回执状态：已发、已存草稿、失败、不确定。 */
export type ReplyCallStatus = 'sent' | 'draft' | 'failed' | 'uncertain';

/**
 * 按固定时间比较两把密钥，不因为前几个字相同就早退。
 * @param expected 这次启动发出去的密钥；程序没在运行是 undefined。
 * @param given 请求头里带来的值。
 * @returns 一样才是 true；任何一边没有都是 false。
 */
export function isSameKey(expected: string | undefined, given: unknown): boolean {
  if (expected === undefined || typeof given !== 'string') return false;

  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  if (left.length !== right.length) return false;

  //M timingSafeEqual 要两边一样长，上面先比过长度。
  return crypto.timingSafeEqual(left, right);
}

/** 程序报上来且无法升级兼容的协议版本。 */
export class UnsupportedProtocol extends Error {}

/** 已校验的就绪行。进程号始终使用父进程自己拿到的值。 */
export interface ReadyLine {
  /** 程序版本。 */
  version: string;
  /** 程序实际监听的端口。 */
  port: number;
}

/**
 * 等候第一条带数字 jmbots 字段的 JSON 行，忽略普通日志。
 * @param reader 正在转存 stdout 的行读取器。
 * @param spec 配置的程序身份、端口和启动超时。
 * @param signal 进程退出或监督停止时中止。
 * @returns 已核对的端口与版本。
 * @throws 协议不支持、公告不合法、超时或中止。
 */
export async function waitReady(
  reader: readline.Interface,
  spec: ProgramSpec,
  signal: AbortSignal,
): Promise<ReadyLine> {
  const announcement = Promise.withResolvers<ReadyLine>();
  const deadline = AbortSignal.timeout(spec.startupMs);
  const until = AbortSignal.any([signal, deadline]);

  //G 注册监听前可能已经收到停机信号，直接结束。
  until.throwIfAborted();

  const abort = (): void => {
    if (deadline.aborted) {
      announcement.reject(new Error('启动超时，未收到就绪行'));
      return;
    }
    announcement.reject(until.reason);
  };
  const onLine = (line: string): void => {
    try {
      //M 日志里的普通行继续落盘，只有协议声明负责就绪结果。
      const ready = parseReady(line, spec);
      if (ready !== undefined) announcement.resolve(ready);
    } catch (error) {
      announcement.reject(error);
    }
  };

  //M 同时等待就绪行与中止，完成后只保留日志监听。
  reader.on('line', onLine);
  until.addEventListener('abort', abort, { once: true });
  try {
    return await announcement.promise;
  } finally {
    reader.off('line', onLine);
    until.removeEventListener('abort', abort);
  }
}

/** 解析可选的就绪行。遇到第一条协议声明时校验全部字段。 */
function parseReady(line: string, spec: ProgramSpec): ReadyLine | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof decoded !== 'object' || decoded === null) return undefined;

  const raw = decoded as Record<string, unknown>;
  const protocol = raw['jmbots'];
  if (typeof protocol !== 'number') return undefined;

  //G 版本不兼容时阻止自动重试，等用户换正确的程序。
  if (protocol !== PROTOCOL) {
    throw new UnsupportedProtocol(`协议版本不对（程序 ${String(protocol)}，jmbots 支持 ${String(PROTOCOL)}）`);
  }
  if (raw['event'] !== 'ready' || raw['name'] !== spec.name) {
    throw new Error(`就绪行的事件或程序名和 ${spec.name} 不符`);
  }
  const version = raw['version'];
  if (typeof version !== 'string' || version.trim() === '') throw new Error('就绪行缺少程序版本');

  const port = raw['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('就绪行端口要是 1 至 65535 的整数');
  }
  if (spec.port !== 0 && port !== spec.port) throw new Error(`就绪行端口与配置 ${String(spec.port)} 不符`);

  return { version, port };
}

/**
 * 通过标准接口核对程序在响应且身份一致。
 * @param url 程序的本机地址。
 * @param name 预期的程序名称。
 * @param route 启动时取 info，随后读 health。
 * @param timeoutMs 检查时限。
 * @param signal 监督或子进程停止时中止。
 * @returns 收到符合协议的健康回执时为 true。
 */
export async function checkProgram(
  url: string, name: string, route: 'info' | 'health', timeoutMs: number, signal: AbortSignal,
): Promise<boolean> {
  //M 兼容原布尔接口，细节由同一跨进程入口校验。
  const report = await readReport(url, name, route, timeoutMs, signal);
  return report !== undefined;
}

/**
 * 让已经报端口的程序先自行关闭。
 * @param url 程序的本机地址。
 * @param graceMs 程序完成收尾的最长时间。
 * @throws 连不上时交给托管方继续走强制退出路径。
 */
export async function requestExit(url: string, graceMs: number): Promise<void> {
  const endpoint = `${url}/jmbots/v1/exit`;
  const signal = AbortSignal.timeout(1000);
  const body = JSON.stringify({ graceMs });
  const options: RequestInit = {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, signal, body,
  };

  //M 请求程序收尾，读完短回执再由托管方等待进程退出。
  const response = await fetch(endpoint, options);
  await response.text();
}

/** info和health的已校验可选信息；程序不支持的字段保持缺席。 */
export interface ProgramReport {
  /** 只承认显式声明的pause能力。 */
  pause: boolean;
  /** 当前进程自报的常驻内存，MiB，不枚举系统进程。 */
  rssMb: number | undefined;
  /** 已校验的程序内部界面路径，缺席或非法为null。 */
  ui: string | null;
}

/** 核对info/health身份并读取可选RSS与能力，失败不冒充健康或零内存。 */
export async function readReport(
  url: string, name: string, route: 'info' | 'health', timeoutMs: number, signal: AbortSignal,
): Promise<ProgramReport | undefined> {
  const endpoint = `${url}/jmbots/v1/${route}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const until = AbortSignal.any([signal, timeout]);
  const options: RequestInit = { signal: until, redirect: 'error' };
  try {
    //M 只信已核对协议与程序名的回执，不让错误服务提供资源排行或暂停能力。
    const response = await fetch(endpoint, options);
    const decoded: unknown = await response.json();
    if (!response.ok || typeof decoded !== 'object' || decoded === null) return undefined;

    const raw = decoded as Record<string, unknown>;
    if (raw['ok'] !== true || raw['protocol'] !== PROTOCOL || raw['name'] !== name) return undefined;

    const capabilities = raw['capabilities'];
    const pause = Array.isArray(capabilities) && capabilities.includes('pause');
    let rssMb: number | undefined;
    const rss = raw['rssMb'];
    if (typeof rss === 'number' && Number.isFinite(rss) && rss >= 0) {
      rssMb = rss;
    }
    //M 界面只接受程序内部路径，不接受任意主机、端口或脚本URL。
    const ui = getUiPath(raw['ui']);
    return { pause, rssMb, ui };
  } catch {
    return undefined;
  }
}

/** 仅已通过info身份校验的Host调用；过期只报告，不关程序。 */
export async function readLicense(url: string, signal: AbortSignal): Promise<string | undefined> {
  const endpoint = `${url}/jmbots/v1/license`;
  const timeout = AbortSignal.timeout(1000);
  const until = AbortSignal.any([signal, timeout]);
  const options: RequestInit = { signal: until, redirect: 'error' };
  try {
    //M 授权接口按既定v1契约只有ok/state，不强加协议里没有的身份字段。
    const response = await fetch(endpoint, options);
    const decoded: unknown = await response.json();
    if (!response.ok || typeof decoded !== 'object' || decoded === null) return undefined;

    const raw = decoded as Record<string, unknown>;
    const state = raw['state'];
    if (raw['ok'] !== true) return undefined;
    if (state === 'licensed' || state === 'expired' || state === 'none' || state === 'free') return state;
    return undefined;
  } catch {
    return undefined;
  }
}

/** 对声明了pause能力的自有就绪进程请求暂停/恢复；不使用OS挂起或任意PID。 */
export async function requestPause(url: string, paused: boolean, signal: AbortSignal): Promise<boolean> {
  let action = 'resume';
  if (paused) {
    action = 'pause';
  }
  const endpoint = `${url}/jmbots/v1/${action}`;
  const timeout = AbortSignal.timeout(1000);
  const until = AbortSignal.any([signal, timeout]);
  const body = JSON.stringify({ reason: 'mem-limit' });
  const options: RequestInit = {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, signal: until, body,
  };
  try {
    //M 有明确确认才改变Host的暂停状态，404和业务失败不当成功。
    const response = await fetch(endpoint, options);
    const decoded: unknown = await response.json();
    if (!response.ok || typeof decoded !== 'object' || decoded === null) return false;

    const raw = decoded as Record<string, unknown>;
    return raw['ok'] === true && raw['paused'] === paused;
  } catch {
    return false;
  }
}

/** 核对外部info的UI入口，只允许单斜线根路径且不含跳转、查询或回溯段。 */
export function getUiPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\\\x00-\x20?#]/u.test(value)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (/[\\\x00-\x20?#]/u.test(decoded) || decoded.startsWith('//')) return null;
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return value;
}

/** 商业授权只是程序自报显示，不授予任何命令执行或用户安全批准。 */
export function getLicenseLabel(state: string | undefined): string {
  if (state === 'licensed') return '已授权';
  if (state === 'expired') return '过期';
  if (state === 'free') return '不需要';
  if (state === 'none') return '不需要';
  return '未知';
}
