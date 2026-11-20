/** 验证独立聊天归档层的格式、稳定目录、重放与分卷。 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context } from 'cordis';
import * as archiveModule from './Archive.ts';
import * as listenModule from './ArchiveListen.ts';
import * as messageModule from './Message.ts';
import * as replyModule from './Reply.ts';


/** 只清理由当前测试创建的临时目录。 */
const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


/** 同一群的稳定聊天号，展示名可以变。 */
const chat: archiveModule.ArchiveChat = {
  channel: 'feishu',
  accountId: 'app',
  chatType: 'group',
  id: 'oc_test',
  name: '测试群',
};

/** 统一固定时间，使分卷文件名可直接比较。 */
const start = Date.UTC(2026, 10, 19, 10, 20, 30);


/** 将所有归档输出来到测试自己的隔离目录。 */
function getTestDir(): string {
  const prefix = path.join(import.meta.dirname, '.archive-test-');
  const directory = fs.mkdtempSync(prefix);
  tempDirs.push(directory);
  return directory;
}


/** 构造同一会话中的一条测试记录。 */
function getEntry(key: string, text: string): archiveModule.ArchiveEntry {
  return { key, at: start, senderId: 'ou_test', senderName: '甲', text, attachments: [] };
}


test('原话和相对附件路径原样入档，重启或聊天改名后回放只记一次', () => {
  const root = getTestDir();
  const archive = new archiveModule.ChatArchive(root);
  const original = '第一行\r\n第二行🙂\n<!-- jmbots-entry:ZmFrZQ:2 -->\n原话';
  const entry = getEntry('in:om_test', original);
  entry.attachments = ['附件/test.png'];

  expect(archive.record(chat, entry)).toBe(true);
  expect(archive.record(chat, entry)).toBe(false);
  const directory = path.join(root, 'channels', 'feishu', 'app', '群聊', '测试群_oc_test');
  const file = path.join(directory, '20261119_001.md');
  const initial = fs.readFileSync(file, 'utf8');
  expect(initial).toMatch(/ou_test · 甲 · 2026-11-19 \d\d:\d\d:\d\d [^*]+\*\*/u);
  expect(initial).toContain(original);
  expect(initial).toContain('- 附件/test.png');

  //M 改名或重启都沿用原目录，手工粘贴进原话的注释不会污染去重。
  const restarted = new archiveModule.ChatArchive(root);
  const renamed = { ...chat, name: '新群名' };
  expect(restarted.getDirectory(renamed)).toBe(directory);
  expect(restarted.record(renamed, entry)).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe(initial);
  expect(restarted.record(renamed, getEntry('fake', '独立记录'))).toBe(true);
});


test('满 200 条后按日开始下一卷，重启后知道当前卷条数', () => {
  const root = getTestDir();
  const archive = new archiveModule.ChatArchive(root);
  for (let number = 1; number <= 200; number += 1) {
    const text = `正文 ${String(number)}`;
    const entry = getEntry(`in:${String(number)}`, text);
    archive.record(chat, entry);
  }

  const restarted = new archiveModule.ChatArchive(root);
  restarted.record(chat, getEntry('out:201', '这一条另开一卷'));
  const nextDay = getEntry('in:202', '下一天从第一卷开始');
  nextDay.at += 86_400_000;
  restarted.record(chat, nextDay);
  const directory = archive.getDirectory(chat);
  const first = fs.readFileSync(path.join(directory, '20261119_001.md'), 'utf8');
  const second = fs.readFileSync(path.join(directory, '20261119_002.md'), 'utf8');
  const third = fs.readFileSync(path.join(directory, '20261120_001.md'), 'utf8');
  expect([...first.matchAll(/^<!-- jmbots-entry:/gmu)]).toHaveLength(200);
  expect(second).toContain('这一条另开一卷');
  expect(third).toContain('下一天从第一卷开始');
});


test('私聊、群聊和频道分目录，文件名归一碰撞时仍按原 ID 区分', () => {
  const archive = new archiveModule.ChatArchive(getTestDir());
  const groupDir = archive.getDirectory(chat);
  const p2p = archive.getDirectory({ ...chat, chatType: 'p2p' });
  const web = archive.getDirectory({ ...chat, channel: 'http' });
  const collision = archive.getDirectory({ ...chat, id: 'oc_:test' });

  expect(path.basename(path.dirname(groupDir))).toBe('群聊');
  expect(path.basename(path.dirname(p2p))).toBe('私聊');
  expect(path.basename(path.dirname(path.dirname(path.dirname(web))))).toBe('http');
  expect(new Set([groupDir, p2p, web, collision]).size).toBe(4);
  expect(fs.readFileSync(path.join(collision, '.chat-id'), 'utf8')).toBe('oc_:test');
});


test('有账号名时账号目录是“名字_ID”，没带名字的回复和重启后的撤回沿用它，没名字就只用 ID', () => {
  const root = getTestDir();
  const archive = new archiveModule.ChatArchive(root);
  const named = archive.getDirectory({ ...chat, accountId: 'cli_x', accountName: '周小灵' });
  expect(path.basename(path.dirname(path.dirname(named)))).toBe('周小灵_cli_x');

  //M 回复没带名字：同一进程沿用刚记下的，重启后在渠道目录里找已有的“名字_ID”。
  expect(archive.getDirectory({ ...chat, accountId: 'cli_x' })).toBe(named);
  const restarted = new archiveModule.ChatArchive(root);
  expect(restarted.getDirectory({ ...chat, accountId: 'cli_x' })).toBe(named);
  expect(restarted.findChat('feishu', 'cli_x', 'oc_test')?.accountId).toBe('cli_x');

  //M 从没带过名字的账号，目录还是只用 ID。
  const plain = archive.getDirectory({ ...chat, accountId: 'cli_y' });
  expect(path.basename(path.dirname(path.dirname(plain)))).toBe('cli_y');
});


