/**
 * 网页要的接口和网页托管（docs/界面/01_界面设计.md 第 12 节）。Http.ts 的 HttpApp.build 经 new UiRoutes(parts).register(app) 注册：
 *   GET  /、其他不是 /api 开头的路径   托管 dist/web（单页：找不到的路径回 index.html）
 *   GET  /api/messages            ?bot=&before=&after=&limit=&origin= 消息列表：每条带附件、回复、分派简要；origin 是 web（只要网页发的）或 other（只要别的渠道的）
 *   GET  /api/messages/:id/trace   ?reply=0 只读查看具体回复的来源、事件边界及缺失说明，不调用模型。
 *   GET  /api/search              ?q=&bot=&limit= 搜聊天：消息原话和回复、会话标题和摘要（docs/界面/01_界面设计.md 6.1）；不给 bot 搜所有机器人
 *   POST /api/bots                {name, identity, language, model?, feishu?: {app_id, app_secret}} 新建机器人，不用重启（6.2）
 *   PUT  /api/uploads/:name       原始字节存进运行时 data/tmp/uploads/，返回 {id, name, size, kind}
 *   GET  /api/files               ?path= 读文件（支持 Range，按扩展名给类型）
 *   GET  /api/files/list          ?path= 列目录
 *   GET  /api/models              模型清单
 *   POST /api/models/reconnect    {provider?} 重新测试模型连接（设置“重连”）：重拉模型清单，拉到了原地换掉，不用重启
 *   GET  /api/ui/sessions         ?bot=&status= 会话列表（不带对话全文）
 *   GET  /api/ui/bots/:name       一个机器人的目录、工作区、记忆概要（右栏的工作区和详情用）
 *   GET  /api/settings            配置内容，明文（用户 11-05：能进设置页的人本来就有权限）
 *   PUT  /api/settings            [{path, value} | {path, delete: true}] 按顺序改 config.yaml（保留注释和没见过的键）
 *   POST /api/settings/apply      重启生效：后台跑 scripts/Swap_Serve.ts --skip_checks yes
 *   POST /api/service/restart     重启服务（设置“重连”）：请基地停掉后端再拉起；源码模式、老版本基地和重启生效一样
 *   GET  /api/ui/info             这个后端进程什么时候起的（重启后网页靠它认出是新进程）
 *   GET  /api/memory/search、/api/memory/health、/api/rag/search、/api/rag/index，POST /api/rag/index   原样转发给 engine.index_url（本地壳子）
 * 另外导出给 Http.ts 用的：botStatus（/api/bots 每项多的字段）、takeUploads（/api/message 的 uploads）。
 * 文件接口只给运行时的 bots/、skills/、memory/、knowledge/ 和各工作区的工作目录；任何情况下都不给 config.yaml、.env、secrets.yaml。
 */
import type * as fastify from 'fastify';
import * as childProcess from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as streamPromises from 'node:stream/promises';
import * as yaml from 'yaml';
import * as model from '../capabilities/Model.ts';
import * as replyEvidence from '../capabilities/ReplyEvidence.ts';
import * as traceModule from '../capabilities/Trace.ts';
import * as embedded from '../resources/Embedded.ts';
import * as versionsModule from '../Versions.ts';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import type * as httpModule from './Http.ts';
import type * as filesModule from '../capabilities/Files.ts';
import type * as storeModule from '../capabilities/Store.ts';
import type * as dispatchModule from '../dispatch/Dispatch.ts';


/** 附件的四种。 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';


/** 文字里认出来的一个附件。 */
export interface Attachment {
  /** 绝对路径。 */
  path: string;
  /** 文件名。 */
  name: string;
  /** 哪一种。 */
  kind: AttachmentKind;
  /** 大小，字节；文件已经不在了是 null。 */
  size: number | null;
  /** 静态文件地址（GET /files/...），别的程序对接用；不在运行时目录里的文件没有。 */
  url?: string;
}


/** 机器人状态（界面设计第 6 节）；连不上后端的 off 由网页自己显示。 */
export type BotStatus = 'waiting' | 'working' | 'idle';


/** /api/bots 每项多出来的字段。 */
export interface BotStatusView {
  /** 有待确认 → waiting；有运行中的会话 → working；有消息在排队或分派中 → waiting；都没有 → idle。 */
  status: BotStatus;
  /** 运行中的会话有几个。 */
  running: number;
  /** 还没进会话的消息有几条（新到、分派中、已分派）。 */
  queued: number;
  /** 待确认有几条。 */
  approvals: number;
}


/** 分派的简要：时间线上的事件行用。 */
export interface DispatchBrief {
  /** 新开还是追加。 */
  action: 'new' | 'append';
  /** 进了哪个会话。 */
  sessionId: string;
  /** 会话标题（取最新的）。 */
  title: string;
  /** 会话 md 的路径，点了在右栏打开；会话不在了是空。 */
  file: string;
  /** 分派定的模型；追加又没换模型时是空。 */
  model: string;
  /** 工作区。 */
  workspace: string;
  /** 谁定的：decision、llm、fallback；直接指定会话的是 direct。 */
  by: string;
  /** 一句话理由。 */
  reason: string;
}


/** 时间线上的一条回复。 */
export interface ReplyView {
  /** 发出的时间，毫秒。 */
  at: number;
  /** 哪个会话回的。 */
  session: storeModule.Reply['session'];
  /** 回了什么。 */
  text: string;
  /** 回复里 @路径 带的附件。 */
  attachments: Attachment[];
  /** 这句文本的生成依据；历史无法可靠恢复时明确为 unknown。 */
  generation: storeModule.ReplyGeneration;
  /** 这句回复可以证明的输入范围，与 trace.target 保持一致。 */
  association: storeModule.ReplyAssociation;
}


/** 时间线上的一条消息。 */
export interface MessageView {
  /** 消息号。 */
  id: number;
  /** 哪个机器人的。 */
  bot: string;
  /** 渠道：http，或 feishu:<应用 ID>。 */
  channel: string;
  /** 来源。 */
  source: string;
  /** 原话（附件已换成 @路径）。 */
  text: string;
  /** 状态。 */
  status: storeModule.MessageStatus;
  /** 进了哪个会话。 */
  sessionId: string | null;
  /** 消息文件。 */
  file: string;
  /** 收到的时间，毫秒。 */
  createdAt: number;
  /** 最后改动的时间，毫秒（轮询拿它当游标）。 */
  updatedAt: number;
  /** 原话里 @路径 带的附件。 */
  attachments: Attachment[];
  /** 回复。 */
  replies: ReplyView[];
  /** 分派简要；还没分派是 null。 */
  dispatch: DispatchBrief | null;
}


/** 带 HTTP 状态码的错误。 */
class HttpError extends Error {
  /**
   * @param status HTTP 状态码。
   * @param message 说明。
   */
  constructor(readonly status: number, message: string) {
    super(message);
  }
}


/** 一次最多取多少条消息。 */
const MAX_MESSAGE_LIMIT = 200;

/** 回完话多久退出（让回答先发出去），毫秒。 */
const EXIT_DELAY_MS = 300;

/** 刚开始换版本多久之内，“立即重启”不再起一个，毫秒。 */
const APPLY_BUSY_MS = 20_000;

/** 没写 limit 时取多少条。 */
const DEFAULT_MESSAGE_LIMIT = 50;

/** 网页发的消息的来源（web/src/Api.ts 的 from）。 */
const WEB_SOURCE = 'web';

/** 转发给本地壳子最多等多久，毫秒。 */
const FORWARD_TIMEOUT_MS = 15_000;

/** 任何情况下都不给看的文件名。 */
const SECRET_FILES = /^(config\.yaml|secrets\.yaml|\.env(\..*)?)$/i;

