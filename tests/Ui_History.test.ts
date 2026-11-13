/** 右栏统一查看历史：真实仓库的返回/前进、阅读恢复、分支、机器人隔离与旧回调。 */
import * as bunTest from 'bun:test';
import * as storeModule from '../web/src/Store.ts';
import * as historyModule from '../web/src/Panel/History.ts';
import type * as types from '../web/src/Types.ts';


/** 假机器人只用于轮询删除后的隔离，不请求后端。 */
function bot(name: string): types.BotView {
  return {
    name, language: 'zh',
    status: 'idle', running: 0, queued: 0, approvals: 0,
  };
}


bunTest.test('事件→消息→会话→文档后退前进，恢复所选回复与全部轻量阅读状态', () => {
  const store = storeModule.createUiStore('dark');
  store.getState().selectBot('甲');
  const trace = { bot: '甲', messageId: 164, replyIndex: 1 };
  store.getState().openTrace(trace);
  const eventEntry = store.getState().panelEntryId!;
  const remembered: historyModule.PanelReadingState = {
    scrollTop: 750,
    expanded: ['answer', 'event:7', 'event-raw:7'],
    raw: true,
    pageOffset: 1024,
    section: 'section:3',
    imageActualSize: true,
  };
  store.getState().savePanelReading(eventEntry, remembered);
  store.getState().openPanel('preview', { path: 'F:/bots/message.md', name: '来源原文' });
  store.getState().openPanel('preview', { path: 'F:/bots/session.md', name: '会话' });
  store.getState().openPanel('preview', { path: 'F:/bots/readme.md', name: '文档' });

  store.getState().panelBack();
  bunTest.expect(store.getState().panelTarget?.name).toBe('会话');
  store.getState().panelBack();
  bunTest.expect(store.getState().panelTarget?.name).toBe('来源原文');
  store.getState().panelBack();
  bunTest.expect(store.getState().panelTab).toBe('events');
  bunTest.expect(store.getState().traceTarget).toEqual(trace);
  bunTest.expect(store.getState().panelReading).toEqual(remembered);
  bunTest.expect(store.getState().previewTabs).toHaveLength(3);

  store.getState().panelForward();
  bunTest.expect(store.getState().panelTarget?.name).toBe('来源原文');
  bunTest.expect(store.getState().panelHistory).toHaveLength(4);
});


bunTest.test('回退后新看目标丢弃前进；相同 Windows 文件不同分隔符不反复入栈或加标签', () => {
  const store = storeModule.createUiStore('dark');
  store.getState().openPanel('preview', { path: 'F:\\Docs\\A.md', name: 'A' });
  store.getState().openPanel('preview', { path: 'f:/docs/a.md', name: 'A' });
  bunTest.expect(store.getState().panelHistory).toHaveLength(1);
  bunTest.expect(store.getState().previewTabs).toHaveLength(1);
  store.getState().openPanel('workspace');
  store.getState().openPanel('memory');
  store.getState().panelBack();
  store.getState().openPanel('usage');
  store.getState().panelForward();
  bunTest.expect(store.getState().panelHistory.map((entry) => entry.tab)).toEqual(['preview', 'workspace', 'usage']);
  bunTest.expect(store.getState().panelTab).toBe('usage');
  bunTest.expect(historyModule.fileIdentity('/Docs/A.md')).not.toBe(historyModule.fileIdentity('/docs/a.md'));
});


bunTest.test('旧异步组件只能保存自己的条目，不能覆盖新目标；删除后的旧条目保存被忽略', () => {
  const store = storeModule.createUiStore('dark');
  store.getState().openTrace({ bot: '甲', messageId: 1, replyIndex: 0 });
  const oldEntry = store.getState().panelEntryId!;
  store.getState().openPanel('preview', { path: 'F:/doc.md', name: 'doc' });
  const newEntry = store.getState().panelEntryId;
  store.getState().savePanelReading(oldEntry, { scrollTop: 900, expanded: ['notes'] });
  bunTest.expect(store.getState().panelEntryId).toBe(newEntry);
  bunTest.expect(store.getState().panelReading.scrollTop).toBe(0);
  store.getState().panelBack();
  bunTest.expect(store.getState().panelReading.scrollTop).toBe(900);

  store.getState().selectBot('乙');
  store.getState().savePanelReading(oldEntry, { scrollTop: 1000 });
  bunTest.expect(store.getState().panelHistory).toEqual([]);
  bunTest.expect(store.getState().panelReading.scrollTop).toBe(0);
  bunTest.expect(store.getState().traceTarget).toBeNull();
});


bunTest.test('机器人被移除后清掉跨机器人历史，原文件标签仍独立保留', () => {
  const store = storeModule.createUiStore('dark');
  store.getState().setPolled({ online: true, bots: [bot('甲'), bot('乙')] });
  store.getState().openTrace({ bot: '甲', messageId: 1, replyIndex: 0 });
  store.getState().openPanel('preview', { path: 'F:/doc.md', name: 'doc' });
  store.getState().setPolled({ online: true, bots: [bot('乙')] });

  bunTest.expect(store.getState().currentBot).toBe('乙');
  bunTest.expect(store.getState().panelHistory).toEqual([]);
  bunTest.expect(store.getState().panelEntryId).toBeNull();
  bunTest.expect(store.getState().traceTarget).toBeNull();
  bunTest.expect(store.getState().previewTabs).toHaveLength(1);
  store.getState().panelBack();
  bunTest.expect(store.getState().currentBot).toBe('乙');
});


bunTest.test('历史最多40条，文件标签仍最多30；回到关闭过的文件不会重新制造标签', () => {
  const store = storeModule.createUiStore('dark');
  for (let index = 0; index < 45; index += 1) {
    store.getState().openPanel('preview', { path: `F:/${index}.md`, name: String(index) });
  }
  bunTest.expect(store.getState().panelHistory).toHaveLength(40);
  bunTest.expect(store.getState().previewTabs).toHaveLength(30);
  bunTest.expect(store.getState().panelHistoryIndex).toBe(39);
  store.getState().closePreview('F:/44.md');
  const tabs = store.getState().previewTabs.length;
  store.getState().panelBack();
  bunTest.expect(store.getState().panelTarget?.path).toBe('F:/44.md');
  bunTest.expect(store.getState().previewTabs).toHaveLength(tabs);
  bunTest.expect(store.getState().panelHistory).toHaveLength(40);
});