/** 造一条标准飞书消息，附件指向测试目录里的真实原件。 */
function getMessage(overrides: Partial<messageModule.ChannelMessage>): messageModule.ChannelMessage {
  return {
    v: 1,
    messageId: '["feishu","app","om_1"]',
    nativeId: 'om_1',
    channel: 'feishu',
    accountId: 'app',
    chatId: 'oc_group',
    chatType: 'group',
    sender: { id: 'ou_a', name: '甲' },
    role: 'guest',
    targetBots: [],
    mentions: [],
    rawText: '你好',
    text: '你好',
    attachments: [],
    createdAt: start,
    receivedAt: start,
    timeSource: 'provider',
    replyTo: null,
    origin: { channel: 'feishu', address: { chatName: '测试群' } },
    visibility: { scope: 'group', trusted: false, publicSourceIds: [] },
    routing: {},
    ...overrides,
  };
}


test('飞书私聊、群聊（含没 @）和机器人回复按名字_ID 落 MD，附件进 附件/，撤回另记一条', async () => {
  const root = getTestDir();
  const ctx = new Context();
  listenModule.applyChatArchive(ctx, root);
  const control = { claims: [] };

  //M 原件在渠道目录，归档只复制。
  const source = path.join(root, 'orig_om_2_图.png');
  fs.writeFileSync(source, 'png');
  const attachment: messageModule.ChannelAttachment = {
    id: 'om_2:0', name: '图.png', sourceRef: source, state: 'available',
  };
  const gone: messageModule.ChannelAttachment = {
    id: 'om_2:1', name: '坏.png', sourceRef: '', state: 'unavailable', reason: '超时',
  };

  //M 私聊（channel/direct）：目录取对面发话人的名字。
  const p2p = getMessage({
    messageId: '["feishu","app","om_p"]', chatId: 'ou_a', chatType: 'p2p', text: '私聊一句',
    origin: { channel: 'feishu', address: {} },
  });
  await messageModule.emitInbound(ctx, p2p, true, control);
  //M 群里没 @（channel/listen）和 @ 了（channel/mention）。
  await messageModule.emitInbound(ctx, getMessage({ text: '群里闲聊' }), false, control);
  const mention = getMessage({
    messageId: '["feishu","app","om_2"]', text: '带图\n第二行', attachments: [attachment, gone],
  });
  await messageModule.emitInbound(ctx, mention, true, control);

  //M 机器人自己的回复：回执 sent 才记，来源快照指向这个群。
  const snapshot = messageModule.getSourceSnapshot(mention, '小助手', mention.origin, 'ck', 'rk');
  const request = {
    requestId: 'r1', channel: 'feishu', bot: '小助手', replyRequestKey: 'req1', replyRoundKey: 'rk',
    replyIndex: 0, kind: 'final', mode: 'text', sourceSnapshot: snapshot, payloadHash: 'h',
    parts: [{ partId: 'p0', kind: 'text', text: '收到' }],
  } as replyModule.ChannelReplyRequest;
  const receipt = replyModule.getReceipt(request, 'sent');
  replyModule.emitReplied(ctx, request, receipt);
  replyModule.emitReplied(ctx, request, receipt);

  const groupDir = path.join(root, 'channels', 'feishu', 'app', '群聊', '测试群_oc_group');
  const privateDir = path.join(root, 'channels', 'feishu', 'app', '私聊', '甲_ou_a');
  expect(fs.readFileSync(path.join(privateDir, '20261119_001.md'), 'utf8')).toContain('私聊一句');

  //M 回复和群消息在同一个群文件夹，重复回执只记一次。
  const groupText = fs.readFileSync(path.join(groupDir, '20261119_001.md'), 'utf8').replaceAll('\r\n', '\n');
  expect(groupText).toContain('群里闲聊');
  expect(groupText).toContain('带图\n第二行');
  expect(groupText).toContain('- 附件/orig_om_2_图.png');
  expect(groupText).not.toContain('坏.png');
  //M 回复按回执的当前时刻分卷，和 2026-11-19 的群消息不在同一天的卷里。
  const names = fs.readdirSync(groupDir).filter((name) => name.endsWith('.md'));
  const all = names.map((name) => fs.readFileSync(path.join(groupDir, name), 'utf8')).join('');
  expect(all.split('小助手 · 小助手').length - 1).toBe(1);
  expect(all).toContain('收到');
  expect(fs.readFileSync(path.join(groupDir, '附件', 'orig_om_2_图.png'), 'utf8')).toBe('png');

  //M 撤回：原话不改，另记一条，聊天号不用带种类。
  await ctx.serial('channel/recall', {
    channel: 'feishu', accountId: 'app', chatId: 'oc_group', messageId: mention.messageId,
    recalledAt: start + 1000, originalText: '带图', recalledBy: { id: 'ou_a', kind: 'sender', isOwner: false },
  });
  expect(fs.readFileSync(path.join(groupDir, '20261119_001.md'), 'utf8')).toContain('【撤回】');
});
