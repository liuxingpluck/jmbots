/**
 * 对话压缩（由原 compress 并入 context-fit）：对话用量达到模型窗口阈值时，把前面的压成一段摘要。
 * 做法是会话里嵌一场小会话：新开一场 kind 是 compress 的会话，让它跑同一个循环写出摘要。
 * 摘要记在 compress_log 表里，原会话存的对话一个字不动；以后每一步先套上已有的摘要，再交给后续裁剪。
 * 只压前台、后台这两种长期对话；交给小会话的那段对话按登记窗口限长，免得压缩请求自己先超长。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as drizzle from 'drizzle-orm';
import type { AskInput, ChatRequest, SessionRow } from '../../Sessions.ts';
import * as utils from '../../utils/index.ts';
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

/**
 * 会压缩的会话种类：前台（front）和后台（work）这两种长期对话。
 * 别的都是 sessions.ask 开的小会话（compress、summary、decision……），问一句就扔，不压，也免得压缩又派出一场压缩。
 */
const COMPRESS_KINDS = new Set(['front', 'work']);

/** 交给压缩小会话的那段对话最多占登记窗口的几成；其余留给提示词、以前的摘要和写出来的摘要。 */
const INPUT_SHARE = 0.5;

/** 一条工具结果交给压缩时最多留多少字：超了留头尾各一半，中间写明省略了多少。 */
const TOOL_TEXT_MAX = 2000;

/** 别的消息一块文字的上限按预算的 1/4 算，最少留这么多字。 */
const MESSAGE_TEXT_MIN = 200;

/** 一张图估多少 token：模型按像素算，一般一两千；不按 base64 字数算。 */
const IMAGE_TOKENS = 1500;

/** 压缩小会话没做成后，要再多出几条消息才重试（每一步都会多出回答和工具结果，不设门槛等于每步都重试）。 */
const RETRY_AFTER_MESSAGES = 10;

/** 失败记录最多记几场会话：满了丢最早的，7×24 跑着不一直涨。 */
const FAILED_MAX = 500;

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
 * 估 token：JSON 以后的 UTF-8 字节数 ÷ 3（中文一个字约 1 token、3 字节；英文估偏多，宁可多留余量）。
 * 图片块不按 base64 字数算（一张 500KB 截图会被当成十几万 token），每张按 IMAGE_TOKENS 计。
 * 压缩限长和 index.ts 的裁剪共用。
 * @param value 任意可 JSON 化的东西。
 * @returns 估算占用的 token 数（向上取整）。
 */
export function estimate(value: unknown): number {
  //M 序列化时把图片块换成空壳（不带 data），顺手数有几张。
  let images = 0;
  const json = JSON.stringify(value, (_key: string, item: unknown) => {
    if (utils.getField(item, 'type') !== 'image') return item;

    images += 1;
    return { type: 'image' };
  }) ?? '';

  //M 文字按字节估，图片按张数加固定值。
  const textTokens = Math.ceil(Buffer.byteLength(json, 'utf8') / 3);
  return textTokens + images * IMAGE_TOKENS;
}

/**
 * 截短一段字：不超过 max 原样交回；超了留头尾各一半，中间写明省略了多少字。
 * @param text 原文。
 * @param max 最多留几个字。
 * @returns 截短后的字。
 */
