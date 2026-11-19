/**
 * 渠道与机器人解耦第 1 步（`channel/message` 统一事件、接口 A）的端到端离线验证：
 *   1. `legacy_auto` 模式兼容（原 `ctx.bots.receive` 自动发送 `row.reply`，`acceptResult` `queued`/`duplicate` 与渠道 `sent` 不混淆）；
 *   2. 飞书单应用 + 单机器人 `channel/message` → `claimKey` 去重 → `channel_reply` 纯文字发送（绝不把 `@/abs/file` 当文件上传，同键幂等、同键不同正文报错、`row.reply` 不自动发）；
 *   3. 同一条 `channel/message` N 机器人独立认领 + `approval` 消息级“同意 1”只消费一次；
 *   4. 统一记忆的渠道归档（可配默认条数、签名游标翻页、受限来源隔离、`identity_unresolved` 报错）；
 *   5. 零次回复兜底（0 次回复工具调用 → 保留 `activeKey`、仅 `request.system` 注入 `"你还没调用回复工具"` 跑 1 次修复轮、排队用户消息不串轮；失败的 `channel_reply` 或 `kind: 'progress'` 不触发兜底；修复后仍 0 次标 `missing_reply`）。
 *   6. 前台归档带标准消息号，重放后同一会话只保留一条往来和一份正文。
 *
 * 跑法：bun test ./src7/plugins/bots/ChannelMessage.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as channels from '../../Channels.ts';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as approvalModule from '../approval/index.ts';
import * as feishuModule from '../feishu/index.ts';
import * as channelIndexModule from '../memory/ChannelIndex.ts';
import * as frontArchiveModule from '../memory/FrontArchive.ts';
import * as workspacesPlugin from '../workspaces/index.ts';
import * as botsPlugin from './index.ts';


//M 每个测例后自动释放插件和临时目录。
const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


/** 假资源服务构造参数。 */
interface FakeResourceOptions {
  root: string;
  bots: Array<{ name: string }>;
  feishuApps: Array<{ app_id: string; app_secret: string; bot: string; bots?: string[] }>;
}


/** 假资源服务。 */
class FakeResources extends cordis.Service {
  readonly db = new Database(':memory:');
  readonly raw: Record<string, unknown>;
  readonly root: string;
  readonly config = {
    defaultModel: 'fake/fake',
    sessionCacheMax: 500,
    thinking: 'low',
    retry: { times: 0, waitMs: 0, timeoutMs: 1000 },
    providers: {},
    plugins: [] as Array<{ name: string; config?: unknown }>,
  };

  constructor(ctx: cordis.Context, options: FakeResourceOptions) {
    super(ctx, 'resources');
    this.root = options.root;
    this.raw = {
      bots: options.bots,
      channels: { feishu: options.feishuApps },
    };
  }

  ensureRuntimeDir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  getModel(): { input: string[] } {
    return { input: ['text'] };
  }
}


/** 记录发往飞书 SDK 接口的真实消息和媒体调用。 */
interface FeishuCallRecord {
  textCalls: Array<{ chatId: string; text: string; replyToId?: string }>;
  uploadCalls: number;
}


