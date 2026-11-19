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
import * as cutModule from '../../utils/Cut.ts';
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
  //M 向骨架注册当前飞书聊天的图片/文件/视频发送工具，限定只能发本轮工作区内部文件。
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
    sessionKinds: ['work'],
    run: async (args, session) => {
      const address = session.row.address as FeishuAddress | undefined;
      if (session.row.channel !== 'feishu' || !address?.appId || !address.chatId) {
        throw new Error('当前不是飞书会话，无法确定发送的应用和聊天');
      }
      //M 将入参路径解析成工作区内规范路径，并对目录越界做 realpath 校验。
      const file = doc.getFile(ctx, session, args['path'] as string);
      //G 只发这一轮工作区里的文件：builder 说话时是他的目录（utils/Workspace.ts 的 getWorkspace），别的是机器人的工作区。
      const workspace = workspaceModule.getWorkspace(ctx.bots.get(session.row.bot)!.workspace, address);
      const relative = path.relative(fs.realpathSync(workspace), fs.realpathSync(file));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('只能发送这一轮工作区里的文件');
      }
      const kind = args['kind'] as 'image' | 'file' | 'video' | undefined;
      //M 校验通过后执行上传并把媒体发往当前飞书会话，回传生成的 message_id。
      const id = await sendFile(feishu, address.appId, address.chatId, file, kind, address.messageId);
      return `已发送，message_id: ${id}`;
    },
  });
}


/** 原始 JSON 最多留多少字。 */
const RAW_MAX = 4000;


// 2026-11-17：自己的 truncate 去掉，原文太长改用 utils/Cut.ts 的 chars 截（末尾写明一共多少字）。


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
  const lines: string[] = [];
  if (post.title !== undefined && post.title !== '') {
    lines.push(post.title);
  }
  for (const paragraph of post.content ?? []) {
    let paragraphItems: unknown[] = [];
    if (Array.isArray(paragraph)) {
      paragraphItems = paragraph;
    }
    const parts = paragraphItems.map((item) => {
      const element = (item ?? {}) as { tag?: string; text?: string; href?: string; user_name?: string };
      if (element.tag === 'img' || element.tag === 'media') return '[图片]';

      if (element.tag === 'at') {
        if (element.user_name === undefined) return '';

        return `@${element.user_name}`;
      }
      return element.text ?? element.href ?? '';
    });
    lines.push(parts.join(''));
  }
  return lines.join('\n');
}


/**
 * 按飞书消息类型把解析后的字段拼成给机器人看的正文（未知类型保留中文类型名与截断后的原始 JSON）。
 * @param type 飞书消息类型。
 * @param raw 消息原始内容字符串。
 * @param content 解析出的 JSON 值。
 * @param top 顶层对象字典。
 * @param field 取顶层文字或数字字段的辅助函数（来自 describe 内部）。
 * @param duration 格式化的语音或视频时长后缀。
 * @returns 拼好的消息正文（未 trim）。
 */
