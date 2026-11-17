/**
 * 飞书消息的内容和资源：各类型消息换成给机器人的文字、取引用和合并转发、下载图片文件、上传并发出文件。
 * 都是函数，不建 class；要用 SDK 客户端时从 feishu.client(应用号) 取。
 * 照 0.4 的 src/channels/Feishu.ts（describeContent、fetchRelated、send）、FeishuSdk.ts（postText）、FeishuMedia.ts（上传前查大小格式）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as doc from './doc/Doc.ts';
import type { FeishuAddress } from './index.ts';
import * as mime from '../../utils/Mime.ts';
import * as textModule from '../../utils/Text.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import * as api from './Api.ts';
import type { Feishu } from './index.ts';


/** 消息里带的一个资源（图片、文件、语音、视频），要下载下来。 */
export interface Resource {
  /** 飞书的 image_key 或 file_key。 */
  key: string;
  /** 下载接口要的类型：图片是 image，别的都是 file。 */
  type: 'image' | 'file';
  /** 存下来叫什么。 */
  name: string;
  /** 资源在哪条消息上；引用、合并转发里的资源不在收到的那条上。不写就是收到的那条。 */
  messageId?: string;
}


/** 取回来的引用、合并转发。 */
export interface Related {
  /** 引用的那条，写成“[引用] 文字”；没有引用是空串。 */
  quote: string;
  /** 合并转发里逐条“序号. 时间 文字”；不是合并转发是空串。 */
  forwarded: string;
  /** 引用、转发里带的资源。 */
  resources: Resource[];
}


/** 消息接口 message.get 交回的一条。 */
interface MessageItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  upper_message_id?: string;
  body?: { content: string };
}


/** 认不出的消息类型的中文名（0.4 同）。 */
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

/** 下载上限：飞书只给下 100MB 以内的资源。 */
const DOWNLOAD_MAX = 100 * 1024 * 1024;

/** 图片消息上限 10MB；飞书收的图片格式。 */
const IMAGE_MAX = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.tif', '.bmp', '.ico']);

/** 文件消息上限 30MB。 */
const FILE_MAX = 30 * 1024 * 1024;

/** 扩展名 → 上传文件时的 file_type；别的都是 stream。 */
const FILE_TYPES: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt'> = {
  '.opus': 'opus',
  '.mp4': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
};

/** 登记当前飞书会话的文件发送工具；上传和发送复用 sendFile。 */
export function setup(feishu: Feishu, ctx: cordis.Context): void {
  ctx.tools.register({
    definition: {
      name: 'feishu_send_file',
      description: '把机器人工作区内的图片、文件或 mp4 视频发到当前飞书聊天，返回 message_id。非飞书会话不可用。',
      parameters: piAi.Type.Object({
        path: piAi.Type.String({ minLength: 1, description: '工作区相对路径或工作区内绝对路径' }),
        kind: piAi.Type.Optional(piAi.Type.Union([
          piAi.Type.Literal('image'), piAi.Type.Literal('file'), piAi.Type.Literal('video'),
        ])),
      }),
    },
    kinds: ['work'],
    run: async (args, session) => {
      const address = session.row.address as FeishuAddress | undefined;
      if (session.row.channel !== 'feishu' || !address?.appId || !address.chatId) {
        throw new Error('当前不是飞书会话，无法确定发送的应用和聊天');
      }
      const file = doc.file(ctx, session, args['path'] as string);
      //G 只发这一轮工作区里的文件：builder 说话时是他的目录（utils/Workspace.ts 的 of），别的是机器人的工作区。
      const workspace = workspaceModule.of(ctx.bots.get(session.row.bot)!.workspace, address);
      const relative = path.relative(fs.realpathSync(workspace), fs.realpathSync(file));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('只能发送这一轮工作区里的文件');
      }
      const kind = args['kind'] as 'image' | 'file' | 'video' | undefined;
      const id = await sendFile(feishu, address.appId, address.chatId, file, kind, address.messageId);
      return `已发送，message_id: ${id}`;
    },
  });
}


/** 原始 JSON 最多留多少字。 */
const RAW_MAX = 4000;


