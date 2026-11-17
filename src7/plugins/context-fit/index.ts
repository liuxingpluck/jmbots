/**
 * 上下文装得下：每一步调模型前估一下要发多少 token；装不下就先把最早的工具结果换成一句“已省略”（最近几条不动），
 * 还装不下就从最早成段丢掉（最后一条用户消息和最近几段不丢），最前面补一句说明。不调模型。
 * 只换 request.messages（本来就是副本），会话存的对话一个字不动。照 0.4 src/executors/ContextFit.ts。
 * 在 plugins 里要排在 compress 之后、model-fallback 之前（它们改完的才是真要发的）。
 * 设计：docs/src7插件设计/context-fit.md。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';


/** 插件名。 */
export const name = 'context-fit';

/** 用到的服务：resources 拿模型的上限。modelCatalog 是可选的（有就用清单里拉到的真上限）。 */
export const inject = ['resources'];


/** 插件配置。 */
export interface Config {
  /** 最近几条工具结果、几段对话一定原样留，默认 6。 */
  keep: number;
  /** 上限的几成拿来装，默认 0.9。 */
  ratio: number;
}

/** 裁完的结果。 */
export interface Fitted {
  messages: piAi.Message[];
  tokens: number;
  trimmed: number;
  dropped: number;
}

/** model-catalog 里用到的：按“供应商/模型”找上限。 */
interface CatalogLike {
  find(id: string): { contextWindow?: number } | undefined;
}


/**
 * 估 token：JSON 以后的 UTF-8 字节数 ÷ 3（中文一个字约 1 token、3 字节；英文估偏多，宁可多留余量）。
 * @param value 任意可 JSON 化的东西。
 */
export function estimate(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') / 3);
}

/**
 * 一条工具结果换成“已省略”。
 * @param message 工具结果。
 * @param order 第几条（从 1 数）。
 */
function trimmed(message: piAi.ToolResultMessage, order: number): piAi.ToolResultMessage {
  const length = message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0);
  const text = `（第 ${String(order)} 条工具结果已省略，以装进模型上下文：原来 ${String(length)} 字。要用就重新调工具。）`;
  return { ...message, content: [{ type: 'text', text }] };
}

/**
 * 切段：一条用户消息自成一段；一条模型回答连同紧跟它的工具结果算一段。
 * @returns 每段是一组下标。
 */
function blocks(messages: piAi.Message[]): number[][] {
  const result: number[][] = [];
  for (const [index, message] of messages.entries()) {
    const last = result.at(-1);
    if (message.role === 'toolResult' && last !== undefined) last.push(index);
    else result.push([index]);
  }
  return result;
}

/**
 * 按预算裁。不改传进来的数组。
 * @param messages 要发的对话。
 * @param budget 最多给对话多少 token。
 * @param keep 最近几条工具结果、几段一定原样留。
 */
export function fit(messages: piAi.Message[], budget: number, keep: number): Fitted {
  let current = [...messages];
  let tokens = estimate(current);
  if (tokens <= budget) return { messages: current, tokens, trimmed: 0, dropped: 0 };

  //M 1. 早的工具结果换成“已省略”：从最早的开始，最近 keep 条不动，够了就停。
  const tools = current.flatMap((message, index) => (message.role === 'toolResult' ? [index] : []));
  let count = 0;
  for (const [order, index] of tools.slice(0, Math.max(0, tools.length - keep)).entries()) {
    if (tokens <= budget) break;
    const message = current[index] as piAi.ToolResultMessage;
    const replaced = trimmed(message, order + 1);
    tokens += estimate(replaced) - estimate(message);
    current[index] = replaced;
    count += 1;
  }
  if (tokens <= budget) return { messages: current, tokens, trimmed: count, dropped: 0 };

  //M 2. 还装不下：从最早成段丢；最后一条用户消息所在的段和最近 keep 段不丢。
  const parts = blocks(current);
  const lastUser = parts.findLastIndex((part) => current[part[0] ?? 0]?.role === 'user');
  const limit = Math.min(parts.length - keep, lastUser < 0 ? parts.length : lastUser);
  let cutAt = 0;
  let dropped = 0;
  while (tokens > budget && cutAt < limit) {
    const part = parts[cutAt] ?? [];
    tokens -= estimate(part.map((index) => current[index]));
    dropped += part.length;
    cutAt += 1;
  }
  if (cutAt > 0) {
    const from = parts[cutAt]?.[0] ?? current.length;
    const notice: piAi.Message = { role: 'user', content: `（更早的 ${String(dropped)} 条对话已省略，以装进模型上下文；需要的话问用户或重新查。）`, timestamp: Date.now() };
    current = [notice, ...current.slice(from)];
    tokens = estimate(current);
  }
  return { messages: current, tokens, trimmed: count, dropped };
}


/**
 * 校验插件配置。
 * @throws keep 不是非负整数、ratio 不在 (0, 1] 时抛错。
 */
function readConfig(config: Record<string, unknown> | undefined): Config {
  const keep = config?.['keep'] ?? 6;
  const ratio = config?.['ratio'] ?? 0.9;
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0) throw new Error('context-fit 的 keep 要是不小于 0 的整数');
  if (typeof ratio !== 'number' || ratio <= 0 || ratio > 1) throw new Error('context-fit 的 ratio 要大于 0、不大于 1');
  return { keep, ratio };
}


/**
 * 挂上上下文裁剪。
 * apply 是 Cordis 插件的入口：inject 里的 resources 就绪后 Cordis 调一次，第二个参数是 plugins 段里它的 config。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param raw 插件配置。
 */
export function apply(ctx: cordis.Context, raw: Record<string, unknown> | undefined): void {
  const config = readConfig(raw);

  //M 听 session/request：所有种类的会话都裁。
  ctx.on('session/request', (request) => {
    //M 上限：挂了 model-catalog（可选服务，ctx.get 现取）且清单里有这个模型就用拉到的真上限，否则用 providers 里手写的（没写是 128000）。
    const catalog = ctx.get('modelCatalog') as CatalogLike | undefined;
    const window = catalog?.find(request.model)?.contextWindow || ctx.resources.modelOf(request.model).contextWindow;
    if (window <= 0) return;

    const budget = Math.floor(window * config.ratio) - estimate(request.system) - estimate(request.tools);
    const before = estimate(request.messages);
    if (before <= budget) return;

    const fitted = fit(request.messages, budget, config.keep);
    request.messages = fitted.messages;

    //T 跟踪：裁了。
    const vars = { 会话: request.session.id, 模型: request.model, 上限: window, 预算: budget, 裁前: before, 裁后: fitted.tokens, 换掉: fitted.trimmed, 丢了: fitted.dropped };
    ctx.emit('trace', 'ContextFit.fit', '装不下，裁了旧的工具结果', 'fit(request.messages, budget, keep)', vars);
  });
}