function formatMessageText(
  type: string,
  raw: string,
  content: unknown,
  top: Record<string, unknown>,
  field: (key: string) => string,
  duration: string,
): string {
  //M 普通纯文本消息直接提取顶层 text 字段。
  if (type === 'text') return field('text');

  if (type === 'post') {
    if (typeof top['text'] === 'string') return top['text'];

    //M 富文本没有扁平 text 字段时，按段落与行内标签抽取纯文字。
    return postText(raw);
  }
  if (type === 'image') return '';

  if (type === 'file') return `[文件] ${field('file_name')}`;

  if (type === 'audio') return `[语音${duration}]`;

  if (type === 'media') return `[视频${duration}] ${field('file_name')}`;

  if (type === 'sticker') return '[表情包]';

  if (type === 'location') return `[位置] ${field('name')}（经度 ${field('longitude')}，纬度 ${field('latitude')}）`;

  if (type === 'share_chat') return `[群名片] ${field('chat_id')}`;

  if (type === 'share_user') return `[个人名片] ${field('user_id')}`;

  if (type === 'merge_forward') return '[合并转发]';

  //M 别的类型：写上类型名，后面跟原文 JSON；太长就截（utils/Cut.ts 的 chars）。
  const json = JSON.stringify(content, null, 2);
  const shown = cutModule.chars(json, RAW_MAX);
  return `[${TYPE_NAMES[type] ?? type}]\n${shown}`;
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
  let topObject: unknown = {};
  if (typeof content === 'object' && content !== null) {
    topObject = content;
  }
  const top = topObject as Record<string, unknown>;

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
      let named: string | undefined;
      if (typeof item['file_name'] === 'string') {
        named = item['file_name'];
      }
      resources.push({ key: item['file_key'], type: 'file', name: named ?? names[type] ?? 'attachment' });
    }
    //M 递归扫描嵌套子节点里的图片与文件资源标识。
    for (const child of Object.values(item)) {
      //M 下钻处理嵌套字段中的附件资源。
      collect(child);
    }
  };
  //M 仅针对飞书开放平台允许下载的消息类型递归搜集附件与图片 key。
  if (['post', 'image', 'file', 'audio', 'media'].includes(type)) {
    collect(content);
  }

  //M 文字：第一层的一个字段、时长（毫秒）写成“N 秒”。
  const field = (key: string): string => {
    const value = top[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);

    return '';
  };
  let duration = '';
  if (typeof top['duration'] === 'number') {
    duration = ` ${String(Math.round(top['duration'] / 1000))} 秒`;
  }
  //M 按飞书消息类型把解析出来的字段拼成正文。
  const text = formatMessageText(type, raw, content, top, field, duration);
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
  //M 按接收应用 ID 取对应的飞书 SDK 客户端用于拉取引用与合并转发原文。
  const client = feishu.client(appId);

  /** 一条换成文字，顺手记下资源；纯图片写 [图片]。 */
  const read = (item: MessageItem): string => {
    //M 复用标准消息描述逻辑抽取子消息正文与内含资源，并将资源归属到子消息 ID 上。
    const described = describe(item.msg_type ?? '', item.body?.content ?? '{}');
    result.resources.push(...described.resources.map((resource) => ({ ...resource, messageId: item.message_id })));
    if (described.text === '') return '[图片]';

    return described.text;
  };
  const fetch = async (id: string): Promise<MessageItem[]> => {
    //M 调用飞书 message.get 并携带限流退让重试，拉取指定消息体及其折叠子项。
    const got = await api.call('取消息', () => client.im.v1.message.get({ path: { message_id: id } }));
    return (got.data?.items ?? []) as MessageItem[];
  };

  if (message.parentId !== undefined && message.parentId !== '') {
    try {
      //M 存在父消息时拉取被引用原文，附带 500 字上限拼接成提示语。
      const [item] = await fetch(message.parentId);
      if (item === undefined) {
        result.quote = '【回复的消息未取到】';
      }
      if (item !== undefined) {
        //M 解析被引用消息内容并截取前 500 字拼成引用提示。
        const quoted = read(item).slice(0, 500);
        result.quote = `【回复的消息：${quoted}】`;
      }
    } catch (error) {
      result.quote = `[引用的消息没取到：${textModule.getMessage(error)}]`;
    }
  }
  if (message.type === 'merge_forward') {
    try {
      //M 合并转发：第一条是它自己，带 upper_message_id 的才是里面的。
      const items = (await fetch(message.messageId)).filter((item) => item.upper_message_id !== undefined);
      const lines = items.map((item, index) => {
        const at = Number(item.create_time);
        let time = '';
        if (Number.isFinite(at) && at > 0) {
          time = `${new Date(at).toLocaleString('zh-CN', { hour12: false })} `;
        }
        return `${String(index + 1)}. ${time}${read(item)}`;
      });
      result.forwarded = lines.join('\n');
    } catch (error) {
      result.forwarded = `[合并转发的内容没取到：${textModule.getMessage(error)}]`;
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
export async function download(
  feishu: Feishu,
  appId: string,
  messageId: string,
  resource: Resource,
): Promise<Uint8Array> {
  //M 按收信应用客户端调资源下载接口（带 429 重试）获取可读流。
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
    let piece: Buffer = Buffer.alloc(0);
    if (Buffer.isBuffer(chunk)) {
      piece = chunk;
    }
    if (!Buffer.isBuffer(chunk)) {
      piece = Buffer.from(chunk as Uint8Array);
    }
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
  //M 调用方未指定类别时按扩展名自动识别图片或普通文件。
  const kind = requestedKind ?? mime.getKind(file);
  if (requestedKind === 'image' && (!IMAGE_EXTENSIONS.has(extension) || data.length > IMAGE_MAX)) {
    throw new Error('图片格式不支持或超过 10MB');
  }
  if (requestedKind === 'video' && extension !== '.mp4') {
    throw new Error('视频请提供 mp4 文件');
  }

  //M 图片：格式和大小都对才按图片发，不然当附件。
  if (kind === 'image' && IMAGE_EXTENSIONS.has(extension) && data.length <= IMAGE_MAX) {
    const client = feishu.client(appId);
    const imageData = { image_type: 'message', image: data } as const;
    const uploaded = await api.call('上传图片', () => client.im.v1.image.create({ data: imageData }));
    const imageKey = uploaded?.image_key;
    if (imageKey === undefined || imageKey === '') {
      throw new Error('飞书上传图片成功但没有交回 image_key');
    }
    //M 上传得到 image_key 后调用统一发送接口推送图片消息。
    return message(feishu, appId, chatId, 'image', { image_key: imageKey }, messageId);
  }

  //M 视频 mp4、语音 opus：先按媒体消息发，发不成退回附件（文件总要送到），原因记日志。
  let mediaKind: 'media' | 'audio' | undefined;
  if (extension === '.mp4') {
    mediaKind = 'media';
  }
  if (extension === '.opus') {
    mediaKind = 'audio';
  }
  if (requestedKind !== 'file' && mediaKind !== undefined) {
    try {
      return await uploadAndSend(feishu, appId, chatId, file, data, mediaKind, messageId);
    } catch (error) {
      let said = '语音';
      if (mediaKind === 'media') {
        said = '视频';
      }
      const failedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      const reason = textModule.getMessage(error);
      console.error(`${failedAt} 飞书：${path.basename(file)} 按${said}消息没发成，改按附件发：${reason}`);
    }
  }
  //M 非音视频文件或媒体方式失败后统一退回按普通文件附件上传发送。
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
  let uploadType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' = 'opus';
  if (type === 'media') {
    uploadType = 'mp4';
  }
  if (type === 'file') {
    const mapped = FILE_TYPES[path.extname(file).toLowerCase()] ?? 'stream';
    uploadType = mapped;
    if (mapped === 'mp4' || mapped === 'opus') {
      uploadType = 'stream';
    }
  }
  //M 按应用取得 SDK 客户端后上传文件字节换取 file_key，再推对应类型消息。
  const client = feishu.client(appId);
  const uploaded = await api.call('上传文件', () => client.im.v1.file.create({
    data: { file_type: uploadType, file_name: path.basename(file), file: data },
  }));
  const fileKey = uploaded?.file_key;
  if (fileKey === undefined || fileKey === '') {
    throw new Error('飞书上传文件成功但没有交回 file_key');
  }
  //M 带 file_key 发出 file/media/audio 消息并回传 message_id。
  return message(feishu, appId, chatId, type, { file_key: fileKey }, messageId);
}


/**
 * 发一条消息。
 * @param feishu 飞书渠道。
 * @param appId 从哪个应用发。
 * @param chatId 发到哪个聊天。
 * @param type 消息类型：text、image、file、media、audio、interactive。
 * @param content 消息内容（会转成 JSON 字符串）。
 * @param messageId 可引用回复的原消息号。
 * @param uuid 直发的供应方去重键。同一发送请求内部重试沿用该键。
 * @returns 新消息的 message_id。
 * @throws 发不出去时抛错：飞书明确拒了是 api.NotSent，断网、超时这类不知道收没收的是普通 Error。
 */
export async function message(
  feishu: Feishu,
  appId: string,
  chatId: string,
  type: string,
  content: unknown,
  messageId?: string,
  uuid?: string,
): Promise<string> {
  //M 获取发送应用对应的飞书客户端实例。
  const client = feishu.client(appId);
  if (messageId) {
    try {
      //M 若带有原消息号则优先作为引用回复发出（可带限流重试）。
      const replied = await api.call('回复消息', () => client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: type, content: JSON.stringify(content) },
      }));
      return replied.data?.message_id ?? '';
    } catch (error) {
      //G 不知道回复发没发到（断网、超时）→ 不再普通发送一遍，免得发两条；原样抛出去。
      if (!(error instanceof api.NotSent)) throw error;

      //M 飞书明确拒了回复（原消息撤回了这类）→ 改普通发送。
      console.error(`飞书回复失败，改为普通发送：${textModule.getMessage(error)}`);
    }
  }
  //M 无原消息号或回复被明确拒收时走聊天直发通道。
  const data: NonNullable<Parameters<typeof client.im.v1.message.create>[0]>['data'] = {
    receive_id: chatId,
    msg_type: type,
    content: JSON.stringify(content),
  };
  if (uuid !== undefined) {
    data.uuid = uuid;
  }

  const payload = { params: { receive_id_type: 'chat_id' as const }, data };
  const sent = await api.call('发消息', () => client.im.v1.message.create(payload));
  return sent.data?.message_id ?? '';
}
