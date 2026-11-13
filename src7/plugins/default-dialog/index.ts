/**
 * 默认对话的本事：让机器人知道自己最近和用户聊了什么，能看会话、交办、喊停。
 * 骨架里的机器人只管把消息放进默认对话；这个插件给默认对话配上三样：
 *   - 往来记录：用户每说一句、机器人每回一句各记一条，跨渠道、跨会话记在一起；
 *   - 每一步的上下文 = 最近 N 条往来（动态拼上去的一条 system 消息，不进系统提示词）+ 这一轮的消息；
 *   - 四个只给默认对话用的工具：history、list_sessions、hand_session、stop_session。
 * 默认对话只回答简单的问题和分派，绝对不自己干活；它的思考档最高只给 low（在 Sessions.create 里定）。
 */
import { Database } from 'bun:sqlite';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChangeEvent, ContextEvent } from '../../Sessions.ts';


/** 插件名。 */
export const name = 'default-dialog';

/** 用到的服务。 */
export const inject = ['resources', 'sessions', 'tools', 'bots'];


/** 给这个插件的配置：config.yaml 的 plugins.default-dialog。 */
export interface DefaultDialogConfig {
  /** 默认对话每一步带上最近多少条往来。不写是 50。 */
  recent: number;
}


/** 往来记录里的一条：用户说的，或者机器人回的。 */
export interface BotLogEntry {
  /** 哪个机器人。 */
  bot: string;
  /** 哪个渠道。 */
  channel: string;
  /** 谁说的：user 用户；bot 机器人。 */
  who: 'user' | 'bot';
  /** 是哪场会话里的。 */
  sessionId: string;
  /** 说了什么。 */
  text: string;
  /** 毫秒时间戳。 */
  time: number;
}


/** 默认对话的本事。 */
class DefaultDialog {
  /**
   * 建往来记录的表，登记四个工具，挂两个监听。
   * @param ctx Cordis 给的 ctx。
   * @param config 带多少条往来。
   */
  constructor(private readonly ctx: cordis.Context, private readonly config: DefaultDialogConfig) {
    //M 没有 bot_log 表就建：列和 BotLogEntry 一一对应。
    ensureLog(this.ctx.resources.db);
    //M 往工具模块登记四个工具，kinds 都是 ['default']（只给默认对话用）：
    //M   history        往前翻这个机器人的往来记录（参数：从哪个时间往前、要几条）→ this.recent()
    this.ctx.tools.register({
      definition: {
        name: 'history',
        description: '往前翻这个机器人的往来记录，跨渠道、跨会话。',
        parameters: piAi.Type.Object({
          count: piAi.Type.Optional(piAi.Type.Number({ description: '要几条，默认 20' })),
          before: piAi.Type.Optional(piAi.Type.Number({ description: '从哪个毫秒时间戳往前；不写就是从现在' })),
        }),
      },
      kinds: ['default'],
      run: (call, session) => {
        const count = num(call.arguments['count'], 20);
        const before = call.arguments['before'] === undefined ? undefined : num(call.arguments['before'], Date.now());
        const entries = this.recent(session.row.bot, count, before);
        if (entries.length === 0) {
          return '没有更早的往来。';
        }
        return entries.map((item) => formatEntry(item)).join('\n');
      },
    });
    //M   list_sessions  这个机器人干活的会话：正在跑的、以前的，每场带一句总结       → ctx.sessions.listOf(bot)，去掉默认对话和小会话
    this.ctx.tools.register({
      definition: {
        name: 'list_sessions',
        description: '看这个机器人干活的会话：正在跑的、以前的，每场一句总结。',
        parameters: piAi.Type.Object({}),
      },
      kinds: ['default'],
      run: (_call, session) => {
        const rows = this.ctx.sessions.listOf(session.row.bot).filter((row) => row.kind === 'work');
        if (rows.length === 0) {
          return '还没有干活的会话。';
        }
        return rows.map((row) => {
          const summary = row.summary ?? '（还没有总结）';
          return `${row.id} ${row.state} ${summary}`;
        }).join('\n');
      },
    });
    //M   hand_session   把一件事交给一场会话：给了会话号就接着那场，没给就新开       → ctx.bots.get(bot).hand()
    this.ctx.tools.register({
      definition: {
        name: 'hand_session',
        description: '把一件事交给一场干活的会话。给了会话号就接着那场，没给就新开。',
        parameters: piAi.Type.Object({
          text: piAi.Type.String({ description: '要办的事' }),
          sessionId: piAi.Type.Optional(piAi.Type.String({ description: '接着哪一场；不写就新开' })),
        }),
      },
      kinds: ['default'],
      run: (call, session) => {
        const text = String(call.arguments['text'] ?? '');
        const sessionId = call.arguments['sessionId'] === undefined ? undefined : String(call.arguments['sessionId']);
        const channel = session.row.channel ?? 'cli';
        const bot = this.ctx.bots.get(session.row.bot);
        if (bot === undefined) {
          throw new Error('没有这个机器人');
        }
        const id = bot.hand(text, channel, sessionId);
        return `已交给会话 ${id}`;
      },
    });
    //M   stop_session   喊停一场会话                                                → ctx.bots.get(bot).stop()
    this.ctx.tools.register({
      definition: {
        name: 'stop_session',
        description: '喊停一场会话。',
        parameters: piAi.Type.Object({
          sessionId: piAi.Type.String({ description: '哪一场' }),
        }),
      },
      kinds: ['default'],
      run: (call, session) => {
        const sessionId = String(call.arguments['sessionId'] ?? '');
        const bot = this.ctx.bots.get(session.row.bot);
        const ok = bot?.stop(sessionId, 'default-dialog') ?? false;
        return ok ? `已喊停 ${sessionId}` : `没有这场或它没在跑：${sessionId}`;
      },
    });
    //M ctx.on('session/context', (event) => this.onContext(event))。
    this.ctx.on('session/context', (event) => {
      this.onContext(event);
    });
    //M ctx.on('session/change', (event) => this.onChange(event))。
    this.ctx.on('session/change', (event) => {
      this.onChange(event);
    });
  }

