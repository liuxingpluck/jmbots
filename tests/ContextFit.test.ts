/**
 * 按模型上限装上下文（executors/ContextFit.ts）的离线测试：纯函数，不联网。
 * 起因：2026-11-04 一个会话 180 万字塞爆了 gpt-6.1-sol 的 51 万 token。
 */
import * as bunTest from 'bun:test';
import type * as piAi from '@earendil-works/pi-ai';
import * as contextFit from '../src/executors/ContextFit.ts';


/**
 * 一条用户消息。
 * @param text 正文。
 */
function user(text: string): piAi.Message {
  return { role: 'user', content: text, timestamp: 0 };
}

/**
 * 一条要调工具的模型回复。
 * @param id 工具调用 ID。
 */
function call(id: string): piAi.Message {
  return { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: {} }] } as unknown as piAi.Message;
}

/**
 * 一条工具结果。
 * @param id 对应的工具调用 ID。
 * @param size 结果多少字。
 */
function result(id: string, size: number): piAi.Message {
  return { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: '字'.repeat(size) }], isError: false, timestamp: 0 };
}


bunTest.test('装得下：原样返回，一条都不动', () => {
  /** 历史。 */
  const history = [user('读一下'), call('a'), result('a', 10)];
  /** 结果。 */
  const fitted = contextFit.fitContext(history, 100_000);
  bunTest.expect(fitted.messages).toEqual(history);
  bunTest.expect([fitted.trimmed, fitted.dropped]).toEqual([0, 0]);
});


bunTest.test('装不下：先把早期的工具输出换成“已省略”，最近几条原样留着', () => {
  /** 10 次读文件，每次 3000 字（约 3000 token）。 */
  const history = [user('把这些文件都读一遍'), ...Array.from({ length: 10 }, (_, index) => [call(`c${index}`), result(`c${index}`, 3000)]).flat()];
  /** 预算只够约 4 次的原文。 */
  const fitted = contextFit.fitContext(history, 13_000, 3);
  bunTest.expect(fitted.tokens).toBeLessThanOrEqual(13_000);
  bunTest.expect(fitted.dropped).toBe(0);
  bunTest.expect(fitted.trimmed).toBeGreaterThan(0);
  //G 最近 3 条工具结果原样。
  /** 最后三条工具结果。 */
  const lastResults = fitted.messages.filter((message): message is piAi.ToolResultMessage => message.role === 'toolResult').slice(-3);
  bunTest.expect(lastResults.every((message) => message.content[0]?.type === 'text' && message.content[0].text.length === 3000)).toBe(true);
  //G 省略掉的写清原来多少字。
  /** 第一条工具结果。 */
  const first = fitted.messages.find((message) => message.role === 'toolResult') as piAi.ToolResultMessage;
  bunTest.expect(first.content[0]?.type === 'text' && first.content[0].text).toContain('原来 3000 字');
  //G 工具调用和结果一条没少（接口要求成对）。
  bunTest.expect(fitted.messages.length).toBe(history.length);
});


bunTest.test('还装不下：从最早开始成段丢，调用和结果不拆开，最后一条用户消息一定留着', () => {
  /** 很多轮对话，最后一句是新的任务。 */
  const history = [
    ...Array.from({ length: 20 }, (_, index) => [user(`第 ${index} 件事：${'话'.repeat(2000)}`), call(`c${index}`), result(`c${index}`, 100)]).flat(),
    user('现在做这件'),
  ];
  /** 结果。 */
  const fitted = contextFit.fitContext(history, 8_000, 2);
  bunTest.expect(fitted.tokens).toBeLessThanOrEqual(8_000);
  bunTest.expect(fitted.dropped).toBeGreaterThan(0);
  //G 最前面补了说明。
  /** 第一条。 */
  const notice = fitted.messages[0];
  bunTest.expect(notice?.role === 'user' && typeof notice.content === 'string' ? notice.content : '').toContain('已省略');
  //G 最后一条用户消息还在。
  bunTest.expect(fitted.messages.at(-1)).toEqual(user('现在做这件'));
  //G 每条工具结果前面都有它的调用：不能把结果单独留下。
  for (const [index, message] of fitted.messages.entries()) {
    if (message.role === 'toolResult') {
      /** 前一条。 */
      const before = fitted.messages[index - 1];
      bunTest.expect(before?.role === 'assistant' || before?.role === 'toolResult').toBe(true);
    }
  }
});


bunTest.test('估 token 偏多：中文一个字约 1 个，英文 3 个字母约 1 个', () => {
  bunTest.expect(contextFit.estimateTokens('字'.repeat(300))).toBeGreaterThanOrEqual(300);
  bunTest.expect(contextFit.estimateTokens('a'.repeat(300))).toBeGreaterThanOrEqual(100);
});
