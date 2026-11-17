/**
 * 命令行渠道：第一个渠道，也是别的渠道（HTTP、飞书）的样板。
 * 用法：bun src7/Main.ts [--bot 机器人] 你好
 *   把命令行里带的那句话发给机器人，等所有会话都停下来就退出（出过错退出码是 1）。
 *   没带话就什么也不做。它不从键盘读输入；要一问一答地聊，以后另写专门的插件。
 */
import * as process from 'node:process';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import * as textModule from '../../utils/Text.ts';

/** 插件名。 */
export const name = 'cli';

/** 用到的服务。 */
export const inject = ['resources', 'bots', 'sessions'];


/** 命令行渠道。 */
class Cli {
  /** 渠道名。 */
  readonly name = 'cli';

  /** 命令行里带的那句话发出去了没有。发了，等所有会话都停下来就退出。 */
  private sent = false;

  /** 退出码：有会话出过错是 1。 */
  private exitCode = 0;

  /**
   * @param ctx Cordis 给的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    this.ctx.effect(() => this.ctx.bots.channel(this.name, (reply, session) => this.send(reply, session)));

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
   * 把命令行里带的那句话发给机器人。
   * @param argv 命令行里剩下的参数：--bot 机器人（不写就用名单里第一个），其余的拼成一句话。
   * 副作用：没有这个机器人、没有插件管分派时，打出原因，以退出码 1 退出。
   */
  private async start(argv: string[]): Promise<void> {
    const words = [...argv];
    let bot = this.ctx.bots.list()[0]?.name ?? '';
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
      await this.ctx.bots.receive(this.name, bot, sentence, { customer: 'cli:本机' });
    } catch (error) {
      console.error(`命令行没跑成：${textModule.messageOf(error)}`);
      process.exit(1);
    }
  }

  /**
   * 把机器人的话打出来：[机器人名 会话号] 话。出错的用红色。
   * @param reply 要说的话。
   * @param session 是哪场会话的结果。
   */
  protected send(reply: string, session: Session): void {
    const line = `[${session.row.bot} ${session.id}] ${reply}`;
    if (session.row.state === 'failed') {
      this.exitCode = 1;
      console.log(`\x1b[31m${line}\x1b[0m`);
      return;
    }
    console.log(line);
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
        process.exit(this.exitCode);
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
  new Cli(ctx);
}
