/**
 * 飞书卡片离线测试（通用 buildCard、feishu_card 用的选项卡片）：用假的飞书传输层和内存数据库，
 * 检查卡片发到会话所在聊天、按钮带着会话和选项、记了 sent 事件；传输层不会发卡片时退回发文字。不连飞书、不调模型。
 */
import * as bunTest from 'bun:test';
import * as feishu from '../src/channels/Feishu.ts';
import * as events from '../src/store/Events.ts';


/**
 * 建一个内存数据库，里面有一个飞书私聊来的会话和它的一次执行。
 * @returns 数据库和会话 ID。
 */
function makeStore(): { store: ReturnType<typeof events.openEventStore>; sessionId: string } {
  /** 数据库。 */
  const store = events.openEventStore(':memory:');
  /** 会话 ID。 */
  const sessionId = store.createSession({ title: '测试', kind: 'task', bot: null, agent: null, model: null, workspace: '', source: '飞书私聊 oc_test' }).id;
  store.createEvent({ sessionId, type: 'execution', payload: { input: '选个模型' } });
  return { store, sessionId };
}


bunTest.test('选项卡片发到会话所在聊天，按钮带会话和选项，记 sent 事件', async () => {
  const { store, sessionId } = makeStore();
  /** 发出去的卡片。 */
  const sent: { to: feishu.FeishuTarget; card: Record<string, unknown> }[] = [];
  /** 假传输层。 */
  const transport: feishu.FeishuTransport = {
    listen: () => Promise.resolve(),
    sendText: () => Promise.resolve('text_1'),
    sendCard: (to, card) => {
      sent.push({ to, card });
      return Promise.resolve('card_1');
    },
    close: () => undefined,
  };
  /** 消息 ID。 */
  const messageId = await feishu.createChoiceSender(transport, store)(sessionId, '用哪个模型？', ['快的', '强的']);
  bunTest.expect(messageId).toBe('card_1');
  bunTest.expect(sent[0]?.to).toEqual({ chatId: 'oc_test' });
  /** 卡片全文。 */
  const text = JSON.stringify(sent[0]?.card);
  bunTest.expect(text).toContain('"kind":"choice"');
  bunTest.expect(text).toContain(`"session_id":"${sessionId}"`);
  bunTest.expect(text).toContain('"choice":"强的"');
  bunTest.expect(store.listEvents(sessionId, 'sent').length).toBe(1);
});


bunTest.test('传输层不会发卡片时退回发文字', async () => {
  const { store, sessionId } = makeStore();
  /** 发出去的文字。 */
  const texts: string[] = [];
  /** 假传输层（没有 sendCard）。 */
  const transport: feishu.FeishuTransport = {
    listen: () => Promise.resolve(),
    sendText: (_to, text) => {
      texts.push(text);
      return Promise.resolve('text_1');
    },
    close: () => undefined,
  };
  await feishu.createChoiceSender(transport, store)(sessionId, '用哪个模型？', ['快的', '强的']);
  bunTest.expect(texts[0]).toContain('1. 快的');
  bunTest.expect(texts[0]).toContain('回一句话');
});


bunTest.test('通用卡片：正文、按钮（带种类）、脚注都拼进去', () => {
  /** 卡片。 */
  const card = feishu.buildCard({ title: '标题', color: 'blue', body: ['第一段'], buttons: [{ text: '好', value: { kind: 'choice', choice: '好' } }], note: '脚注' });
  /** 全文。 */
  const text = JSON.stringify(card);
  bunTest.expect(text).toContain('"content":"第一段"');
  bunTest.expect(text).toContain('"tag":"action"');
  bunTest.expect(text).toContain('"kind":"choice"');
  bunTest.expect(text).toContain('"content":"脚注"');
});