/** 扩展名 → 附件类别和 Content-Type。 */
const FILE_TYPES: Record<string, [AttachmentKind, string]> = {
  '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'],
  '.bmp': ['image', 'image/bmp'],
  '.svg': ['image', 'image/svg+xml'],
  '.ico': ['image', 'image/x-icon'],
  '.avif': ['image', 'image/avif'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.wav': ['audio', 'audio/wav'],
  '.ogg': ['audio', 'audio/ogg'],
  '.opus': ['audio', 'audio/ogg'],
  '.m4a': ['audio', 'audio/mp4'],
  '.aac': ['audio', 'audio/aac'],
  '.flac': ['audio', 'audio/flac'],
  '.amr': ['audio', 'audio/amr'],
  '.mp4': ['video', 'video/mp4'],
  '.m4v': ['video', 'video/mp4'],
  '.webm': ['video', 'video/webm'],
  '.mov': ['video', 'video/quicktime'],
  '.mkv': ['video', 'video/x-matroska'],
  '.avi': ['video', 'video/x-msvideo'],
  '.pdf': ['file', 'application/pdf'],
  '.md': ['file', 'text/markdown; charset=utf-8'],
  '.txt': ['file', 'text/plain; charset=utf-8'],
  '.log': ['file', 'text/plain; charset=utf-8'],
  '.json': ['file', 'application/json; charset=utf-8'],
  '.yaml': ['file', 'text/yaml; charset=utf-8'],
  '.yml': ['file', 'text/yaml; charset=utf-8'],
  '.csv': ['file', 'text/csv; charset=utf-8'],
  '.html': ['file', 'text/html; charset=utf-8'],
  '.css': ['file', 'text/css; charset=utf-8'],
  '.js': ['file', 'text/javascript; charset=utf-8'],
  '.mjs': ['file', 'text/javascript; charset=utf-8'],
  '.map': ['file', 'application/json; charset=utf-8'],
  '.woff2': ['file', 'font/woff2'],
  '.woff': ['file', 'font/woff'],
  '.ttf': ['file', 'font/ttf'],
};

/** 当纯文字给的代码文件（预览时等宽显示）。 */
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.toml', '.xml', '.ini', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.java', '.c', '.h', '.cpp', '.cs']);

/** 代码目录（本文件在 src/channels/ 下）。 */
const CODE_DIR = path.resolve(import.meta.dir, '..', '..');

/** 打包好的网页在哪：代码目录下的 dist/web。 */
const WEB_DIR = path.join(CODE_DIR, 'dist', 'web');

/** 这个进程什么时候起的，毫秒（重启后网页靠它认出是新进程）。 */
const STARTED_AT = Date.now();

/** 机器人名字里不许有的字（Windows 文件夹名不许的）；结尾也不许是点或空格。控制字符另外查。 */
const BAD_BOT_NAME = /[<>:"|?*]|[. ]$/u;

/** 搜聊天每组默认几条。 */
const SEARCH_LIMIT = 20;

/** 搜聊天每组最多几条。 */
const MAX_SEARCH_LIMIT = 50;

/** 搜聊天的片段：命中处前后各留几个字。 */
const SNIPPET_AROUND = 40;


/**
 * 文字里有没有这个关键字（不分大小写）。
 * @param text 文字。
 * @param keyword 关键字。
 */
function includesFolded(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}


/**
 * 新建机器人时填的飞书应用：两个都填才算，都不填是 undefined。
 * @param value 请求体里的 feishu。
 * @throws 只填了一个、不是字符串时抛错。
 */
function feishuOf(value: unknown): { app_id: string; app_secret: string } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  /** 当成对象看。 */
  const item = checks.asRecord(value, 'feishu');
  /** app_id。 */
  const appId = typeof item.app_id === 'string' ? item.app_id.trim() : '';
  /** app_secret。 */
  const appSecret = typeof item.app_secret === 'string' ? item.app_secret.trim() : '';
  if (!appId && !appSecret) {
    return undefined;
  }
  if (!appId || !appSecret) {
    throw new HttpError(400, '飞书应用的 app_id 和 app_secret 要两个都填');
  }
  return { app_id: appId, app_secret: appSecret };
}


/**
 * 搜聊天结果里的片段：命中处前后各 SNIPPET_AROUND 字，截掉的一头加“…”，换行压成空格；没命中给开头一段。
 * @param text 文字。
 * @param keyword 关键字。
 */
function snippetOf(text: string, keyword: string): string {
  /** 压成一行的文字。 */
  const flat = text.replace(/\s+/g, ' ').trim();
  /** 命中的位置。 */
  const at = flat.toLowerCase().indexOf(keyword.toLowerCase());
  /** 从哪截。 */
  const start = at < 0 ? 0 : Math.max(0, at - SNIPPET_AROUND);
  /** 截到哪。 */
  const end = at < 0 ? Math.min(flat.length, SNIPPET_AROUND * 2) : Math.min(flat.length, at + keyword.length + SNIPPET_AROUND);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}


/** 改配置的一步：设一个值，或删掉一项。路径里字符串是键、数字是列表的第几项。 */
export type SettingEdit = { path: (string | number)[]; value: unknown } | { path: (string | number)[]; delete: true };


/**
 * 文件名是哪一类附件。
 * @param name 文件名或路径。
 * @returns image、audio、video 或 file。
 */
export function attachmentKind(name: string): AttachmentKind {
  return FILE_TYPES[path.extname(name).toLowerCase()]?.[0] ?? 'file';
}


/**
 * 按扩展名给 Content-Type；认不出的代码文件当纯文字，别的当二进制。
 * @param name 文件名或路径。
 */
function contentType(name: string): string {
  /** 扩展名。 */
  const extension = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    return 'text/plain; charset=utf-8';
  }
  return FILE_TYPES[extension]?.[1] ?? 'application/octet-stream';
}


/**
 * 认出文字里的 @绝对路径（带空格时是 @"路径"），和 Files.saveIncoming 的写法对称。结尾跟着的标点不算路径。
 * @param text 原话或回复。
 * @returns 认出来的路径和类别（不查文件在不在、多大）；同一个路径只算一次。
 */