function getShortText(text: string, max: number): string {
  if (text.length <= max) return text;

  const half = Math.floor(max / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const cut = text.length - half * 2;
  return `${head}\n…（中间省略 ${String(cut)} 字）…\n${tail}`;
}

/**
 * 模型回答里的一块交给压缩前的样子：正文、思考截到 max 字，调工具的参数太长就整段换成截短的 JSON 字。
 * @param block 回答里的一块。
 * @param max 一块最多留几个字。
 * @returns 截短后的那一块。
 */
function getShortAnswerBlock(
  block: piAi.TextContent | piAi.ThinkingContent | piAi.ToolCall,
  max: number,
): piAi.TextContent | piAi.ThinkingContent | piAi.ToolCall {
  if (block.type === 'text') return { ...block, text: getShortText(block.text, max) };

  if (block.type === 'thinking') return { ...block, thinking: getShortText(block.thinking, max) };

  //M 调工具：参数（写文件的全文、长命令）没超就原样，超了换成一句截短的 JSON。
  const args = JSON.stringify(block.arguments);
  if (args.length <= max) return block;

  return { ...block, arguments: { 参数太长已截短: getShortText(args, max) } };
}

/**
 * 一条消息交给压缩前的样子：图片换成“[图片]”（base64 太长，压缩也用不上），每块文字都截到上限。
 * 工具结果最多 TOOL_TEXT_MAX 字；用户话、模型回答（正文、思考、调工具参数）最多 max 字。不改传进来的消息。
 * @param message 一条历史消息。
 * @param max 一块文字最多留几个字（按这一次的预算算）。
 * @returns 交给压缩的那一条。
 */
function getCompressMessage(message: piAi.Message, max: number): piAi.Message {
  //M 模型回答：逐块截正文、思考和调工具参数。
  if (message.role === 'assistant') {
    const answer = message.content.map((block) => getShortAnswerBlock(block, max));
    return { ...message, content: answer };
  }

  //M 纯文字的用户话：截到上限。
  const content = message.content;
  if (typeof content === 'string') {
    const said = getShortText(content, max);
    return { ...message, content: said } as piAi.Message;
  }

  //M 用户话、工具结果的块：图片换成一句字，文字截短（工具结果按更小的上限）。
  let textMax = max;
  if (message.role === 'toolResult') {
    textMax = Math.min(max, TOOL_TEXT_MAX);
  }
  const blocks = content.map((block): piAi.TextContent | piAi.ImageContent => {
    if (block.type === 'image') return { type: 'text', text: '[图片]' };

    const text = getShortText(block.text, textMax);
    return { ...block, text };
  });
  return { ...message, content: blocks } as piAi.Message;
}

/**
 * 省掉中间几条时插的那一句。
 * @param skipped 省了几条。
 * @returns 一条用户话。
 */
function getSkipNotice(skipped: number): piAi.Message {
  return { role: 'user', content: `（中间 ${String(skipped)} 条太长，没交给压缩）`, timestamp: Date.now() };
}

/**
 * 拼交给压缩小会话的那段对话（JSON），保证不超过 budget：
 *   1. 每条消息先换掉图片、每块文字截到上限（预算的 1/4，至少 MESSAGE_TEXT_MIN 字），单条超大的也压得住；
 *   2. 还超：最新一条一定留，首条装得下才留，再从后往前装，装不下的中间写一句省了几条；
 *   3. 一条消息块太多、仍超：整段 JSON 再截到预算以内。
 * @param messages 要压的那段对话。
 * @param budget 这段最多占多少 token（估算）。
 * @returns JSON 字符串（最后一步截过时是截短的 JSON 字）。
 */
export function getCompressInput(messages: piAi.Message[], budget: number): string {
  //M 一块文字的上限：预算的四分之一，最少 MESSAGE_TEXT_MIN 字。
  const maxChars = Math.max(MESSAGE_TEXT_MIN, Math.floor(budget / 4));
  const shortened = messages.map((message) => getCompressMessage(message, maxChars));
  if (estimate(shortened) <= budget) return JSON.stringify(shortened);

  //M 还超：省略说明先占一份位置；最新一条一定留，首条装得下才留。
  const reserve = estimate(getSkipNotice(shortened.length));
  const last = shortened.slice(-1);
  let room = budget - reserve - estimate(last);
  let head: piAi.Message[] = [];
  const firstSize = estimate(shortened[0]);
  if (shortened.length > 1 && firstSize <= room) {
    head = shortened.slice(0, 1);
    room -= firstSize;
  }

  //M 从倒数第二条往前装，装不下就停（不碰已经留下的首条）。
  let start = shortened.length - 1;
  while (start > head.length) {
    const size = estimate(shortened[start - 1]);
    if (size > room) break;

    room -= size;
    start -= 1;
  }

  //M 中间省掉的写一句，让压缩知道这里断过；一条都没省就不写。
  const skipped = start - head.length;
  let kept = [...head, ...shortened.slice(start)];
  if (skipped > 0) {
    kept = [...head, getSkipNotice(skipped), ...shortened.slice(start)];
  }

  //G 一条消息块太多、整段仍超：截到预算以内（budget 个字：中文一字约 1 token，英文更少）。
  const json = JSON.stringify(kept);
  if (estimate(kept) <= budget) return json;

  return getShortText(json, budget);
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
  /** 会话号 → 上次压缩小会话没做成时原会话有几条消息；按放进去的先后排，最多 FAILED_MAX 场。 */
  private readonly failed = new Map<string, number>();

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

    //G 只压前台、后台；小会话不管带没带 parent 都跳过，避免压缩又派出一场压缩。
    if (!COMPRESS_KINDS.has(row.kind)) return;

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
    //M 上一步用量达到登记窗口的指定比例时，生成或更新会话摘要；上次没压成、消息还没多出 RETRY_AFTER_MESSAGES 条就先不试。
    const failedAt = this.failed.get(row.id);
    const backingOff = failedAt !== undefined && row.messages.length < failedAt + RETRY_AFTER_MESSAGES;
    if (window > 0 && used >= trigger && !backingOff) {
      done = await this.compress(request, done, window);
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
   * @param window 已登记的模型窗口：交给小会话的那段对话按它限长。
   * @returns 新的进度和摘要；没有可压的、或者小会话没做成，交回原来的 done。
   */
  private async compress(request: ChatRequest, done: Compressed | null, window: number): Promise<Compressed | null> {
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

    //M 要压的那段按登记窗口限长：图片换字、长工具结果截短，还超就留首尾、省中间。
    const budget = Math.floor(window * INPUT_SHARE);
    const input = getCompressInput(messages.slice(from, upto), budget);

    //M 开一场小会话来压。它没有渠道，不会被当成回话。等它跑完。
    const ask = [
      '把下面的对话压缩成更短的摘要，保留关键事实、约定和没做完的事。只输出摘要，不要解释。',
      `以前的摘要：\n${done?.summary ?? '（没有）'}`,
      `要压缩的对话（JSON）：\n${input}`,
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

    //G 被叫停了 → 这次不压，也不算失败。
    if (request.signal.aborted) return done;

    //G 小会话没做成 → 这次不压，记下失败时的消息数，多出几条再试。
    if (!ok) {
      this.noteFailed(row.id, row.messages.length);
      return done;
    }

    //M 压成了：清掉失败记录。
    this.failed.delete(row.id);

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

  /**
   * 记一场会话压缩没做成：先删再放（排到最后），超过 FAILED_MAX 场丢最早的。
   * @param session 会话号。
   * @param count 失败时原会话有几条消息。
   */
  private noteFailed(session: string, count: number): void {
    this.failed.delete(session);
    this.failed.set(session, count);
    if (this.failed.size <= FAILED_MAX) return;

    //M 超了：丢最早那场，它以后照常按阈值触发压缩。
    const oldest = this.failed.keys().next().value;
    if (oldest !== undefined) {
      this.failed.delete(oldest);
    }
  }
}
