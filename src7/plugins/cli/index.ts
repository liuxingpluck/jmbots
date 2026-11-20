/**
 * 命令行渠道：经 channels 的 emitInbound 发 channel/direct（命令行是私聊）把本机命令行输入交给机器人；前台一轮里 channel_reply 几次就逐条打几行，
 * 一次没调就打最后的话（routing.autoFinal）。本机输入就是本人（role: owner）。
 * 用法：bun src7/Main.ts [--bot 机器人] 你好
 *   先把原始输入存进 channels/cli/<YYYY-MM-DD>.jsonl，再发出 channel/direct；等所有会话停下退出（出过错退出码为 1）。
 *   没带话就什么也不做。它不从键盘读输入；要一问一答地聊，以后另写专门的插件。
 */
import * as botUtils from '../../utils/Bots.ts';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import type * as cordis from 'cordis';
import * as textModule from '../../utils/Text.ts';
import * as protocol from '../channels/index.ts';


/** 插件名。 */
export const name = 'cli';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
//M 1.1.3：改成 channel_tool：一轮里能连发多条、逐条打印；零次回复打最后的话；收尾没回成红字、退出码 1；role 写 owner。
//M 1.1.4：registerTextReply 接入 getTargetAddress 自行识别命令行跨渠道发话目标（本机 / cli:本机 / 命令行）。
//M 1.1.8：channel/message 拆了，命令行经 emitInbound 发 channel/direct。
export const version = '1.1.8';

/** 命令行跨渠道/跨聊天回复允许认出的本机聊天名称集合。 */
const CLI_TARGET_CHATS = new Set(['', '本机', 'cli:本机', '命令行', 'local']);

/** 用到的服务。 */
export const inject = ['resources', 'bots', 'sessions'];


/** 命令行渠道构造选项（主要给离线单测拦截退出与输出用，生产默认走 process.exit 和 console）。 */
export interface CliOptions {
  /** 覆盖退出动作。 */
  exit?: (code: number) => void;
  /** 覆盖终端输出动作。 */
  write?: (line: string, isError?: boolean) => void;
}


/** 命令行渠道。 */
export class Cli {
  /** 渠道名。 */
  readonly name = 'cli';

  /** 本次运行实例唯一号，和递增序号一起拼成稳定 sourceId（nativeId）。 */
  private readonly runId = crypto.randomUUID();

  /** 本次运行内的消息递增序号。 */
  private seq = 0;

  /** 单调毫秒时间戳游标，避免同毫秒多句撞在同一时刻上。 */
  private lastAt = 0;

  /** 命令行里带的那句话发出去了没有。发了，等所有会话都停下来就退出。 */
  private sent = false;

  /** 退出码：有会话出过错是 1。 */
  private exitCode = 0;

  /** 进程退出动作。 */
  private readonly exitFn: (code: number) => void;

  /** 输出打印动作。 */
  private readonly writeFn: (line: string, isError?: boolean) => void;

