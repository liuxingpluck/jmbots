/**
 * 对话压缩（由原 compress 并入 context-fit）：干活的会话太长时，把前面的压成一段摘要。
 * 做法是会话里嵌一场小会话：新开一场 kind 是 compress 的会话，让它跑同一个循环写出摘要。
 * 摘要记在 compress_log 表里，原会话存的对话一个字不动；以后每一步先套上已有的摘要，再交给后续裁剪。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as drizzle from 'drizzle-orm';
import type { AskInput, ChatRequest, SessionRow } from '../../Sessions.ts';
import type * as dbModule from '../db/index.ts';
import * as schema from './Schema.ts';


/** 给压缩模块的配置。 */
export interface CompressConfig {
  /** 上一步模型用掉的 token 到了多少就压缩。不写是 200000。 */
  at: number;
  /** 压缩以后原样留下最近几条。不写是 6。 */
  keep: number;
}

/** `plugins[context-fit].config.compress` 解析结果（带开启开关）。 */
export interface CompressSettings extends CompressConfig {
  enabled: boolean;
}

/** 表 compress_log 里的一行：一场会话压到了第几条、摘要是什么。 */
interface Compressed {
  /** 压到第几条（不含）：对话里它前面的都在摘要里了。 */
  upto: number;
  /** 摘要。 */
  summary: string;
}


/**
 * 校验并读取 `plugins[context-fit].config.compress`。
 * @param raw 原始配置；未写默认 `{ enabled: true, at: 200000, keep: 6 }`，`false` 关闭，对象校验 `at`/`keep` 正整数。
 * @returns 校验后的压缩开关与阈值、保留条数配置。
 * @throws 类型或范围不合法时抛错。
 */
export function readCompressSettings(raw: unknown): CompressSettings {
  if (raw === false) return { enabled: false, at: 200000, keep: 6 };

  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new Error('context-fit.compress 要是 false 或对象');
  }
  const own = (raw ?? {}) as Record<string, unknown>;
  const at = own['at'] ?? 200000;
  const keep = own['keep'] ?? 6;
  if (typeof at !== 'number' || !Number.isInteger(at) || at <= 0
    || typeof keep !== 'number' || !Number.isInteger(keep) || keep <= 0) {
    throw new Error('context-fit.compress 的 at、keep 必须是正整数');
  }
  return { enabled: true, at, keep };
}


/**
 * 压缩：维护 compress_log 表并在 session/request 时把达到阈值的旧消息压成摘要。
 */
export class Compress {
  /**
   * 挂压缩监听，使用插件启动时迁移好的表。
   * @param ctx Cordis 给的上下文。
   * @param config 多长才压、留几条。
   * @param orm db 插件提供的 Drizzle 实例。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly config: CompressConfig,
    private readonly orm: dbModule.SqliteOrm,
  ) {
    //M 在每步模型请求前检查会话用量，达到阈值时触发压缩并把摘要拼回请求消息。
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

    //M 按原会话号读取以前的摘要和边界，没压过按空记录处理。
    const table = schema.compressLog;
    const where = drizzle.eq(table.session, row.id);
    const saved = this.orm.select().from(table).where(where).get();
    let done: Compressed | null = saved ?? null;

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
    //M 运行内部 compress 小会话生成摘要，并等待结果决定是否更新压缩记录。
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //G 小会话没做成 → 这次不压。
    if (!ok) return done;

    //M 小会话成功返回摘要后，将最新压缩进度与摘要覆盖存入 compress_log 供后续请求复用。
    const next: Compressed = { upto, summary: reply };
    const table = schema.compressLog;
    const entry = { session: row.id, ...next };
    const existing = { target: table.session, set: next };
    this.orm.insert(table).values(entry).onConflictDoUpdate(existing).run();
    return next;
  }
}