  /**
   * 响应 session/context：给默认对话拼上下文。
   * @param event 会话和这一步要发的对话。
   */
  private onContext(event: ContextEvent): void {
    //G 不是默认对话 → 不管。
    if (event.session.row.kind !== 'default') {
      return;
    }
    //M 最近 = this.recent(机器人, config.recent)：照时间往上数，可能来自不同的渠道、不同的会话。
    const entries = this.recent(event.session.row.bot, this.config.recent);
    //T 跟踪：『给默认对话拼上最近往来』 变量 { 会话号, 带了几条 }
    this.ctx.emit('trace', {
      module: 'plugins/default-dialog',
      fn: 'onContext',
      event: 'session/context',
      session: event.session.id,
      text: '给默认对话拼上最近往来',
      vars: () => ({ 会话号: event.session.id, 带了几条: entries.length }),
    });
    //M 把它拼成一条背景消息，role 是 system（pi 的 Message 里有这个角色）：
    //M   开头写明“下面是你最近和用户的往来，按时间从早到晚，只是背景，不是用户这次说的话”；每条写明时间、渠道、谁说的。
    //M   它是动态的上下文，不放进系统提示词。
    //M   写实现时真跑一次：OpenAI、Anthropic 两种协议都要接受对话中间的 system 消息；有一种不接受，就改成 user 角色，开头那句照留。
    /** 这一轮的消息（从 roundStart 起）。 */
    const thisRound = event.session.row.messages.slice(event.session.row.roundStart);
    if (entries.length === 0) {
      //M event.messages = [背景消息, ...这一轮的消息（row.messages 从 row.roundStart 起）]。
      event.messages = thisRound;
      return;
    }
    const body = [
      '下面是你最近和用户的往来，按时间从早到晚，只是背景，不是用户这次说的话。',
      ...entries.map((item) => formatEntry(item)),
    ].join('\n');
    const background: piAi.SystemMessage = { role: 'system', content: body, timestamp: Date.now() };
    //M   默认对话不带更早的原文，要看更早的让它调 history 工具。所以它不用压缩。
    event.messages = [background, ...thisRound];
  }