  /**
   * @param ctx Cordis 给的 ctx。
   * @param options 可选退出与输出钩子。
   */
  constructor(private readonly ctx: cordis.Context, options: CliOptions = {}) {
    this.exitFn = options.exit ?? ((code) => process.exit(code));
    this.writeFn = options.write ?? ((line, isError) => {
      if (isError === true) {
        console.error(line);
        return;
      }
      console.log(line);
    });

    //M 向 bots 登记渠道名（网页的渠道清单用），随本插件卸载自动撤销。
    this.ctx.effect(() => this.ctx.bots.channel(this.name));

    //M 发到命令行的话（模型的 channel_reply、零次兜底、审批直回、旧路自动回话）都经 channel/reply 到这里，逐条打出来。
    protocol.registerTextReply(this.ctx, {
      channel: this.name,
      getTargetAddress: (chat) => this.getReplyTargetAddress(chat),
      sendDirectText: (text, request) => {
        this.print(text, request);
      },
    });

    //M 挂上命令行历史监听，让其他渠道能按约定查本机记录。

    //M 一轮收尾没回成（模型出错、停下）：红字打出原因，退出码记 1。
    this.ctx.on('bot/settled', (event) => {
      if (event.sourceSnapshot.channel !== this.name) return;

      if (event.stage === 'sent' || event.stage === 'sending') return;

      //M 终端以红字显示失败原因，同时留下失败退出码。
      this.exitCode = 1;
      this.writeFn(`\x1b[31m[${event.sourceSnapshot.botName}] 没回成：${event.note || event.stage}\x1b[0m`);
    });

    //M 等 Main 把插件都挂完（事件 ready，带着命令行里剩下的参数）才发话：这时候工具、提示词都挂上了。
    this.ctx.on('ready', (argv) => {
      void this.start(argv);
    });

    //M 每次有会话的状态变了，就看一眼是不是可以退出了。
    this.ctx.on('session/change', () => {
      this.exitWhenIdle();
    });
  }

  /**
   * 识别跨渠道发往命令行的目标聊天名称（仅接受本机命令行别名）；认不出时返回 undefined。
   * @param chat 调用方传入的目标聊天名称。
   */
  private getReplyTargetAddress(chat: string): Record<string, unknown> | undefined {
    if (!CLI_TARGET_CHATS.has(chat.trim())) return undefined;

    return { customer: 'cli:本机' };
  }

  /**
   * 落盘一行原始输入并发出 channel/direct 事件；approval 消息级命令会被先消费一次。
   * @param bot 目标机器人名。
   * @param sentence 用户说的话。
   * @returns 认领协调结果（给离线测试检查认领与消费次数）。
   * @throws 目标机器人不存在或没有任何插件处理该消息时抛错。
   */
  async submitLine(bot: string, sentence: string): Promise<protocol.ChannelMessageControl> {
    //G 确认机器人能接收这条输入，再写命令行原件。
    if (bot === '' || botUtils.getBotConfig(this.ctx.resources.raw, bot) === undefined) {
      throw new Error(`没有这个机器人：${bot}`);
    }

    const now = Math.max(Date.now(), this.lastAt + 1);
    this.lastAt = now;
    const address = { customer: 'cli:本机' };

    //M 渠道自己落盘原件（运行时目录 channels/cli/<YYYY-MM-DD>.jsonl），与原 bots.receive 记录格式一致。
    const day = new Date(now).toLocaleDateString('sv-SE');
    const file = path.join(this.ctx.resources.ensureRuntimeDir('channels', this.name), `${day}.jsonl`);
    const rawEntry = { channel: this.name, bot, text: sentence, time: now, address };
    fs.appendFileSync(file, `${JSON.stringify(rawEntry)}\n`, 'utf8');

    //M 给本次运行中的输入分配唯一渠道消息号，供后续分派使用。
    this.seq += 1;
    const nativeId = `${this.runId}:${String(this.seq)}`;
    const messageId = protocol.makeChannelMessageId(this.name, 'local', nativeId);

    //T 跟踪：命令行收到一句话，转成统一事件发出。
    const vars = { bot: bot, sequence: this.seq, length: sentence.length };
    this.ctx.emit('trace', 'Cli.submitLine', 'trace.cli.submitLine', 'protocol.emitInbound(ctx, msg, true, control)', vars);

    const channelMessage: protocol.ChannelMessage = {
      v: 1,
      messageId,
      nativeId,
      channel: this.name,
      accountId: 'local',
      chatId: 'cli:本机',
      chatType: 'local',
      sender: { id: 'cli:本机', name: '本机' },
      role: 'owner',
      targetBots: [bot],
      mentions: [],
      rawText: sentence,
      text: sentence,
      attachments: [],
      createdAt: now,
      receivedAt: now,
      timeSource: 'received',
      replyTo: null,
      origin: {
        channel: this.name,
        address: { ...address },
      },
      visibility: {
        scope: 'cli:local:cli:本机',
        trusted: true,
        publicSourceIds: [],
      },
      routing: {
        autoFinal: true,
      },
    };

    //M 发出 channel/direct（命令行是私聊）：approval 先看“同意 N”，bots 再排进前台（一轮里 channel_reply 几次打几条，一次没调就打最后的话）。
    const control: protocol.ChannelMessageControl = { claims: [] };
    await protocol.emitInbound(this.ctx, channelMessage, true, control);
    if (control.approvalHandled !== true && control.claims.length === 0) {
      throw new Error(`机器人 ${bot} 收到了消息，但前台没有定下进哪场会话`);
    }
    return control;
  }

