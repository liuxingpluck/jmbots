/** 渠道回话请求（Reply.ts 的 requestChannelReply）：没人接、接单后出错、正常回执三种结果，都不靠掐表。 */
import { afterEach, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import * as protocol from './index.ts';

const contexts: cordis.Context[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose();
  }
});

/** 一条按地址发的纯文字回复请求，渠道叫 test。 */
function getRequest(): Omit<protocol.ChannelReplyRequest, 'requestId'> {
  const parts: protocol.ReplyPartInput[] = [{ partId: 'text:0', kind: 'text', text: '你好' }];
  return {
    channel: 'test',
    bot: '助手',
    replyRequestKey: 'key',
    replyRoundKey: 'round',
    replyIndex: 0,
    kind: 'final',
    mode: 'text',
    payloadHash: 'hash',
    parts,
  };
}

/** 新建一个事件总线，测完撤掉。 */
function getContext(): cordis.Context {
  const ctx = new cordis.Context();
  contexts.push(ctx);
  return ctx;
}

test('没有渠道接单：确定没发，回 rejected（channel_unavailable）', async () => {
  const ctx = getContext();
  const receipt = await protocol.requestChannelReply(ctx, getRequest());
  expect(receipt).toMatchObject({ ok: false, status: 'rejected', reason: 'channel_unavailable：渠道 test 没挂' });
});

test('渠道接单后出错：发没发到不确定，回 uncertain 并带出错原话', async () => {
  const ctx = getContext();
  ctx.on('channel/reply', async (request) => {
    request.handled = true;
    await Bun.sleep(5);
    throw new Error('网络断了');
  });
  const receipt = await protocol.requestChannelReply(ctx, getRequest());
  expect(receipt).toMatchObject({ ok: false, status: 'uncertain', reason: expect.stringContaining('网络断了') });
});

test('渠道正常回执：原样交回', async () => {
  const ctx = getContext();
  ctx.on('channel/reply', (request) => {
    request.handled = true;
    const sent = protocol.getReceipt(request, 'sent');
    protocol.emitReplied(ctx, request, sent);
  });
  const receipt = await protocol.requestChannelReply(ctx, getRequest());
  expect(receipt).toMatchObject({ ok: true, status: 'sent', replyRequestKey: 'key' });
});
