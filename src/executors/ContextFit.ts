/**
 * 按模型能读的上限装上下文：装得下就全给，装不下先把早期的工具输出换成一句"已省略"，再不行从最早的对话成段丢掉。
 *
 * 为什么（2026-11-04）：周小灵一个会话堆了 17 件事、457 条消息，一次发给模型约 180 万字，超出 gpt-6.1-sol 的
 * 51 万 token，报"Your input exceeds the context window of this model"，整件事卡死。原来 buildContext 把整个会话
 * 原样全发，从不看模型能读多少。用户："所有模型的上下文都应该是它能达到的最大"——上限是模型定的，我们要做的是
 * 每次按它装满、装不下就压缩老的，而不是塞爆。
 *
 * 只做确定的裁剪，不调模型（不花钱、不慢）：
 *   1. 早期的工具输出（最近 keepRecent 条以外的）换成"第几条工具结果已省略：原来多少字，要用就重新读"；图片也去掉。
 *   2. 还装不下：从最早开始成段丢（一段 = 一条用户消息，或一条模型回复连同它的工具结果，不拆开，否则接口会报错），
 *      最后一条用户消息和最近 keepRecent 段不丢；丢了的在最前面补一句"更早的 N 条已省略"。
 * 字数估 token：按 UTF-8 字节数 / 3（中文一个字约 1 token、3 字节；英文 4 个字母约 1 token，这样估偏多，宁可多留余量）。
 */
import type * as piAi from '@earendil-works/pi-ai';


/** 裁剪的结果。 */
export interface Fitted {
  /** 装好的消息。 */
  messages: piAi.Message[];

  /** 估算的 token 数（裁剪后）。 */
  tokens: number;

  /** 换成"已省略"的工具输出有几条。 */
  trimmed: number;

  /** 丢掉的整段消息有几条。 */
  dropped: number;
}


/**
 * 估算一组消息大约多少 token。
 * @param value 消息或任意可 JSON 化的东西。
 * @returns 估算值（偏多）。
 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') / 3);
}


/**
 * 把一条工具结果换成"已省略"。
 * @param message 工具结果。
 * @param index 它是第几条工具结果（从 1 数）。
 * @returns 换好的消息。
 */
function trimToolResult(message: piAi.ToolResultMessage, index: number): piAi.ToolResultMessage {
  /** 原来的文字有多长。 */
  const length = message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0);
  return {
    ...message,
    content: [{ type: 'text', text: `（第 ${index} 条工具结果已省略，以装进模型上下文：原来 ${length} 字。要用就重新调工具。）` }],
  };
}


/**
 * 把消息切成段：一条用户消息自成一段；一条模型回复连同紧跟它的工具结果算一段。
 * @param messages 消息。
 * @returns 段，每段是一组下标。
 */
function toBlocks(messages: piAi.Message[]): number[][] {
  /** 结果。 */
  const blocks: number[][] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'toolResult' && blocks.length > 0) {
      blocks.at(-1)?.push(index);
    } else {
      blocks.push([index]);
    }
  }
  return blocks;
}


/**
 * 按预算装上下文。
 * @param messages 完整的历史（buildContext 拼出来的）。
 * @param budget 这次最多给消息多少 token（模型上限减掉系统提示词、工具说明和留给回复的）。
 * @param keepRecent 最近几条工具结果、几段消息一定原样保留。
 * @returns 装好的消息和统计；本来就装得下时原样返回。
 * 无副作用（不改传进来的数组）。
 */
export function fitContext(messages: piAi.Message[], budget: number, keepRecent = 6): Fitted {
  /** 现在的消息（逐步替换）。 */
  let current = [...messages];
  /** 现在估多少。 */
  let tokens = estimateTokens(current);
  if (tokens <= budget) {
    return { messages: current, tokens, trimmed: 0, dropped: 0 };
  }

  //M 1. 早期的工具输出换成"已省略"：从最早的开始，最近 keepRecent 条不动。
  /** 工具结果在哪些位置。 */
  const toolIndexes = current.flatMap((message, index) => (message.role === 'toolResult' ? [index] : []));
  /** 可以省略的（最近 keepRecent 条以外的）。 */
  const trimmable = toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent));
  let trimmed = 0;
  for (const [order, index] of trimmable.entries()) {
    if (tokens <= budget) {
      break;
    }
    /** 这一条。 */
    const message = current[index] as piAi.ToolResultMessage;
    /** 换掉之后。 */
    const replaced = trimToolResult(message, order + 1);
    tokens += estimateTokens(replaced) - estimateTokens(message);
    current[index] = replaced;
    trimmed += 1;
  }
  if (tokens <= budget) {
    return { messages: current, tokens, trimmed, dropped: 0 };
  }

  //M 2. 还装不下：从最早开始成段丢；最后一条用户消息和最近 keepRecent 段不丢。
  /** 段。 */
  const blocks = toBlocks(current);
  /** 最后一条用户消息在哪一段。 */
  const lastUser = blocks.findLastIndex((block) => current[block[0] ?? 0]?.role === 'user');
  /** 最多能丢到第几段（不含）。 */
  const limit = Math.min(blocks.length - keepRecent, lastUser < 0 ? blocks.length : lastUser);
  /** 丢到第几段。 */
  let cut = 0;
  /** 丢掉的消息条数。 */
  let dropped = 0;
  while (tokens > budget && cut < limit) {
    /** 这一段。 */
    const block = blocks[cut] ?? [];
    tokens -= estimateTokens(block.map((index) => current[index]));
    dropped += block.length;
    cut += 1;
  }
  if (cut > 0) {
    /** 从这一段起保留。 */
    const from = blocks[cut]?.[0] ?? current.length;
    /** 补在最前面的说明。 */
    const notice: piAi.Message = { role: 'user', content: `（更早的 ${dropped} 条对话已省略，以装进模型上下文；需要的话问用户或重新查。）`, timestamp: Date.now() };
    current = [notice, ...current.slice(from)];
    tokens = estimateTokens(current);
  }
  return { messages: current, tokens, trimmed, dropped };
}