  /**
   * 把命令行里带的那句话发给机器人。
   * @param argv 命令行里剩下的参数：--bot 机器人（不写就用名单里第一个），其余的拼成一句话。
   * 副作用：没有这个机器人、没有插件管分派时，打出原因，以退出码 1 退出。
   */
  private async start(argv: string[]): Promise<void> {
    //M 从机器人名单取默认目标，再允许显式参数覆盖。
    const words = [...argv];
    let bot = botUtils.getDefaultBot(this.ctx.resources.raw) ?? '';
    const at = words.indexOf('--bot');
    if (at >= 0) {
      bot = words[at + 1] ?? '';
      words.splice(at, 2);
    }
    const sentence = words.join(' ').trim();

    //G 没带话 → 什么也不做。
    if (sentence === '') return;

    this.sent = true;
    try {
      //M 提交这句输入，发出后立即判断是否已无会话需要等待。
      await this.submitLine(bot, sentence);
      this.exitWhenIdle();
    } catch (error) {
      //G 输入提交失败时把原因写到错误输出，以失败退出码结束进程。
      this.writeFn(`命令行没跑成：${textModule.getErrorMessage(error)}`, true);
      this.exitFn(1);
    }
  }

  /**
   * 把机器人的话打出来：模型的回复打 [机器人名] 话；旧路（带会话号）打 [机器人名 会话号] 话，那场会话出错了用红色、退出码记 1。
   * @param text 要说的话。
   * @param request 回复请求：机器人名、旧路的会话号。
   */
  private print(text: string, request: protocol.ChannelReplyRequest): void {
    //M 模型一轮里的回复：只带机器人名。
    const sessionId = request.sessionId;
    if (sessionId === undefined) {
      this.writeFn(`[${request.bot}] ${text}`);
      return;
    }

    //M 旧路自动回话：带会话号，照会话现在的状态看是不是出错的话。
    const line = `[${request.bot} ${sessionId}] ${text}`;
    const session = this.ctx.sessions.open(sessionId);
    if (session.row.state === 'failed') {
      //G 会话失败时仍打出来，用红字和退出码反映异常。
      this.exitCode = 1;
      this.writeFn(`\x1b[31m${line}\x1b[0m`);
      return;
    }

    //M 把正常会话的回复交给终端显示。
    this.writeFn(line);
  }

  /**
   * 话发出去以后：没有还在转的会话了，就退出。
   */
  private exitWhenIdle(): void {
    if (!this.sent) return;

    //M 等这一下的通知都发完再看：别的插件可能紧接着又开一场小会话（比如写总结）。
    setTimeout(() => {
      const running = this.ctx.sessions.find({ state: 'running' });
      if (running.length === 0) {
        this.exitFn(this.exitCode);
      }
    }, 0);
  }
}


/**
 * 挂上命令行渠道。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务都就绪，
 * 再调一次 apply(ctx, 配置)。插件在 apply 里通过 ctx 听事件、登记工具；插件被拔掉时，这些登记自动撤掉。
 * 详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  //M 建立命令行渠道并登记输入、回复和会话状态监听。
  new Cli(ctx);
}
