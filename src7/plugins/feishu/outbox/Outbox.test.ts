/**
 * 飞书发件箱（Outbox.ts）离线单测：
 * 1. 单份 .md 发送失败时自动移入 failed/ 隔离，绝不阻断同批后续文件投递，也绝不下一轮死循环卡住；
 * 2. 支持文件头（app_id / bot / chat_id）与插件配置（config.outbox）多应用路由；
 * 3. 无文件头的普通 .md 保持原有兼容（自动选已有私聊记录的应用投递）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import * as cordis from 'cordis';
import type { Feishu, FeishuAddress } from '../index.ts';
import * as outboxModule from './Outbox.ts';


const tempDirs: string[] = [];

function makeTempDirs(): outboxModule.OutboxDirs {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-outbox-'));
  tempDirs.push(base);
  const outbox = path.join(base, 'outbox');
  const sent = path.join(base, 'sent');
  const failed = path.join(base, 'failed');
  fs.mkdirSync(outbox, { recursive: true });
  fs.mkdirSync(sent, { recursive: true });
  fs.mkdirSync(failed, { recursive: true });
  return { outbox, sent, failed };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d !== undefined) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});


describe('Feishu Outbox 单份失败隔离与多应用路由', () => {
  test('第 1 份发送报错时移入 failed/ 不阻塞同批第 2、3 份，且支持文件头按 bot / app_id / chat_id 路由', async () => {
    const dirs = makeTempDirs();
    const ctx = new cordis.Context();
    const delivered: { appId: string; chatId: string; text: string }[] = [];

    const p2pMap = new Map<string, FeishuAddress>([
      ['cli_app2', { appId: 'cli_app2', chatId: 'oc_p2p_2', messageId: 'om_2', openId: 'ou_owner', chatType: 'p2p' }],
    ]);
    const fakeFeishu = {
      config: {
        apps: [
          { appId: 'cli_app1', appSecret: 's1', bot: 'BotOne' },
          { appId: 'cli_app2', appSecret: 's2', bot: 'BotTwo', bots: ['BotTwo', 'SharedBot'] },
        ],
        groups: new Map([['oc_group_99', { chatId: 'oc_group_99' }]]),
      },
      apps: new Map([
        ['cli_app1', { config: { appId: 'cli_app1', bot: 'BotOne' } }],
        ['cli_app2', { config: { appId: 'cli_app2', bot: 'BotTwo' } }],
      ]),
      chats: new Map(),
      lastPrivate: (appId?: string) => p2pMap.get(appId ?? 'cli_app1'),
      sendText: async (addr: FeishuAddress, text: string) => {
        if (text.includes('TRIGGER_SEND_ERROR')) {
          throw new Error('模拟网络闪断');
        }
        delivered.push({ appId: addr.appId, chatId: addr.chatId, text });
        return { status: 'accepted' as const, reason: '', messageId: 'om_out' };
      },
    } as unknown as Feishu;

    // 01_bad_app.md：指定了尚未私聊过的 cli_app1 -> 失败移入 failed/
    fs.writeFileSync(
      path.join(dirs.outbox, '01_bad_app.md'),
      '---\napp_id: cli_app1\n---\n没人私聊过第一个应用',
      'utf8',
    );
    // 02_send_err.md：发送中途抛错 -> 失败移入 failed/
    fs.writeFileSync(
      path.join(dirs.outbox, '02_send_err.md'),
      '---\nbot: BotTwo\n---\nTRIGGER_SEND_ERROR',
      'utf8',
    );
    // 03_plain_auto.md：无文件头，自动选中已有私聊记录的 cli_app2 投递成功！
    fs.writeFileSync(
      path.join(dirs.outbox, '03_plain_auto.md'),
      '普通无头通知正文',
      'utf8',
    );
    // 04_group_route.md：文件头按共享机器人名 + 指定群 chat_id 精准投递！
    fs.writeFileSync(
      path.join(dirs.outbox, '04_group_route.md'),
      '---\nbot: SharedBot\nchat_id: oc_group_99\n---\n群内主动播报',
      'utf8',
    );

    const outcome = await outboxModule.scanOutboxOnce(fakeFeishu, ctx, dirs);
    expect(outcome.failed).toEqual(['01_bad_app.md', '02_send_err.md']);
    expect(outcome.sent).toEqual(['03_plain_auto.md', '04_group_route.md']);

    // outbox 已清空，下一轮不会死循环卡住
    expect(fs.readdirSync(dirs.outbox)).toEqual([]);
    expect(fs.readdirSync(dirs.failed).sort()).toEqual(['01_bad_app.md', '02_send_err.md']);
    expect(fs.readdirSync(dirs.sent).sort()).toEqual(['03_plain_auto.md', '04_group_route.md']);

    expect(delivered).toEqual([
      { appId: 'cli_app2', chatId: 'oc_p2p_2', text: '普通无头通知正文' },
      { appId: 'cli_app2', chatId: 'oc_group_99', text: '群内主动播报' },
    ]);

    await ctx.fiber.dispose();
  });

  test('支持 plugins.feishu.outbox 默认路由配置，文件头可按单文件覆盖', async () => {
    const dirs = makeTempDirs();
    const ctx = new cordis.Context();
    const delivered: { appId: string; chatId: string; text: string }[] = [];

    const fakeFeishu = {
      config: {
        apps: [
          { appId: 'cli_a', appSecret: 'sa', bot: 'Alpha' },
          { appId: 'cli_b', appSecret: 'sb', bot: 'Beta' },
        ],
        groups: new Map(),
        outbox: { bot: 'Beta', chatId: 'oc_default_ops' },
      },
      apps: new Map([
        ['cli_a', { config: { appId: 'cli_a', bot: 'Alpha' } }],
        ['cli_b', { config: { appId: 'cli_b', bot: 'Beta' } }],
      ]),
      chats: new Map(),
      lastPrivate: () => undefined,
      sendText: async (addr: FeishuAddress, text: string) => {
        delivered.push({ appId: addr.appId, chatId: addr.chatId, text });
        return { status: 'accepted' as const, reason: '', messageId: 'om_cfg' };
      },
    } as unknown as Feishu;

    fs.writeFileSync(path.join(dirs.outbox, '10_default.md'), '走默认配置目标', 'utf8');
    fs.writeFileSync(
      path.join(dirs.outbox, '20_override.md'),
      '---\napp_id: cli_a\nchat_id: oc_custom\n---\n单文件覆盖目标',
      'utf8',
    );

    const res = await outboxModule.scanOutboxOnce(fakeFeishu, ctx, dirs);
    expect(res.failed).toEqual([]);
    expect(res.sent).toEqual(['10_default.md', '20_override.md']);
    expect(delivered).toEqual([
      { appId: 'cli_b', chatId: 'oc_default_ops', text: '走默认配置目标' },
      { appId: 'cli_a', chatId: 'oc_custom', text: '单文件覆盖目标' },
    ]);

    await ctx.fiber.dispose();
  });

  test('发送成功但归档失败时记入内存 Set，本进程内后续轮询绝不重复发送，且不误移入 failed/', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-outbox-stuck-'));
    tempDirs.push(base);
    const outbox = path.join(base, 'outbox');
    const failed = path.join(base, 'failed');
    const brokenSent = path.join(base, 'sent-is-file');
    fs.mkdirSync(outbox, { recursive: true });
    fs.mkdirSync(failed, { recursive: true });
    //M 用普通文件冒充 sent 目录，确保 rename/copy 归档必定失败。
    fs.writeFileSync(brokenSent, 'not-a-directory', 'utf8');

    const ctx = new cordis.Context();
    const sentTexts: string[] = [];
    const fakeFeishu = {
      config: { apps: [{ appId: 'cli_a', appSecret: 'sa', bot: 'Alpha' }], groups: new Map() },
      apps: new Map([['cli_a', { config: { appId: 'cli_a', bot: 'Alpha' } }]]),
      chats: new Map(),
      lastPrivate: () => ({ appId: 'cli_a', chatId: 'oc_p2p', messageId: 'm1', openId: 'ou_1', chatType: 'p2p' }),
      sendText: async (_addr: FeishuAddress, text: string) => {
        sentTexts.push(text);
        return { status: 'accepted' as const, reason: '', messageId: 'om_1' };
      },
    } as unknown as Feishu;

    const dirs: outboxModule.OutboxDirs = { outbox, sent: brokenSent, failed };
    const sentUnarchived = new Set<string>();
    fs.writeFileSync(path.join(outbox, 'stuck.md'), '只应发一次的消息', 'utf8');

    const first = await outboxModule.scanOutboxOnce(fakeFeishu, ctx, dirs, sentUnarchived);
    expect(first.sent).toEqual(['stuck.md']);
    expect(first.failed).toEqual([]);
    expect(sentUnarchived.has('stuck.md')).toBe(true);
    expect(fs.readdirSync(failed)).toEqual([]);

    //M 第二轮扫描：文件仍在 outbox，但已被 sentUnarchived 拦截，绝不再重发。
    const second = await outboxModule.scanOutboxOnce(fakeFeishu, ctx, dirs, sentUnarchived);
    expect(second.sent).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(sentTexts).toEqual(['只应发一次的消息']);

    //M 人工移走卡滞文件后，集合自动清理，后续新放入同名文件可正常发送。
    fs.rmSync(path.join(outbox, 'stuck.md'), { force: true });
    await outboxModule.scanOutboxOnce(fakeFeishu, ctx, dirs, sentUnarchived);
    expect(sentUnarchived.has('stuck.md')).toBe(false);

    await ctx.fiber.dispose();
  });

  test('同名文件连续归档到 sent/ 或 failed/ 时自动加时间戳后缀，绝不覆盖旧文件', async () => {
    const dirs = makeTempDirs();
    const ctx = new cordis.Context();
    const fakeFeishu = {
      config: { apps: [{ appId: 'cli_a', appSecret: 'sa', bot: 'Alpha' }], groups: new Map() },
      apps: new Map([['cli_a', { config: { appId: 'cli_a', bot: 'Alpha' } }]]),
      chats: new Map(),
      lastPrivate: () => ({ appId: 'cli_a', chatId: 'oc_p2p', messageId: 'm1', openId: 'ou_1', chatType: 'p2p' }),
      sendText: async (_addr: FeishuAddress, text: string) => {
        if (text.includes('FAIL')) throw new Error('模拟失败');
        return { status: 'accepted' as const, reason: '', messageId: 'om_ok' };
      },
    } as unknown as Feishu;

    //M 连续两次发送同名 notice.md。
    fs.writeFileSync(path.join(dirs.outbox, 'notice.md'), '第一份通知', 'utf8');
    await outboxModule.scanOutboxOnce(fakeFeishu, ctx, dirs);
    fs.writeFileSync(path.join(dirs.outbox, 'notice.md'), '第二份通知', 'utf8');
    await outboxModule.scanOutboxOnce(fakeFeishu, ctx, dirs);

    const sentFiles = fs.readdirSync(dirs.sent).sort();
    expect(sentFiles).toHaveLength(2);
    const sentContents = sentFiles.map((file) => fs.readFileSync(path.join(dirs.sent, file), 'utf8')).sort();
    expect(sentContents).toEqual(['第一份通知', '第二份通知']);

    //M 连续两次失败同名 err.md。
    fs.writeFileSync(path.join(dirs.outbox, 'err.md'), 'FAIL_1', 'utf8');
    await outboxModule.scanOutboxOnce(fakeFeishu, ctx, dirs);
    fs.writeFileSync(path.join(dirs.outbox, 'err.md'), 'FAIL_2', 'utf8');
    await outboxModule.scanOutboxOnce(fakeFeishu, ctx, dirs);

    const failedFiles = fs.readdirSync(dirs.failed).sort();
    expect(failedFiles).toHaveLength(2);
    const failedContents = failedFiles.map((file) => fs.readFileSync(path.join(dirs.failed, file), 'utf8')).sort();
    expect(failedContents).toEqual(['FAIL_1', 'FAIL_2']);

    await ctx.fiber.dispose();
  });

  test('parseOutboxMarkdown：--- 块内未命中任何已知路由键时回退为全文正文，绝不误吞水平线内容', () => {
    const markdownRule = '---\n第一段正文\n---\n第二段正文';
    const parsedRule = outboxModule.parseOutboxMarkdown(markdownRule);
    expect(parsedRule.appId).toBeUndefined();
    expect(parsedRule.bot).toBeUndefined();
    expect(parsedRule.chatId).toBeUndefined();
    expect(parsedRule.body).toBe(markdownRule);

    const unknownMeta = '---\ntitle: 每日播报\nauthor: ops\n---\n具体内容';
    const parsedUnknown = outboxModule.parseOutboxMarkdown(unknownMeta);
    expect(parsedUnknown.body).toBe(unknownMeta);

    const validHeader = '---\nbot: Alpha\nchat_id: oc_1\n---\n真正正文';
    const parsedValid = outboxModule.parseOutboxMarkdown(validHeader);
    expect(parsedValid).toEqual({ bot: 'Alpha', chatId: 'oc_1', body: '真正正文' });
  });
});