/** 将 Feishu 客户端接口替换成内存桩，拦截真实 HTTP 请求并记录输出。 */
function stubFeishuClient(
  feishu: feishuModule.Feishu,
  appId: string,
  records: FeishuCallRecord,
  options?: { botOpenId?: string; failReplyOnce?: boolean },
): { triggerInbound: (data: unknown) => Promise<void> } {
  const inside = feishu as unknown as {
    apps: Map<string, {
      botOpenId?: string;
      client: { im: { v1: Record<string, unknown> } };
    }>;
    chats: Map<string, unknown>;
    inbound: { onMessage: (appId: string, data: unknown) => Promise<void> };
  };
  const app = inside.apps.get(appId);
  if (app === undefined) {
    throw new Error(`测试应用不存在：${appId}`);
  }
  app.botOpenId = options?.botOpenId;

  let seq = 0;
  let failLeft = 0;
  if (options?.failReplyOnce === true) {
    failLeft = 1;
  }

  const nextId = (): string => {
    seq += 1;
    return `om_sent_${String(seq)}`;
  };

  const imV1 = app.client.im.v1 as {
    messageReaction: Record<string, unknown>;
    message: Record<string, unknown>;
    image: Record<string, unknown>;
    file: Record<string, unknown>;
  };
  imV1.messageReaction = {
    create: () => Promise.resolve({ code: 0, data: { reaction_id: 'r_1' } }),
    delete: () => Promise.resolve({ code: 0, data: {} }),
  };
  imV1.image = {
    create: () => {
      records.uploadCalls += 1;
      return Promise.resolve({ image_key: 'img_stub' });
    },
  };
  imV1.file = {
    create: () => {
      records.uploadCalls += 1;
      return Promise.resolve({ file_key: 'file_stub' });
    },
  };
  imV1.message = {
    reply: (input: { path: { message_id: string }; data: { msg_type: string; content: string } }) => {
      if (failLeft > 0) {
        failLeft -= 1;
        return Promise.reject(new Error('network timeout simulation'));
      }
      const parsed = JSON.parse(input.data.content) as { text?: string };
      records.textCalls.push({ chatId: '', text: parsed.text ?? '', replyToId: input.path.message_id });
      return Promise.resolve({ code: 0, data: { message_id: nextId() } });
    },
    create: (input: { data: { receive_id: string; msg_type: string; content: string } }) => {
      const parsed = JSON.parse(input.data.content) as { text?: string };
      records.textCalls.push({ chatId: input.data.receive_id, text: parsed.text ?? '' });
      return Promise.resolve({ code: 0, data: { message_id: nextId() } });
    },
  };

  const chats = new Map<string, string>([['ou_owner', '老板'], ['ou_guest', '访客']]);
  inside.chats.set('oc_chat_1', { name: '测试群', members: chats, at: Date.now() });

  return {
    triggerInbound: (data: unknown) => inside.inbound.onMessage(appId, data),
  };
}


