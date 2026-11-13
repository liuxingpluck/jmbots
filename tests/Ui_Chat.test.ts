/**
 * 网页聊天区（web/src/Chat）的纯逻辑测试：认附件（和后端同一套认法）、时间线怎么排、事件行的文字、斜杠命令过滤。
 * 输入框（Tiptap）和界面靠 AOBB 截图核对，这里不起浏览器。
 */
import * as bunTest from 'bun:test';
import * as httpUi from '../src/channels/HttpUi.ts';
import * as approvalRules from '../web/src/Approval/Rules.ts';
import * as previewKinds from '../web/src/Panel/PreviewKind.ts';
import * as attachments from '../web/src/Chat/Attachments.ts';
import * as slash from '../web/src/Chat/SlashCommands.ts';
import * as timeline from '../web/src/Chat/Timeline.ts';
import * as i18n from '../web/src/I18n.ts';
import type * as types from '../web/src/Types.ts';
import * as replyEvidenceModule from '../src/capabilities/ReplyEvidence.ts';


/** 旧时间线样例未保存生成模型，只明确回复给消息 #1。 */
const REPLY_EVIDENCE = {
  generation: replyEvidenceModule.unknownGeneration(),
  association: replyEvidenceModule.association([1], 'target', 'test'),
};


/**
 * 造一条消息。
 * @param id 消息号。
 * @param patch 要改的字段。
 */
function messageOf(id: number, patch: Partial<types.MessageView> = {}): types.MessageView {
  return { id, bot: '小测', channel: 'http', source: 'web', text: `第 ${id} 条`, status: 'taken', sessionId: null, file: `F:/m/${id}.md`, createdAt: id * 1000, updatedAt: id * 1000, attachments: [], replies: [], dispatch: null, ...patch };
}


/**
 * 造一张待审核的卡片。
 * @param id 号。
 * @param patch 要改的字段。
 */
function approvalOf(id: number, patch: Partial<types.ApprovalView> = {}): types.ApprovalView {
  return { id, bot: '小测', sessionId: 's1', command: 'bun run build', workDir: 'F:/w', review: { what: '构建', risk: '低', advice: '可以' }, createdAt: id * 1000, ...patch };
}


bunTest.describe('附件', () => {
  bunTest.test('网页和后端认出同样的附件', () => {
    const samples = ['看图 @F:\\a\\1.png，还有 @"F:/a b/2_报告.pdf" 和 @/tmp/3.opus。@张三 你好', '回复：@F:/x/图.webp.', '没有附件 @someone', '@C:/v/4.mp4) 结尾'];
    for (const text of samples) {
      const fromWeb = attachments.splitAttachments(text).flatMap((segment) => (segment.type === 'attachment' ? [{ path: segment.path, kind: segment.kind }] : []));
      const fromBackend = httpUi.parseAttachments(text).map((item) => ({ path: item.path, kind: item.kind }));
      //M 后端同一路径只算一次；网页按出现的位置切，每次都算。比较去重后的。
      bunTest.expect([...new Map(fromWeb.map((item) => [item.path, item])).values()]).toEqual(fromBackend);
    }
  });

  bunTest.test('切段：附件前后的文字原样留着；被吃掉的结尾标点还给后面', () => {
    const segments = attachments.splitAttachments('看 @F:/a/1.png，好吗');
    bunTest.expect(segments).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'attachment', path: 'F:/a/1.png', name: '1.png', kind: 'image' },
      { type: 'text', text: '，好吗' },
    ]);
    bunTest.expect(attachments.splitAttachments('@F:/a/2.pdf).')[1]).toEqual({ type: 'text', text: ').' });
  });

  bunTest.test('换成 jmfile 链接再取回来；大小的写法', () => {
    const linked = attachments.withAttachmentLinks('见 @"F:/a b/报告 1.pdf"');
    bunTest.expect(linked).toContain('[报告 1.pdf](jmfile:');
    const href = /\((jmfile:[^)]+)\)/.exec(linked)?.[1];
    bunTest.expect(attachments.pathFromLink(href)).toBe('F:/a b/报告 1.pdf');
    bunTest.expect(attachments.pathFromLink('https://x')).toBeUndefined();
    bunTest.expect(attachments.formatSize(512)).toBe('512 B');
    bunTest.expect(attachments.formatSize(1536)).toBe('1.5 KB');
    bunTest.expect(attachments.formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    bunTest.expect(attachments.formatSize(null)).toBe('');
  });

  bunTest.test('工作区标签拼到正文后：带空格的包引号，Windows 反斜杠原样不转义', () => {
    //M 设计 11.1 的验收例子：多个标签按顺序用空格接在正文后。
    bunTest.expect(attachments.withWorkspaceTags('看下', ['F:\\a b\\笔记.md', 'F:\\a\\b.md']))
      .toBe('看下 @"F:\\a b\\笔记.md" @F:\\a\\b.md');
    //M 正文为空就只有 @路径 串；没有路径原样返回。
    bunTest.expect(attachments.withWorkspaceTags('', ['F:\\a\\b.md'])).toBe('@F:\\a\\b.md');
    bunTest.expect(attachments.withWorkspaceTags('看下', [])).toBe('看下');
    //M 拼出来的 @路径 能被同一套认法认回来（发出去机器人认得）。
    const joined = attachments.withWorkspaceTags('看下', ['F:\\a b\\笔记.md', 'F:\\a\\b.md']);
    bunTest.expect(attachments.splitAttachments(joined).filter((segment) => segment.type === 'attachment'))
      .toEqual([
        { type: 'attachment', path: 'F:\\a b\\笔记.md', name: '笔记.md', kind: 'file' },
        { type: 'attachment', path: 'F:\\a\\b.md', name: 'b.md', kind: 'file' },
      ]);
  });
});


