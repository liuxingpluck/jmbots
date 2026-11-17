/**
 * 压缩：干活的会话太长时，把前面的压成一段摘要。
 * 做法是会话里嵌一场小会话：新开一场 kind 是 compress 的会话，让它跑同一个循环写出摘要。
 * 所以压缩的每一步也落库、也发事件，界面上看得到压缩的过程。
 * 摘要记在这个插件自己的表里，原会话存的对话一个字不动；以后每一步先套上已有的摘要，不用重压。
 * 以后别的“会话里再问一次模型”的事照这个做法写（总结插件 plugins/summary 就是）。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { ChatRequest } from '../../Chat.ts';
import type { AskInput, SessionRow } from '../../Sessions.ts';


/** 插件名。 */
export const name = 'compress';

/** 用到的服务。 */
export const inject = ['resources', 'sessions'];


/** 给压缩插件的配置：config.yaml 的 plugins 段里它的 config。 */
export interface CompressConfig {
  /** 上一步模型用掉的 token 到了多少就压缩。不写是 200000。 */
  at: number;
  /** 压缩以后原样留下最近几条。不写是 6。 */
  keep: number;
}


/** 表 compress_log 里的一行：一场会话压到了第几条、摘要是什么。 */
interface Compressed {
  /** 压到第几条（不含）：对话里它前面的都在摘要里了。 */
  upto: number;
  /** 摘要。 */
  summary: string;
}


/** 压缩。 */
class Compress {
  /**
   * 建自己的表，挂监听。
   * @param ctx Cordis 给的 ctx。
   * @param config 多长才压、留几条。
   */
  constructor(private readonly ctx: cordis.Context, private readonly config: CompressConfig) {
    this.ctx.resources.db.exec(`
      CREATE TABLE IF NOT EXISTS compress_log (
        session TEXT PRIMARY KEY,
        upto INTEGER NOT NULL,
        summary TEXT NOT NULL
      )
    `);
    this.ctx.on('session/request', (request) => this.onRequest(request));
  }

  /**
   * 响应 session/request：太长了就压；压过的套上摘要。
   * @param request 这一步的请求；改它的 messages。
   * 副作用：可能新开一场小会话并跑完它；写自己的表。
   */
  private async onRequest(request: ChatRequest): Promise<void> {
    const row = request.session.row;

    //G 只压干活的会话：前台对话只带最近往来，小会话很短。
    if (row.kind !== 'work') return;

    //M 这场以前压到哪了；没压过是 null。
    const query = this.ctx.resources.db.query('SELECT upto, summary FROM compress_log WHERE session = ?');
    let done = query.get(row.id) as Compressed | null;

    //M 上一步模型实际用掉多少 token；到了 config.at 就再压一次。
    const lastAnswer = row.messages.findLast((item): item is piAi.AssistantMessage => item.role === 'assistant');
    if (lastAnswer !== undefined && lastAnswer.usage.totalTokens >= this.config.at) {
      done = await this.compress(row, done);
    }

    //G 从来没压过 → 原样发。
    if (done === null) return;

    //M 套上摘要：一条写着摘要的消息，加上压到的那一条以后的原文。
    const note: piAi.Message = {
      role: 'user',
      content: `（前面的对话已经压缩成下面这段摘要）\n${done.summary}`,
      timestamp: Date.now(),
    };
    request.messages = [note, ...row.messages.slice(done.upto)];
  }

  /**
   * 开一场小会话，把还没压过的那一段压成摘要。
   * @param row 要压的那场会话的记录。
   * @param done 以前压到哪了；没压过是 null。
   * @returns 新的进度和摘要；没有可压的、或者小会话没做成，交回原来的 done。
   */
  private async compress(row: SessionRow, done: Compressed | null): Promise<Compressed | null> {
    //M 压到哪：留下最近 config.keep 条，再往前退到一条用户的话（不能从模型的回答和工具结果中间切开）。
    let upto = row.messages.length - this.config.keep;
    while (upto > 0 && row.messages[upto]?.role !== 'user') {
      upto -= 1;
    }
    const from = done?.upto ?? 0;

    //G 没有可压的。
    if (upto <= from) return done;

    //T 跟踪：压缩。
    const vars = { 会话: row.id, 从第几条: from, 压到第几条: upto };
    this.ctx.emit('trace', 'compress.compress', '对话太长，开一场小会话来压缩', 'sessions.ask(askInput)', vars);

    //M 开一场小会话来压。它没有渠道，不会被当成回话。等它跑完。
    const ask = [
      '把下面的对话压缩成更短的摘要，保留关键事实、约定和没做完的事。只输出摘要，不要解释。',
      `以前的摘要：\n${done?.summary ?? '（没有）'}`,
      `要压缩的对话（JSON）：\n${JSON.stringify(row.messages.slice(from, upto))}`,
    ];
    const askInput: AskInput = {
      bot: row.bot,
      kind: 'compress',
      parent: row.id,
      text: ask.join('\n\n'),
    };
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //G 小会话没做成 → 这次不压。
    if (!ok) return done;

    const next: Compressed = { upto, summary: reply };
    const save = this.ctx.resources.db.query(
      'INSERT OR REPLACE INTO compress_log (session, upto, summary) VALUES (?, ?, ?)',
    );
    save.run(row.id, next.upto, next.summary);
    return next;
  }
}


/**
 * 挂上压缩。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务都就绪，
 * 再调一次 apply(ctx, 配置)。插件在 apply 里通过 ctx 听事件、登记工具；插件被拔掉时，这些登记自动撤掉。
 * 详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 见 CompressConfig；每一项都可以不写。
 */
export function apply(ctx: cordis.Context, config: Partial<CompressConfig>): void {
  //M 配置是外面进来的，在这里校验一次：at 不写是 200000，keep 不写是 6，都必须是正整数。
  const at = config.at ?? 200000;
  const keep = config.keep ?? 6;
  if (!Number.isInteger(at) || at <= 0 || !Number.isInteger(keep) || keep <= 0) {
    throw new Error('compress 的 at、keep 必须是正整数');
  }
  new Compress(ctx, { at, keep });
}