export function parseAttachments(text: string): Omit<Attachment, 'size'>[] {
  /** 找到的。 */
  const found: Omit<Attachment, 'size'>[] = [];
  for (const match of text.matchAll(/@"([^"]+)"|@([^\s，。、；：！？（）【】《》「」"'<>|]+)/gu)) {
    /** 路径：引号里的原样取；没引号的到空白或中文标点为止，再去掉结尾的英文标点和点。 */
    const raw = match[1] ?? (match[2] ?? '').replace(/[.,;!?)\]>`]+$/, '');
    //G 只认绝对路径（Windows 盘符或 / 开头），别的 @ 是普通文字（@某人）。
    if (!/^([A-Za-z]:[\\/]|\/)/.test(raw) || found.some((item) => item.path === raw)) {
      continue;
    }
    found.push({ path: raw, name: path.basename(raw.replace(/\\/g, '/')), kind: attachmentKind(raw) });
  }
  return found;
}


/**
 * 文件的静态地址。
 * @param file 绝对路径。
 * @param runtimeDir 运行时目录。
 * @returns 在运行时目录里的给 url，不在的是空对象。
 */
function fileUrl(file: string, runtimeDir: string): { url?: string } {
  /** 相对运行时目录的路径。 */
  const relative = path.relative(runtimeDir, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return {};
  }
  /** 每个路径段分别编码，保留目录分隔。 */
  const encodedPath = relative.split(path.sep).map(encodeURIComponent).join('/');
  return { url: `/files/${encodedPath}` };
}


/**
 * 认出附件并查大小。
 * @param text 原话或回复。
 * @param runtimeDir 运行时目录。
 * @returns 附件；文件不在了 size 是 null。
 */
async function attachmentsOf(text: string, runtimeDir: string): Promise<Attachment[]> {
  /** 从正文提取的附件路径。 */
  const attachments = parseAttachments(text);
  /** 文件可能已被用户删除；大小未知时保留附件本身。 */
  const pending = attachments.map(async (item) => {
    const stat = await fs.stat(item.path).catch(() => null);
    const size = stat === null ? null : stat.size;
    const url = fileUrl(item.path, runtimeDir);
    return {
      ...item,
      size,
      ...url,
    };
  });
  return Promise.all(pending);
}


/**
 * 一个机器人现在的状态（/api/bots 每项多的字段）。
 * @param parts 用到的对象（HttpParts 里的这几样）。
 * @param bot 机器人名。
 * @returns 状态和几个计数。
 */
export function botStatus(parts: Pick<httpModule.HttpParts, 'store' | 'approvals'>, bot: string): BotStatusView {
  /** 待确认几条。 */
  const approvals = parts.approvals.list().filter((item) => item.bot === bot && item.sessionId !== '').length;
  /** 运行中的会话几个。 */
  const running = parts.store.listSessions(bot, { status: 'running' }).length;
  /** 还没进会话的消息几条。 */
  const queued = parts.store.listMessages(bot, { statuses: ['new', 'dispatching', 'queued'] }).length;
  //M 优先级从上到下：等用户点 → 干活 → 排队 → 闲着。
  /** 状态。 */
  let status: BotStatus = 'idle';
  if (approvals > 0) {
    status = 'waiting';
  } else if (running > 0) {
    status = 'working';
  } else if (queued > 0) {
    status = 'waiting';
  }
  return { status, running, queued, approvals };
}


/**
 * 一条收件的分派简要。
 * @param parts 用到的对象（HttpParts 里的这几样）。
 * @param row 收件。
 * @returns 简要；还没进会话是 null。
 */
function dispatchBrief(
  parts: Pick<httpModule.HttpParts, 'store' | 'files'>,
  row: storeModule.MessageRow,
): DispatchBrief | null {
  if (!row.sessionId) {
    return null;
  }
  /** 会话（取最新的标题）。 */
  const session = parts.store.getSession(row.sessionId);
  /** 分派结论；直接指定会话的没有分派记录。 */
  const result = (row.dispatch as { result?: Partial<dispatchModule.Decision> } | null)?.result;
  return {
    action: result?.session === 'new' ? 'new' : 'append',
    sessionId: row.sessionId,
    title: session?.title ?? result?.title ?? '',
    file: session ? parts.files.sessionFiles(session).md : '',
    model: result?.model ?? '',
    workspace: session?.workspace ?? result?.workspace ?? '',
    by: result?.by ?? 'direct',
    reason: result?.reason ?? '',
  };
}


/**
 * 一条收件给网页的样子。
 * @param parts 用到的对象（HttpParts 里的这几样）。
 * @param row 收件。
 */
async function messageView(
  parts: Pick<httpModule.HttpParts, 'resources' | 'store' | 'files'>,
  row: storeModule.MessageRow,
  evidence: replyEvidence.ReplyEvidenceReader,
): Promise<MessageView> {
  return {
    id: row.id,
    bot: row.bot,
    channel: row.channel,
    source: row.source,
    text: row.text,
    status: row.status,
    sessionId: row.sessionId,
    file: row.file,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    attachments: await attachmentsOf(row.text, parts.resources.dir),
    replies: await Promise.all(row.replies.map(async (reply) => {
      const recorded = evidence.read(row, reply);
      return {
        at: reply.at,
        session: reply.session,
        text: reply.text,
        attachments: await attachmentsOf(reply.text, parts.resources.dir),
        generation: recorded.generation,
        association: recorded.association,
      };
    })),
    dispatch: dispatchBrief(parts, row),
  };
}


/**
 * /api/messages 的 origin 参数变成数据库的筛选条件。
 * @param origin web 只要网页发的，other 只要别的渠道的，不写是全部。
 * @returns 筛选条件。
 * @throws 写了别的值时抛错。
 */
function originFilter(origin: string | undefined): { source?: string; notSource?: string } {
  if (origin === undefined || origin === '') {
    return {};
  }
  if (origin === 'web') {
    return { source: WEB_SOURCE };
  }
  if (origin === 'other') {
    return { notSource: WEB_SOURCE };
  }
  throw new HttpError(400, 'origin 要是 web 或 other');
}


/**
 * 可选的非负整数参数。
 * @param value 网址里的值。
 * @param where 参数名（报错用）。
 * @returns 没写是 undefined。
 * @throws 不是非负整数时抛错。
 */
function optionalCount(value: string | undefined, where: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  /** 数字。 */
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new HttpError(400, `${where} 要是非负整数`);
  }
  return number;
}


/**
 * 上传暂存在哪。
 * @param parts 用到的对象（HttpParts 里的这几样）。
 */
function uploadsDir(parts: Pick<httpModule.HttpParts, 'resources'>): string {
  return path.join(parts.resources.dir, 'data', 'tmp', 'uploads');
}


/**
 * 上传的文件名整理成能落盘的样子，扩展名保留。
 * @param name 网址里的名字。
 */
function uploadName(name: string): string {
  /** 原来的扩展名。 */
  const extension = path.extname(name);
  /** 留下的扩展名：太长的不算扩展名，怪字符去掉。 */
  const kept = extension.length <= 10 ? extension.replace(/[^.\w-]/g, '') : '';
  /** 去掉扩展名的部分。 */
  const base = utils.safeFolderName(kept ? name.slice(0, -extension.length) : name, 60);
  return kept.length > 1 ? `${base}${kept}` : base;
}


/**
 * 取出上传的文件，交给 Files.saveIncoming（和图片一样进消息文件夹）。读出来就删掉暂存的文件。
 * @param parts 用到的对象（HttpParts 里的这几样）。
 * @param value 请求体里的 uploads：上传号的列表；不写是空。
 * @returns 原来的文件名和内容。
 * @throws 不是上传号、或者上传已经不在了时抛错。
 * 副作用：删掉暂存的文件。
 */
export async function takeUploads(
  parts: Pick<httpModule.HttpParts, 'resources'>,
  value: unknown,
): Promise<filesModule.IncomingImage[]> {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('uploads 要是上传号的列表');
  }
  /** 暂存目录里的文件。 */
  const names = await fs.readdir(uploadsDir(parts)).catch(() => [] as string[]);
  /** 读出来的。 */
  const taken: { name: string; data: Uint8Array; file: string }[] = [];
  for (const [index, item] of value.entries()) {
    /** 上传号。 */
    const id = checks.requireString(item, `uploads[${index}]`);
    if (!/^\d{20}$/.test(id)) {
      throw new Error(`uploads[${index}] 不是上传号：${id}`);
    }
    /** 暂存的文件名。 */
    const name = names.find((file) => file.startsWith(`${id}_`));
    if (!name) {
      throw new Error(`上传 ${id} 不在了（可能已经发过）`);
    }
    /** 暂存的文件。 */
    const file = path.join(uploadsDir(parts), name);
    taken.push({ name: name.slice(id.length + 1), data: new Uint8Array(await fs.readFile(file)), file });
  }
  //M 都读到了才删，免得删了一半又报错。
  for (const item of taken) {
    await fs.rm(item.file, { force: true });
  }
  return taken.map((item) => ({ name: item.name, data: item.data }));
}


/**
 * 文件接口能读的根目录：运行时的 bots/、skills/、memory/、knowledge/，加上每个工作区的工作目录。
 * @param parts 用到的对象（HttpParts 里的这几样）。
 */
async function allowedRoots(parts: Pick<httpModule.HttpParts, 'resources' | 'files'>): Promise<string[]> {
  /** 根目录。 */
  const roots = ['bots', 'skills', 'memory', 'knowledge'].map((name) => path.join(parts.resources.dir, name));
  for (const bot of parts.resources.listBots()) {
    for (const workspace of await parts.files.listWorkspaces(bot.name)) {
      roots.push(workspace.dir);
    }
  }
  return roots.map((root) => path.resolve(root));
}


/**
 * target 在不在 root 里面（含 root 本身）。
 * @param target 绝对路径。
 * @param root 根目录。
 */
function isInside(target: string, root: string): boolean {
  /** 相对路径。 */
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}


/**
 * 请求里的路径变成能读的绝对路径。
 * @param parts 用到的对象（HttpParts 里的这几样）。
 * @param value 网址里的 path。
 * @returns 绝对路径。
 * @throws 不是绝对路径（400）、是密钥文件或不在范围里（403）时抛 HttpError。
 */
async function resolveAllowed(
  parts: Pick<httpModule.HttpParts, 'resources' | 'files'>,
  value: string | undefined,
): Promise<string> {
  if (!value || !path.isAbsolute(value)) {
    throw new HttpError(400, 'path 要是绝对路径');
  }
  /** 规范化以后的。 */
  const target = path.resolve(value);
  //G 密钥文件任何情况下都不给。
  if (SECRET_FILES.test(path.basename(target))) {
    throw new HttpError(403, '这个文件不给看');
  }
  if (!(await allowedRoots(parts)).some((root) => isInside(target, root))) {
    throw new HttpError(403, `不在能看的范围里（运行时的 bots、skills、memory、knowledge 和工作区的工作目录）：${target}`);
  }
  return target;
}


/**
 * 解析 Range 请求头。
 * @param header 请求头。
 * @param size 文件大小。
 * @returns 要的那一段；没写或认不出是 undefined（给整份）；超出文件是 'invalid'（回 416）。
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  /** bytes=开始-结束。 */
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) {
    return undefined;
  }
  /** 开始和结束（含）。 */
  let start: number;
  let end: number;
  if (!match[1]) {
    //M bytes=-500：最后 500 个字节。
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start >= size || start > end ? 'invalid' : { start, end };
}


/**
 * 照顺序把几步改动做到 config.yaml 的文字上：用 yaml 的 Document 改，注释和没见过的键都留着。
 * @param text config.yaml 原文（还没有就是空的）。
 * @param edits 改动。
 * @returns 改完的原文。
 * @throws 路径不对、改完不是合法 YAML 时抛错。
 */
export function applySettingEdits(text: string, edits: SettingEdit[]): string {
  /** 文档。 */
  const document = yaml.parseDocument(text);
  if (document.errors.length > 0) {
    throw new HttpError(409, `config.yaml 现在就不是合法的 YAML，先手动修好：${document.errors[0]!.message}`);
  }
  for (const [index, edit] of edits.entries()) {
    //G 路径要是非空的键和序号。
    if (!Array.isArray(edit.path) || edit.path.length === 0 || edit.path.some((key) => typeof key !== 'string' && typeof key !== 'number')) {
      throw new HttpError(400, `第 ${index + 1} 步的 path 要是非空的列表（键或序号）`);
    }
    if ('delete' in edit) {
      document.deleteIn(edit.path);
      continue;
    }
    document.setIn(edit.path, edit.value);
  }
  //M 不折长行（lineWidth 0），免得把用户写的长值、长注释排成好几行。
  return document.toString({ lineWidth: 0 });
}


/**
 * 出错时回的样子：HttpError 用它的状态码，别的回 400。
 * @param reply 回复。
 * @param error 错误。
 */
function sendError(reply: fastify.FastifyReply, error: unknown): fastify.FastifyReply {
  return reply.code(error instanceof HttpError ? error.status : 400).send({ error: utils.errorText(error) });
}


/**
 * 原样转发给本地壳子（engine.index_url）。
 * @param parts 用到的对象（HttpParts 里的这几样）。
 * @param reply 回复。
 * @param target 壳子那边的路径和查询，如 /search?q=记忆。
 * @param body 有就用 POST 把它转过去（JSON）。
 */
async function forward(
  parts: Pick<httpModule.HttpParts, 'resources'>,
  reply: fastify.FastifyReply,
  target: string,
  body?: unknown,
): Promise<fastify.FastifyReply> {
  /** 壳子的地址。 */
  const base = parts.resources.getSetting('indexUrl');
  if (!base) {
    return reply.code(503).send({ error: '没配 engine.index_url：记忆搜索要开着本地壳子 jmbots.exe，并把 index_url 指到它' });
  }
  try {
    /** 壳子的回答（有请求体时用 POST 原样转过去）。 */
    const response = await fetch(`${base.replace(/\/+$/, '')}${target}`, {
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const contentType = response.headers.get('content-type') ?? 'application/json; charset=utf-8';
    const contents = await response.text();

    return reply.code(response.status).type(contentType).send(contents);
  } catch (error) {
    return reply.code(502).send({ error: `连不上本地壳子（${base}）：${utils.errorText(error)}` });
  }
}


/**
 * 网址里 ? 后面那一段（原样，转发用）。
 * @param request 请求。
 */
function rawQuery(request: fastify.FastifyRequest): string {
  /** ? 的位置。 */
  const index = request.url.indexOf('?');
  return index < 0 ? '' : request.url.slice(index);
}


/**
 * 托管打包好的网页：有这个文件就给它，没有就给 index.html（单页）；还没打包时说一句怎么打包。
 * @param reply 回复。
 * @param relative 网址里的路径（不带开头的 /）。
 */
async function serveWeb(reply: fastify.FastifyReply, relative: string): Promise<fastify.FastifyReply> {
  //M 编译好的程序：网页打包在程序里。
  if (embedded.isCompiled()) {
    /** 要的文件。 */
    const found = embedded.find(`web/${relative}`);
    /** 给出去的文件。 */
    const packed = found ?? embedded.find('web/index.html');
    if (!packed) {
      return reply.code(404).type('text/plain; charset=utf-8').send('这个程序里没有打包网页');
    }
    reply.header('Cache-Control', found && relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    const type = contentType(found ? relative : 'index.html');
    const buffer = await Bun.file(packed).arrayBuffer();
    const contents = Buffer.from(buffer);

    return reply.type(type).send(contents);
  }
  /** 要的文件（不许跳出 dist/web）。 */
  const wanted = path.resolve(WEB_DIR, relative);
  /** 是不是真有这个文件。 */
  const isFile = relative !== '' && isInside(wanted, WEB_DIR) && (await fs.stat(wanted).then((stat) => stat.isFile(), () => false));
  /** 给出去的文件。 */
  const file = isFile ? wanted : path.join(WEB_DIR, 'index.html');
  if (!fsSync.existsSync(file)) {
    return reply.code(404).type('text/plain; charset=utf-8').send('网页还没打包：在代码目录跑 bun run build:web');
  }
  //M 带哈希的资源长期缓存；index.html 每次都问，换版本后马上用新的。
  reply.header('Cache-Control', isFile && relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  return reply.type(contentType(file)).send(await fs.readFile(file));
}


/** 查询串里 /api/messages 带的参数。 */
interface MessagesQuery {
  bot?: string;
  before?: string;
  after?: string;
  limit?: string;
  origin?: string;
}

/** /api/ui/provider-models 的请求体。 */
interface ProviderModelsBody {
  provider?: string;
  base_url?: string;
  api_key?: string;
  api?: string;
}

/** /api/models/reconnect 的请求体。 */
interface ReconnectBody {
  /** 只重连这一家供应商；不给就每家都重连。 */
  provider?: string;
}

/**
 * 网页要的接口和网页托管：每个路由的处理函数是一个私有方法，按组由 registerXxx 注册。
 * 建它的地方：HttpApp.build（src/channels/Http.ts）。
 */
export class UiRoutes {
  /**
   * @param parts HTTP 要用的对象（见 src/channels/Http.ts 的 HttpParts，入口 src/entries/App.ts 建的）。
   */
  constructor(private readonly parts: httpModule.HttpParts) {}

  /**
   * 注册网页要的接口和网页托管。
   * @param app Fastify 实例（HttpApp.build 建的）。
   * 副作用：给 app 加路由；上传会写运行时 data/tmp/uploads/。
   */
  register(app: fastify.FastifyInstance): void {
    //M 按组注册；网页托管的兜底路由 /* 最后注册。
    this.registerMessages(app);
    this.registerCreateBot(app);
    this.registerFiles(app);
    this.registerBrowse(app);
    this.registerSettings(app);
    this.registerUpdate(app);
    this.registerMemory(app);
    this.registerWeb(app);
  }

  /**
   * 消息列表和搜聊天。
   * @param app Fastify 实例。
   */
  private registerMessages(app: fastify.FastifyInstance): void {
    app.get<{ Querystring: { bot?: string; ids?: string } }>(
      '/api/messages/resolve',
      (request, reply) => this.resolveMessages(request, reply),
    );
    app.get<{ Querystring: MessagesQuery }>(
      '/api/messages',
      (request, reply) => this.listMessages(request, reply),
    );
    app.get<{ Querystring: { q?: string; bot?: string; limit?: string } }>(
      '/api/search',
      (request, reply) => this.search(request, reply),
    );
    app.get<{
      Params: { id: string };
      Querystring: { reply?: string };
    }>('/api/messages/:id/trace', (request, reply) => {
      /** URL 用收件号和回复数组下标定位，不按正文或相同时间猜。 */
      const messageId = Number(request.params.id);
      const replyIndex = Number(request.query.reply ?? '0');
      if (!Number.isSafeInteger(messageId) || messageId <= 0
        || !Number.isSafeInteger(replyIndex) || replyIndex < 0) {
        return reply.code(400).send({ error: '消息号要是正整数，reply 要是非负整数' });
      }

      /** 聚合器只读数据库与已有事件，不调用模型或改变消息状态。 */
      const tracer = new traceModule.ReplyTracer(this.parts.store, this.parts.secrets);
      const view = tracer.read(messageId, replyIndex);
      if (!view) {
        return reply.code(404).send({ error: '没有这条消息或回复' });
      }
      return view;
    });
  }

  /**
   * 新建机器人。
   * @param app Fastify 实例。
   */
  private registerCreateBot(app: fastify.FastifyInstance): void {
    app.post('/api/bots', (request, reply) => this.createBot(request, reply));
  }

  /**
   * 上传、读文件、静态文件、列目录。
   * @param app Fastify 实例。
   */
  private registerFiles(app: fastify.FastifyInstance): void {
    //M 上传单独一个作用域：任何类型的请求体都原样交给处理函数，边收边写盘，大文件不进内存、不转 base64。
    app.register((scope, _options, done) => {
      scope.addContentTypeParser('*', (_request, payload, next) => {
        next(null, payload);
      });
      scope.put<{ Params: { name: string } }>('/api/uploads/:name', (request, reply) => {
        return this.upload(request, reply);
      });
      done();
    });
    app.get<{ Querystring: { path?: string } }>(
      '/api/files',
      (request, reply) => this.readFile(request.query.path, request, reply),
    );
    //M 静态文件（用户 11-05：方便别的程序、AI 接口对接）：路径相对运行时目录，范围和 /api/files 一样。
    app.get<{ Params: { '*': string } }>(
      '/files/*',
      (request, reply) => this.readStaticFile(request, reply),
    );
    app.get<{ Querystring: { path?: string } }>(
      '/api/files/list',
      (request, reply) => this.listFiles(request, reply),
    );
  }

  /**
   * 模型清单、会话列表、机器人详情。
   * @param app Fastify 实例。
   */
  private registerBrowse(app: fastify.FastifyInstance): void {
    app.get('/api/models', () => this.listModels());
    app.post<{ Body: ReconnectBody | null }>(
      '/api/models/reconnect',
      (request, reply) => this.reconnectModels(request, reply),
    );
    app.get<{ Querystring: { bot?: string; status?: string } }>(
      '/api/ui/sessions',
      (request, reply) => this.listSessions(request, reply),
    );
    app.get<{ Params: { name: string } }>(
      '/api/ui/bots/:name',
      (request, reply) => this.getBotDetail(request, reply),
    );
  }

  /**
   * 设置、重启生效、重启服务、进程信息、渠道状态、供应商模型。
   * @param app Fastify 实例。
   */
  private registerSettings(app: fastify.FastifyInstance): void {
    app.get('/api/settings', () => this.getSettings());
    app.put('/api/settings', (request, reply) => this.saveSettings(request, reply));
    app.post('/api/settings/apply', (_request, reply) => this.applySettings(reply));
    app.post('/api/service/restart', (_request, reply) => this.restartService(reply));
    app.get('/api/ui/info', () => this.getInfo());
    app.get('/api/ui/status', () => this.getStatus());
    app.post<{ Body: ProviderModelsBody | null }>(
      '/api/ui/provider-models',
      (request, reply) => this.probeProviderModels(request, reply),
    );
  }

  /**
   * 版本更新、进度、开机自启。
   * @param app Fastify 实例。
   */
  private registerUpdate(app: fastify.FastifyInstance): void {
    //M 版本更新是基地的事（docs/界面/02_一个程序跑起来的规划.md 第 6 步），网页经这里转发。
    app.get('/api/update', (_request, reply) => this.getUpdate(reply));
    app.post('/api/update/apply', (_request, reply) => this.applyUpdate(reply));
    app.get<{ Querystring: { bot?: string } }>(
      '/api/progress',
      (request) => this.listProgress(request),
    );
    app.post<{ Params: { id: string } }>(
      '/api/progress/:id',
      (request) => this.actProgress(request),
    );
    app.get('/api/autostart', (_request, reply) => this.getAutostart(reply));
    app.post('/api/autostart', (request, reply) => this.setAutostart(request, reply));
  }

  /**
   * 记忆搜索和 RAG：原样转发给基地。
   * @param app Fastify 实例。
   */
  private registerMemory(app: fastify.FastifyInstance): void {
    app.get('/api/memory/search', (request, reply) => this.memorySearch(request, reply));
    app.get('/api/memory/health', (_request, reply) => this.memoryHealth(reply));
    app.get('/api/rag/search', (request, reply) => this.ragSearch(request, reply));
    app.post('/api/rag/index', (request, reply) => this.ragIndexPost(request, reply));
    app.get('/api/rag/index', (request, reply) => this.ragIndexGet(request, reply));
  }

  /**
   * 网页托管：兜底路由，要最后注册。
   * @param app Fastify 实例。
   */
  private registerWeb(app: fastify.FastifyInstance): void {
    app.get<{ Params: { '*': string } }>(
      '/*',
      (request, reply) => this.serveWebPage(request, reply),
    );
  }

  /**
   * GET /api/messages：消息列表，每条带附件、回复、分派简要。
   * @param request 请求（?bot=&before=&after=&limit=&origin=）。
   * @param reply 回应。
   * @returns {messages, hasMore, cursor}；出错是错误回应。
   */
  private async listMessages(
    request: fastify.FastifyRequest<{ Querystring: MessagesQuery }>,
    reply: fastify.FastifyReply,
  ): Promise<unknown> {
    try {
      /** 依赖。 */
      const parts = this.parts;
      /** 机器人。 */
      const bot = request.query.bot ?? parts.resources.listBots()[0]?.name;
      if (!bot) {
        return { messages: [], hasMore: false, cursor: 0 };
      }
      parts.resources.getBot(bot);
      /** 往前翻：只要号比它小的。 */
      const before = optionalCount(request.query.before, 'before');
      /** 取变化：只要 updatedAt 不早于它的。 */
      const after = optionalCount(request.query.after, 'after');
      /** 条数。 */
      const asked = optionalCount(request.query.limit, 'limit') ?? DEFAULT_MESSAGE_LIMIT;
      /** 条数（封顶）。 */
      const limit = Math.min(asked, MAX_MESSAGE_LIMIT);
      /** 只要网页发的（时间线）、只要别的渠道的（右栏“消息”），或者全要。 */
      const origin = originFilter(request.query.origin);
      //M 往前翻多取一条，看还有没有更早的；取变化时全给。
      /** 收件。 */
      const rows = after === undefined
        ? parts.store.listMessages(bot, { before, limit: limit + 1, ...origin })
        : parts.store.listMessages(bot, { after, ...origin });
      /** 还有没有更早的。 */
      const hasMore = after === undefined && rows.length > limit;
      /** 这次给的。 */
      const shown = hasMore ? rows.slice(1) : rows;
      /** 每条的视图。 */
      const evidence = new replyEvidence.ReplyEvidenceReader(parts.store);
      const messages = await Promise.all(shown.map((row) => messageView(parts, row, evidence)));
      /** 下次取变化用的游标。 */
      const cursor = Math.max(after ?? 0, ...shown.map((row) => row.updatedAt));
      return { messages, hasMore, cursor };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /** 明确号补取，不翻扫旧分页，不越过所请求机器人的归属。 */
  private async resolveMessages(
    request: fastify.FastifyRequest<{ Querystring: { bot?: string; ids?: string } }>,
    reply: fastify.FastifyReply,
  ): Promise<unknown> {
    try {
      const bot = request.query.bot;
      if (!bot) {
        throw new HttpError(400, '补取原消息必须写 bot');
      }
      this.parts.resources.getBot(bot);
      const tokens = (request.query.ids ?? '').split(',');
      if (tokens.length > 100 || tokens.some((id) => !/^[1-9]\d*$/.test(id))) {
        throw new HttpError(400, 'ids 要是最多 100 个逗号分隔的正整数');
      }
      const ids = [...new Set(tokens.map(Number))];
      if (ids.some((id) => !Number.isSafeInteger(id))) {
        throw new HttpError(400, '消息号超出安全整数范围');
      }
      const rows: storeModule.MessageRow[] = [];
      const missingIds: number[] = [];
      for (const id of ids) {
        const row = this.parts.store.getMessage(id);
        if (!row || row.bot !== bot) {
          missingIds.push(id);
        } else {
          rows.push(row);
        }
      }
      const evidence = new replyEvidence.ReplyEvidenceReader(this.parts.store);
      const messages = await Promise.all(rows.map((row) => messageView(this.parts, row, evidence)));
      return { messages, missingIds };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * GET /api/search：搜聊天，消息原话和回复、会话标题和摘要。
   * @param request 请求（?q=&bot=&limit=）。
   * @param reply 回应。
   * @returns {messages, sessions}；出错是错误回应。
   */
  private search(
    request: fastify.FastifyRequest<{ Querystring: { q?: string; bot?: string; limit?: string } }>,
    reply: fastify.FastifyReply,
  ): unknown {
    try {
      /** 依赖。 */
      const parts = this.parts;
      /** 关键字。 */
      const keyword = (request.query.q ?? '').trim();
      if (!keyword) {
        throw new HttpError(400, '要写搜什么：?q=关键字');
      }
      /** 机器人：不写搜所有的。 */
      const bot = request.query.bot || undefined;
      if (bot) {
        parts.resources.getBot(bot);
      }
      /** 每组几条。 */
      const asked = optionalCount(request.query.limit, 'limit') ?? SEARCH_LIMIT;
      /** 每组几条（封顶）。 */
      const limit = Math.min(asked, MAX_SEARCH_LIMIT);
      /** 命中的消息：原话没命中就是某条回复命中。 */
      const messageHits = parts.store.searchMessages(keyword, { bot, limit }).map((row) => {
        /** 命中的回复（原话没命中时）。 */
        const hitReply = includesFolded(row.text, keyword)
          ? undefined
          : row.replies.find((item) => includesFolded(item.text, keyword));
        return {
          id: row.id,
          bot: row.bot,
          channel: row.channel,
          source: row.source,
          createdAt: row.createdAt,
          file: row.file,
          sessionId: row.sessionId,
          hit: hitReply ? 'reply' : 'text',
          snippet: snippetOf(hitReply ? hitReply.text : row.text, keyword),
        };
      });
      /** 命中的会话：摘要命中给摘要那段，只有标题命中给摘要开头。 */
      const sessionHits = parts.store.searchSessions(keyword, { bot, limit }).map((session) => ({
        id: session.id,
        bot: session.bot,
        workspace: session.workspace,
        title: session.title,
        snippet: snippetOf(session.summary, keyword),
        updatedAt: session.updatedAt,
        file: parts.files.sessionFiles(session).md,
      }));
      return { messages: messageHits, sessions: sessionHits };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * POST /api/bots：新建机器人，不用重启。
   * @param request 请求（{name, identity, language, model?, feishu?}）。
   * @param reply 回应。
   * @returns {ok, bot, feishu?}；出错是错误回应。
   * 副作用：改 config.yaml，建机器人目录，连飞书，起机器人循环。
   */
  private async createBot(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<unknown> {
    try {
      /** 依赖。 */
      const parts = this.parts;
      /** 请求体。 */
      const body = checks.asRecord(request.body ?? {}, '请求体');
      //M 1. 核对：名字、重名、语言、模型、飞书（docs/界面/01_界面设计.md 6.2）。
      /** 名字。 */
      const name = checks.safeName(typeof body.name === 'string' ? body.name.trim() : '', '机器人的名字');
      if (BAD_BOT_NAME.test(name) || [...name].some((char) => char.charCodeAt(0) < 32)) {
        throw new HttpError(400, '机器人的名字是文件夹名：不能有 < > : " | ? *，结尾不能是点或空格');
      }
      if (parts.resources.listBots().some((bot) => bot.name === name)) {
        throw new HttpError(400, `已经有机器人「${name}」了`);
      }
      if (body.language !== undefined && body.language !== 'zh' && body.language !== 'en') {
        throw new HttpError(400, 'language 只能是 zh 或 en');
      }
      /** 语言。 */
      const language = body.language === 'en' ? 'en' : 'zh';
      /** 一句话身份。 */
      const identity = typeof body.identity === 'string' ? body.identity.trim() : '';
      /** 默认模型。 */
      const modelId = typeof body.model === 'string' ? body.model.trim() : '';
      if (modelId && !parts.ai.listModels().some((item) => item.id === modelId)) {
        throw new HttpError(400, `模型清单里没有 ${modelId}`);
      }
      /** 飞书应用。 */
      const feishu = feishuOf(body.feishu);
      /** config.yaml。 */
      const file = path.join(parts.resources.dir, 'config.yaml');
      /** 原文。 */
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      /** 配置原文（去掉 BOM）。 */
      const source = text.replace(/^\uFEFF/u, '');
      /** 现在的配置。 */
      const config = checks.asRecord(text ? (Bun.YAML.parse(source) ?? {}) : {}, 'config.yaml');
      /** 现在的机器人列表。 */
      const bots = Array.isArray(config.bots) ? config.bots : [];
      /** 现在的飞书应用列表。 */
      const feishuList = (config.channels as { feishu?: unknown } | undefined)?.feishu ?? [];
      if (!Array.isArray(feishuList)) {
        throw new HttpError(409, 'config.yaml 里 channels.feishu 不是列表，先在设置页改好');
      }
      /** 已经绑过的飞书 app_id。 */
      const used = feishuList.some(
        (item) => (item as { app_id?: unknown } | null)?.app_id === feishu?.app_id,
      );
      if (feishu && used) {
        throw new HttpError(400, `飞书应用 ${feishu.app_id} 已经绑给别的机器人了`);
      }
      //M 2. 写 config.yaml：保留注释和没见过的键；先写临时文件再改名。
      /** 改动：bots 加一项；填了飞书在 channels.feishu 加一项。 */
      const edits: SettingEdit[] = [{ path: ['bots', bots.length], value: { name, language } }];
      if (feishu) {
        /** 新的飞书应用项。 */
        const item = { ...feishu, bot: name };
        edits.push({ path: ['channels', 'feishu', feishuList.length], value: item });
      }
      await fs.writeFile(`${file}.tmp`, applySettingEdits(text, edits), 'utf8');
      await fs.rename(`${file}.tmp`, file);
      //M 3. 不重启就用上：加进机器人列表，建目录和索引.md，连飞书，起机器人循环。
      parts.resources.addBot({ name, language });
      await parts.files.ensureBot(name, { identity, model: modelId });
      /** 飞书连上没有；没填飞书时没有。 */
      let feishuState: string | undefined;
      if (feishu) {
        parts.secrets.add([feishu.app_secret]);
        feishuState = parts.out.addChannel
          ? await parts.out.addChannel('feishu', { ...feishu, bot: name }).then(
            () => '已连上',
            (error: unknown) => `没连上：${utils.errorText(error)}`,
          )
          : '没连上：这个后端不支持运行时加渠道，重启后生效';
      }
      this.parts.botLoop.start(name);
      return { ok: true, bot: { name, language }, ...(feishuState ? { feishu: feishuState } : {}) };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * PUT /api/uploads/:name：原始字节存进运行时 data/tmp/uploads/。
   * @param request 请求（请求体是原始的流）。
   * @param reply 回应。
   * @returns {id, name, size, kind}；出错是错误回应。
   * 副作用：写暂存文件。
   */
  private async upload(
    request: fastify.FastifyRequest<{ Params: { name: string } }>,
    reply: fastify.FastifyReply,
  ): Promise<unknown> {
    try {
      /** 暂存目录。 */
      const dir = uploadsDir(this.parts);
      /** 落盘的名字。 */
      const name = uploadName(request.params.name);
      /** 上传号。 */
      const id = utils.createSessionId();
      await fs.mkdir(dir, { recursive: true });
      /** 暂存的文件。 */
      const file = path.join(dir, `${id}_${name}`);
      /** 请求体：原始的流；空请求体时没有。 */
      const body = request.body as NodeJS.ReadableStream | undefined;
      if (body && typeof body.pipe === 'function') {
        await streamPromises.pipeline(body, fsSync.createWriteStream(file));
      } else {
        await fs.writeFile(file, '');
      }
      return { id, name, size: (await fs.stat(file)).size, kind: attachmentKind(name) };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * 回一个文件：支持 Range，按扩展名给 Content-Type。
   * @param value 文件的绝对路径。
   * @param request 请求。
   * @param reply 回应。
   * @returns 回应。
   */
  private async readFile(
    value: string | undefined,
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> {
    try {
      /** 要读的文件。 */
      const file = await resolveAllowed(this.parts, value);
      /** 文件信息。 */
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat?.isFile()) {
        return reply.code(404).send({ error: `没有这个文件：${file}` });
      }
      /** 要的那一段。 */
      const range = parseRange(request.headers.range, stat.size);
      reply.header('Accept-Ranges', 'bytes').type(contentType(file));
      if (range === 'invalid') {
        return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
      }
      if (range) {
        /** Content-Range 的值。 */
        const contentRange = `bytes ${range.start}-${range.end}/${stat.size}`;
        return reply
          .code(206)
          .header('Content-Range', contentRange)
          .header('Content-Length', range.end - range.start + 1)
          .send(fsSync.createReadStream(file, range));
      }
      return reply.header('Content-Length', stat.size).send(fsSync.createReadStream(file));
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * GET /files/*：静态文件，路径相对运行时目录。
   * @param request 请求。
   * @param reply 回应。
   * @returns 回应。
   */
  private readStaticFile(
    request: fastify.FastifyRequest<{ Params: { '*': string } }>,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> {
    /** 文件的绝对路径。 */
    const file = path.join(this.parts.resources.dir, request.params['*']);
    return this.readFile(file, request, reply);
  }

  /**
   * GET /api/files/list：列目录。
   * @param request 请求（?path=）。
   * @param reply 回应。
   * @returns 目录里每一项；出错是错误回应。
   */
  private async listFiles(
    request: fastify.FastifyRequest<{ Querystring: { path?: string } }>,
    reply: fastify.FastifyReply,
  ): Promise<unknown> {
    try {
      /** 要列的目录。 */
      const dir = await resolveAllowed(this.parts, request.query.path);
      /** 目录里的东西（密钥文件不列）。 */
      const entries = (await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined))
        ?.filter((entry) => !SECRET_FILES.test(entry.name));
      if (!entries) {
        return reply.code(404).send({ error: `没有这个目录：${dir}` });
      }
      /** 每一项。 */
      const items = await Promise.all(
        entries.map(async (entry) => {
          /** 这一项的路径。 */
          const full = path.join(dir, entry.name);
          /** 大小和修改时间。 */
          const stat = await fs.stat(full).catch(() => undefined);
          return {
            name: entry.name,
            path: full,
            dir: entry.isDirectory(),
            size: stat?.size ?? 0,
            mtime: stat?.mtimeMs ?? 0,
          };
        }),
      );
      //M 文件夹在前，再按名字排。
      return items.sort(
        (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'zh-CN'),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * GET /api/models：模型清单。
   * @returns 模型清单。
   */
  private listModels(): unknown {
    return this.parts.ai.listModels();
  }

  /**
   * POST /api/models/reconnect：重拉模型清单（重新连接），拉到了原地换掉，不用重启。
   * 网页设置“重连”里的“重新测试模型连接”调它（web/src/Settings/Reconnect.tsx），每家都重连。
   * @param request 请求；body.provider 只重连这一家，不给就每家都重连。
   * @param reply 回应。
   * @returns {results}：每家连上没有、现在几个模型、没连上的原因；供应商不在配置里是 400。
   */
  private async reconnectModels(
    request: fastify.FastifyRequest<{ Body: ReconnectBody | null }>,
    reply: fastify.FastifyReply,
  ): Promise<unknown> {
    try {
      /** 要重连的供应商；空串当没给。 */
      const provider = request.body?.provider || undefined;
      /** config.yaml 里的供应商。 */
      const providers = this.parts.resources.getProviders();
      if (provider !== undefined && providers[provider] === undefined) {
        throw new HttpError(400, `config.yaml 的 providers 里没有 ${provider}`);
      }
      /** 每家的结果。 */
      const results = await this.parts.ai.reconnect(provider);
      return { results };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * GET /api/ui/sessions：会话列表（不带对话全文）。
   * @param request 请求（?bot=&status=）。
   * @param reply 回应。
   * @returns 会话列表；出错是错误回应。
   */
  private listSessions(
    request: fastify.FastifyRequest<{ Querystring: { bot?: string; status?: string } }>,
    reply: fastify.FastifyReply,
  ): unknown {
    try {
      /** 依赖。 */
      const parts = this.parts;
      /** 机器人。 */
      const bot = request.query.bot ?? parts.resources.listBots()[0]?.name;
      if (!bot) {
        return [];
      }
      parts.resources.getBot(bot);
      /** 只要哪种状态的。 */
      const status = request.query.status as storeModule.SessionStatus | undefined;
      if (status !== undefined && !['idle', 'running', 'error'].includes(status)) {
        throw new HttpError(400, 'status 要是 idle、running 或 error');
      }
      return parts.store.listSessions(bot, { status }).map((session) => ({
        id: session.id,
        bot: session.bot,
        workspace: session.workspace,
        title: session.title,
        summary: session.summary,
        model: session.model,
        status: session.status,
        tokens: session.tokens,
        runs: session.runs.length,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        files: parts.files.sessionFiles(session),
      }));
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * GET /api/ui/bots/:name：一个机器人的目录、工作区、记忆概要。
   * @param request 请求。
   * @param reply 回应。
   * @returns 详情；出错是 404 回应。
   */
  private async getBotDetail(
    request: fastify.FastifyRequest<{ Params: { name: string } }>,
    reply: fastify.FastifyReply,
  ): Promise<unknown> {
    try {
      /** 依赖。 */
      const parts = this.parts;
      /** 机器人（不存在时抛错）。 */
      const bot = parts.resources.getBot(request.params.name);
      return {
        name: bot.name,
        language: bot.language,
        paths: parts.files.paths(bot.name),
        workspaces: await parts.files.listWorkspaces(bot.name),
        memoryIndex: await parts.files.readMemoryIndex(bot.name),
      };
    } catch (error) {
      return sendError(reply, new HttpError(404, utils.errorText(error)));
    }
  }

  /**
   * GET /api/settings：配置内容，明文。
   * @returns {config}。
   */
  private async getSettings(): Promise<unknown> {
    /** config.yaml 原文；还没有就是空的。 */
    const text = await fs
      .readFile(path.join(this.parts.resources.dir, 'config.yaml'), 'utf8')
      .catch(() => '');
    return { config: text ? Bun.YAML.parse(text.replace(/^\uFEFF/u, '')) : {} };
  }

  /**
   * PUT /api/settings：按顺序改 config.yaml。
   * @param request 请求（[{path, value} | {path, delete: true}]）。
   * @param reply 回应。
   * @returns {ok, changed, note}；出错是错误回应。
   * 副作用：写 config.yaml。
   */
  private async saveSettings(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<unknown> {
    try {
      /** 改动。 */
      const edits = request.body;
      if (!Array.isArray(edits)) {
        throw new HttpError(400, '请求体要是改动的列表：[{path, value} 或 {path, delete: true}]');
      }
      /** config.yaml。 */
      const file = path.join(this.parts.resources.dir, 'config.yaml');
      /** 改完的原文。 */
      const text = applySettingEdits(
        await fs.readFile(file, 'utf8').catch(() => ''),
        edits as SettingEdit[],
      );
      //M 先写临时文件再改名：读的人不会读到半截；不留副本，不把内容打进日志。
      await fs.writeFile(`${file}.tmp`, text, 'utf8');
      await fs.rename(`${file}.tmp`, file);
      return { ok: true, changed: edits.length, note: 'config.yaml 是后端启动时读的，重启后生效' };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * POST /api/settings/apply：重启生效。
   * @param reply 回应。
   * @returns {ok, startedAt, note}；出错是错误回应。
   * 副作用：编译好的程序 300ms 后退出；源码模式后台起 Swap_Serve.ts。
   */
  private async applySettings(reply: fastify.FastifyReply): Promise<unknown> {
    try {
      //M 编译好的程序：退出，基地会把它重新拉起来（新进程读新的 config.yaml）。
      if (embedded.isCompiled()) {
        if (!process.env.JMBOTS_SUPERVISED) {
          throw new HttpError(409, '这个程序不是基地拉起来的，没人重启它：手动重启一下');
        }
        setTimeout(() => process.exit(0), EXIT_DELAY_MS);
        return {
          ok: true,
          startedAt: STARTED_AT,
          note: '正在重启：等 /api/ui/info 的 startedAt 变了就是新进程',
        };
      }
      /** 换版本的锁文件。 */
      const lockFile = path.join(this.parts.resources.dir, 'data', 'swap.lock');
      /** 最近一次开始换版本的时间。 */
      const lockedAt = Number(await fs.readFile(lockFile, 'utf8').catch(() => '0'));
      //G 刚有人开始换，再起一个会撞；换完了就不拦（换版本脚本默认 3 分钟内不再换，拒绝时没人看得到，所以这里加 --force）。
      if (Date.now() - lockedAt < APPLY_BUSY_MS) {
        throw new HttpError(409, '刚开始换版本，等它换完再点');
      }
      //M 换版本那套：先试运行、再替换正式服务；后台独立进程跑，马上返回（它会停掉这个服务）。
      /** 换版本脚本的参数。 */
      const swapArgs = ['scripts/Swap_Serve.ts', '--skip_checks', 'yes', '--force', 'yes'];
      childProcess
        .spawn(process.execPath, swapArgs, {
          cwd: CODE_DIR,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        .unref();
      return {
        ok: true,
        startedAt: STARTED_AT,
        note: '正在重启：等 /api/ui/info 的 startedAt 变了就是新进程',
      };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * POST /api/service/restart：重启服务（设置“重连”里的“重启服务”，用户 11-07）。
   * 编译好的程序请基地重启（基地 POST /restart：等一秒停掉这个后端，守护线程马上拉起来）。
   * 基地答应了才算：基地没开、不在守护时不退出，免得停了没人拉起来。
   * 源码模式、没配 engine.index_url、基地是老版本（没有 /restart，回 404）时，和“立即重启”一样（applySettings）。
   * @param reply 回应。
   * @returns {ok, startedAt, note}；基地不肯、连不上时是错误回应（带原因）。
   */
  private async restartService(reply: fastify.FastifyReply): Promise<unknown> {
    /** 基地的地址。 */
    const base = this.parts.resources.getSetting('indexUrl');
    //G 源码模式、不知道基地在哪：基地帮不上，走“立即重启”那套。
    if (!embedded.isCompiled() || !base) {
      return this.applySettings(reply);
    }
    /** 基地的重启接口。 */
    const target = `${base.replace(/\/+$/, '')}/restart`;
    /** 请求的设置。 */
    const init: RequestInit = {
      method: 'POST',
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    };
    /** 基地的回答。 */
    let response: Response;
    try {
      response = await fetch(target, init);
    } catch (error) {
      /** 连不上的原因。 */
      const reason = `连不上基地（${base}），没人能把服务拉起来，没有重启：${utils.errorText(error)}`;
      return reply.code(502).send({ error: reason });
    }
    //G 老版本基地没有 /restart：自己退出，基地的守护线程照样拉起来（applySettings 编译好的那条路）。
    if (response.status === 404) {
      return this.applySettings(reply);
    }
    try {
      /** 回答的内容。 */
      const body: unknown = await response.json();
      /** 回答。 */
      const answer = checks.asRecord(body, '基地的回答');
      if (answer.ok !== true) {
        /** 基地说的原因；基地没在守护（serve 命令起的）时只回 {managed: false}。 */
        const reason = typeof answer.error === 'string'
          ? answer.error
          : '基地没在守护后端（是用 serve 命令起的），停了没人拉起来：手动重启';
        throw new HttpError(409, reason);
      }
      return {
        ok: true,
        startedAt: STARTED_AT,
        note: '基地正在重启服务：等 /api/ui/info 的 startedAt 变了就是新进程',
      };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * GET /api/ui/info：这个后端进程什么时候起的、什么版本。
   * @returns {startedAt, version}。
   */
  private getInfo(): unknown {
    return { startedAt: STARTED_AT, version: versionsModule.VERSIONS[0]?.version ?? '' };
  }

  /**
   * GET /api/ui/status：渠道状态。
   * @returns {channels}。
   */
  private getStatus(): unknown {
    return { channels: this.parts.out.channelStatus?.() ?? [] };
  }

  /**
   * POST /api/ui/provider-models：用表单里的地址、密钥、协议查供应商的模型清单。
   * @param request 请求。
   * @param reply 回应。
   * @returns {models}；出错是错误回应。
   */
  private async probeProviderModels(
    request: fastify.FastifyRequest<{ Body: ProviderModelsBody | null }>,
    reply: fastify.FastifyReply,
  ): Promise<unknown> {
    try {
      /** 表单里现在的地址、密钥、协议。 */
      const body = request.body ?? {};
      if (!body.base_url) {
        throw new HttpError(400, '先填 API 地址');
      }
      /** 探测用的供应商配置。 */
      const provider = {
        base_url: body.base_url,
        api_key: body.api_key,
        api: body.api || undefined,
        list_models: true,
      };
      return { models: await model.probeProvider(body.provider || 'provider', provider) };
    } catch (error) {
      return sendError(reply, error);
    }
  }

  /**
   * GET /api/update：转发给基地。
   * @param reply 回应。
   * @returns 基地的回应。
   */
  private getUpdate(reply: fastify.FastifyReply): Promise<fastify.FastifyReply> {
    return forward(this.parts, reply, '/update');
  }

  /**
   * POST /api/update/apply：转发给基地。
   * @param reply 回应。
   * @returns 基地的回应。
   */
  private applyUpdate(reply: fastify.FastifyReply): Promise<fastify.FastifyReply> {
    return forward(this.parts, reply, '/update/apply', {});
  }

  /**
   * GET /api/progress：进度列表。
   * @param request 请求（?bot=）。
   * @returns 进度列表。
   */
  private listProgress(
    request: fastify.FastifyRequest<{ Querystring: { bot?: string } }>,
  ): unknown {
    return this.parts.progress?.list(request.query.bot) ?? [];
  }

  /**
   * POST /api/progress/:id：对一条进度停止或限时。
   * @param request 请求（{action, minutes?}）。
   * @returns {text}。
   */
  private actProgress(request: fastify.FastifyRequest<{ Params: { id: string } }>): unknown {
    /** 请求体。 */
    const body = checks.asRecord(request.body ?? {}, '请求体');
    /** 限时的分钟数。 */
    const minutes = typeof body.minutes === 'number' && body.minutes > 0 ? body.minutes : undefined;
    /** 动作。 */
    const action = body.action === 'stop' ? 'stop' : 'limit';
    return { text: this.parts.progress?.act(Number(request.params.id), action, minutes) ?? '没有进度' };
  }

  /**
   * GET /api/autostart：转发给基地。
   * @param reply 回应。
   * @returns 基地的回应。
   */
  private getAutostart(reply: fastify.FastifyReply): Promise<fastify.FastifyReply> {
    return forward(this.parts, reply, '/autostart');
  }

  /**
   * POST /api/autostart：转发给基地。
   * @param request 请求。
   * @param reply 回应。
   * @returns 基地的回应。
   */
  private setAutostart(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> {
    return forward(this.parts, reply, '/autostart', request.body ?? {});
  }

  /**
   * GET /api/memory/search：转发给基地。
   * @param request 请求。
   * @param reply 回应。
   * @returns 基地的回应。
   */
  private memorySearch(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> {
    return forward(this.parts, reply, `/search${rawQuery(request)}`);
  }

  /**
   * GET /api/memory/health：转发给基地。
   * @param reply 回应。
   * @returns 基地的回应。
   */
  private memoryHealth(reply: fastify.FastifyReply): Promise<fastify.FastifyReply> {
    return forward(this.parts, reply, '/health');
  }

  /**
   * GET /api/rag/search：转发给基地。
   * @param request 请求。
   * @param reply 回应。
   * @returns 基地的回应。
   */
  private ragSearch(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> {
    return forward(this.parts, reply, `/rag/search${rawQuery(request)}`);
  }

  /**
   * POST /api/rag/index：转发给基地。
   * @param request 请求。
   * @param reply 回应。
   * @returns 基地的回应。
   */
  private ragIndexPost(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> {
    return forward(this.parts, reply, '/rag/index', request.body ?? {});
  }

  /**
   * GET /api/rag/index：转发给基地。
   * @param request 请求。
   * @param reply 回应。
   * @returns 基地的回应。
   */
  private ragIndexGet(
    request: fastify.FastifyRequest,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> {
    return forward(this.parts, reply, `/rag/index${rawQuery(request)}`);
  }

  /**
   * GET /*：托管 dist/web；/api 开头又没有对上的回 404。
   * @param request 请求。
   * @param reply 回应。
   * @returns 回应。
   */
  private serveWebPage(
    request: fastify.FastifyRequest<{ Params: { '*': string } }>,
    reply: fastify.FastifyReply,
  ): Promise<fastify.FastifyReply> | fastify.FastifyReply {
    /** 网址里的路径。 */
    const relative = decodeURIComponent(request.params['*'] ?? '');
    //G /api 开头又没有对上的，是写错的接口，不回网页。
    if (relative === 'api' || relative.startsWith('api/')) {
      return reply.code(404).send({ error: `没有这个接口：${request.method} /${relative}` });
    }
    return serveWeb(reply, relative);
  }
}