bunTest.describe('时间线', () => {
  bunTest.test('用户的话 → 事件行 → 回复，按时间排；回复晚到也排在后面', () => {
    const dispatch: types.DispatchBrief = { action: 'new', sessionId: 's1', title: '看图', file: 'F:/w/s1.md', model: 'magpie/workbuddy/hy4free', workspace: '日常', by: 'llm', reason: '新的事' };
    const first = messageOf(1, { dispatch, replies: [{ at: 5000, session: { id: 's1', title: '看图', file: 'F:/w/s1.md' }, text: '好的', attachments: [], ...REPLY_EVIDENCE }] });
    const second = messageOf(2);
    const items = timeline.buildTimeline([second, first]);
    bunTest.expect(items.map((item) => item.key)).toEqual(['m1', 'e1', 'm2', 'r1_0']);
  });

  bunTest.test('程序写的灰字：全角（系统）和半角 (system) 开头；普通消息不算', () => {
    bunTest.expect(timeline.isSystemNote('（系统）待确认 #1：同意执行')).toBe(true);
    bunTest.expect(timeline.isSystemNote('(system) 待确认 #1：同意执行')).toBe(true);
    bunTest.expect(timeline.isSystemNote('普通消息')).toBe(false);
  });

  bunTest.test('审核卡片按提出时间插进时间线；同一时刻排在用户的话、事件行、回复后面', () => {
    const dispatch: types.DispatchBrief = { action: 'new', sessionId: 's1', title: '看图', file: 'F:/w/s1.md', model: '', workspace: '日常', by: 'llm', reason: '' };
    const first = messageOf(1, { createdAt: 1000, dispatch, replies: [{ at: 2000, session: { id: 's1', title: '看图', file: 'F:/w/s1.md' }, text: '好的', attachments: [], ...REPLY_EVIDENCE }] });
    const second = messageOf(2, { createdAt: 3000 });
    const card = approvalOf(5, { createdAt: 2500 });
    const items = timeline.buildTimeline([second, first], [card]);
    //M 卡片落在两条消息中间：按 at 升序排。
    bunTest.expect(items.map((item) => item.key)).toEqual(['m1', 'e1', 'r1_0', 'a5', 'm2']);
    bunTest.expect(items.map((item) => item.at)).toEqual([1000, 1000, 2000, 2500, 3000]);
    bunTest.expect(items.find((item) => item.key === 'a5')).toMatchObject({ kind: 'approval', approval: { id: 5 } });

    //M 同一时刻：用户的话、事件行、回复都在卡片前面；消息之间按号排。
    const sameAtFirst = messageOf(1, { createdAt: 1000, dispatch, replies: [{ at: 1000, session: { id: 's1', title: '看图', file: 'F:/w/s1.md' }, text: '好的', attachments: [], ...REPLY_EVIDENCE }] });
    const sameAtSecond = messageOf(2, { createdAt: 1000 });
    const sameAtItems = timeline.buildTimeline([sameAtSecond, sameAtFirst], [approvalOf(7, { createdAt: 1000 })]);
    bunTest.expect(sameAtItems.map((item) => item.key)).toEqual(['m1', 'e1', 'r1_0', 'm2', 'a7']);
    bunTest.expect(sameAtItems.at(-1)).toMatchObject({ kind: 'approval', approval: { id: 7 } });
  });

  bunTest.test('合并：同一个号用新的，别的留着', () => {
    const merged = timeline.mergeMessages(new Map([[1, messageOf(1)], [2, messageOf(2)]]), [messageOf(2, { text: '改过' }), messageOf(3)]);
    bunTest.expect([...merged.keys()].sort()).toEqual([1, 2, 3]);
    bunTest.expect(merged.get(2)?.text).toBe('改过');
  });

  bunTest.test('事件行、来源、排队的小字、模型写短', () => {
    const brief: types.DispatchBrief = { action: 'new', sessionId: 's1', title: '看图', file: '', model: 'magpie/workbuddy/hy4free', workspace: '日常', by: 'llm', reason: '' };
    bunTest.expect(timeline.eventText(brief)).toBe('新开了会话「看图」，用 hy4free');
    bunTest.expect(timeline.eventText({ ...brief, action: 'append', model: '' })).toBe('进了会话「看图」');
    //M 追加不换模型：有模型也不写“模型换成”。
    bunTest.expect(timeline.eventText({ ...brief, action: 'append' })).toBe('进了会话「看图」');
    bunTest.expect(timeline.channelLabel('feishu:cli_x', 'feishu:cli_x:oc:ou')).toBe('飞书');
    bunTest.expect(timeline.channelLabel('http', 'web')).toBe('网页');
    bunTest.expect(timeline.channelLabel('http', 'http')).toBe('HTTP');
    bunTest.expect(timeline.pendingText('new')).toBe('等分派');
    bunTest.expect(timeline.pendingText('queued')).toBe('排队中');
    bunTest.expect(timeline.pendingText('taken')).toBe('');
    const now = new Date(2026, 10, 5, 20, 0).getTime();
    bunTest.expect(timeline.formatTime(new Date(2026, 10, 5, 9, 5).getTime(), now)).toBe('09:05');
    bunTest.expect(timeline.formatTime(new Date(2026, 10, 4, 9, 5).getTime(), now)).toBe('11-04 09:05');
  });

  bunTest.test('回复耗时：秒、分、小时；负数和非数不显示；英文带参数', () => {
    bunTest.expect(timeline.formatElapsed(300)).toBe('耗时不到 1 秒');
    bunTest.expect(timeline.formatElapsed(35_000)).toBe('耗时 35 秒');
    bunTest.expect(timeline.formatElapsed(125_000)).toBe('耗时 2 分钟 5 秒');
    bunTest.expect(timeline.formatElapsed(3_725_000)).toBe('耗时 1 小时 2 分 5 秒');
    bunTest.expect(timeline.formatElapsed(-1)).toBe('');
    bunTest.expect(timeline.formatElapsed(Number.NaN)).toBe('');
    /** 英文翻译。 */
    const en = (text: string, params?: Record<string, string | number>): string => i18n.translate('en', text, params);
    bunTest.expect(timeline.formatElapsed(125_000, en)).toBe('took 2 min 5 s');
  });
});


