/**
 * 微信渠道接入 channel/message 后的端到端离线验证（渠道统一第 2 步）：
 *   1. 首轮存量只存不发；第二轮监听私聊来 1 条新消息 → 先存 wechat_messages，channel/message 只发 1 次，
 *      目标机器人只认领 1 次，前台没调 channel_reply 时零次兜底把最后的话落进 wechat_outbox（draft）；
 *   2. 同一微信客户前台会话发起待确认后发“同意 1” → channel/message 只发 1 次，approval 只消费 1 次，
 *      确认正文只通过 channel/reply 落入 wechat_outbox 1 条，不再触发模型轮次。
 *
 * 跑法：bun test ./src7/plugins/wechat/ChannelMessage.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as channels from '../channels/index.ts';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as approvalModule from '../approval/index.ts';
import * as rules from '../approval/Rules.ts';
import * as botsPlugin from '../bots/index.ts';
import * as workspacesPlugin from '../workspaces/index.ts';
import { Wechat, checkConfig } from './index.ts';
import type { ChatItem, RawMessage, SyncResult } from './read/Reader.ts';


//M 每个测例后自动清理临时目录和插件。
const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});


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

  constructor(ctx: cordis.Context, options: { root: string; bots: Array<{ name: string }> }) {
    super(ctx, 'resources');
    this.root = options.root;
    this.raw = { bots: options.bots };
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


/** 构造一条测试用微信原始消息。 */
function makeMsg(id: number, at: number, text: string): RawMessage {
  return {
    source: 'm0',
    local_id: id,
    local_type: 1,
    create_time: at,
    from_self: false,
    at_me: false,
    view: { kind: 'text', text, sender: '' },
  };
}


