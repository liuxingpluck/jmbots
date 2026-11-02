/** Feishu.ts 的离线测试：只测把飞书事件换成 zbots 消息格式这一步，不连飞书。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as feishu from '../src/Feishu.ts';


test.test('文字消息：取出正文，去掉群里 @ 机器人的占位符', () => {
  const message = feishu.toMessage({
    sender: { sender_id: { open_id: 'ou_test' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我查一下天气 ' }),
      mentions: [{ key: '@_user_1' }],
    },
  });
  assert.deepEqual(message, {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'group',
    openId: 'ou_test',
    messageType: 'text',
    text: '帮我查一下天气',
  });
});


test.test('不是文字的消息：正文留空，类型照实给出', () => {
  const message = feishu.toMessage({
    sender: {},
    message: { message_id: 'om_2', chat_id: 'oc_2', chat_type: 'p2p', message_type: 'image', content: '{"image_key":"img_x"}' },
  });
  assert.equal(message.text, '');
  assert.equal(message.messageType, 'image');
  assert.equal(message.openId, '');
});
