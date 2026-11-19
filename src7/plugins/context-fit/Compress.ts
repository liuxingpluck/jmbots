/**
 * 对话压缩（由原 compress 并入 context-fit）：对话用量达到模型窗口阈值时，把前面的压成一段摘要。
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
  /** 上一步用量达到模型窗口的这个比例就压缩，默认 0.8。 */
  ratio: number;
  /** 压缩以后原样留下最近几条。不写是 6。 */
  keep: number;
}

/** `plugins[context-fit].config.compress` 解析结果（带开启开关）。 */
export interface CompressSettings extends CompressConfig {
  enabled: boolean;
}

/** sessions.ask 当前用来区分内部小会话的种类。 */
const ASK_KINDS = new Set(['compress', 'summary', 'exec-review', 'decision', 'review', 'wrapup']);

/** 压缩开启时默认的窗口比例与原样保留的条数。 */
const DEFAULT_COMPRESS: CompressConfig = { ratio: 0.8, keep: 6 };

/** 表 compress_log 里的一行：一场会话压到了第几条、摘要是什么。 */
interface Compressed {
  /** 压到第几条（不含）：对话里它前面的都在摘要里了。 */
  upto: number;
  /** 摘要。 */
  summary: string;
}

/**
 * 确认请求仍以库里原来的消息开头，才能按原会话的下标读写摘要。
 * @param row 原会话记录。
 * @param messages 当前可发送的消息。
 * @param upto 摘要覆盖到的下标，不含该条。
 */
function matchesOriginalPrefix(row: SessionRow, messages: piAi.Message[], upto: number): boolean {
  if (upto > row.messages.length) return false;

  const prefix = row.messages.slice(0, upto);
  return prefix.every((message, index) => messages[index] === message);
}


/**
 * 校验并读取 `plugins[context-fit].config.compress`。
 * @param raw 原始配置。省略时默认开启，`false` 关闭，对象可写 `ratio` 和 `keep`。
 * @returns 校验后的压缩开关与阈值、保留条数配置。
 * @throws 类型或范围不合法时抛错。
 */
export function readCompressSettings(raw: unknown): CompressSettings {
  if (raw === false) return { enabled: false, ...DEFAULT_COMPRESS };

  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new Error('context-fit.compress 要是 false 或对象');
  }
  const own = (raw ?? {}) as Record<string, unknown>;
  //G 旧的固定 token 阈值应改成按窗口比例配置。
  if (Object.hasOwn(own, 'at')) {
    throw new Error('context-fit.compress.at 已移除，请改用 compress.ratio（默认 0.8）');
  }
  const { ratio = DEFAULT_COMPRESS.ratio, keep = DEFAULT_COMPRESS.keep } = own;
  if (typeof ratio !== 'number' || !(ratio > 0 && ratio < 1)) {
    throw new Error('context-fit.compress.ratio 要大于 0 且小于 1');
  }
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep <= 0) {
    throw new Error('context-fit.compress.keep 必须是正整数');
  }
  return { enabled: true, ratio, keep };
}


/**
 * 压缩：维护 compress_log 表并在 session/before-model 时把达到阈值的旧消息压成摘要。
 */
