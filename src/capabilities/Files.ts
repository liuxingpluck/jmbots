/**
 * 文件库（docs/10 第 3 节、6.4）：机器人文件夹里的文件和全局技能。文件是写给人和 AI 看的，**数据库才是真相**：
 * 消息文件、分派记录、会话文件都是照数据库整份重写（先写 .tmp 再改名，读的人不会读到半截）。
 *
 *   bots/<机器人>/
 *     机器人.yaml                     机器人设置：merge_ms
 *     message/<渠道>_<17 位时间>_<说明>/  一条消息一个文件夹，说明是原话开头最多 20 个字：同名 .md 是消息文件（原话、分派、结果），同名 _分派.md/.json 是分派记录，1.png、2_报告.pdf… 是带的图和附件
 *     workspace/<工作区>/工作区.yaml   说明 + 工作目录
 *     workspace/<工作区>/<会话ID>_<标题>.md / .json / _压缩.md
 *     memory/索引.md（英文 index.md）  记忆概要，机器人自己维护
 *   skills/<技能>/SKILL.md             技能（全局）；bots/<机器人>/skills/<技能>/SKILL.md 是个人技能，同名时个人优先
 *   memory/                            公共记忆，所有机器人能读能搜，写要明确写到公共区
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import type * as dispatchModule from '../dispatch/Dispatch.ts';
import type * as resourcesModule from '../resources/Resources.ts';
import type * as storeModule from './Store.ts';


/** 一个机器人的几个目录。 */
export interface BotPaths {
  /** bots/<机器人>/。 */
  botDir: string;
  /** message/：消息文件、消息带的图、分派记录。 */
  messageDir: string;
  /** workspace/：下面一层是工作区。 */
  workspaceRoot: string;
  /** memory/：机器人自己管的记忆。 */
  memoryDir: string;
}


/** 一个工作区。 */
export interface WorkspaceInfo {
  /** 名字（文件夹名）。 */
  name: string;
  /** 一句话说明，分派靠它选工作区。 */
  description: string;
  /** 工具干活的目录；工作区.yaml 没写 dir 时是工作区文件夹下的 files/。 */
  dir: string;
}


/** 存好的收件。 */
export interface Incoming {
  /** 消息文件的绝对路径（内容由 writeMessage 写）。 */
  file: string;
  /** 原话：图片已换成 @绝对路径。 */
  text: string;
}


/** 收到的一张图。 */
export interface IncomingImage {
  /** 原来的文件名（图片取扩展名；文档、语音、视频留着名字）。 */
  name: string;
  /** 内容。 */
  data: Uint8Array;
}


/** 机器人设置（机器人.yaml）。 */
export interface BotSettings {
  /** 只收件供外部处理，不自动分派或执行。 */
  relayOnly?: boolean;
  /** 合批等多久，毫秒；没写用 config 的 engine.merge_ms。 */
  mergeMs?: number;
}


/** 记忆文件夹里一个改过的文件（自动感应用）。 */
export interface MemoryChange {
  /** 绝对路径。 */
  path: string;
  /** 修改时间，毫秒。 */
  mtime: number;
  /** 开头一句（去掉 # 号，最多 50 字）。 */
  head: string;
}


/** 一个技能。 */
export interface SkillInfo {
  /** 名字（SKILL.md 开头的 name；没写用文件夹名）。 */
  name: string;
  /** 一句话说明（description；没写用正文第一行）。 */
  description: string;
  /** SKILL.md 的绝对路径。 */
  file: string;
}


/** 写会话文件要的、数据库里没有的东西（由会话循环给）。 */
export interface SessionView {
  /** 用到的提示词文件（md 里只写路径）。 */
  promptFiles: string[];
  /** 技能清单有几个技能。 */
  skills: number;
  /** 系统提示词全文（.json 里给程序看）。 */
  system: string;
  /** 给模型的工具定义（.json 里给程序看）。 */
  tools: piAi.Tool[];
  /** 现在的模型能不能看图、最大上下文；清单里没有时不写。 */
  model?: { vision: boolean; contextWindow: number };
  /** 工作目录。 */
  workDir: string;
  /** 这个会话里用户消息对应的收件（md 里写渠道、时间、@消息文件）。 */
  incoming: storeModule.MessageRow[];
}


/** 一个会话的三个文件。 */
export interface SessionFiles {
  /** 给人看的 md。 */
  md: string;
  /** 给程序看的 json。 */
  json: string;
  /** 精简版 _压缩.md。 */
  compact: string;
}


/** 消息文件夹名后面的说明最多几个字。 */
const MESSAGE_NOTE_CHARS = 20;

/** 每一步之间的那一行等号（前后各空一行，免得 Markdown 把上面一行当成大标题）。 */
const SEPARATOR = `\n\n${'='.repeat(68)}\n\n`;

/** 记忆概要最多多少字。 */
const MEMORY_INDEX_MAX_CHARS = 4000;

/** md 里工具结果超过这么长就只放头尾。 */
const RESULT_MAX_CHARS = 3000;

/** 头尾各放多少。 */
const RESULT_HEAD_CHARS = 2000;
const RESULT_TAIL_CHARS = 500;

/** 新机器人的默认工作区。 */
const DEFAULT_WORKSPACE = '日常';

/** 渠道显示名。 */
const CHANNEL_NAMES: Record<string, string> = { http: 'HTTP', feishu: '飞书' };

/** 一次运行的结局写成中文。 */
const ENDINGS: Record<storeModule.RunEnding, string> = { done: '做完', interrupted: '被打断', limit: '到上限', error: '出错' };

/** 会话状态写成中文。 */
const STATUSES: Record<storeModule.SessionStatus, string> = { idle: '空闲', running: '运行中', error: '出错' };

/** 网页新建机器人时写进索引.md 第一段的（docs/界面/01_界面设计.md 6.2）。 */
export interface BotIntro {
  /** 一句话身份；空是没定。 */
  identity: string;
  /** 平时用的模型；空是没定。 */
  model: string;
}


/** 新机器人的初始记忆概要（docs/10 7.1 末尾）；网页新建时第一段用填的身份和模型。 */
const INITIAL_INDEX = {
  zh: (name: string, intro?: BotIntro) => `# 我是谁\n\n${intro?.identity ? `我是${name}，jmbots 里的机器人：${intro.identity}。` : `我是${name}，jmbots 里的机器人。具体身份还没定——用户告诉我我是谁、做什么、平时用什么模型之后，我把它写在这一段。`}${intro?.model ? `平时用 ${intro.model}。` : ''}\n\n# 记忆都涉及什么\n\n（还没有）\n`,
  en: (name: string, intro?: BotIntro) => `# Who I am\n\n${intro?.identity ? `I am ${name}, a bot in jmbots: ${intro.identity}.` : `I am ${name}, a bot in jmbots. My identity is not set yet; once the user tells me who I am, what I do and which models I usually use, I write it here.`}${intro?.model ? ` I usually use ${intro.model}.` : ''}\n\n# What my memory covers\n\n(nothing yet)\n`,
};


