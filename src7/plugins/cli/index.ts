/**
 * 命令行渠道：第一个渠道，也是别的渠道（HTTP、飞书）的样板。
 * 用法：bun src7/Main.ts [--bot 机器人] 你好
 *   带了一句话：发出去，等到回话就退出。
 *   没带：一行一行读输入，每行当一句话发出去；输入 /stop 会话号 喊停。
 */
import * as process from 'node:process';
import * as readline from 'node:readline';
import type * as cordis from 'cordis';
import * as channelModule from '../../Channel.ts';
import type { ChangeEvent } from '../../Sessions.ts';


/** 插件名。 */
export const name = 'cli';

/** 用到的服务。 */
export const inject = ['resources', 'bots', 'sessions'];


/** 给命令行渠道的配置：config.yaml 的 plugins.cli，加上 Main 传进来的剩余参数。 */
export interface CliConfig {
  /** 命令行里剩下的参数。 */
  argv?: string[];
}


/** 命令行渠道。 */
class Cli extends channelModule.Channel {
  /** 渠道名。 */
  readonly name = 'cli';

  /** 带了一句话、回了就退出。 */
  private oneShot = false;

  /** 退出码：出错是 1。 */
  private exitCode = 0;

  /** 给哪个机器人发。 */
  private botName = '';

  /** 一句话模式：所有该回的会话都有结果了就结束。 */
  private readonly finished: Promise<void>;

  /** 解开 finished。 */
  private resolveFinished: () => void = () => { /* 构造里会被换掉 */ };

  /**
   * @param ctx Cordis 给的 ctx。
   * @param config 剩余的命令行参数。
   */
  constructor(ctx: cordis.Context, config: CliConfig) {
    super(ctx);
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
    //M 解析 config.argv：--bot 机器人（不写就用名单里第一个）、剩下的拼成一句话。命令行是外部输入，在这里校验一次。
    void this.start(config).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      console.error(`命令行没跑成：${text}`);
      process.exit(1);
    });
  }

  /**
   * 解析参数，发一句话或读标准输入。
   * @param config 剩余的命令行参数。
   */
  private async start(config: CliConfig): Promise<void> {
    const argv = config.argv ?? [];
    /** --bot 指定的名字。 */
    let bot: string | undefined;
    /** 拼成一句话的其余参数。 */
    const words: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i];
      if (token === '--bot') {
        const value = argv[i + 1];
        if (value === undefined || value === '') {
          throw new Error('--bot 后面要写机器人名');
        }
        bot = value;
        i += 1;
        continue;
      }
      if (token !== undefined) {
        words.push(token);
      }
    }
    const first = this.ctx.bots.list()[0];
    this.botName = bot ?? first?.name ?? '';
    if (this.botName === '' || this.ctx.bots.get(this.botName) === undefined) {
      throw new Error(this.botName === '' ? '名单里一个机器人也没有' : `没有这个机器人：${this.botName}`);
    }
    const sentence = words.join(' ').trim();
    //M 有一句话 → this.receive(bot, 这句话)，记下“回了话就退出”。
    if (sentence !== '') {
      this.oneShot = true;
      this.receive(this.botName, sentence);
      await this.finished;
      process.exit(this.exitCode);
    }
    //M 没有 → 一行一行读标准输入：
    //M   “/stop 会话号” → ctx.bots.get(bot).stop(会话号, 'cli')；
    //M   别的 → this.receive(bot, 这一行)。
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('输入一句话发给机器人；/stop 会话号 喊停；Ctrl+D 退出。');
    for await (const line of rl) {
      const text = line.trim();
      if (text.startsWith('/stop ')) {
        const id = text.slice('/stop '.length).trim();
        const ok = this.ctx.bots.get(this.botName)?.stop(id, 'cli') ?? false;
        console.log(ok ? `已喊停 ${id}` : `没有这场或它没在跑：${id}`);
        continue;
      }
      if (text !== '') {
        this.receive(this.botName, text);
      }
    }
  }

  /**
   * 把机器人的话打出来。
   * @param text 要说的话。
   * @param event 是哪场会话的什么结果。
   */
  protected send(text: string, event: ChangeEvent): void {
    //M 打一行：[机器人名 会话号] 话。出错的用红色。
    const line = `[${event.row.bot} ${event.row.id}] ${text}`;
    if (event.row.state === 'failed') {
      console.log(`\x1b[31m${line}\x1b[0m`);
      this.exitCode = 1;
    } else {
      console.log(line);
    }
    //M 是“回了话就退出”的那种 → 默认对话和它交办出去的会话都有结果了才退出；出错的退出码 1。
    if (this.oneShot) {
      this.maybeExit();
    }
  }

  /**
   * 一句话模式：这个渠道上没有还在跑的会话，就结束等待。
   */
  private maybeExit(): void {
    const rows = this.ctx.sessions.listOf(this.botName);
    const busy = rows.some((row) => {
      return row.channel === 'cli' && (row.state === 'running' || row.state === 'wait_tools' || row.state === 'wait_compress');
    });
    if (!busy) {
      this.resolveFinished();
    }
  }
}


/**
 * 挂上命令行渠道。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 见 CliConfig。
 */
export function apply(ctx: cordis.Context, config: CliConfig): void {
  new Cli(ctx, config);
}
