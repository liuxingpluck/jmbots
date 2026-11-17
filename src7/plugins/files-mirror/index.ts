/**
 * 会话的文件镜像：每场会话（没有 parent 的）一个文件夹 bots/<机器人>/sessions/<会话号>/，里面
 *   对话.md：人看的，每条消息一块，只往后追加；这个进程第一次见到某场会话、或者条数对不上时，照库里的对话整份重写一次；
 *   session.json：会话记录去掉对话（状态、模型、总结、插件加的项），状态变了就重写，一秒内合成一次。
 * 库才是真相：文件丢了、坏了照库重写。不改会话、不发事件。网页的“打开会话 md”、review 读复盘材料、progress 转新会话都按这条路径找。
 * 挂了它，journal 就不再写自己那份简版的 对话.md（journal 用 ctx.get('filesMirror') 看它在不在）。
 * 写法照 0.4 src/capabilities/Files.ts:604-732。设计：docs/src7插件设计/files-mirror.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { Session, SessionRow } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';


/** 插件名。 */
export const name = 'files-mirror';

/** 用到的服务：resources 拿运行时目录。 */
export const inject = ['resources'];


declare module 'cordis' {
  interface Context {
    /** 会话文件镜像，实现在 src7/plugins/files-mirror/index.ts。别的插件用 ctx.get('filesMirror') 看它在不在。 */
    filesMirror: FilesMirror;
  }
}


/** 块和块之间：一行 68 个等号，前后各空一行（免得 Markdown 把上一行当大标题）。 */
const SEPARATOR = `\n\n${'='.repeat(68)}\n\n`;

/** 工具结果超过多少字就截。 */
const RESULT_MAX = 3000;
/** 截的时候留开头几个字。 */
const RESULT_HEAD = 2000;
/** 截的时候留结尾几个字。 */
const RESULT_TAIL = 500;
/** 结局那行的回答截几个字。 */
const REPLY_MAX = 300;
/** session.json 合并多久写一次。 */
const JSON_EVERY_MS = 1000;


/** 多行的放进代码块，围栏比里面最长的一串反引号多一个；一行的原样。 */
function fenced(text: string): string {
  if (!text.includes('\n')) return text;
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length + 1)));
  return `\n\n${fence}text\n${text}\n${fence}`;
}

/** 行尾补两个空格：预览时单个换行不被并成一段。标题行不加。 */
function hardBreaks(text: string): string {
  return text.replace(/^(?!#)(.*\S)$/gmu, '$1  ');
}

/**
 * 先写 .tmp 再改名；改名失败（Windows 上文件被打开着）就直接写，再删临时文件。
 * @param file 文件。
 * @param text 全文。
 */
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.writeFileSync(file, text, 'utf8');
    fs.rmSync(temp, { force: true });
  }
}


/** 会话文件镜像。当成服务只是为了让 journal 知道它在。 */
export class FilesMirror extends cordis.Service {
  /** 会话号 → 对话.md 里写了几条消息、写到第几步。 */
  private readonly written = new Map<string, { count: number; step: number }>();