/** 等待条件成立，最多 3 秒。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;

    await Bun.sleep(10);
  }
  throw new Error('等待超时：条件未在 3 秒内成立');
}


test('wechat 监听新消息：先存表再发 1 次 channel/message、认领 1 次，零次回复把最后的话落草稿并消费一次“同意 1”', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-channel-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeResources, { root, bots: [{ name: '助手' }] });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(approvalModule, { thinking: 'low', decision_pass: 0.8 });

  const wechat = new Wechat(ctx, checkConfig(ctx, { bot: '助手', interval_ms: 0, send: false }));
  wechat.approval = ctx.approval;

  //M 记录发出的 channel/direct（私聊）、channel/mention（群里 @我）与认领、模型执行次数。
  const emitted: Array<{ message: channels.ChannelMessage; control: channels.ChannelMessageControl | undefined }> = [];
  const record = (message: channels.ChannelMessage, control?: channels.ChannelMessageControl): void => {
    emitted.push({ message, control });
  };
  ctx.on('channel/direct', record);
  ctx.on('channel/mention', record);

  let modelRuns = 0;
  //M 记下模型这一步拿到的工具名（本监听在 approval 之后挂，看到的是已按说话人过滤的清单）。
  let toolNames: string[] = [];
  ctx.on('session/before-model', (request) => {
    modelRuns += 1;
    toolNames = request.tools.map((tool) => tool.name);
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    let said = '';
    if (last?.role === 'user') {
      said = piAi.contentText(last.content);
    }
    request.answer = piAi.fauxAssistantMessage(`微信草稿：${said}`);
  });

  ctx.resources.db.query('INSERT INTO wechat_watch VALUES (?, ?, ?, 0, NULL)').run('acc1', 'wxid_c1', '老客户');

  let chats: ChatItem[] = [
    { username: 'wxid_c1', chat: '老客户', is_group: false, unread: 0, last_message: '', timestamp: 100 },
  ];
  let batch: Record<string, RawMessage[]> = {
    wxid_c1: [makeMsg(1, 100, '旧存量')],
  };
  wechat.reader.accounts = () => [{ id: 'acc1', nickname: '', wxid: '' }];
  wechat.reader.sessions = async () => chats;
  wechat.reader.syncBatch = async (_acc, list): Promise<SyncResult[]> => list.map((item) => ({
    chat: item.chat,
    missing: false,
    is_group: false,
    messages: batch[item.chat] ?? [],
  }));
  wechat.reader.backfill = async (_acc, chat): Promise<SyncResult> => ({
    chat,
    missing: false,
    messages: [],
  });

  //G 第一轮存量只存不发 channel/message。
  await wechat.poll();
  expect(emitted).toHaveLength(0);

  //M 第二轮来 1 条新消息：先写 wechat_messages，再发 1 次 channel/message 并认领 1 次，零次兜底写入草稿箱。
  chats = chats.map((item) => ({ ...item, timestamp: 200 }));
  batch = { wxid_c1: [makeMsg(2, 200, '在吗问个价格')] };
  await wechat.poll();

  const saved = ctx.resources.db.query("SELECT text FROM wechat_messages WHERE chat = 'wxid_c1' AND local_id = 2").get() as { text: string } | null;
  expect(saved?.text).toBe('在吗问个价格');
  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.message.channel).toBe('wechat');
  expect(emitted[0]?.message.targetBots).toEqual(['助手']);
  expect(emitted[0]?.control?.claims).toHaveLength(1);
  expect(emitted[0]?.control?.claims[0]?.status).toBe('claimed');

  await waitFor(() => {
    const out = ctx.resources.db.query('SELECT text, state FROM wechat_outbox').all() as Array<{ text: string; state: string }>;
    return out.length >= 1;
  });
  expect(modelRuns).toBe(1);
  const firstOut = ctx.resources.db.query('SELECT text, state FROM wechat_outbox ORDER BY id').all() as Array<{ text: string; state: string }>;
  expect(firstOut).toEqual([{ text: '微信草稿：在吗问个价格', state: 'draft' }]);

  //G 微信联系人起的会话按外人算：说话人档位是 guest，工具清单里只剩只读白名单的工具。
  const guestFront = ctx.sessions.find({ bot: '助手', kind: 'front', customer: 'wechat:wxid_c1' })[0];
  expect(guestFront?.address).toMatchObject({ chat: 'wxid_c1', owner: false });
  expect(channels.getSpeakerRole(guestFront?.address)).toBe('guest');
  expect(channels.isOwnerTurn('wechat', guestFront?.address)).toBe(false);
  expect(toolNames.length).toBeGreaterThan(0);
  expect(toolNames.filter((name) => !rules.READ_ONLY_TOOLS.has(name))).toEqual([]);

  //M 从同一微信客户前台会话发起待确认，再从微信发“同意 1”：channel/message 只发 1 次，approval 只消费 1 次。
  const front = ctx.sessions.find({ bot: '助手', kind: 'front', customer: 'wechat:wxid_c1' })[0];
  expect(front).toBeDefined();
  let decidedState = '';
  ctx.on('approval/decided', (pending) => {
    decidedState = pending.state;
  });
  const pending = ctx.approval.ask({
    kind: 'exec',
    title: '给微信客户查账单',
    detail: 'check',
    payload: {},
    bot: '助手',
    session: front?.id,
  });

  chats = chats.map((item) => ({ ...item, timestamp: 300 }));
  batch = { wxid_c1: [makeMsg(3, 300, `同意 ${String(pending.id)}`)] };
  await wechat.poll();

  expect(emitted).toHaveLength(2);
  expect(emitted[1]?.control?.approvalHandled).toBe(true);
  expect(emitted[1]?.control?.claims).toHaveLength(0);
  expect(decidedState).toBe('approved');
  expect(modelRuns).toBe(1);

  const allOut = ctx.resources.db.query('SELECT text, state FROM wechat_outbox ORDER BY id').all() as Array<{ text: string; state: string }>;
  expect(allOut).toHaveLength(3);
  expect(allOut.every((row) => row.state === 'draft')).toBe(true);
  expect(allOut.filter((row) => row.text.includes(`已同意待确认 #${String(pending.id)}`))).toHaveLength(1);
});
