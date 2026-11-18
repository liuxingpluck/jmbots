/** 确认入口通过审核事件和固定 P2 路径运输，只用合成草稿和内存库。 */
import * as sqlite from 'bun:sqlite';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import { expect, spyOn, test } from 'bun:test';
import * as outbound from '../approval/Outbound.ts';
import * as send from './ChannelSend.ts';
import * as hostModule from './Host.ts';
import * as specModule from './Spec.ts';

test('代理只接受已核验本人，精确草稿由程序提供，批准发送走内部管理接口', async () => {
  const ctx = new cordis.Context();
  const app = fastify.default();
  const db = new sqlite.Database(':memory:');
  ctx.provide('resources', { db });
  new outbound.Outbound(ctx);
  const spec = { name: 'sample', file: 'unused', channels: [{ name: 'wechat-external', bot: '助手' }] };
  const [parsed] = specModule.readPrograms({ programs: [spec] });
  const host = new hostModule.Host(parsed!, import.meta.dir);
  host.getSendTarget = () => ({ base: 'http://127.0.0.1:1', key: 'fixture-key', generation: 'gen-a' });
  const hosts = new Map([[spec.name, host]]);
  const isVerified = (request: fastify.FastifyRequest) => request.ip === '127.0.0.1';
  send.listenChannelSend(ctx, hosts);
  send.mountOutbound(ctx, app, isVerified, hosts);

  const calls: Array<{ path: string; wire?: send.ApprovedCall; verified: boolean }> = [];
  const raw = ' 草稿原文\n ';
  const response = { status: 'failed', reason: '明确失败' };
  const fakeFetch = async (...[input, options]: Parameters<typeof fetch>): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(options?.headers);
    const verified = headers.get('x-jmbots-key') === 'fixture-key';
    if (url.pathname === '/api/wechat-kefu/drafts') {
      calls.push({ path: url.pathname, verified });
      const draft = { id: 4, account: 'source', chat: 'target', text: raw, state: 'draft' };
      return Response.json([draft]);
    }
    if (url.pathname === '/jmbots/v1/channel/send') {
      const wire = JSON.parse(String(options?.body)) as send.ApprovedCall;
      calls.push({ path: url.pathname, wire, verified });
      return Response.json(response);
    }
    throw new Error('测试不允许其他请求');
  };
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch as typeof fetch);
  try {
    const prefix = '/programs/sample/_approval';
    const method = 'POST' as const;
    const payload = { draftId: 4, account: 'wrong', chat: 'wrong', text: 'wrong', role: 'owner' };
    const anonymous = { method, url: prefix + '/prepare', payload, remoteAddress: '192.0.2.7' };
    expect((await app.inject(anonymous)).statusCode).toBe(403);
    expect(calls).toEqual([]);

    const prepare = { method, url: prefix + '/prepare', payload };
    const preview = await app.inject(prepare);
    expect(preview.statusCode).toBe(200);
    const { intent } = preview.json<{ intent: { intentId: string; digest: string; requestId: string } }>();
    expect(intent).toMatchObject({ account: 'source', chat: 'target', text: raw });
    const decision = {
      intentId: intent.intentId, observedIntentDigest: intent.digest, decision: 'approve', interactionId: 'id-1',
      approval: { id: 'forged' },
    };
    const confirm = { method, url: prefix + '/confirm', payload: decision };
    const sent = await app.inject(confirm);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ intent: { status: 'failed', receipt: response } });
    expect(calls).toHaveLength(3);
    const captured = calls[2];
    expect(captured).toMatchObject({
      path: '/jmbots/v1/channel/send', verified: true,
      wire: { requestId: intent.requestId, channel: 'wechat-external', account: 'source', chat: 'target', text: raw },
    });
    expect(captured?.wire?.approval.id).not.toBe('forged');
    expect(captured?.wire?.approval.state).toBe('approved');
    expect(await app.inject(confirm)).toMatchObject({ statusCode: 200 });
    const callback = '/api/programs/sample/channel/approval';
    const status = { action: 'status', intentId: intent.intentId };
    const retry = { method, url: callback, payload: status };
    expect((await app.inject({ ...retry, headers: { 'x-jmbots-key': 'forged' } })).statusCode).toBe(403);
    const relayed = await app.inject({ ...retry, headers: { 'x-jmbots-key': 'fixture-key' } });
    expect(relayed.json()).toMatchObject({ intent: { status: 'failed', receipt: response } });
    expect(calls).toHaveLength(3);
  } finally {
    fetchSpy.mockRestore();
    await app.close();
    await ctx.fiber.dispose();
    db.close();
  }
});

test('代理重建双阶段请求，旧版读 id 的临时批准拿不到草稿号', () => {
  const path = '/api/wechat-kefu/outbox/send';
  const legacy = Buffer.from(JSON.stringify({ id: 4 }));
  expect(send.getProxyApproval(path, 'POST', legacy)).toBeUndefined();
  const patched = Buffer.from(JSON.stringify({ id: 4, draftId: 4, action: 'prepare', text: '伪造' }));
  expect(send.getProxyApproval(path, 'POST', patched)).toEqual({ action: 'prepare', draftId: 4 });
});