/** 等待条件满足，最多 3 秒。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;

    await Bun.sleep(10);
  }
  throw new Error('等待超时：条件未在 3 秒内成立');
}


test('1. legacy_auto 兼容与回执语义隔离：bots.receive 照常自动发 row.reply，v1 accepted 不混 acceptResult', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-legacy-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_0123456789abcdef';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '助手' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '助手' }],
  });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});

  ctx.on('session/before-model', (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    let said = '';
    if (last?.role === 'user') {
      said = piAi.contentText(last.content);
    }
    request.answer = piAi.fauxAssistantMessage(`自动回复：${said}`);
  });

  const sent: string[] = [];
  ctx.bots.channel('legacy', (reply) => {
    sent.push(reply);
    return { status: 'accepted', reason: '' };
  });

  await ctx.bots.receive('legacy', '助手', '你好老渠道', { customer: 'legacy:u1' });
  await waitFor(() => sent.includes('自动回复：你好老渠道'));

  //M acceptResult 返回的是 queued / duplicate，与渠道 v1 accepted → v2 sent 严格分开。
  const front = ctx.sessions.find({ kind: 'front', customer: 'legacy:u1' })[0];
  expect(front).toBeDefined();
  const receipt = ctx.frontDesk.acceptResult({
    key: 'work:w1:1',
    sessionId: front?.id ?? '',
    source: { type: 'work', id: 'w1' },
    payload: { text: '后台报告', files: [] },
  }, () => undefined);
  expect(receipt.status).toBe('queued');
  await waitFor(() => sent.some((item) => item.includes('后台报告')));
  const normalized = botsPlugin.normalizeLegacyReceipt('accepted', '', {
    replyRequestKey: 'rk',
    replyRoundKey: 'rrk',
    replyIndex: 0,
    kind: 'final',
  });
  expect(normalized.status).toBe('sent');
});


test('2. 单飞书账号单机器人：channel/message → claim 去重 → channel_reply 纯文字不解释 @path → 幂等与冲突校验', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-feishu-single-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  //M 在磁盘创建一个真实存在的文件，验证 channel_reply 纯文字发送不会把它当附件上传。
  const sampleFile = path.join(root, 'secret.txt');
  fs.writeFileSync(sampleFile, 'not-an-attachment', 'utf8');

  const appId = 'cli_1111222233334444';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '周小灵' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '周小灵' }],
  });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
  });
  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const records: FeishuCallRecord = { textCalls: [], uploadCalls: 0 };
  const stub = stubFeishuClient(feishu, appId, records, { botOpenId: 'ou_bot' });

  //M 假模型：第一步调用 channel_reply 并故意在 text 里包含 @真实文件路径；收到工具结果后收尾只输出普通助手文本（验证不自动发送）。
  const toolResults: string[] = [];
  ctx.on('session/before-model', (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      const txt = piAi.contentText(last.content);
      toolResults.push(txt);
      request.answer = piAi.fauxAssistantMessage('这是内部总结草稿，绝不能自动发给用户');
      return;
    }
    const call = piAi.fauxToolCall('channel_reply', { text: `纯文字包含 @${sampleFile} 请原样保留` });
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
  });

  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_in_1',
      chat_id: 'oc_p2p_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我查一下' }),
    },
  });

  await waitFor(() => toolResults.length >= 1 && ctx.sessions.find({ kind: 'front' })[0]?.state === 'done');
  //M 只发出一条含字面 @路径 的纯文字，没有上传文件，也没有自动发内部草稿。
  expect(records.uploadCalls).toBe(0);
  expect(records.textCalls).toHaveLength(1);
  expect(records.textCalls[0]?.text).toContain(`@${sampleFile}`);
  expect(records.textCalls.some((item) => item.text.includes('内部总结草稿'))).toBe(false);

  const receipt = JSON.parse(toolResults[0] ?? '{}') as channels.ReplyReceipt;
  expect(receipt.v).toBe(2);
  expect(receipt.status).toBe('sent');
  expect(receipt.messageIds?.length).toBe(1);

  //M 同条消息飞书重推不会再次触发模型或发第二条消息。
  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_in_1',
      chat_id: 'oc_p2p_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我查一下' }),
    },
  });
  await Bun.sleep(30);
  expect(records.textCalls).toHaveLength(1);

  //M 同 replyRequestKey 同正文幂等返回同一回执；同键改内容报错 reply_conflict。
  const roundKey = channels.getReplyRoundKey(JSON.stringify(['feishu', appId, 'om_in_1']), '周小灵', 'receive');
  const reqKey = receipt.replyRequestKey;
  const frontMeta = ctx.sessions.find({ kind: 'front' })[0];
  const snapshot = frontMeta?.resultQueue?.[0]?.payload.sourceSnapshot;
  expect(snapshot).toBeDefined();
  if (snapshot !== undefined) {
    const partsSame: channels.ReplyPartInput[] = [{ partId: 'text:0', kind: 'text', text: `纯文字包含 @${sampleFile} 请原样保留` }];
    const idem = await channels.requestChannelReply(ctx, {
      channel: 'feishu',
      bot: '周小灵',
      replyRequestKey: reqKey,
      replyRoundKey: roundKey,
      replyIndex: 0,
      kind: 'final',
      mode: 'text',
      sourceSnapshot: snapshot,
      payloadHash: channels.getPayloadHash({ kind: 'final', mode: 'text', parts: partsSame }),
      parts: partsSame,
    });
    expect(idem.status).toBe('sent');
    expect(records.textCalls).toHaveLength(1);

    const partsDiff: channels.ReplyPartInput[] = [{ partId: 'text:0', kind: 'text', text: '窜改内容' }];
    const conflict = await channels.requestChannelReply(ctx, {
      channel: 'feishu',
      bot: '周小灵',
      replyRequestKey: reqKey,
      replyRoundKey: roundKey,
      replyIndex: 0,
      kind: 'final',
      mode: 'text',
      sourceSnapshot: snapshot,
      payloadHash: channels.getPayloadHash({ kind: 'final', mode: 'text', parts: partsDiff }),
      parts: partsDiff,
    });
    expect(conflict.status).toBe('rejected');
    expect(conflict.reason).toContain('reply_conflict');
  }
});


test('3. 多机器人独立认领与 approval 仅消费一次：同条消息两个机器人分别建会话，同意 N 只批准一次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-multibot-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_aaaa1111bbbb2222';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '助手A' }, { name: '助手B' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '助手A', bots: ['助手B'] }],
  });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(approvalModule, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
  });

  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const records: FeishuCallRecord = { textCalls: [], uploadCalls: 0 };
  const stub = stubFeishuClient(feishu, appId, records, { botOpenId: 'ou_bot' });

  const repliedBots: string[] = [];
  ctx.on('session/before-model', (request) => {
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      repliedBots.push(request.session.row.bot);
      request.answer = piAi.fauxAssistantMessage('done');
      return;
    }
    const call = piAi.fauxToolCall('channel_reply', { text: `${request.session.row.bot} 收到` });
    request.answer = piAi.fauxAssistantMessage([call], { stopReason: 'toolUse' });
  });

  //M 私聊下同一应用的 targetBots 包含 ['助手A', '助手B']，两者各自认领进自己的前台会话并各自回复。
  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_multi_1',
      chat_id: 'oc_p2p_multi',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '大家一起看下' }),
    },
  });
  await waitFor(() => repliedBots.includes('助手A') && repliedBots.includes('助手B'));
  expect(ctx.sessions.find({ kind: 'front', bot: '助手A' })).toHaveLength(1);
  expect(ctx.sessions.find({ kind: 'front', bot: '助手B' })).toHaveLength(1);
  expect(records.textCalls).toHaveLength(2);

  //M approval 待确认：群/私聊发“同意 1”经 channel/message 只批一次、只发一条确认、不进任何一个机器人会话。
  const pending = ctx.approval.ask({
    kind: 'exec',
    title: '执行测试命令',
    detail: 'echo hi',
    payload: {},
    bot: '助手A',
  });
  let decidedCount = 0;
  ctx.on('approval/decided', () => {
    decidedCount += 1;
  });
  const prevModelCount = repliedBots.length;
  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_approve_1',
      chat_id: 'oc_p2p_multi',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: `同意 ${String(pending.id)}` }),
    },
  });
  await Bun.sleep(40);
  expect(decidedCount).toBe(1);
  expect(repliedBots.length).toBe(prevModelCount);
  expect(records.textCalls.filter((item) => item.text.includes('已同意待确认'))).toHaveLength(1);
});


test('5. 零次回复兜底：0 次调用只触发一次“你还没调用回复工具”，progress 或调用失败不触发，新消息排队不串轮', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-fallback-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  const appId = 'cli_9999000011112222';
  await ctx.plugin(FakeResources, {
    root,
    bots: [{ name: '小兜' }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot: '小兜' }],
  });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(feishuModule, {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
  });

  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const records: FeishuCallRecord = { textCalls: [], uploadCalls: 0 };
  const stub = stubFeishuClient(feishu, appId, records, { botOpenId: 'ou_bot', failReplyOnce: true });

  //M 场景 A：第 1 轮不调回复工具，只直接说普通文字；期待下一轮 system 收到精确提示“你还没调用回复工具”，
  //M        并且修复轮持有同一 activeKey 期间并发进来的第 2 条用户消息老实排队不抢先跑；
  //M        修复轮首次调 channel_reply（故意遇到 1 次网络失败）也记为已调，不再开第 3 轮；
  //M        同时系统提醒正文不作为用户往来交给 memory，也不进 user 消息历史。
  let scenario: 'zero_then_fail' | 'progress_only' | 'still_zero' = 'zero_then_fail';
  const systemSeen: string[][] = [];
  const recordedFrontText: string[] = [];
  ctx.on('memory/front-message', (message) => {
    recordedFrontText.push(message.text);
  });
  let concurrentInjected = false;

  ctx.on('session/before-model', (request) => {
    systemSeen.push([...request.system]);
    const hasReminder = request.system.includes('你还没调用回复工具');
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    if (last?.role === 'toolResult') {
      request.answer = piAi.fauxAssistantMessage('调用完成');
      return;
    }

    if (scenario === 'zero_then_fail') {
      const hasQueuedInMsgs = request.messages.some((m) => m.role === 'user' && piAi.contentText(m.content).includes('第2条排队消息'));
      const lastUser = request.messages.findLast((m) => m.role === 'user');
      const isQueuedRound = lastUser !== undefined && piAi.contentText(lastUser.content).includes('第2条排队消息');
      if (hasReminder) {
        expect(hasQueuedInMsgs).toBe(false);
      }
      if (isQueuedRound) {
        const queuedCall = piAi.fauxToolCall('channel_reply', { text: '第2条正常回复' });
        request.answer = piAi.fauxAssistantMessage([queuedCall], { stopReason: 'toolUse' });
        return;
      }
      if (!hasReminder) {
        if (!concurrentInjected) {
          concurrentInjected = true;
          //M 在模型尚未结束时推入下一条用户消息，它必须等修复轮结束后才运行。
          setTimeout(() => {
            void stub.triggerInbound({
              sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
              message: {
                message_id: 'om_fb_queued',
                chat_id: 'oc_p2p_fb',
                chat_type: 'p2p',
                message_type: 'text',
                content: JSON.stringify({ text: '第2条排队消息' }),
              },
            });
          }, 0);
        }
        request.answer = piAi.fauxAssistantMessage('模型忘记调回复工具的普通回答');
        return;
      }
      const failCall = piAi.fauxToolCall('channel_reply', { text: '补发回复' });
      request.answer = piAi.fauxAssistantMessage([failCall], { stopReason: 'toolUse' });
      return;
    }

    if (scenario === 'progress_only') {
      const progressCall = piAi.fauxToolCall('channel_reply', { text: '正在查，请稍等', kind: 'progress' });
      request.answer = piAi.fauxAssistantMessage([progressCall], { stopReason: 'toolUse' });
      return;
    }

    request.answer = piAi.fauxAssistantMessage('仍然忘记调工具');
  });

  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_fb_1',
      chat_id: 'oc_p2p_fb',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '第一条消息' }),
    },
  });

  await waitFor(() => {
    const front = ctx.sessions.find({ kind: 'front' })[0];
    return front !== undefined && front.state === 'done' && front.activeKey === undefined && (front.resultQueue?.length ?? 0) >= 2;
  });

  //M 第 1 轮触发且仅触发 1 次带精准文本的修复轮，总共有且只有 1 次修复注入。
  const reminderSteps = systemSeen.filter((arr) => arr.includes('你还没调用回复工具'));
  expect(reminderSteps).toHaveLength(1);

  //M 确保修复提示只出现于系统提示，不作为前台往来归档。
  const frontSession = ctx.sessions.open(ctx.sessions.find({ kind: 'front' })[0]!.id);
  const fakeUsers = frontSession.row.messages.filter((m) => m.role === 'user' && piAi.contentText(m.content).includes('你还没调用回复工具'));
  expect(fakeUsers).toHaveLength(0);
  expect(recordedFrontText.some((text) => text.includes('第2条排队消息'))).toBe(true);
  expect(recordedFrontText.some((text) => text.includes('你还没调用回复工具'))).toBe(false);

  //M 第 1 项因为修复轮调用过 channel_reply（虽然第一次网络失败）收尾标记为 uncertain，不再二次修复。
  const item1 = frontSession.row.resultQueue?.find((item) => item.key.includes('om_fb_1'));
  expect(item1?.replyControl?.reminder).toBe('used');
  expect(item1?.stage).toBe('uncertain');

  //M 场景 B：只调用 channel_reply(kind: 'progress') → 本轮已调用 1 次，不触发零次兜底。
  scenario = 'progress_only';
  const beforeReminderCount = reminderSteps.length;
  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_fb_progress',
      chat_id: 'oc_p2p_fb',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '只发进度' }),
    },
  });
  await waitFor(() => frontSession.row.state === 'done' && frontSession.row.activeKey === undefined);
  await Bun.sleep(40);
  expect(systemSeen.filter((arr) => arr.includes('你还没调用回复工具'))).toHaveLength(beforeReminderCount);
  expect(records.textCalls.some((item) => item.text === '正在查，请稍等')).toBe(true);

  //M 场景 C：第 1 轮与唯一 1 次修复轮都 0 次调用 → 最多跑 1 次修复，收尾标 missing_reply（rejected），不自动发送 row.reply。
  scenario = 'still_zero';
  await stub.triggerInbound({
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: 'om_fb_missing',
      chat_id: 'oc_p2p_fb',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '两次都没调' }),
    },
  });
  await waitFor(() => {
    const item = frontSession.row.resultQueue?.find((one) => one.key.includes('om_fb_missing'));
    return item?.replyControl?.reminder === 'used' && frontSession.row.activeKey === undefined;
  });
  const missingItem = frontSession.row.resultQueue?.find((one) => one.key.includes('om_fb_missing'));
  expect(missingItem?.replyControl?.outcome).toBe('missing_reply');
  expect(missingItem?.stage).toBe('rejected');
  expect(records.textCalls.some((item) => item.text.includes('仍然忘记调工具'))).toBe(false);
});


test('6. 重放同一前台归档事件只写一条往来和一份正文', async () => {
  //M 复用离线渠道夹具，把真实前台事件接到内存归档。
  const tempDir = os.tmpdir();
  const prefix = path.join(tempDir, 'ch-front-archive-');
  const root = fs.mkdtempSync(prefix);
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  const bot = '助手';
  const appId = 'cli_1111222233334444';
  const resourceOptions: FakeResourceOptions = {
    root,
    bots: [{ name: bot }],
    feishuApps: [{ app_id: appId, app_secret: 'sec', bot }],
  };
  await ctx.plugin(FakeResources, resourceOptions);
  const db = ctx.resources.db;
  closers.push(() => db.close());
  closers.push(() => ctx.fiber.dispose());
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  const botsOptions = {};
  await ctx.plugin(botsPlugin, botsOptions);
  const feishuOptions = {
    domain: 'http://127.0.0.1:9',
    people: [{ open_id: 'ou_owner', name: '老板', owner: true }],
  };
  await ctx.plugin(feishuModule, feishuOptions);
  const feishu = ctx.get('feishu') as feishuModule.Feishu;
  const records: FeishuCallRecord = { textCalls: [], uploadCalls: 0 };
  const stubOptions = { botOpenId: 'ou_bot' };
  const stub = stubFeishuClient(feishu, appId, records, stubOptions);
  const index = new channelIndexModule.ChannelIndex(db);
  const archive = new frontArchiveModule.FrontArchive(db, index);
  const events: frontArchiveModule.FrontMessage[] = [];
  const writes: boolean[] = [];
  ctx.on('memory/front-message', (entry) => {
    //G 此处只数本次要重放的用户往来。
    if (entry.who !== 'user') return;

    //M 归档使用生产实现，记录首次保存和重放的结果。
    events.push(entry);
    const saved = archive.record(entry);
    writes.push(saved);
  });
  ctx.on('session/before-model', (request) => {
    //M 用假模型回复，让这轮会话走完，避免发网络请求。
    const last = request.messages.at(-1);
    const summary = '已完成';
    if (last?.role === 'toolResult') {
      request.answer = piAi.fauxAssistantMessage(summary);
      return;
    }

    const reply = { text: summary };
    const call = piAi.fauxToolCall('channel_reply', reply);
    const stop = { stopReason: 'toolUse' } as const;
    request.answer = piAi.fauxAssistantMessage([call], stop);
  });

  //M 从飞书标准入口发来用户消息，核对前台归档沿用渠道消息号。
  const nativeId = 'om_front_archive';
  const text = '应只归档一次的用户消息';
  const incoming = {
    sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
    message: {
      message_id: nativeId,
      chat_id: 'oc_p2p_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
  await stub.triggerInbound(incoming);
  const filter = { kind: 'front' } as const;
  const isDone = () => ctx.sessions.find(filter)[0]?.state === 'done';
  await waitFor(isDone);
  expect(events).toHaveLength(1);
  const [entry] = events;
  if (entry === undefined) throw new Error('未收到前台归档事件');

  const messageId = channels.makeChannelMessageId('feishu', appId, nativeId);
  expect(entry.sourceKey).toBe(messageId);

  //M 在归档入口重放，直接验证归档去重，避免渠道认领层先丢掉重放。
  ctx.emit('memory/front-message', entry);
  expect(writes).toEqual([true, false]);
  const query: frontArchiveModule.FrontQuery = {
    bot,
    sessionIds: [entry.sessionId],
    order: 'first',
    limit: 10,
  };
  const history = archive.read(query);
  expect(history).toHaveLength(1);
  expect(history[0]?.text).toBe(text);

  //M 核对索引正文也只有一份，避免只有会话关联去重。
  const sql = 'SELECT text FROM memory_channel_messages';
  const statement = db.query(sql);
  const indexRows = statement.all();
  expect(indexRows).toEqual([{ text }]);
});
