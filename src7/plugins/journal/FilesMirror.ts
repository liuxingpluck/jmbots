/**
 * 会话的文件镜像：每场会话（没有 parent 的）一个文件夹 bots/<机器人>/sessions/<会话号>/，里面
 *   对话.md：人看的，每条消息一块，只往后追加；这个进程第一次见到某场会话、或者条数对不上时，照库里的对话整份重写一次；
 *   session.json：会话记录去掉对话（状态、模型、总结、插件加的项），状态变了就重写，一秒内合成一次。
 * 库才是真相：文件丢了、坏了照库重写。不改会话、不发事件。
 * 由原 files-mirror 插件并入 journal（保留服务名 ctx.filesMirror 不变）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type { Session, SessionRow } from '../../Sessions.ts';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';


declare module 'cordis' {
  interface Context {
    /** 会话文件镜像，实现在 src7/plugins/journal/FilesMirror.ts。别的插件用 ctx.get('filesMirror') 看它在不在。 */
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

/** 对话.md 和 session.json 只给人看，改名失败（Windows 上被编辑器开着）就退回直接写。 */
const FALLBACK_DIRECT = true;


/**
 * 多行的放进代码块，围栏比里面最长的一串反引号多一个；一行的原样。
 * @param text 原始正文。
 */
function fenced(text: string): string {
  if (!text.includes('\n')) return text;

  const lengths = [...text.matchAll(/`+/gu)].map((match) => match[0].length + 1);
  const fence = '`'.repeat(Math.max(3, ...lengths));
  return `\n\n${fence}text\n${text}\n${fence}`;
}


/**
 * 行尾补两个空格：预览时单个换行不被并成一段。标题行不加。
 * @param text 原始正文。
 */
function hardBreaks(text: string): string {
  return text.replace(/^(?!#)(.*\S)$/gmu, '$1  ');
}


/** 会话文件镜像（原 files-mirror），挂为 ctx.filesMirror 服务。 */
export class FilesMirror extends cordis.Service {
  /** 会话号 → 对话.md 里写了几条消息、写到第几步。 */
  private readonly written = new Map<string, { count: number; step: number }>();

  /** session.json 的合并定时器。 */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 登记 filesMirror 服务并监听 session/message、session/change。
   * @param ctx Cordis 给 journal 插件的 ctx。
   */
  constructor(ctx: cordis.Context) {
    super(ctx, 'filesMirror');

    //M session/message（通知）：对话里新接了一条 → 追加一块；条数对不上就整份重写。
    ctx.on('session/message', (session, message) => {
      if (session.row.parent !== undefined) return;

      //M 安全追加这条顶层会话消息，写盘异常由镜像自己记录。
      this.guard(() => this.onMessage(session, message));
    });

    //M session/change（通知）：一轮开始、结局各追加一行；再排一次 session.json 重写。
    ctx.on('session/change', (session) => {
      if (session.row.parent !== undefined) return;

      //M 将状态变化写进顶层会话的镜像，写盘异常由镜像自己记录。
      this.guard(() => this.onChange(session));
    });

    //M 拔插件时清掉合并定时器。
    ctx.effect(() => () => {
      for (const timer of this.timers.values()) {
        clearTimeout(timer);
      }
      this.timers.clear();
    });
  }

  /**
   * 捕获写文件异常打一行日志，不挡主会话。
   * @param work 写入操作。
   */
  private guard(work: () => void): void {
    try {
      work();
    } catch (error) {
      //G 把写盘异常转成日志文字，让会话继续运行。
      const detail = textModule.getMessage(error);
      console.error(`会话文件没写成：${detail}`);
    }
  }

  /**
   * 这场会话的镜像文件夹绝对路径。
   * @param row 会话行（用到 bot 和 id）。
   */
  getDir(row: Pick<SessionRow, 'bot' | 'id'>): string {
    //M 用机器人名和会话号定位镜像，沿用资源服务的目录创建规则。
    return this.ctx.resources.dir('bots', row.bot, 'sessions', row.id);
  }

  /**
   * 新接一条消息：记过的条数正好是前一条 → 追加；不然（新开的、重启后第一次见、漏了）整份重写。
   * @param session 当前会话。
   * @param message 新加的一条消息。
   */
  private onMessage(session: Session, message: piAi.Message): void {
    const row = session.row;
    //M 找到会话的镜像和已写条数，用于判断能否只追加新消息。
    const known = this.written.get(row.id);
    const file = path.join(this.getDir(row), '对话.md');
    if (known === undefined || known.count !== row.messages.length - 1 || !fs.existsSync(file)) {
      //G 条数不衔接或镜像文件丢失时，从会话记录补齐整份对话。
      this.rewrite(session);
      return;
    }
    if (message.role === 'assistant') {
      known.step += 1;
    }

    //M 用当前步数渲染新消息，追加后更新已写条数。
    fs.appendFileSync(file, this.block(message, row.messages.length - 1, known.step), 'utf8');
    known.count += 1;
  }

  /**
   * 会话状态变更：running 追加“一轮开始”，结束追加结局；排一次 session.json。
   * @param session 当前会话。
   */
  private onChange(session: Session): void {
    const row = session.row;
    //M 定位状态标记要写入的对话文件。
    const file = path.join(this.getDir(row), '对话.md');
    if (!this.written.has(row.id) || !fs.existsSync(file)) {
      //G 首次见到会话或镜像被移走时，先重建历史再写状态。
      this.rewrite(session);
    }
    if (row.state === 'running') {
      //M 追加开轮标记，并安排同步本轮的会话元数据。
      fs.appendFileSync(file, `${SEPARATOR}## 一轮开始 · ${textModule.getClock(Date.now(), 'date')}`, 'utf8');
      this.saveJson(session);
      return;
    }
    if (row.state === 'done' || row.state === 'stopped' || row.state === 'failed') {
      const stateWords: Record<string, string> = { done: '做完了', stopped: '停下了', failed: '出错了' };
      const word = stateWords[row.state] ?? row.state;
      let reply = row.reply;
      if (reply.length > REPLY_MAX) {
        reply = `${reply.slice(0, REPLY_MAX)}…`;
      }
      fs.appendFileSync(
        file,
        `${SEPARATOR}【这一轮】${word} · ${textModule.getClock(Date.now())}：${hardBreaks(reply)}\n`,
        'utf8',
      );
    }

    //M 安排同步当前状态到 session.json，短时间内的更新由定时器合并。
    this.saveJson(session);
  }

  /**
   * 整份重写 对话.md：头两行 + 每条一块，再记录当前条数与步数。
   * @param session 当前会话。
   */
  private rewrite(session: Session): void {
    const row = session.row;
    let step = 0;
    const parts = [`# 会话 ${row.id}（${row.bot} · ${row.kind}）\n状态、模型、总结在同目录 session.json；这份照库里的对话写，只追加`];
    row.messages.forEach((message, index) => {
      if (message.role === 'assistant') {
        step += 1;
      }

      //M 保留消息顺序，把这一条按它所属的模型步骤渲染成对话段落。
      parts.push(this.block(message, index, step));
    });

    //M 整份写成 对话.md：先写临时文件再改名（utils/Files.ts 的 writeTextAtomic）。
    const file = path.join(this.getDir(row), '对话.md');
    const text = parts.join('');
    filesModule.writeTextAtomic(file, text, FALLBACK_DIRECT);
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
      return `${SEPARATOR}【用户 · ${textModule.getClock(message.timestamp)}】\n`
        + hardBreaks(piAi.contentText(message.content));
    }
    if (message.role === 'assistant') {
      const usage = message.usage;
      const context = usage.input + usage.cacheRead + usage.cacheWrite;
      const lines = [
        `### 第 ${String(step)} 步 · ${textModule.getClock(message.timestamp)} · `
        + `${message.provider}/${message.model} · 上下文 ${String(context)}`,
      ];
      for (const block of message.content) {
        if (block.type === 'thinking' && block.thinking.trim() !== '') {
          lines.push(`【思考】${hardBreaks(block.thinking.trim())}`);
        }
        if (block.type === 'text' && block.text.trim() !== '') {
          lines.push(`【助手】${hardBreaks(block.text.trim())}`);
        }
        if (block.type === 'toolCall') {
          lines.push(`【调用】${block.name} ${JSON.stringify(block.arguments)}`);
        }
      }
      if (message.errorMessage !== undefined && message.errorMessage !== '') {
        lines.push(`【出错】${message.errorMessage}`);
      }
      return `${SEPARATOR}${lines.join('\n\n')}`;
    }
    //G 系统消息（中途加的说明）不进对话.md。
    if (message.role !== 'toolResult') return '';

    const text = piAi.contentText(message.content);
    let shown = text;
    if (text.length > RESULT_MAX) {
      shown = `${text.slice(0, RESULT_HEAD)}\n……（共 ${String(text.length)} 字，全文在库里这场会话的第 ${String(index + 1)} 条）……\n`
        + text.slice(-RESULT_TAIL);
    }
    let errorMark = '';
    if (message.isError) {
      errorMark = '（出错）';
    }
    return `\n\n【结果】${message.toolName}${errorMark}：${fenced(shown)}`;
  }

  /**
   * session.json 一秒内合成一次重写：记录去掉对话，对话只放条数，再带上 对话.md 的路径。
   * @param session 当前会话。
   */
  private saveJson(session: Session): void {
    if (this.timers.has(session.id)) return;

    this.timers.set(session.id, setTimeout(() => {
      this.timers.delete(session.id);
      //G 写镜像失败时只记日志，定时任务无需向会话抛出异常。
      this.guard(() => {
        const { messages, ...meta } = session.row;
        //M 取会话镜像目录，给元数据文件与其中的对话链接共用。
        const dir = this.getDir(session.row);
        const json = { ...meta, messages: messages.length, file: path.join(dir, '对话.md') };
        const file = path.join(dir, 'session.json');
        const text = `${JSON.stringify(json, null, 2)}\n`;

        //M 原子替换元数据文件，供读取会话快照的页面使用。
        filesModule.writeTextAtomic(file, text, FALLBACK_DIRECT);
      });
    }, JSON_EVERY_MS));
  }
}
