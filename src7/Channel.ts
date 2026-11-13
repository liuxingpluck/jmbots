/**
 * 渠道基类：命令行、HTTP、飞书、别的 AI，都是渠道，都继承它。
 * 渠道只做三件事：收一句话，自己存，直接推给对应的机器人；机器人有结果了，把话交给用户。
 * 推给机器人是直接调函数，不走事件。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { IncomingMessage } from './Bots.ts';
import type { ChangeEvent } from './Sessions.ts';


/**
 * 渠道基类。子类只要写 name 和 send，再在自己的入口里调 receive。
 * 它要用 resources 和 bots 两个服务：渠道所在的插件要把这两个写进自己的 inject。
 */
export abstract class Channel {
  /** 渠道名：cli、http、feishu…… 消息里带着它，回话靠它认回来。 */
  abstract readonly name: string;

  /**
   * 挂上“有结果了就回话”的监听。
   * @param ctx Cordis 给的 ctx。
   */
  constructor(protected readonly ctx: cordis.Context) {
    //M ctx.on('session/change', (event) => this.onChange(event))。
    this.ctx.on('session/change', (event) => {
      this.onChange(event);
    });
  }

  /**
   * 收到用户一句话。
   * @param bot 给哪个机器人。
   * @param text 用户说的话。
   * @throws 没有这个机器人时抛错（渠道是外部入口，在这里校验一次）。
   * 副作用：存到本地；推给机器人。
   */
  receive(bot: string, text: string): void {
    //G ctx.bots.get(bot) 没有 → 抛错。
    const target = this.ctx.bots.get(bot);
    if (target === undefined) {
      throw new Error(`没有这个机器人：${bot}`);
    }
    //M message = { channel: this.name, bot, text, time: 现在 }。
    const message: IncomingMessage = { channel: this.name, bot, text, time: Date.now() };
    //T 跟踪：『渠道收到一句话，存下来，推给机器人』 代码 bots.get(bot).receive(message) 变量 { 渠道, 机器人, 字数 }
    this.ctx.emit('trace', {
      module: 'Channel',
      fn: 'receive',
      text: '渠道收到一句话，存下来，推给机器人',
      code: 'bots.get(bot).receive(message)',
      vars: () => ({ 渠道: this.name, 机器人: bot, 字数: text.length }),
    });
    //M this.save(message)。
    this.save(message);
    //M ctx.bots.get(bot).receive(message)。直接调，不走事件。
    target.receive(message);
  }

  /**
   * 存到渠道自己的本地存储：resources.paths.channels/<渠道名>/ 下，一天一个文件，一条一行 JSON。
   * @param message 刚收到的那条。
   * 副作用：写文件。
   */
  protected save(message: IncomingMessage): void {
    const dir = path.join(this.ctx.resources.paths.channels, this.name);
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date(message.time);
    const name = `${String(day.getFullYear())}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.jsonl`;
    fs.appendFileSync(path.join(dir, name), `${JSON.stringify(message)}\n`, 'utf8');
  }

  /**
   * 把机器人的话交给用户。每种渠道自己写：命令行是打印，飞书是发消息。
   * @param text 要说的话。
   * @param event 是哪场会话的什么结果（做完、出错、停下、要用户决定）。
   */
  protected abstract send(text: string, event: ChangeEvent): void | Promise<void>;

  /**
   * 响应 session/change：是我这个渠道的会话有结果了，就回话。
   * @param event 变化之后的会话。
   */
  private onChange(event: ChangeEvent): void {
    //G event.row.channel 不是 this.name → 不管（小会话没有渠道，自然不会回）。
    if (event.row.channel !== this.name) {
      return;
    }
    //M 照状态定回什么：
    //M   done      → row.reply
    //M   failed    → “出错了：” + row.reply 没有就用 row.reason
    //M   stopped   → “已停止” 或者 row.reason（比如“到 N 步了”）
    //M   wait_user → “要你确认：” + row.reason
    //M   别的状态  → 不回。
    const text = replyOf(event);
    if (text === undefined) {
      return;
    }
    //T 跟踪：『把机器人的话交给用户』 代码 send(话, event) 变量 { 渠道, 会话号, 状态, 话多少字 }
    this.ctx.emit('trace', {
      module: 'Channel',
      fn: 'onChange',
      event: 'session/change',
      session: event.row.id,
      text: '把机器人的话交给用户',
      code: 'send(话, event)',
      vars: () => ({ 渠道: this.name, 会话号: event.row.id, 状态: event.row.state, 话多少字: text.length }),
    });
    //M void this.send(话, event)。
    void this.send(text, event);
  }
}


/**
 * 按状态决定回给用户的那句话；不该回时是 undefined。
 * @param event 变化之后的会话。
 */
function replyOf(event: ChangeEvent): string | undefined {
  const row = event.row;
  if (row.state === 'done') {
    return row.reply ?? '';
  }
  if (row.state === 'failed') {
    return `出错了：${row.reply ?? row.reason ?? ''}`;
  }
  if (row.state === 'stopped') {
    return row.reason !== undefined && row.reason !== '' ? row.reason : '已停止';
  }
  if (row.state === 'wait_user') {
    return `要你确认：${row.reason ?? ''}`;
  }
  return undefined;
}


/**
 * 两位数补零。
 * @param value 月或日。
 */
function pad(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}