  /** session.json 的合并定时器。 */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 登记 files-mirror 插件：把 FilesMirror 作为服务挂到 Cordis 上（以后用 ctx.filesMirror 取）；再听两个通知。
   * @param ctx Cordis 给这个插件的 ctx。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'filesMirror');

    //M session/message（通知）：对话里新接了一条 → 追加一块；条数对不上就整份重写。
    ctx.on('session/message', (session, message) => {
      if (session.row.parent !== undefined) return;
      this.guard(() => this.onMessage(session, message));
    });

    //M session/change（通知）：一轮开始、结局各追加一行；再排一次 session.json 重写。
    ctx.on('session/change', (session) => {
      if (session.row.parent !== undefined) return;
      this.guard(() => this.onChange(session));
    });

    //M 拔插件时清掉合并定时器。ctx.effect：交回的函数在插件被拔掉时 Cordis 来调。
    ctx.effect(() => () => {
      for (const timer of this.timers.values()) clearTimeout(timer);
    });
  }

  /** 写文件出错（磁盘满、被占着）只打一行，不挡会话。 */
  private guard(work: () => void): void {
    try {
      work();
    } catch (error) {
      console.error(`会话文件没写成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 这场会话的文件夹。 */
  dirOf(row: SessionRow): string {
    return this.ctx.resources.dir('bots', row.bot, 'sessions', row.id);
  }

  /**
   * 新接一条：记过的条数正好是前一条 → 追加；不然（新开的、重启后第一次见、漏了）整份重写。
   */
  private onMessage(session: Session, message: piAi.Message): void {
    const row = session.row;
    const known = this.written.get(row.id);
    const file = path.join(this.dirOf(row), '对话.md');
    if (known === undefined || known.count !== row.messages.length - 1 || !fs.existsSync(file)) {
      this.rewrite(session);
      return;
    }
    if (message.role === 'assistant') known.step += 1;
    fs.appendFileSync(file, this.block(message, row.messages.length - 1, known.step), 'utf8');
    known.count += 1;
  }

  /** 状态变了：running 追加“一轮开始”，结束追加结局；排一次 session.json。 */
  private onChange(session: Session): void {
    const row = session.row;
    const file = path.join(this.dirOf(row), '对话.md');
    if (!this.written.has(row.id) || !fs.existsSync(file)) this.rewrite(session);
    if (row.state === 'running') {
      fs.appendFileSync(file, `${SEPARATOR}## 一轮开始 · ${textModule.clock(Date.now(), 'date')}`, 'utf8');
    } else if (row.state === 'done' || row.state === 'stopped' || row.state === 'failed') {
      const word = row.state === 'done' ? '做完' : row.state === 'stopped' ? '停下' : '出错';
      const reply = row.reply.length > REPLY_MAX ? `${row.reply.slice(0, REPLY_MAX)}…` : row.reply;
      fs.appendFileSync(file, `${SEPARATOR}【这一轮】${word} · ${textModule.clock(Date.now())}：${hardBreaks(reply)}\n`, 'utf8');
    }
    this.saveJson(session);
  }

  /** 整份重写：头两行 + 每条一块。 */
  private rewrite(session: Session): void {
    const row = session.row;
    let step = 0;
    const parts = [`# 会话 ${row.id}（${row.bot} · ${row.kind}）\n状态、模型、总结在同目录 session.json；这份照库里的对话写，只追加`];
    row.messages.forEach((message, index) => {
      if (message.role === 'assistant') step += 1;
      parts.push(this.block(message, index, step));
    });
    writeAtomic(path.join(this.dirOf(row), '对话.md'), parts.join(''));
    this.written.set(row.id, { count: row.messages.length, step });
  }

  /**
   * 一条消息拼成一块。用户的话和模型的回答前面带分隔行；工具结果紧跟在它那一步下面，只空一行。
   * @param message 消息。
   * @param index 它在对话里是第几条（从 0 数）。
   * @param step 模型的回答是第几步。
   */
  private block(message: piAi.Message, index: number, step: number): string {
    if (message.role === 'user') {
      return `${SEPARATOR}【用户 · ${textModule.clock(message.timestamp)}】\n${hardBreaks(piAi.contentText(message.content))}`;
    }
    if (message.role === 'assistant') {
      const usage = message.usage;
      const context = usage.input + usage.cacheRead + usage.cacheWrite;
      const lines = [`### 第 ${String(step)} 步 · ${textModule.clock(message.timestamp)} · ${message.provider}/${message.model} · 上下文 ${String(context)}`];
      for (const block of message.content) {
        if (block.type === 'thinking' && block.thinking.trim() !== '') lines.push(`【思考】${hardBreaks(block.thinking.trim())}`);
        if (block.type === 'text' && block.text.trim() !== '') lines.push(`【助手】${hardBreaks(block.text.trim())}`);
        if (block.type === 'toolCall') lines.push(`【调用】${block.name} ${JSON.stringify(block.arguments)}`);
      }
      if (message.errorMessage !== undefined && message.errorMessage !== '') lines.push(`【出错】${message.errorMessage}`);
      return `${SEPARATOR}${lines.join('\n\n')}`;
    }
    //G 系统消息（中途加的说明）不进对话.md。
    if (message.role !== 'toolResult') return '';
    const text = piAi.contentText(message.content);
    const shown = text.length <= RESULT_MAX ? text
      : `${text.slice(0, RESULT_HEAD)}\n……（共 ${String(text.length)} 字，全文在库里这场会话的第 ${String(index + 1)} 条）……\n${text.slice(-RESULT_TAIL)}`;
    return `\n\n【结果】${message.toolName}${message.isError ? '（出错）' : ''}：${fenced(shown)}`;
  }

  /** session.json 一秒内合成一次重写：记录去掉对话，对话只放条数，再带上 对话.md 的路径。 */
  private saveJson(session: Session): void {
    if (this.timers.has(session.id)) return;
    this.timers.set(session.id, setTimeout(() => {
      this.timers.delete(session.id);
      this.guard(() => {
        const { messages, ...meta } = session.row;
        const dir = this.dirOf(session.row);
        const json = { ...meta, messages: messages.length, file: path.join(dir, '对话.md') };
        writeAtomic(path.join(dir, 'session.json'), `${JSON.stringify(json, null, 2)}\n`);
      });
    }, JSON_EVERY_MS));
  }
}


/**
 * 挂上会话文件镜像。
 * apply 是 Cordis 插件的入口：inject 里的 resources 就绪后 Cordis 调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new FilesMirror(ctx);
}
