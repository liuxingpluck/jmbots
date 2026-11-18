/**
 * 命令行渠道接入 channel/message 后的离线测试（渠道统一第 2 步）：
 *   1. 输入一句命令行话 → 先落盘 channels/cli/<日期>.jsonl，channel/message 只发 1 次，目标机器人只认领 1 次，
 *      前台一次 channel_reply 都没调时，零次兜底（routing.autoFinal）把最后的话打印到终端；
 *   2. 同客户会话发起待确认后发“同意 1” → channel/message 只发 1 次，approval 只消费 1 次，
 *      确认正文只通过 channel/reply 打出 1 次，不触发模型轮次。
 *
 * 跑法：bun test ./src7/plugins/cli/Cli.test.ts
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import type * as channels from '../../Channels.ts';
import * as sessionsModule from '../../Sessions.ts';
import * as toolsModule from '../../Tools.ts';
import * as approvalModule from '../approval/index.ts';
import * as botsPlugin from '../bots/index.ts';
import * as workspacesPlugin from '../workspaces/index.ts';
import { Cli } from './index.ts';


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

  dir(...parts: string[]): string {
    const full = path.join(this.root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  getModel(): { input: string[] } {
    return { input: ['text'] };
  }
}


/** 等待条件满足，最多 3 秒。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;

    await Bun.sleep(10);
  }
  throw new Error('等待超时：条件未在 3 秒内成立');
}


test('cli 收到输入：channel/message 只发 1 次、目标机器人认领 1 次，零次回复把最后的话打到终端并消费一次“同意 1”', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-channel-'));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = new cordis.Context();
  closers.push(() => ctx.fiber.dispose());

  await ctx.plugin(FakeResources, { root, bots: [{ name: '助手' }, { name: '备选' }] });
  await ctx.plugin(toolsModule.Tools);
  await ctx.plugin(sessionsModule.Sessions);
  await ctx.plugin(workspacesPlugin);
  await ctx.plugin(botsPlugin, {});
  await ctx.plugin(approvalModule, { thinking: 'low', decision_pass: 0.8 });

  const lines: string[] = [];
  const exits: number[] = [];
  const cli = new Cli(ctx, {
    exit: (code) => { exits.push(code); },
    write: (line) => { lines.push(line); },
  });

  //M 记录 channel/message 发出次数、目标与模型被调次数。
  const channelEvents: channels.ChannelMessage[] = [];
  ctx.on('channel/message', (message) => {
    channelEvents.push(message);
  });

  let modelRuns = 0;
  ctx.on('session/request', (request) => {
    modelRuns += 1;
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');
    let said = '';
    if (last?.role === 'user') {
      said = piAi.contentText(last.content);
    }
    request.answer = piAi.fauxAssistantMessage(`命令行回：${said}`);
  });

  const firstControl = await cli.submitLine('助手', '查一下今天日程');
  expect(channelEvents).toHaveLength(1);
  expect(channelEvents[0]?.channel).toBe('cli');
  expect(channelEvents[0]?.targetBots).toEqual(['助手']);
  expect(channelEvents[0]?.origin.address).toEqual({ customer: 'cli:本机' });
  expect(firstControl.claims).toHaveLength(1);
  expect(firstControl.claims[0]?.status).toBe('claimed');

  await waitFor(() => lines.some((line) => line.includes('命令行回：查一下今天日程')));
  expect(modelRuns).toBe(1);

  //M 验证原始输入已落盘 channels/cli/*.jsonl。
  const cliDir = path.join(root, 'channels', 'cli');
  const files = fs.readdirSync(cliDir);
  expect(files.length).toBe(1);
  expect(fs.readFileSync(path.join(cliDir, files[0]!), 'utf8')).toContain('查一下今天日程');

  //M 从这台命令行前台会话发起一条待确认，再发“同意 1”验证只发送与只消费各 1 次。
  const front = ctx.sessions.find({ bot: '助手', kind: 'front', customer: 'cli:本机' })[0];
  expect(front).toBeDefined();
  let decidedState = '';
  ctx.on('approval/decided', (pending) => {
    decidedState = pending.state;
  });
  const pending = ctx.approval.ask({
    kind: 'exec',
    title: '执行测试脚本',
    detail: 'echo hi',
    payload: {},
    bot: '助手',
    session: front?.id,
  });

  const approvalControl = await cli.submitLine('助手', `同意 ${String(pending.id)}`);
  expect(channelEvents).toHaveLength(2);
  expect(approvalControl.approvalHandled).toBe(true);
  expect(approvalControl.claims).toHaveLength(0);
  expect(decidedState).toBe('approved');
  expect(modelRuns).toBe(1);
  expect(lines.filter((line) => line.includes(`已同意待确认 #${String(pending.id)}`))).toHaveLength(1);
  expect(exits).toHaveLength(0);
});