  /**
   * 响应 session/change：用户说的、机器人回的，各记一条往来。
   * @param event 变化之后的会话。
   */
  private onChange(event: ChangeEvent): void {
    //G 小会话（compress）不管。
    if (event.row.kind === 'compress') {
      return;
    }
    const channel = event.row.channel ?? '';
    //M 默认对话里新接进来的用户消息（event.added 里 role 是 user 的）→ this.log({ who: 'user', … })。
    //  干活的会话里用户说的也记，这样默认对话的“最近往来”能看到交办出去的事。
    for (const item of event.added) {
      if (item.role === 'user') {
        const text = typeof item.content === 'string' ? item.content : item.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
        this.log({
          bot: event.row.bot,
          channel,
          who: 'user',
          sessionId: event.row.id,
          text,
          time: item.timestamp,
        });
      }
    }
    //M 状态变成 done、failed、stopped、wait_user，而且有渠道 → this.log({ who: 'bot', text: 要回给用户的那句话, … })。
    const terminal = event.row.state === 'done' || event.row.state === 'failed' || event.row.state === 'stopped' || event.row.state === 'wait_user';
    if (terminal && channel !== '' && event.added.length === 0) {
      const text = botReply(event);
      if (text !== '') {
        this.log({
          bot: event.row.bot,
          channel,
          who: 'bot',
          sessionId: event.row.id,
          text,
          time: Date.now(),
        });
      }
    }
  }

  /**
   * 一个机器人最近的往来，跨渠道、跨会话。
   * @param bot 机器人名。
   * @param count 要几条。
   * @param before 从哪个时间往前数；不给就是从现在。
   * @returns 照时间从早到晚。
   */
  private recent(bot: string, count: number, before?: number): BotLogEntry[] {
    const until = before ?? Date.now() + 1;
    const rows = this.ctx.resources.db.query(
      'SELECT bot, channel, who, sessionId, text, time FROM bot_log WHERE bot = ? AND time < ? ORDER BY time DESC LIMIT ?',
    ).all(bot, until, count) as Record<string, unknown>[];
    return rows.reverse().map((row) => ({
      bot: String(row['bot']),
      channel: String(row['channel']),
      who: row['who'] === 'bot' ? 'bot' : 'user',
      sessionId: String(row['sessionId']),
      text: String(row['text']),
      time: Number(row['time']),
    }));
  }

  /**
   * 记一条往来。
   * @param entry 谁说的、哪个渠道、哪场会话、说了什么。
   * 副作用：写库。
   */
  private log(entry: BotLogEntry): void {
    this.ctx.resources.db.query(
      'INSERT INTO bot_log (bot, channel, who, sessionId, text, time) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(entry.bot, entry.channel, entry.who, entry.sessionId, entry.text, entry.time);
  }
}


/**
 * 建往来记录表。
 * @param db 数据库。
 */
function ensureLog(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot TEXT NOT NULL,
      channel TEXT NOT NULL,
      who TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      text TEXT NOT NULL,
      time INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS bot_log_bot_time ON bot_log (bot, time)');
}


/**
 * 把一条往来写成一行给人看。
 * @param entry 往来。
 */
function formatEntry(entry: BotLogEntry): string {
  const when = new Date(entry.time).toLocaleString('zh-CN', { hour12: false });
  const who = entry.who === 'user' ? '用户' : '机器人';
  return `[${when} ${entry.channel} ${who}] ${entry.text}`;
}


/**
 * 状态变成结束时要记的那句机器人的话。
 * @param event 变化之后的会话。
 */
function botReply(event: ChangeEvent): string {
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
  return '';
}


/**
 * 把工具参数收成数字。
 * @param value 模型给的值。
 * @param fallback 不是数字时用这个。
 */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}


/**
 * 给默认对话配上往来记录和四个工具。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 见 DefaultDialogConfig。
 */
export function apply(ctx: cordis.Context, config: DefaultDialogConfig): void {
  //M 校验一次：recent 不写是 50，必须是正整数。
  const raw = config as Partial<DefaultDialogConfig> | undefined;
  const recent = raw?.recent ?? 50;
  if (!Number.isInteger(recent) || recent <= 0) {
    throw new Error('default-dialog 的 recent 必须是正整数');
  }
  new DefaultDialog(ctx, { recent });
}