export class Compress {
  /**
   * 使用插件启动时迁移好的表。
   * @param ctx Cordis 给的上下文。
   * @param config 多长才压、留几条。
   * @param orm db 插件提供的 Drizzle 实例。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly config: CompressConfig,
    private readonly orm: dbModule.SqliteOrm,
  ) {}

  /**
   * 在窗口裁剪前按已登记的窗口触发压缩，并套用已有摘要。
   * @param request 这一步的请求；改它的 messages。
   * @param window 已登记的模型窗口。0 表示目前没有登记。
   * 副作用：可能新开一场小会话并跑完它；写自己的表。
   */
  async onRequest(request: ChatRequest, window: number): Promise<void> {
    const row = request.session.row;

    //G 跳过 sessions.ask 开的内部会话，避免压缩又派出一场压缩。
    if (row.parent !== undefined && ASK_KINDS.has(row.kind)) return;

    //M 按原会话号读取以前的摘要和边界，没压过按空记录处理。
    const table = schema.compressLog;
    const where = drizzle.eq(table.session, row.id);
    const saved = this.orm.select().from(table).where(where).get();
    let done: Compressed | null = null;
    if (saved !== undefined && matchesOriginalPrefix(row, request.messages, saved.upto)) {
      done = saved;
    }

    //M AssistantMessage 是模型回答。role 区分回答，content 存内容块，usage.totalTokens 用来决定是否再压。
    const lastAnswer = row.messages.findLast((item): item is piAi.AssistantMessage => item.role === 'assistant');
    const used = lastAnswer?.usage.totalTokens ?? 0;
    const trigger = window * this.config.ratio;
    //M 上一步用量达到登记窗口的指定比例时，生成或更新会话摘要。
    if (window > 0 && used >= trigger) {
      done = await this.compress(request, done);
    }

    //G 从来没压过 → 原样发。
    if (done === null) return;

    //M 套上摘要：一条写着摘要的消息，加上压到的那一条以后的原文。
    //M Message 是一条历史消息。这里用 role 标成 user，content 存摘要，timestamp 记生成时间。
    const note: piAi.Message = {
      role: 'user',
      content: `（前面的对话已经压缩成下面这段摘要）\n${done.summary}`,
      timestamp: Date.now(),
    };
    request.messages = [note, ...request.messages.slice(done.upto)];
  }

  /**
   * 开一场小会话，把还没压过的那一段压成摘要。
   * @param request 本轮请求，使用其中已经选出的可发送消息。
   * @param done 以前压到哪了；没压过是 null。
   * @returns 新的进度和摘要；没有可压的、或者小会话没做成，交回原来的 done。
   */
  private async compress(request: ChatRequest, done: Compressed | null): Promise<Compressed | null> {
    const row = request.session.row;
    const messages = request.messages;
    //M 压到哪：留下最近 config.keep 条，再往前退到一条用户的话（不能从模型的回答和工具结果中间切开）。
    let upto = messages.length - this.config.keep;
    while (upto > 0 && messages[upto]?.role !== 'user') {
      upto -= 1;
    }
    const from = done?.upto ?? 0;

    //G 没有可压的。
    if (upto <= from) return done;

    //T 跟踪：压缩。
    const vars = { session: row.id, fromIndex: from, throughIndex: upto };
    this.ctx.emit('trace', 'compress.compress', 'trace.contextFit.compress', 'sessions.ask(askInput)', vars);

    //M 开一场小会话来压。它没有渠道，不会被当成回话。等它跑完。
    const ask = [
      '把下面的对话压缩成更短的摘要，保留关键事实、约定和没做完的事。只输出摘要，不要解释。',
      `以前的摘要：\n${done?.summary ?? '（没有）'}`,
      `要压缩的对话（JSON）：\n${JSON.stringify(messages.slice(from, upto))}`,
    ];
    const askInput: AskInput = {
      bot: row.bot,
      kind: 'compress',
      parent: row.id,
      text: ask.join('\n\n'),
      signal: request.signal,
    };
    //M 运行内部 compress 小会话生成摘要，并等待结果决定是否更新压缩记录。
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //G 小会话没做成 → 这次不压。
    if (!ok || request.signal.aborted) return done;

    const next: Compressed = { upto, summary: reply };
    //G 经过上游筛选的消息没有原会话的同一段前缀，摘要只用于当前请求。
    if (!matchesOriginalPrefix(row, messages, upto)) return next;

    //M 原会话的历史前缀仍可见，保存摘要和原会话下标供后续请求复用。
    const table = schema.compressLog;
    const entry = { session: row.id, ...next };
    const existing = { target: table.session, set: next };
    this.orm.insert(table).values(entry).onConflictDoUpdate(existing).run();
    return next;
  }
}