bunTest.describe('斜杠命令', () => {
  bunTest.test('没打字给全部；中文、拼音首字母、英文都认；开头对上的排前面', () => {
    bunTest.expect(slash.filterCommands('')).toHaveLength(slash.SLASH_COMMANDS.length);
    bunTest.expect(slash.filterCommands('图')[0]?.name).toBe('图片');
    bunTest.expect(slash.filterCommands('tp')[0]?.name).toBe('图片');
    bunTest.expect(slash.filterCommands('file')[0]?.name).toBe('文件');
    bunTest.expect(slash.filterCommands('hh')[0]?.name).toBe('会话');
    bunTest.expect(slash.filterCommands('没有这个')).toEqual([]);
  });

  bunTest.test('每条命令都有名字、说明、分组；名字不重复', () => {
    const names = slash.SLASH_COMMANDS.map((command) => command.name);
    bunTest.expect(new Set(names).size).toBe(names.length);
    for (const command of slash.SLASH_COMMANDS) {
      bunTest.expect(command.hint.length).toBeGreaterThan(0);
      bunTest.expect(['格式', '附件', '功能']).toContain(command.group);
    }
  });
});


bunTest.describe('审核卡片的规矩', () => {
  bunTest.test('不能错按：Enter 永远不算；输入框里打 y 不算；1 秒内不算；按着 Ctrl 不算', () => {
    bunTest.expect(approvalRules.decisionForKey('y', true, true, false)).toBe('approve');
    bunTest.expect(approvalRules.decisionForKey('N', true, true, false)).toBe('reject');
    bunTest.expect(approvalRules.decisionForKey('Enter', true, true, false)).toBeNull();
    bunTest.expect(approvalRules.decisionForKey(' ', true, true, false)).toBeNull();
    bunTest.expect(approvalRules.decisionForKey('y', false, true, false)).toBeNull();
    bunTest.expect(approvalRules.decisionForKey('y', true, false, false)).toBeNull();
    bunTest.expect(approvalRules.decisionForKey('y', true, true, true)).toBeNull();
    bunTest.expect(approvalRules.isArmed(1000, 1000 + approvalRules.ARM_MS - 1)).toBe(false);
    bunTest.expect(approvalRules.isArmed(1000, 1000 + approvalRules.ARM_MS)).toBe(true);
  });

  bunTest.test('决定以后的提示：成功、已经处理过了、连不上', () => {
    bunTest.expect(approvalRules.decisionNotice('approve', 200)).toBe('已同意执行');
    bunTest.expect(approvalRules.decisionNotice('reject', 200)).toBe('已拒绝');
    bunTest.expect(approvalRules.decisionNotice('approve', 404)).toContain('已经处理过了');
    bunTest.expect(approvalRules.decisionNotice('reject', 0)).toContain('连不上');
  });
});


bunTest.describe('右栏预览', () => {
  bunTest.test('按扩展名挑样子；工作区里的 md 要刷新', () => {
    bunTest.expect(previewKinds.previewKind('F:/a/1.PNG')).toBe('image');
    bunTest.expect(previewKinds.previewKind('F:/a/会话.md')).toBe('markdown');
    bunTest.expect(previewKinds.previewKind('F:/a/x.json')).toBe('text');
    bunTest.expect(previewKinds.previewKind('F:/a/报告.pdf')).toBe('pdf');
    bunTest.expect(previewKinds.previewKind('F:/a/录音.opus')).toBe('audio');
    bunTest.expect(previewKinds.previewKind('F:/a/v.mp4')).toBe('video');
    bunTest.expect(previewKinds.previewKind('F:/a/压缩包.zip')).toBe('other');
    bunTest.expect(previewKinds.isLive('F:\\AIJMBots\\bots\\周小灵\\workspace\\日常\\1_标题.md')).toBe(true);
    bunTest.expect(previewKinds.isLive('F:/AIJMBots/bots/周小灵/memory/索引.md')).toBe(false);
  });
});