/**
 * 截断：太长的留前面，末尾写明截掉了多少。
 * @param text 原文。
 * @param max 最多几个字。
 * @returns 截过的。
 */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}……（截掉 ${String(text.length - max)} 字）`;
}


/**
 * 取出图文消息（post）里的文字：标题一行，每段一行；文字、链接、@ 照写，图片写成 [图片]。
 * 收到的 post 有两种写法：{ title, content } 或按语言包包一层 { zh_cn: { title, content } }。
 * @param raw 消息的 content（JSON 字符串）。
 * @returns 文字。
 */
export function postText(raw: string): string {
  let post = JSON.parse(raw) as { title?: string; content?: unknown[][] } & Record<string, unknown>;
  if (!Array.isArray(post.content)) {
    const first = Object.values(post).find((value) => typeof value === 'object' && value !== null
      && Array.isArray((value as { content?: unknown }).content));
    post = (first ?? {}) as typeof post;
  }
  const lines = post.title !== undefined && post.title !== '' ? [post.title] : [];
  for (const paragraph of post.content ?? []) {
    const parts = (Array.isArray(paragraph) ? paragraph : []).map((item) => {
      const element = (item ?? {}) as { tag?: string; text?: string; href?: string; user_name?: string };
      if (element.tag === 'img' || element.tag === 'media') return '[图片]';
      if (element.tag === 'at') return element.user_name === undefined ? '' : `@${element.user_name}`;
      return element.text ?? element.href ?? '';
    });
    lines.push(parts.join(''));
  }
  return lines.join('\n');
}


/**
 * 一条消息换成给机器人的文字和要下载的资源（第 4 节的表）。
 * @param type 飞书的消息类型：text、post、image、file、audio、media、sticker……
 * @param raw 消息的 content（JSON 字符串）。
 * @returns 文字（去了首尾空白）和资源（按 key 去重）。
 */
export function describe(type: string, raw: string): { text: string; resources: Resource[] } {
  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch {
    return { text: raw, resources: [] };
  }
  const top = (typeof content === 'object' && content !== null ? content : {}) as Record<string, unknown>;

  //M 资源：只有这几种下载得了（表情包、卡片里的飞书不让下），递归找 image_key、file_key。
  const resources: Resource[] = [];
  const collect = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const item = value as Record<string, unknown>;
    if (typeof item['image_key'] === 'string') {
      const key = item['image_key'];
      resources.push({ key, type: 'image', name: `image_${key.slice(-8)}.png` });
    }
    if (typeof item['file_key'] === 'string') {
      const names: Record<string, string> = { audio: 'audio.opus', media: 'video.mp4' };
      const named = typeof item['file_name'] === 'string' ? item['file_name'] : undefined;
      resources.push({ key: item['file_key'], type: 'file', name: named ?? names[type] ?? 'attachment' });
    }
    for (const child of Object.values(item)) {
      collect(child);
    }
  };
  if (['post', 'image', 'file', 'audio', 'media'].includes(type)) collect(content);

  //M 文字：第一层的一个字段、时长（毫秒）写成“N 秒”。
  const field = (key: string): string => {
    const value = top[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  };
  const duration = typeof top['duration'] === 'number' ? ` ${String(Math.round(top['duration'] / 1000))} 秒` : '';
  let text: string;
  if (type === 'text') {
    text = field('text');
  } else if (type === 'post') {
    text = typeof top['text'] === 'string' ? top['text'] : postText(raw);
  } else if (type === 'image') {
    text = '';
  } else if (type === 'file') {
    text = `[文件] ${field('file_name')}`;
  } else if (type === 'audio') {
    text = `[语音${duration}]`;
  } else if (type === 'media') {
    text = `[视频${duration}] ${field('file_name')}`;
  } else if (type === 'sticker') {
    text = '[表情包]';
  } else if (type === 'location') {
    text = `[位置] ${field('name')}（经度 ${field('longitude')}，纬度 ${field('latitude')}）`;
  } else if (type === 'share_chat') {
    text = `[群名片] ${field('chat_id')}`;
  } else if (type === 'share_user') {
    text = `[个人名片] ${field('user_id')}`;
  } else if (type === 'merge_forward') {
    text = '[合并转发]';
  } else {
    text = `[${TYPE_NAMES[type] ?? type}]\n${truncate(JSON.stringify(content, null, 2), RAW_MAX)}`;
  }
  const unique = resources.filter((item, index) => resources.findIndex((other) => other.key === item.key) === index);
  return { text: text.trim(), resources: unique };
}


/**
 * 取事件里没有的内容：引用的那条、合并转发里的每一条。取不到写明原因，不挡这条消息。
 * @param feishu 飞书渠道（取客户端）。
 * @param appId 哪个应用收的。
 * @param message 收到的那条：消息号、引用的消息号、类型。
 * @returns 引用、转发的文字和它们带的资源。
 */
export async function related(
  feishu: Feishu,
  appId: string,
  message: { messageId: string; parentId?: string; type: string },
): Promise<Related> {
  const result: Related = { quote: '', forwarded: '', resources: [] };
  const client = feishu.client(appId);

  /** 一条换成文字，顺手记下资源；纯图片写 [图片]。 */
  const read = (item: MessageItem): string => {
    const described = describe(item.msg_type ?? '', item.body?.content ?? '{}');
    result.resources.push(...described.resources.map((resource) => ({ ...resource, messageId: item.message_id })));
    return described.text === '' ? '[图片]' : described.text;
  };
  const fetch = async (id: string): Promise<MessageItem[]> => {
    const got = await api.call('取消息', () => client.im.v1.message.get({ path: { message_id: id } }));
    return (got.data?.items ?? []) as MessageItem[];
  };

  if (message.parentId !== undefined && message.parentId !== '') {
    try {
      const [item] = await fetch(message.parentId);
      result.quote = item === undefined
        ? '【回复的消息未取到】'
        : `【回复的消息：${read(item).slice(0, 500)}】`;
    } catch (error) {
      result.quote = `[引用的消息没取到：${textModule.messageOf(error)}]`;
    }
  }
  if (message.type === 'merge_forward') {
    try {
      //M 合并转发：第一条是它自己，带 upper_message_id 的才是里面的。
      const items = (await fetch(message.messageId)).filter((item) => item.upper_message_id !== undefined);
      const lines = items.map((item, index) => {
        const at = Number(item.create_time);
        const time = Number.isFinite(at) && at > 0 ? `${new Date(at).toLocaleString('zh-CN', { hour12: false })} ` : '';
        return `${String(index + 1)}. ${time}${read(item)}`;
      });
      result.forwarded = lines.join('\n');
    } catch (error) {
      result.forwarded = `[合并转发的内容没取到：${textModule.messageOf(error)}]`;
    }
  }
  return result;
}


/**
 * 下载一个资源，读进内存。
 * @param feishu 飞书渠道。
 * @param appId 哪个应用。
 * @param messageId 资源在哪条消息上。
 * @param resource 资源。
 * @returns 文件内容。
 * @throws 接口出错、超过 100MB 时抛错。
 */
export async function download(feishu: Feishu, appId: string, messageId: string, resource: Resource): Promise<Uint8Array> {
  const client = feishu.client(appId);
  const got = await api.call('下载资源', () => client.im.v1.messageResource.get({
    params: { type: resource.type },
    path: { message_id: messageId, file_key: resource.key },
  }));
  const declared = Number((got.headers as Record<string, unknown> | undefined)?.['content-length'] ?? 0);
  if (declared > DOWNLOAD_MAX) {
    throw new Error(`文件 ${String(Math.round(declared / 1024 / 1024))}MB，超过 100MB`);
  }

  //M 边读边数，过 100MB 就停，不信 content-length。
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of got.getReadableStream()) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += piece.length;
    if (size > DOWNLOAD_MAX) {
      throw new Error('文件超过 100MB');
    }
    chunks.push(piece);
  }
  return new Uint8Array(Buffer.concat(chunks));
}


/**
 * 发一个本地文件到聊天：图片发图片，.mp4 发视频，.opus 发语音，别的发附件；视频、语音发不成退回附件。
 * @param feishu 飞书渠道。
 * @param appId 从哪个应用发。
 * @param chatId 发到哪个聊天。
 * @param file 文件的绝对路径。
 * @throws 空文件、太大、格式不对、上传或发送失败时抛错。
 */
export async function sendFile(
  feishu: Feishu,
  appId: string,
  chatId: string,
  file: string,
  requestedKind?: 'image' | 'file' | 'video',
  messageId?: string,
): Promise<string> {
  const data = fs.readFileSync(file);
  if (data.length === 0) {
    throw new Error(`${path.basename(file)} 是空文件，飞书不收`);
  }
  const extension = path.extname(file).toLowerCase();
  const kind = requestedKind ?? mime.kindOf(file);
  if (requestedKind === 'image' && (!IMAGE_EXTENSIONS.has(extension) || data.length > IMAGE_MAX)) {
    throw new Error('图片格式不支持或超过 10MB');
  }
  if (requestedKind === 'video' && extension !== '.mp4') {
    throw new Error('视频请提供 mp4 文件');
  }

  //M 图片：格式和大小都对才按图片发，不然当附件。
  if (kind === 'image' && IMAGE_EXTENSIONS.has(extension) && data.length <= IMAGE_MAX) {
    const client = feishu.client(appId);
    const uploaded = await api.call('上传图片', () => client.im.v1.image.create({ data: { image_type: 'message', image: data } }));
    const imageKey = uploaded?.image_key;
    if (imageKey === undefined || imageKey === '') {
      throw new Error('飞书上传图片成功但没有交回 image_key');
    }
    return message(feishu, appId, chatId, 'image', { image_key: imageKey }, messageId);
  }

  //M 视频 mp4、语音 opus：先按媒体消息发，发不成退回附件（文件总要送到），原因记日志。
  const media = extension === '.mp4' ? 'media' : extension === '.opus' ? 'audio' : undefined;
  if (requestedKind !== 'file' && media !== undefined) {
    try {
      return await uploadAndSend(feishu, appId, chatId, file, data, media, messageId);
    } catch (error) {
      const said = media === 'media' ? '视频' : '语音';
      console.error(`${new Date().toLocaleString('zh-CN', { hour12: false })} 飞书：${path.basename(file)} 按${said}消息没发成，改按附件发：${textModule.messageOf(error)}`);
    }
  }
  return uploadAndSend(feishu, appId, chatId, file, data, 'file', messageId);
}


/**
 * 上传文件再发一条文件、视频或语音消息。
 * @param feishu 飞书渠道。
 * @param appId 从哪个应用发。
 * @param chatId 发到哪个聊天。
 * @param file 文件路径（取名字和扩展名）。
 * @param data 文件内容。
 * @param type 消息类型。
 * @throws 超过 30MB、上传或发送失败时抛错。
 */
async function uploadAndSend(
  feishu: Feishu,
  appId: string,
  chatId: string,
  file: string,
  data: Buffer,
  type: 'file' | 'media' | 'audio',
  messageId?: string,
): Promise<string> {
  if (data.length > FILE_MAX) {
    throw new Error(`${path.basename(file)} 超过 30MB，飞书不收`);
  }
  const fileType = type === 'file' ? (FILE_TYPES[path.extname(file).toLowerCase()] ?? 'stream') : (type === 'media' ? 'mp4' : 'opus');
  const client = feishu.client(appId);
  const uploaded = await api.call('上传文件', () => client.im.v1.file.create({
    data: { file_type: type === 'file' && (fileType === 'mp4' || fileType === 'opus') ? 'stream' : fileType, file_name: path.basename(file), file: data },
  }));
  const fileKey = uploaded?.file_key;
  if (fileKey === undefined || fileKey === '') {
    throw new Error('飞书上传文件成功但没有交回 file_key');
  }
  return message(feishu, appId, chatId, type, { file_key: fileKey }, messageId);
}


/**
 * 发一条消息。
 * @param feishu 飞书渠道。
 * @param appId 从哪个应用发。
 * @param chatId 发到哪个聊天。
 * @param type 消息类型：text、image、file、media、audio、interactive。
 * @param content 消息内容（会转成 JSON 字符串）。
 * @returns 新消息的 message_id。
 * @throws 发不出去时抛错。
 */
export async function message(
  feishu: Feishu,
  appId: string,
  chatId: string,
  type: string,
  content: unknown,
  messageId?: string,
): Promise<string> {
  const client = feishu.client(appId);
  if (messageId) {
    try {
      const replied = await api.call('回复消息', () => client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: type, content: JSON.stringify(content) },
      }));
      return replied.data?.message_id ?? '';
    } catch (error) {
      console.error(`飞书回复失败，改为普通发送：${textModule.messageOf(error)}`);
    }
  }
  const sent = await api.call('发消息', () => client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: type, content: JSON.stringify(content) },
  }));
  return sent.data?.message_id ?? '';
}