/**
 * 17 位本地时间：年月日时分秒毫秒，消息文件名用。
 * @param time 毫秒时间戳，默认现在。
 * @returns 如 20261105102305123。
 */
function stamp(time = Date.now()): string {
  return utils.createSessionId(new Date(time)).slice(0, 17);
}


/**
 * 时分秒，如 10:23:05。
 * @param time 毫秒时间戳。
 */
function clock(time: number): string {
  return utils.formatTime(time).slice(11);
}


/**
 * 截短，超了在末尾加省略号。
 * @param text 原文。
 * @param max 最多几个字。
 */
function clip(text: string, max: number): string {
  /** 去掉首尾空白、换行压成空格。 */
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}


/**
 * 秒数，一位小数。
 * @param ms 毫秒。
 */
function seconds(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}


/**
 * @路径：带空格或中文标点的写成 @"……"（和 00_base_dsh.md 的约定一样；不加引号时认路径的人到这些字就停了）。
 * @param file 绝对路径。
 */
function at(file: string): string {
  return /[\s，。、；：！？（）【】《》「」'<>|]/u.test(file) ? `@"${file}"` : `@${file}`;
}


/**
 * 消息文件夹名后面的简短说明（用户 11-05：全是时间戳看不出在讲什么）：原话开头的字，只留文字和数字。
 * @param text 原话。
 * @param hasFiles 带没带附件。
 * @returns 最多 MESSAGE_NOTE_CHARS 个字；什么字都没有时，带附件的写“附件”，否则是空的。
 */
export function messageNote(text: string, hasFiles: boolean): string {
  /** 去掉 @路径以后的文字和数字，一段一段。 */
  const words = text.replace(/@"[^"]*"|@\S+/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  /** 拼起来，按字截断。 */
  const note = [...words.join('_')].slice(0, MESSAGE_NOTE_CHARS).join('').replace(/_+$/, '');
  return note || (hasFiles ? '附件' : '');
}


/**
 * 一条 Pi 消息里的文字（图片不算）。
 * @param message Pi 消息。
 */
function textOf(message: piAi.Message): string {
  if (message.role === 'system') {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}


/**
 * 先写 .tmp 再改名，读的人不会读到半截。
 * @param file 目标文件。
 * @param text 内容。
 * @returns 无。
 * 副作用：建上级目录、写文件。
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  writeCount += 1;
  /** 临时文件（带递增编号：同一个文件同时写两次也不会撞名）。 */
  const temp = `${file}.${process.pid}.${writeCount}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  try {
    await fs.rename(temp, file);
  } catch {
    //G Windows 上目标文件被别的程序开着（编辑器、memorycli）时改名会失败：退回直接写，再删临时文件。
    await fs.writeFile(file, text, 'utf8');
    await fs.rm(temp, { force: true });
  }
}


/** 写过几次文件（临时文件编号用）。 */
let writeCount = 0;


/**
 * 看内容认图片类型（飞书的 JPEG 也可能叫 image.png，扩展名不可信）。
 * @param data 文件内容。
 * @returns 扩展名；不是图片时 undefined。
 */
function imageExtension(data: Uint8Array): string | undefined {
  /** 开头几个字节的十六进制。 */
  const head = Buffer.from(data.subarray(0, 12)).toString('hex');
  if (head.startsWith('89504e47')) {
    return '.png';
  }
  if (head.startsWith('ffd8ff')) {
    return '.jpg';
  }
  if (head.startsWith('47494638')) {
    return '.gif';
  }
  if (head.startsWith('52494646') && head.slice(16, 24) === '57454250') {
    return '.webp';
  }
  return head.startsWith('424d') ? '.bmp' : undefined;
}


/**
 * 附件在消息文件夹里的名字：图片和没有名字的是“序号 + 扩展名”，别的是“序号_原名”（文档留着名字才认得）。
 * @param order 第几个，从 1 数。
 * @param attachment 附件。
 */
function attachmentName(order: number, attachment: IncomingImage): string {
  /** 原名的扩展名。 */
  const extension = path.extname(attachment.name).toLowerCase();
  /** 看内容认出来的图片扩展名。 */
  const image = imageExtension(attachment.data);
  if (image || /^\.(png|jpe?g|gif|webp|bmp)$/.test(extension)) {
    return `${order}${image ?? extension}`;
  }
  return /^(image|audio|video|attachment)\./.test(attachment.name) || !attachment.name ? `${order}${extension}` : `${order}_${utils.safeFolderName(attachment.name)}`;
}


/**
 * 会话现在的思考强度：最近一步实际用的；还没跑过就是会话上写的。
 * @param session 会话。
 * @returns 思考强度；都没有时 undefined。
 */
function currentEffort(session: storeModule.SessionRow): string | undefined {
  return session.messages.findLast((stored) => stored.effort)?.effort ?? session.thinking ?? undefined;
}


/**
 * 文件名主干：<会话 ID>_<标题>（标题去掉不能做文件名的字符）。
 * @param session 会话。
 */
function sessionBase(session: Pick<storeModule.SessionRow, 'id' | 'title'>): string {
  return `${session.id}_${utils.safeFolderName(session.title || '未命名')}`;
}


/**
 * 拼“每一步之间一行等号”的正文：会话文件和分派记录共用。
 * @param blocks 每一块的文字。
 * @returns 用等号行连起来的正文。
 */
function renderSteps(blocks: string[]): string {
  return blocks.filter((block) => block.trim()).join(SEPARATOR);
}


/** 用户消息正文里每条消息开头那行：[渠道 · 时间 · 消息 #号]（docs/10 7.4）。 */
const USER_HEADER = /^\[(.+?) · \d{4}-\d\d-\d\d (\d\d:\d\d:\d\d) · (?:消息|message) #(\d+)\]$/gm;


/**
 * 去掉程序加在会话第一条输入、压缩摘要开头的那段“这个会话”和记忆概要（那是给模型看的），只留后面的正文。
 * @param text 这条消息的全文。
 * @returns 正文，和有没有去掉东西。
 */
function stripPreface(text: string): { body: string; prefaced: boolean } {
  /** 那段后面接的是什么。 */
  const marker = ['# 用户的消息\n\n', '# User message\n\n', '（以下是前面对话的摘要）\n', '(Summary of the earlier conversation)\n'].find((item) => text.includes(item));
  if (!marker || !(text.startsWith('# 这个会话') || text.startsWith('# This session'))) {
    return { body: text, prefaced: false };
  }
  return { body: text.slice(text.indexOf(marker) + marker.length), prefaced: true };
}


/**
 * 用户的原话：去掉开头那段、每条消息开头那行和后面接的自动感应（压缩版、分派认会话用）。
 * @param text 这条用户消息的全文。
 * @returns 原话。
 */
function userWords(text: string): string {
  /** 正文。 */
  const body = stripPreface(text).body;
  /** 自动感应从哪开始。 */
  const sense = body.search(/（系统）自动感应|\(system\) Auto-sense/);
  return (sense >= 0 ? body.slice(0, sense) : body).replace(USER_HEADER, '').trim();
}


/**
 * 多行文字放进代码块：工具结果、现状原文里的 # 和列表不要被 Markdown 当成文档结构。一行的原样。
 * @param text 文字。
 */
function fenced(text: string): string {
  if (!text.includes('\n')) {
    return text;
  }
  /** 比里面最长的一串反引号还长一个。 */
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `\n\n${fence}text\n${text}\n${fence}`;
}


/**
 * 行尾加两个空格：Markdown 预览时单个换行会被并成一段，这样每行还是一行。标题行不用加。
 * @param text 文字。
 */
function hardBreaks(text: string): string {
  return text.replace(/^(?!#)(.*\S)$/gm, '$1  ');
}


/**
 * 工具结果在 md 里的样子：超过 3000 字放开头 2000 字和结尾 500 字，写明全文在 .json 的第几条。
 * @param text 结果全文。
 * @param jsonIndex 它在 .json 的 messages 里是第几条（从 0 数）。
 */
function resultText(text: string, jsonIndex: number): string {
  if (text.length <= RESULT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, RESULT_HEAD_CHARS)}\n……（共 ${text.length} 字，中间省略；全文在 .json 的 messages[${jsonIndex}]）……\n${text.slice(-RESULT_TAIL_CHARS)}`;
}


/**
 * 工具调用的主要参数，压缩版用：path、command、query、title、text，都没有就是参数的 JSON。
 * @param args 参数。
 */
function briefArgs(args: unknown): string {
  /** 参数对象。 */
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  for (const key of ['path', 'command', 'query', 'title', 'action', 'text']) {
    if (typeof record[key] === 'string') {
      return clip(record[key], 100);
    }
  }
  return clip(JSON.stringify(args ?? {}), 100);
}


/**
 * 照数据库拼消息文件（docs/10 3.1）：原话；分派完多出“分派”；回复了多出“结果”。
 * @param message 收件。
 * @param session 它进的会话（有就写会话的 @路径）。
 * @param sessionFile 那个会话的 md 路径。
 * @returns 消息文件全文。
 */
function renderMessage(
  message: storeModule.MessageRow,
  session?: storeModule.SessionRow,
  sessionFile?: string,
): string {
  /** 渠道前缀。 */
  const [kind = ''] = message.channel.split(':');
  /** 来自哪里。 */
  const chatType = message.address.chatType === 'p2p' ? '单聊' : '群聊';
  const channelName = CHANNEL_NAMES[kind] ?? kind;
  const from = kind === 'feishu'
    ? `飞书（应用「${message.bot}」），${chatType}`
    : `${channelName}（来源 ${message.source}）`;
  /** 各行。 */
  const lines = [
    `# 消息 #${message.id}`,
    '',
    `- 来自：${from}`,
    `- 时间：${utils.formatTime(message.createdAt)}`,
    `- 响应bots：${message.bot}`,
    '',
    '## 原话',
    '',
    message.text || '（空）',
  ];

  //M 分派：结论、会话 @路径、理由、怎么定的、全过程。
  /** 分派记录。 */
  const record = message.dispatch as dispatchModule.DispatchRecord | null;
  if (record) {
    /** 结论。 */
    const result = record.result;
    lines.push('', '## 分派', '');
    if (record.messageIds.length > 1) {
      lines.push(`${record.messageIds.map((id) => `#${id}`).join('、')} 合成一批分派。`, '');
    }
    /** 会话标题。 */
    const title = session?.title ?? result.title;
    /** 打断的说明。 */
    const interrupted = result.interrupt.length > 0 ? `并打断了 ${result.interrupt.join('、')}` : '没有打断别的会话';
    lines.push(
      result.session === 'new'
        ? `结论：**新开会话**「${title}」，放进工作区「${result.workspace}」，用 ${session?.model ?? result.model}；${interrupted}。`
        : `结论：**追加到会话**「${title}」，${result.model ? `模型换成 ${result.model}` : '模型不换'}；${interrupted}。`,
    );
    if (sessionFile) {
      lines.push(`会话文件：${at(sessionFile)}`);
    }
    lines.push(`理由：${result.reason || '（没写）'}`, '', '怎么定的：');
    if (record.decisionModel) {
      lines.push(`- 决策模型（${record.decisionModel.model}，${seconds(record.decisionModel.ms)} 秒）：${record.decisionModel.why}`);
    }
    if (record.llm) {
      lines.push(`- 常规模型（${record.llm.request.model}，${record.llm.steps.length} 步，重跑 ${record.llm.reruns} 次）${record.llm.error ? `：没成，${record.llm.error}` : '：回了结论，核对通过'}`);
    }
    if (result.by === 'fallback') {
      lines.push(`- 程序兜底：新开会话，放进最近用过的工作区，用默认模型，谁也不打断。`);
    }
    lines.push('', `全过程：${at(message.file.replace(/\.md$/, '_分派.md'))}`, '', `${clock(record.startedAt)} 开始 本次分派 用了 ${seconds(record.ms)} 秒`);
  }

  //M 结果：每条回复一行。
  if (message.replies.length > 0) {
    lines.push('', '## 结果', '');
    for (const reply of message.replies) {
      /** 已登记回复的来源；没有会话文件时是程序直接通知。 */
      const origin = reply.session.file
        ? `会话「${reply.session.title}」（${at(reply.session.file)}）回复`
        : '回复';
      const line = `- ${clock(reply.at)}\u3000${origin}：${reply.text}`;
      lines.push(line);
    }
  }
  return `${hardBreaks(lines.join('\n'))}\n`;
}


/**
 * 拼分派记录的 md（docs/10 3.1）：开头一段结论，然后决策模型、常规模型每一步、现状原文，之间一行等号。
 * @param message 这批的第一条。
 * @param record 分派记录。
 * @param session 进的会话。
 */
function renderDispatch(
  message: storeModule.MessageRow,
  record: dispatchModule.DispatchRecord,
  session?: storeModule.SessionRow,
): string {
  /** 结论。 */
  const result = record.result;
  /** 谁定的。 */
  const by = { decision: '决策模型', llm: '常规模型', fallback: '程序兜底' }[result.by];
  /** 开头一段。 */
  const head = [
    `# 分派记录：消息 ${record.messageIds.map((id) => `#${id}`).join('、')}`,
    '',
    `- 机器人：${message.bot}；消息文件：${at(message.file)}`,
    `- ${clock(record.startedAt)} 开始，用了 ${seconds(record.ms)} 秒`,
    `- 结论：${result.session === 'new' ? `新开会话「${session?.title ?? result.title}」` : `追加到会话「${session?.title ?? result.session}」`}，工作区「${result.workspace}」，模型 ${result.model || '不换'}；打断：${result.interrupt.join('、') || '无'}`,
    `- 理由：${result.reason || '（没写）'}`,
    `- 谁定的：${by}`,
    ...(record.checks.length > 0 ? [`- 核对没过：${record.checks.join('；')}`] : []),
  ].join('\n');
  /** 各块。 */
  const blocks = [head];

  //M 决策模型那一段：填入的状态、每道题和选项、回答、判定，中间过程都看得到。
  if (record.decisionModel) {
    /** 决策模型。 */
    const decision = record.decisionModel;
    /**
     * 一个概率的写法：模型没回时写“没回”，不写成 0。
     * @param value 概率。
     */
    const chance = (value: number): string => (decision.error ? '没回' : value.toFixed(2));
    blocks.push(
      [
        `决策模型 ${decision.model} · ${seconds(decision.ms)} 秒${decision.error ? ` · 出错：${decision.error}` : ''}`,
        `填入的状态（原文）：${fenced(decision.state)}`,
        `去向（选择题）：${decision.question}\n${decision.options.map((option) => `- ${option.label}：${chance(option.probability)}`).join('\n')}`,
        ...(decision.interruptQuestion ? [`打断（是非题）：${decision.interruptQuestion}\n- 要停下：${decision.interrupt === undefined ? '没回' : decision.interrupt.toFixed(2)}`] : []),
        `判定：${decision.why}`,
      ].join('\n\n'),
    );
  }

  //M 常规模型：第一条输入（和决策模型填入的状态是同一份，有就不重复），然后每一步。
  if (record.llm) {
    blocks.push(record.decisionModel ? '常规模型的第一条输入：就是上面决策模型填入的状态。' : `常规模型的第一条输入（原文）：${fenced(record.llm.request.input)}`);
    for (const [index, step] of record.llm.steps.entries()) {
      /** 这一步的各行。 */
      const lines = [`常规模型 ${record.llm.request.model} （思考强度：${step.effort}）· 第 ${index + 1} 步 · ${clock(step.at)} · ${seconds(step.ms)} 秒`];
      if (step.thinking) {
        lines.push(`【思考】${step.thinking}`);
      }
      if (step.text) {
        lines.push(`【回答】${step.text}`);
      }
      for (const call of step.calls) {
        lines.push(`【调用】${call.name} ${JSON.stringify(call.args)}`, `【结果】${fenced(resultText(call.result, -1).replace('全文在 .json 的 messages[-1]', '全文在 _分派.json'))}`);
      }
      if (step.error) {
        lines.push(`【核对】没过：${step.error}`);
      }
      blocks.push(lines.join('\n\n'));
    }
    if (record.llm.error) {
      blocks.push(`常规模型没成：${record.llm.error}`);
    }
  }

  return `${renderSteps(blocks)}\n`;
}


/**
 * 拼会话 md 的正文：每次运行一个小标题，每一步之间一行等号（docs/10 3.2）。
 * @param session 会话。
 * @param view 数据库里没有的东西。
 * @param messageFile 消息号 → 收件。
 */
function renderSessionBody(
  session: storeModule.SessionRow,
  view: SessionView,
  messageFile: Map<number, storeModule.MessageRow>,
): string {
  /** 各次运行的文字。 */
  const parts: string[] = [];
  /** 上一步的模型（换模型时写一句）。 */
  let lastModel = '';
  for (const run of session.runs) {
    /** 这次运行的消息（带在 .json 里的下标：前面有一条系统消息，所以 +1）。 */
    const items = session.messages.map((stored, index) => ({ stored, jsonIndex: index + 1 })).filter((item) => item.stored.run === run.n);
    /** 因为哪几条消息。 */
    const ids = items.flatMap((item) => item.stored.messageIds ?? []);
    /** 结局。 */
    const ending = run.ending ? `${ENDINGS[run.ending]}（${run.steps} 步，${seconds((run.endedAt ?? run.startedAt) - run.startedAt)} 秒）` : `还在跑（已走 ${run.steps} 步）`;
    /** 各块。 */
    const blocks: string[] = [];
    /** 正在拼的一步。 */
    let current: string[] | undefined;
    /** 第几步。 */
    let stepNo = 0;
    /** 收尾当前这一步。 */
    const flush = (): void => {
      if (current) {
        blocks.push(current.join('\n\n'));
        current = undefined;
      }
    };
    for (const { stored, jsonIndex } of items) {
      /** Pi 消息。 */
      const message = stored.message;
      if (message.role === 'user') {
        flush();
        /** 去掉给模型看的开头（这个会话、记忆概要），人看的只留正文。 */
        const { body, prefaced } = stripPreface(textOf(message));
        if (stored.summary) {
          blocks.push(`【压缩摘要】\n\n${body}`);
          continue;
        }
        if (!stored.messageIds?.length) {
          blocks.push(`【程序】${body}`);
          continue;
        }
        /** 每条消息开头那行换成带 @消息文件 的【用户 ……】。 */
        const shown = body.replace(USER_HEADER, (_line, channel: string, time: string, id: string) => {
          /** 这条收件。 */
          const row = messageFile.get(Number(id));
          return `【用户 · ${channel} · ${time} · 消息 #${id}】${row ? ` ${at(row.file)}` : ''}\n`;
        });
        blocks.push(`${shown}${prefaced ? `\n\n（这是会话的第一条输入，开头还带了“这个会话”和记忆概要，原文在 .json 的 messages[${jsonIndex}]）` : ''}`);
        continue;
      }
      if (message.role === 'assistant') {
        flush();
        stepNo += 1;
        /** 上下文多长。 */
        const tokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
        /** 模型全名。 */
        const modelName = `${message.provider}/${message.model}`;
        current = [`### 第 ${stepNo} 步 · ${clock(message.timestamp)} · ${modelName}${stored.effort ? ` （思考强度：${stored.effort}）` : ''}${lastModel && lastModel !== modelName ? `（模型换成了 ${modelName}）` : ''}${message.durationMs ? ` · ${seconds(message.durationMs)} 秒` : ''} · 上下文 ${tokens.toLocaleString('en-US')}`];
        lastModel = modelName;
        for (const block of message.content) {
          if (block.type === 'thinking' && block.thinking.trim()) {
            current.push(`【思考】${block.thinking}`);
          } else if (block.type === 'text' && block.text.trim()) {
            current.push(`【助手】${block.text}`);
          } else if (block.type === 'toolCall') {
            current.push(`【调用】${block.name} ${JSON.stringify(block.arguments)}`);
          }
        }
        if (message.errorMessage) {
          current.push(`【出错】${message.errorMessage}`);
        }
        continue;
      }
      if (message.role === 'toolResult') {
        /** 结果文字。 */
        const text = fenced(resultText(textOf(message), jsonIndex));
        /** 图片。 */
        const images = (stored.images ?? []).map((file) => at(file)).join(' ');
        /** 审核记录（exec 才有）。 */
        const hasReview = message.details
          && typeof message.details === 'object'
          && 'verdict' in message.details;
        /** 历史工具记录可能没有审核字段；只在已存在时展示。 */
        const review = hasReview ? message.details as {
          /** 当时的执行决定。 */
          verdict: string;
          /** 当时的审核来源。 */
          by: string;
          /** 保存下来的理由。 */
          reason: string;
        } : undefined;
        /** 审核段独立拼接，便于核对来源与结论。 */
        let reviewText = '';
        if (review) {
          const sources: Record<string, string> = {
            rule: '程序的规矩',
            decision: '决策模型',
            llm: '小循环',
            user: '用户',
          };
          const verdicts: Record<string, string> = {
            run: '执行',
            reject: '不执行',
            interrupted: '被打断',
          };
          const source = sources[review.by] ?? review.by;
          const verdict = verdicts[review.verdict] ?? review.verdict;
          reviewText = `【审核】${source} → ${verdict}：${review.reason}\n\n`;
        }
        /** 工具结果与图片段保持各自的来源。 */
        const errorText = message.isError ? '（出错）' : '';
        const imageText = images ? `\n\n图片 ${images}` : '';
        const resultLine = `【结果】${message.toolName}${errorText}：${text}`;
        const line = `${reviewText}${resultLine}${imageText}`;
        if (current) {
          current.push(line);
        } else {
          blocks.push(line);
        }
      }
    }
    flush();
    parts.push(`## 第 ${run.n} 次运行 · ${clock(run.startedAt)} 开始 · 因为消息 ${ids.map((id) => `#${id}`).join('、') || '（无）'} · ${ending}\n\n${renderSteps(blocks)}`);
  }
  return parts.join('\n\n');
}


/**
 * 拼压缩版（docs/10 3.2）：程序照数据库生成，不调模型；压缩过的从最近那段摘要接着写；用户的话、回复、助手的话、每个工具一行。
 * @param session 会话。
 * @param files 会话的三个文件。
 * @param view 数据库里没有的东西。
 */
function renderCompact(session: storeModule.SessionRow, files: SessionFiles, view: SessionView): string {
  /** 最后一段摘要在哪。 */
  const lastSummary = session.messages.findLastIndex((stored) => stored.summary === true);
  /** 从哪条开始写。 */
  const start = Math.max(0, lastSummary);
  /** 各行。 */
  const lines = [
    `# ${session.title}（压缩版）`,
    '',
    `会话 ${session.id} · ${session.bot} / ${session.workspace} · ${STATUSES[session.status]} · ${session.model}${currentEffort(session) ? ` （思考强度：${currentEffort(session)}）` : ''} · 已用上下文 ${session.tokens.toLocaleString('en-US')}${view.model ? ` / ${view.model.contextWindow.toLocaleString('en-US')}` : ''}`,
    `摘要：${session.summary || '（还没写）'}`,
    `全文：${at(files.md)}`,
  ];
  /** 现在写到第几次运行。 */
  let run = -1;
  /** 工具调用 ID → 名字和主要参数。 */
  const calls = new Map<string, { name: string; brief: string; reply?: string }>();
  for (const stored of session.messages.slice(start)) {
    /** Pi 消息。 */
    const message = stored.message;
    if (stored.run !== run) {
      run = stored.run;
      /** 这次运行。 */
      const info = session.runs.find((item) => item.n === run);
      if (info) {
        /** 因为哪几条消息。 */
        const ids = session.messages.filter((item) => item.run === run).flatMap((item) => item.messageIds ?? []);
        lines.push('', `## 第 ${info.n} 次运行 · ${clock(info.startedAt)}${ids.length > 0 ? ` · 因为消息 ${ids.map((id) => `#${id}`).join('、')}` : ''}${info.ending ? ` · ${ENDINGS[info.ending]}（${info.steps} 步）` : ' · 还在跑'}`, '');
      }
    }
    if (message.role === 'user') {
      //M 只写用户的原话和压缩摘要；程序加的提醒、自动感应不写。
      if (stored.summary) {
        lines.push(`【压缩摘要】${clip(stripPreface(textOf(message)).body, 3000)}`);
      } else if (stored.messageIds?.length) {
        lines.push(`【用户 ${stored.messageIds.map((id) => `#${id}`).join('、')}】${clip(userWords(textOf(message)), 1000)}`);
      }
    } else if (message.role === 'assistant') {
      /** 助手的话。 */
      const text = textOf(message).trim();
      if (text) {
        lines.push(`【助手】${clip(text, 300)}`);
      }
      for (const block of message.content) {
        if (block.type === 'toolCall') {
          calls.set(block.id, { name: block.name, brief: briefArgs(block.arguments), reply: block.name === 'reply' && typeof block.arguments.text === 'string' ? block.arguments.text : undefined });
        }
      }
    } else if (message.role === 'toolResult') {
      /** 对应的调用。 */
      const call = calls.get(message.toolCallId);
      /** 结果怎样。 */
      let outcome = message.isError ? '失败' : '成功';
      if (textOf(message).startsWith('未执行') || textOf(message).startsWith('Not executed')) {
        outcome = '未执行';
      }
      if (call?.reply !== undefined && outcome === '成功') {
        lines.push(`【回复】${clip(call.reply, 500)}`);
      } else {
        lines.push(`【工具】${message.toolName} ${call?.brief ?? ''}（${outcome}）`);
      }
    }
  }
  return `${hardBreaks(lines.join('\n'))}\n`;
}


/**
 * 转成 OpenAI chat 接口的格式（docs/10 3.2）：外面加会话信息和状态；每条助手消息带这一步用的模型；图片只写路径。
 * @param session 会话。
 * @param view 数据库里没有的东西。
 */
function toOpenAi(session: storeModule.SessionRow, view: SessionView): unknown {
  /** OpenAI 格式的消息。 */
  const messages: Record<string, unknown>[] = [{ role: 'system', content: view.system }];
  for (const stored of session.messages) {
    /** Pi 消息。 */
    const message = stored.message;
    /** 时间（本地时间写法）。 */
    const timeText = 'timestamp' in message ? utils.formatTime(message.timestamp) : undefined;
    if (message.role === 'user') {
      messages.push({ role: 'user', content: textOf(message), ...(stored.messageIds ? { message_ids: stored.messageIds } : {}), ...(stored.summary ? { summary: true } : {}), run: stored.run, at: timeText });
    } else if (message.role === 'assistant') {
      /** 工具调用。 */
      const toolCalls = message.content.filter((block): block is piAi.ToolCall => block.type === 'toolCall');
      messages.push({
        role: 'assistant',
        content: textOf(message),
        reasoning_content: message.content.map((block) => (block.type === 'thinking' ? block.thinking : '')).join(''),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
        model: `${message.provider}/${message.model}`,
        ...(stored.effort ? { effort: stored.effort } : {}),
        usage: message.usage,
        ...(message.errorMessage ? { error: message.errorMessage } : {}),
        run: stored.run,
        at: timeText,
      });
    } else if (message.role === 'toolResult') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: textOf(message), ...(stored.images?.length ? { images: stored.images } : {}), ...(message.isError ? { is_error: true } : {}), ...(message.details === undefined ? {} : { details: message.details }), run: stored.run });
    }
  }
  return {
    id: session.id,
    bot: session.bot,
    workspace: session.workspace,
    title: session.title,
    summary: session.summary,
    status: session.status,
    model: session.model,
    thinking: session.thinking,
    context: { used: session.tokens, max: view.model?.contextWindow },
    runs: session.runs.map((run) => ({ n: run.n, started_at: utils.formatTime(run.startedAt), ended_at: run.endedAt ? utils.formatTime(run.endedAt) : undefined, ending: run.ending, steps: run.steps })),
    tools: view.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
    messages,
  };
}


/**
 * 文件库：机器人文件夹和全局技能的读写。构造时只记下资源；用 new Files(resources) 创建。
 * 入口建一个，传给用到的对象。
 */
export class Files {
  /** 资源（运行时目录、机器人的语言），谁建的：入口 src/entries/App.ts。 */
  private readonly resources: resourcesModule.Resources;

  /**
   * 建文件库。
   * @param resources 资源（运行时目录、机器人的语言）。
   */
  constructor(resources: resourcesModule.Resources) {
    this.resources = resources;
  }

  /**
   * 记忆概要文件：中文机器人 索引.md，英文 index.md。
   * @param bot 机器人名。
   */
  private memoryIndexFile(bot: string): string {
    /** 文件名随机器人的语言。 */
    const name = this.resources.getBot(bot).language === 'en' ? 'index.md' : '索引.md';
    return path.join(this.paths(bot).memoryDir, name);
  }

  /**
   * 标题变了：把这个会话的旧文件改成新名字。
   * @param session 会话。
   * @returns 无。
   * 副作用：重命名文件。
   */
  private async renameIfRetitled(session: storeModule.SessionRow): Promise<void> {
    /** 工作区文件夹。 */
    const dir = path.join(this.paths(session.bot).workspaceRoot, session.workspace);
    /** 新主干。 */
    const base = sessionBase(session);
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      /** 这个文件是别的会话的，或者已经是新名字。 */
      const skip = !name.startsWith(`${session.id}_`)
        || name.startsWith(`${base}.`)
        || name.startsWith(`${base}_压缩`);
      if (skip) {
        continue;
      }
      /** 后缀：_压缩.md、.json、.md。 */
      const suffix = ['_压缩.md', '.json', '.md'].find((item) => name.endsWith(item));
      if (suffix && !name.endsWith('.tmp')) {
        /** 新文件路径。 */
        const target = path.join(dir, `${base}${suffix}`);
        await fs.rename(path.join(dir, name), target).catch(() => undefined);
      }
    }
  }

  /**
   * 列出一个工作区（没有 工作区.yaml 时说明是空的、工作目录是 files/）。
   * @param bot 机器人名。
   * @param name 工作区名。
   */
  private async readWorkspace(bot: string, name: string): Promise<WorkspaceInfo> {
    /** 工作区文件夹。 */
    const dir = path.join(this.paths(bot).workspaceRoot, name);
    /** 工作区.yaml。 */
    const text = await fs.readFile(path.join(dir, '工作区.yaml'), 'utf8').catch(() => '');
    /** 读出来的。 */
    const item = text ? checks.asRecord(Bun.YAML.parse(text) ?? {}, `${name}/工作区.yaml`) : {};
    /** 工作目录。 */
    const workDir = checks.optionalString(item.dir, `${name} 的 dir`);
    /** 说明。 */
    const description = checks.optionalString(item.description, `${name} 的 description`) ?? '';
    return { name, description, dir: workDir ? path.resolve(workDir) : path.join(dir, 'files') };
  }

  /** 这个机器人的几个目录。 */
  paths(bot: string): BotPaths {
    /** 机器人文件夹。 */
    const botDir = path.join(this.resources.dir, 'bots', checks.safeName(bot, '机器人名'));
    return {
      botDir,
      messageDir: path.join(botDir, 'message'),
      workspaceRoot: path.join(botDir, 'workspace'),
      memoryDir: path.join(botDir, 'memory'),
    };
  }

  /** 一个会话的三个文件在哪。 */
  sessionFiles(
    session: Pick<storeModule.SessionRow, 'id' | 'bot' | 'workspace' | 'title'>,
  ): SessionFiles {
    /** 主干。 */
    const base = path.join(
      this.paths(session.bot).workspaceRoot,
      session.workspace,
      sessionBase(session),
    );
    return { md: `${base}.md`, json: `${base}.json`, compact: `${base}_压缩.md` };
  }

  /** 建好 message/、workspace/日常/、memory/索引.md（已有的不动）；intro 是网页新建机器人时填的身份和模型，写进索引.md 第一段。 */
  async ensureBot(bot: string, intro?: BotIntro): Promise<void> {
    //M 1. 三个目录。
    /** 目录。 */
    const dirs = this.paths(bot);
    for (const dir of [dirs.messageDir, dirs.workspaceRoot, dirs.memoryDir]) {
      await fs.mkdir(dir, { recursive: true });
    }
    //M 2. 记忆概要（已有的不动）。
    /** 语言。 */
    const language = this.resources.getBot(bot).language;
    await fs
      .writeFile(this.memoryIndexFile(bot), INITIAL_INDEX[language](bot, intro), { flag: 'wx' })
      .catch(checks.ignoreExists);
    //M 3. 默认工作区。
    /** 默认工作区的说明。 */
    const description = language === 'en'
      ? 'Everyday things: chat, questions, looking things up'
      : '日常的事：聊天、问答、查资料';
    await this.ensureWorkspace(bot, DEFAULT_WORKSPACE, description);
  }

  /** 图存进 message/，定好消息文件名，返回文件路径和换成 @路径之后的原话。 */
  async saveIncoming(
    bot: string,
    channel: string,
    text: string,
    images: IncomingImage[],
  ): Promise<Incoming> {
    /** 消息文件夹。 */
    const dir = this.paths(bot).messageDir;
    await fs.mkdir(dir, { recursive: true });
    //M 1. 一条消息一个文件夹：<渠道>_<17 位时间>/，同一毫秒撞上就加 _2、_3。消息文件、分派记录、图和附件都放里面。
    /** 渠道前缀。 */
    const prefix = channel.split(':')[0] || 'message';
    /** 文件夹名后面的说明。 */
    const note = messageNote(text, images.length > 0);
    /**
     * 主干变成文件夹名。
     * @param stem 主干。
     */
    const folderName = (stem: string): string => (note ? `${stem}_${note}` : stem);
    /** 主干：里面的消息文件用它（不带说明）。 */
    let base = `${prefix}_${stamp()}`;
    for (let index = 2; fsSync.existsSync(path.join(dir, folderName(base))); index += 1) {
      base = `${prefix}_${stamp()}_${index}`;
    }
    /** 这条消息的文件夹。 */
    const folder = path.join(dir, folderName(base));
    await fs.mkdir(folder, { recursive: true });
    //M 2. 先占住消息文件名（写个空的），再存附件，原话里接上 @路径。
    /** 消息文件。 */
    const messageFile = path.join(folder, `${base}.md`);
    await fs.writeFile(messageFile, '', { flag: 'wx' }).catch(checks.ignoreExists);
    /** 附件路径。 */
    const saved: string[] = [];
    for (const [index, image] of images.entries()) {
      /** 附件文件。 */
      const file = path.join(folder, attachmentName(index + 1, image));
      await fs.writeFile(file, image.data);
      saved.push(file);
    }
    /** 换成 @路径之后的原话。 */
    const full = [text.trim(), ...saved.map((file) => at(file))].filter(Boolean).join(' ');
    return { file: messageFile, text: full };
  }

  /** 照数据库重写消息文件：原话、分派、结果；session 是它进的那个会话（有就写会话的 @路径）。 */
  async writeMessage(
    message: storeModule.MessageRow,
    session?: storeModule.SessionRow,
  ): Promise<void> {
    /** 会话 md 的路径（有会话才有）。 */
    const sessionFile = session ? this.sessionFiles(session).md : undefined;
    await writeAtomic(message.file, renderMessage(message, session, sessionFile));
  }

  /** 写分派记录 _分派.md / .json。 */
  async writeDispatch(
    message: storeModule.MessageRow,
    record: dispatchModule.DispatchRecord,
    session?: storeModule.SessionRow,
  ): Promise<void> {
    /** 主干。 */
    const base = message.file.replace(/\.md$/, '_分派');
    await writeAtomic(`${base}.md`, renderDispatch(message, record, session));
    await writeAtomic(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`);
  }

  /** 这个机器人的工作区。 */
  async listWorkspaces(bot: string): Promise<WorkspaceInfo[]> {
    /** 工作区文件夹。 */
    const entries = await fs
      .readdir(this.paths(bot).workspaceRoot, { withFileTypes: true })
      .catch(() => [] as fsSync.Dirent[]);
    /** 工作区名，按名字排。 */
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    return Promise.all(names.map((name) => this.readWorkspace(bot, name)));
  }

  /** 没有就建（写 工作区.yaml），返回它；工作目录保证存在。 */
  async ensureWorkspace(bot: string, name: string, description: string): Promise<WorkspaceInfo> {
    checks.safeName(name, '工作区名');
    //M 1. 工作区文件夹和 工作区.yaml（已有的不动）。
    /** 工作区文件夹。 */
    const dir = path.join(this.paths(bot).workspaceRoot, name);
    await fs.mkdir(dir, { recursive: true });
    /** 工作区.yaml 的内容。 */
    const yamlText = [
      '# 工作区：一句话说明（分派靠它选工作区）；dir 是工具干活的目录，不写就是这个文件夹下的 files/',
      `description: ${JSON.stringify(description)}`,
      '',
    ].join('\n');
    await fs
      .writeFile(path.join(dir, '工作区.yaml'), yamlText, { flag: 'wx' })
      .catch(checks.ignoreExists);
    //M 2. 读回来，保证工作目录存在。
    /** 工作区。 */
    const workspace = await this.readWorkspace(bot, name);
    await fs.mkdir(workspace.dir, { recursive: true });
    return workspace;
  }

  /** 读记忆概要，超过 4000 字截断并写明要精简。 */
  async readMemoryIndex(bot: string): Promise<string> {
    /** 全文。 */
    const text = await fs.readFile(this.memoryIndexFile(bot), 'utf8').catch(() => '');
    if (text.length <= MEMORY_INDEX_MAX_CHARS) {
      return text;
    }
    /** 截断后的提示。 */
    const note = this.resources.getBot(bot).language === 'en'
      ? '……(The memory summary is too long; please trim it.)'
      : '……（概要太长了，请精简）';
    return `${text.slice(0, MEMORY_INDEX_MAX_CHARS)}\n${note}`;
  }

  /** memory/ 里修改时间晚于 since 的文件。 */
  async listMemoryChanges(bot: string, since: number): Promise<MemoryChange[]> {
    /** 记忆文件夹。 */
    const dir = this.paths(bot).memoryDir;
    /** 改过的。 */
    const changes: MemoryChange[] = [];
    /** 记忆文件夹下所有文件的相对路径。 */
    /** 扫描器。 */
    const scanner = new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: true });
    /** 记忆文件夹下所有文件的相对路径。 */
    const relatives = await Array.fromAsync(scanner).catch(() => [] as string[]);
    for (const relative of relatives) {
      /** 隐藏文件或临时文件。 */
      const hidden = relative.split(/[\\/]/).some((part) => part.startsWith('.'));
      if (hidden || relative.endsWith('.tmp')) {
        continue;
      }
      /** 绝对路径。 */
      const file = path.join(dir, relative);
      /** 修改时间。 */
      const mtime = (await fs.stat(file).catch(() => undefined))?.mtimeMs ?? 0;
      if (mtime <= since) {
        continue;
      }
      /** 开头一句。 */
      const head = (await fs.readFile(file, 'utf8').catch(() => ''))
        .split(/\r?\n/)
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find(Boolean);
      changes.push({ path: file, mtime, head: clip(head ?? '', 50) });
    }
    return changes.sort((left, right) => left.mtime - right.mtime);
  }

  /** 全局 skills/ 和这个机器人 skills/ 下的技能，同名时个人优先，按名字排。没给机器人就只看全局。 */
  async listSkills(bot?: string): Promise<SkillInfo[]> {
    /** 技能按名字放，后放的盖掉先放的：先全局、后个人，同名时个人优先。 */
    const skills = new Map<string, SkillInfo>();
    /** 要看的技能根目录：先全局、后个人。 */
    const roots = [path.join(this.resources.dir, 'skills')];
    if (bot) {
      roots.push(path.join(this.paths(bot).botDir, 'skills'));
    }
    for (const root of roots) {
      /** 这个根目录下的条目。 */
      const entries = await fs
        .readdir(root, { withFileTypes: true })
        .catch(() => [] as fsSync.Dirent[]);
      for (const entry of entries) {
        /** SKILL.md。 */
        const file = path.join(root, entry.name, 'SKILL.md');
        /** 全文。 */
        const text = entry.isDirectory() ? await fs.readFile(file, 'utf8').catch(() => '') : '';
        if (!text) {
          continue;
        }
        //M 开头的 --- name/description --- 优先；没有就用文件夹名和正文第一行。
        /** 开头那段。 */
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
        /** 读出来的。 */
        let meta: Record<string, unknown>;
        try {
          meta = front
            ? checks.asRecord(Bun.YAML.parse(front[1] ?? '') ?? {}, `${entry.name}/SKILL.md`)
            : {};
        } catch {
          meta = {};
        }
        /** 正文第一行。 */
        const firstLine = text
          .slice(front ? front[0].length : 0)
          .split(/\r?\n/)
          .map((line) => line.replace(/^#+\s*/, '').trim())
          .find(Boolean) ?? '';
        /** 技能的名字。 */
        const metaName = typeof meta.name === 'string' ? meta.name.trim() : '';
        const name = metaName || entry.name;
        /** 技能的说明。 */
        const description = typeof meta.description === 'string' && meta.description.trim()
          ? meta.description
          : firstLine;
        skills.set(name, { name, description: clip(description, 200), file });
      }
    }
    return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /** 读机器人.yaml；没有就是空的。 */
  readBotSettings(bot: string): BotSettings {
    /** 机器人.yaml。 */
    const text = (() => {
      try {
        return fsSync.readFileSync(path.join(this.paths(bot).botDir, '机器人.yaml'), 'utf8');
      } catch {
        return '';
      }
    })();
    if (!text.trim()) {
      return {};
    }
    /** 读出来的。 */
    const item = checks.asRecord(Bun.YAML.parse(text) ?? {}, `${bot}/机器人.yaml`);
    /** 合批等待。 */
    const raw = item.merge_ms;
    const mergeMs = raw === undefined || raw === null ? undefined : Number(raw);
    const settings: BotSettings = {};
    if (mergeMs !== undefined && Number.isFinite(mergeMs) && mergeMs >= 0) {
      settings.mergeMs = mergeMs;
    }
    if (item.relay_only === true) {
      settings.relayOnly = true;
    }
    return settings;
  }

  /** 写机器人.yaml。 */
  async writeBotSettings(bot: string, settings: BotSettings): Promise<void> {
    /** 各行。 */
    const lines = ['# 机器人设置（docs/10 1.2）：merge_ms 是合批等多久（毫秒），不写用 config.yaml 的 engine.merge_ms'];
    if (settings.mergeMs !== undefined) {
      lines.push(`merge_ms: ${Math.round(settings.mergeMs)}`);
    }
    if (settings.relayOnly) {
      lines.push('relay_only: true');
    }
    await writeAtomic(path.join(this.paths(bot).botDir, '机器人.yaml'), `${lines.join('\n')}\n`);
  }

  /** 照数据库重写会话的 .md、.json、_压缩.md；标题变了顺手改名。 */
  async writeSession(session: storeModule.SessionRow, view: SessionView): Promise<void> {
    //M 1. 标题变了先改旧文件名。
    await this.renameIfRetitled(session);
    /** 三个文件。 */
    const target = this.sessionFiles(session);
    /** 消息号 → 收件。 */
    const messageFile = new Map(view.incoming.map((row) => [row.id, row]));
    //M 2. 开头那张表。
    /** 最大上下文（有模型清单才有）。 */
    const windowSize = view.model?.contextWindow.toLocaleString('en-US');
    /** 思考强度的说明。 */
    const effortNote = currentEffort(session) ? ` （思考强度：${currentEffort(session)}）` : '';
    /** 模型能力的说明。 */
    const modelNote = view.model
      ? `（${view.model.vision ? '能看图' : '看不了图'}，最大上下文 ${windowSize}）`
      : '';
    /** 上下文窗口的说明。 */
    const windowNote = view.model ? ` / ${windowSize}` : '';
    /** 摘要（表格里不能有竖线和换行）。 */
    const summary = (session.summary || '（还没写）').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    /** 系统提示词用到的文件。 */
    const promptNote = view.promptFiles.map((file) => at(file)).join(' + ');
    /** 技能清单的说明。 */
    const skillNote = view.skills > 0 ? ` + 技能清单（${view.skills} 个）` : '';
    /** 开头那张表。 */
    const table = [
      `# ${session.title}`,
      '',
      '| 项 | 内容 |',
      '| --- | --- |',
      `| 会话 | ${session.id} |`,
      `| 机器人 / 工作区 | ${session.bot} / ${session.workspace}（工作目录 ${view.workDir}） |`,
      `| 状态 | ${STATUSES[session.status]} |`,
      `| 模型 | ${session.model}${effortNote}${modelNote} |`,
      `| 已用上下文 | ${session.tokens.toLocaleString('en-US')}${windowNote} |`,
      `| 摘要 | ${summary} |`,
      `| 系统提示词 | ${promptNote}${skillNote} |`,
      `| 精简版 | ${at(target.compact)} |`,
    ].join('\n');
    //M 3. 写三个文件。
    await writeAtomic(target.md, `${table}\n\n${renderSessionBody(session, view, messageFile)}\n`);
    await writeAtomic(target.json, `${JSON.stringify(toOpenAi(session, view), null, 2)}\n`);
    await writeAtomic(target.compact, renderCompact(session, target, view));
  }
}
